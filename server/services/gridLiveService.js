// GRID Open Access 补充数据：实时比分与单图（单局）比分，覆盖游戏注册表里配置了 grid 的所有游戏。
//
// PandaScore 仍是赛程、赛果、赛程图与结算的唯一来源；这里只做展示层增强：
//   1. 配对（discovery）：把近期比赛按「双方队名 + 开赛时间」关联到同游戏（titleId）的 GRID series；
//   2. 轮询（poll）：对已开赛的关联比赛拉取 seriesState，写入系列赛比分与每张地图的回合比分。
//
// Open Access 限额很紧（实测 central-data 20 次/分钟，series-state 6 次/分钟），且按 token 计：
// CS2 用 GRID_API_TOKEN，Valorant / LoL 共用 RIOT_GRID_API_TOKEN。所以退避和每轮额度都按 token 算，
// 同一 token 下的多个游戏共用额度、按上次拉取时间统一轮转。
// 生产和本地开发若共用同一 token 也共享额度：本地可用 GRID_LIVE_ENABLED=false 关闭，
// 或用 GRID_LIVE_GAMES=cs2 只开部分游戏。
const db = require('../config/database');
const { GAMES } = require('../config/games');
const { pickSeriesForMatch, orientSeriesState } = require('./gridMatching');
const { normalizeGameStats, flipGameStats } = require('./gridStats');
const { captureMapResults } = require('./botMapEvents');

const SOURCE = 'grid';
// GRID 用来测试数据管道的赛事，里面用的是真实队名（如 NAVI vs JDG），绝不能拿来配对。
const TEST_TOURNAMENT = /^grid[-\s]?test/i;
const DEFAULT_BASE_URL = 'https://api-op.grid.gg';
const CENTRAL_PATH = '/central-data/graphql';
const STATE_PATH = '/live-data-feed/series-state/graphql';
const DEFAULT_INTERVAL_MS = 60 * 1000;
const MIN_INTERVAL_MS = 30 * 1000;
const DEFAULT_DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
const MIN_DISCOVERY_INTERVAL_MS = 60 * 1000;
const DEFAULT_STATE_BUDGET = 5;
const MAX_STATE_BUDGET = 6;
const REQUEST_TIMEOUT_MS = 15000;
// 配对窗口：开赛前 2 小时 ~ 开赛后 18 小时（覆盖刚结束、需要补单图比分的比赛）。
const LOOKAHEAD_MS = 2 * 60 * 60 * 1000;
const LOOKBACK_MS = 18 * 60 * 60 * 1000;
// 开赛前 10 分钟开始轮询；超过回看窗口仍未结束的关联不再轮询。
const POLL_LEAD_MS = 10 * 60 * 1000;
const STALE_UNSTARTED_MS = 6 * 60 * 60 * 1000;
const SERIES_TIME_SLACK_MS = 4 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
// 历史补齐：回看天数（GRID_BACKFILL_DAYS，0 = 关闭），每次配对每个游戏处理一个 1 天的窗口
const DEFAULT_BACKFILL_DAYS = 90;
const BACKFILL_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 8;

let timer = null;
let running = false;
let lastDiscoveryAt = 0;
const backoffUntil = new Map();
const stats = { last_tick_at: null, last_discovery_at: null, last_error: null, linked_last_discovery: 0, polled_last_tick: 0, backfilled_last_tick: 0 };

function tokenValue(tokenEnv) {
    // GRID_API_KEY：CS2 早期使用的变量名，保持兼容
    const fallback = tokenEnv === 'GRID_API_TOKEN' ? process.env.GRID_API_KEY : '';
    return (process.env[tokenEnv] || fallback || '').trim();
}

// GRID_LIVE_GAMES=cs2,valorant：只为列出的游戏拉取（留空 = 全部已配置 token 的游戏）
function gameAllowList() {
    const raw = String(process.env.GRID_LIVE_GAMES || '').trim();
    return raw ? new Set(raw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)) : null;
}

// 已配置 GRID 的游戏：[{ key, label, titleId, tokenEnv }]
function gridGames() {
    const allow = gameAllowList();
    return Object.values(GAMES)
        .filter(game => game.grid?.titleId && game.grid.tokenEnv && tokenValue(game.grid.tokenEnv))
        .filter(game => !allow || allow.has(game.key))
        .map(game => ({ key: game.key, label: game.label, titleId: game.grid.titleId, tokenEnv: game.grid.tokenEnv }));
}

function gridGame(key) {
    return gridGames().find(game => game.key === key) || null;
}

function enabled() {
    return gridGames().length > 0 && process.env.GRID_LIVE_ENABLED !== 'false';
}

function numberEnv(name, fallback, min, max = Infinity) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.min(Math.max(value, min), max);
}

const intervalMs = () => numberEnv('GRID_LIVE_INTERVAL_MS', DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
const discoveryIntervalMs = () => numberEnv('GRID_DISCOVERY_INTERVAL_MS', DEFAULT_DISCOVERY_INTERVAL_MS, MIN_DISCOVERY_INTERVAL_MS);
const backfillDays = () => {
    const value = Number(process.env.GRID_BACKFILL_DAYS);
    return Number.isFinite(value) && value >= 0 ? Math.min(value, 365) : DEFAULT_BACKFILL_DAYS;
};
const stateBudget = () => Math.floor(numberEnv('GRID_STATE_BUDGET', DEFAULT_STATE_BUDGET, 1, MAX_STATE_BUDGET));
const baseUrl = () => (process.env.GRID_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

class GridRateLimitError extends Error {}

// 限额按 token + 接口计：Riot token 被 429 时不影响 CS2 的请求。
async function graphql(tokenEnv, path, query, variables = {}) {
    const bucket = `${tokenEnv}|${path}`;
    const blockedUntil = backoffUntil.get(bucket) || 0;
    if (blockedUntil > Date.now()) {
        throw new GridRateLimitError(`GRID 限流中，${Math.ceil((blockedUntil - Date.now()) / 1000)} 秒后重试`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${baseUrl()}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': tokenValue(tokenEnv) },
            body: JSON.stringify({ query, variables }),
            signal: controller.signal
        });
        const remaining = Number(response.headers.get('x-ratelimit-remaining'));
        const resetSec = Number(response.headers.get('x-ratelimit-reset'));
        if (response.status === 429) {
            const retryAfter = Number(response.headers.get('retry-after')) || resetSec || 60;
            backoffUntil.set(bucket, Date.now() + retryAfter * 1000);
            throw new GridRateLimitError(`GRID 返回 429，${retryAfter} 秒后重试`);
        }
        // 本窗口额度用完：主动等到重置，避免下一次请求直接 429。
        if (remaining === 0 && resetSec > 0) backoffUntil.set(bucket, Date.now() + resetSec * 1000);
        if (!response.ok) throw new Error(`GRID HTTP ${response.status}`);
        const payload = await response.json();
        if (payload.errors?.length && !payload.data) {
            throw new Error(`GRID: ${payload.errors.map(error => error.message).join('; ')}`);
        }
        return payload.data || {};
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('GRID 请求超时');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

const SERIES_FIELDS = 'id startTimeScheduled tournament { name } teams { baseInfo { id name nameShortened } }';

const isTestSeries = series => TEST_TOURNAMENT.test(String(series?.tournament?.name || ''));

async function fetchSeriesWindow(game, fromIso, toIso) {
    const query = `query($after: Cursor, $from: String!, $to: String!) {
        allSeries(first: ${PAGE_SIZE}, after: $after, orderBy: StartTimeScheduled, orderDirection: ASC,
            filter: { titleId: ${Number(game.titleId)}, startTimeScheduled: { gte: $from, lte: $to } }) {
            pageInfo { hasNextPage endCursor }
            edges { node { ${SERIES_FIELDS} } }
        }
    }`;
    const series = [];
    let after = null;
    for (let page = 0; page < MAX_PAGES; page++) {
        const data = await graphql(game.tokenEnv, CENTRAL_PATH, query, { after, from: fromIso, to: toIso });
        const connection = data.allSeries;
        if (!connection) break;
        series.push(...connection.edges.map(edge => edge.node).filter(node => !isTestSeries(node)));
        if (!connection.pageInfo?.hasNextPage) break;
        after = connection.pageInfo.endCursor;
    }
    return series;
}

async function fetchSeries(game, seriesId) {
    const data = await graphql(game.tokenEnv, CENTRAL_PATH, `query($id: ID!) { series(id: $id) { ${SERIES_FIELDS} title { id } } }`, { id: String(seriesId) });
    return data.series || null;
}

// 一次请求同时取比分和每局详细数据（选手 / LoL 经济与资源 / 每局 BP），不额外消耗限额。
// 各游戏特有字段用内联片段，查询对所有游戏通用。
const SERIES_STATE_QUERY = `query($id: ID!) {
    seriesState(id: $id) {
        id started finished updatedAt
        teams { id name won score }
        draftActions { type sequenceNumber drafter { id type } draftable { type name } }
        games {
            sequenceNumber started finished map { name } duration
            draftActions { type sequenceNumber drafter { id type } draftable { type name } }
            teams {
                id side won score kills deaths killAssistsGiven netWorth
                objectives { type completionCount }
                ... on GameTeamStateLol { moneyDifference totalMoneyEarned damageDealt visionScore }
                players {
                    id name character { name } kills deaths killAssistsGiven netWorth
                    ... on GamePlayerStateLol { inventory { items { name } } unitKills { unitName count } objectives { type completionCount }
                        damageDealt damagePercentage killParticipation visionScore totalMoneyEarned }
                    ... on GamePlayerStateCs2 { damageDealt headshots }
                    ... on GamePlayerStateValorant { damageDealt headshots }
                }
            }
        }
    }
}`;

async function fetchSeriesState(game, seriesId) {
    const data = await graphql(game.tokenEnv, STATE_PATH, SERIES_STATE_QUERY, { id: String(seriesId) });
    return data.seriesState || null;
}

const MATCH_COLUMNS = `m.id, m.match_time, m.status, m.team1_id, m.team2_id,
    t1.name team1_name, t1.short_name team1_short_name, t2.name team2_name, t2.short_name team2_short_name`;

function discoveryCandidates(gameKey, nowMs) {
    return db.prepare(`
        SELECT ${MATCH_COLUMNS}
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        LEFT JOIN match_live_links l ON l.match_id = m.id
        WHERE tour.game_type = ? AND tour.is_active = 1
            AND t1.name <> 'TBD' AND t2.name <> 'TBD'
            AND l.match_id IS NULL
            AND m.status IN ('upcoming', 'ongoing', 'finished')
            AND datetime(m.match_time) BETWEEN datetime(?) AND datetime(?)
        ORDER BY m.match_time ASC
        LIMIT 80
    `).all(gameKey, new Date(nowMs - LOOKBACK_MS).toISOString(), new Date(nowMs + LOOKAHEAD_MS).toISOString());
}

function insertLink(match, pick, method, now) {
    const teamMap = { [match.team1_id]: pick.team1GridId, [match.team2_id]: pick.team2GridId };
    return db.prepare(`
        INSERT INTO match_live_links (match_id, source, series_id, link_method, link_score, team1_id, team_map, linked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(match_id) DO UPDATE SET series_id = excluded.series_id, link_method = excluded.link_method,
            link_score = excluded.link_score, team1_id = excluded.team1_id, team_map = excluded.team_map,
            started = 0, finished = 0, team1_score = NULL, team2_score = NULL, state_updated_at = NULL,
            last_polled_at = NULL, last_error = NULL, linked_at = excluded.linked_at
    `).run(match.id, SOURCE, String(pick.series.id), method, pick.score, match.team1_id, JSON.stringify(teamMap), now);
}

// 按游戏分别配对：一个游戏失败（如 Riot token 被限流）不影响其他游戏。
async function discover(nowMs = Date.now()) {
    lastDiscoveryAt = nowMs;
    stats.last_discovery_at = new Date(nowMs).toISOString();
    const total = { candidates: 0, series: 0, linked: 0, backfill_linked: 0, games: {} };
    const errors = [];
    for (const game of gridGames()) {
        try {
            const result = await discoverGame(game, nowMs);
            total.games[game.key] = result;
            total.candidates += result.candidates;
            total.series += result.series || 0;
            total.linked += result.linked;
            // 实时配对之后再补一个历史窗口；失败只记错误，不影响实时
            try {
                const backfill = await backfillDiscoverGame(game, nowMs);
                if (backfill) {
                    result.backfill = backfill;
                    total.backfill_linked += backfill.linked;
                }
            } catch (error) {
                result.backfill = { error: error.message };
                if (!(error instanceof GridRateLimitError)) errors.push(`${game.label} 历史补齐: ${error.message}`);
            }
        } catch (error) {
            total.games[game.key] = { error: error.message };
            errors.push(`${game.label}: ${error.message}`);
        }
    }
    stats.linked_last_discovery = total.linked;
    if (errors.length) total.error = errors.join('；');
    return total;
}

async function discoverGame(game, nowMs) {
    const candidates = discoveryCandidates(game.key, nowMs);
    if (!candidates.length) return { candidates: 0, linked: 0 };
    const { series, linked } = await linkCandidates(game, candidates, nowMs);
    if (linked.size) console.log(`[GRID] ${game.label} 新关联 ${linked.size}/${candidates.length} 场比赛（窗口内 ${series} 个 series）`);
    return { candidates: candidates.length, series, linked: linked.size };
}

// 拉取覆盖这批比赛的 GRID series 并逐场配对；返回窗口内 series 数和配上的本地比赛 id。
async function linkCandidates(game, candidates, nowMs) {
    const times = candidates.map(match => new Date(match.match_time).getTime());
    const from = new Date(Math.min(...times) - SERIES_TIME_SLACK_MS).toISOString();
    const to = new Date(Math.max(...times) + SERIES_TIME_SLACK_MS).toISOString();
    const series = await fetchSeriesWindow(game, from, to);

    const taken = new Set(db.prepare('SELECT series_id FROM match_live_links WHERE source = ? AND series_id IS NOT NULL').all(SOURCE).map(row => row.series_id));
    const now = new Date(nowMs).toISOString();
    const linked = new Set();
    const tx = db.transaction(() => {
        for (const match of candidates) {
            const pick = pickSeriesForMatch(match, series, { excludeSeriesIds: taken });
            if (!pick) continue;
            insertLink(match, pick, 'auto', now);
            taken.add(String(pick.series.id));
            linked.add(match.id);
        }
    });
    tx();
    return { series: series.length, linked };
}

// ===== 历史补齐 =====
// 统计页需要历史数据，而本地库不会上传到服务器，所以补齐就在服务器的轮询里慢慢做：
//   配对：每次配对时，每个游戏挑最近一个「已结束、未关联、没查过」的比赛，处理它往前 1 天窗口内的比赛；
//   详细数据：每轮实时轮询后，用该 token 剩余的 seriesState 额度拉取已结束、还没有详细数据的关联比赛。
// 进度都记在库里（grid_backfill_misses / match_live_links.backfill_at），重启后接着做，不会重复消耗额度。

const UNLINKED_FINISHED = `
    FROM matches m
    JOIN tournaments tour ON tour.id = m.tournament_id
    JOIN teams t1 ON t1.id = m.team1_id
    JOIN teams t2 ON t2.id = m.team2_id
    LEFT JOIN match_live_links l ON l.match_id = m.id
    LEFT JOIN grid_backfill_misses miss ON miss.match_id = m.id
    WHERE tour.game_type = ? AND tour.is_active = 1 AND m.status = 'finished'
        AND t1.name <> 'TBD' AND t2.name <> 'TBD'
        AND l.match_id IS NULL AND miss.match_id IS NULL`;

async function backfillDiscoverGame(game, nowMs) {
    const days = backfillDays();
    if (!days) return null;
    const oldest = new Date(nowMs - days * 86400000).toISOString();
    const newest = new Date(nowMs - LOOKBACK_MS).toISOString();
    const anchor = db.prepare(`SELECT m.match_time ${UNLINKED_FINISHED}
        AND datetime(m.match_time) BETWEEN datetime(?) AND datetime(?)
        ORDER BY m.match_time DESC LIMIT 1`).get(game.key, oldest, newest);
    if (!anchor) return { candidates: 0, linked: 0 };
    const windowEnd = Date.parse(anchor.match_time);
    const windowStart = Math.max(windowEnd - BACKFILL_WINDOW_MS, Date.parse(oldest));
    const candidates = db.prepare(`SELECT ${MATCH_COLUMNS} ${UNLINKED_FINISHED}
        AND datetime(m.match_time) BETWEEN datetime(?) AND datetime(?)
        ORDER BY m.match_time DESC LIMIT 80`).all(game.key, new Date(windowStart).toISOString(), anchor.match_time);
    const { series, linked } = await linkCandidates(game, candidates, nowMs);
    const now = new Date(nowMs).toISOString();
    const miss = db.prepare('INSERT OR IGNORE INTO grid_backfill_misses (match_id, checked_at) VALUES (?, ?)');
    db.transaction(() => { for (const match of candidates) if (!linked.has(match.id)) miss.run(match.id, now); })();
    if (linked.size) console.log(`[GRID] ${game.label} 历史补齐关联 ${linked.size}/${candidates.length} 场（${anchor.match_time.slice(0, 10)} 前 1 天）`);
    return { candidates: candidates.length, series, linked: linked.size };
}

function backfillStateCandidates(gameKeys, nowMs, limit) {
    const days = backfillDays();
    if (!days || limit <= 0) return [];
    return db.prepare(`
        SELECT l.*, m.team1_id match_team1_id, m.team2_id match_team2_id, m.match_time, tour.game_type
        FROM match_live_links l
        JOIN matches m ON m.id = l.match_id
        JOIN tournaments tour ON tour.id = m.tournament_id
        WHERE tour.is_active = 1 AND tour.game_type IN (${gameKeys.map(() => '?').join(',')})
            AND l.source = ? AND l.series_id IS NOT NULL AND l.link_method != 'none'
            AND m.status = 'finished' AND l.backfill_at IS NULL
            AND datetime(m.match_time) BETWEEN datetime(?) AND datetime(?)
            AND NOT EXISTS (SELECT 1 FROM match_game_stats s WHERE s.match_id = l.match_id)
        ORDER BY m.match_time DESC
        LIMIT ?
    `).all(...gameKeys, SOURCE, new Date(nowMs - days * 86400000).toISOString(), new Date(nowMs - LOOKBACK_MS).toISOString(), limit);
}

// gameKeys：共用同一 token 的游戏，一起按上次拉取时间轮转、共享这一 token 的每轮额度。
function pollCandidates(gameKeys, nowMs, limit) {
    return db.prepare(`
        SELECT l.*, m.team1_id match_team1_id, m.team2_id match_team2_id, m.match_time, tour.game_type
        FROM match_live_links l
        JOIN matches m ON m.id = l.match_id
        JOIN tournaments tour ON tour.id = m.tournament_id
        -- 只为管理员手动开启的赛事拉取实时数据（新赛事同步入库时默认关闭），节省 GRID 限额
        WHERE tour.is_active = 1 AND tour.game_type IN (${gameKeys.map(() => '?').join(',')})
            AND l.source = ? AND l.series_id IS NOT NULL AND l.link_method != 'none'
            AND l.finished = 0 AND m.status != 'cancelled'
            AND datetime(m.match_time) <= datetime(?)
            -- 手动关联不受回看窗口限制（管理员可能补关联更早的比赛）
            AND (l.link_method = 'manual' OR datetime(m.match_time) >= datetime(?))
            -- PandaScore 早已结束、但 GRID 从未开赛的（无数据覆盖），不再浪费限额
            AND NOT (m.status = 'finished' AND l.started = 0 AND l.last_polled_at IS NOT NULL
                AND datetime(m.match_time) < datetime(?))
        -- 公平轮转：从未拉取过的优先，其余按上次拉取时间。不能按 started 优先，
        -- 否则进行中的比赛数 ≥ 每轮额度时，刚开赛的比赛永远轮不到、也就永远显示不成进行中。
        ORDER BY COALESCE(l.last_polled_at, '') ASC, m.match_time ASC
        LIMIT ?
    `).all(...gameKeys, SOURCE, new Date(nowMs + POLL_LEAD_MS).toISOString(), new Date(nowMs - LOOKBACK_MS).toISOString(),
        new Date(nowMs - STALE_UNSTARTED_MS).toISOString(), limit);
}

// 按 token 分组：{ tokenEnv: [game, ...] }
function gamesByToken() {
    const groups = new Map();
    for (const game of gridGames()) {
        if (!groups.has(game.tokenEnv)) groups.set(game.tokenEnv, []);
        groups.get(game.tokenEnv).push(game);
    }
    return groups;
}

function dropLink(matchId) {
    db.prepare('DELETE FROM match_games WHERE match_id = ?').run(matchId);
    db.prepare('DELETE FROM match_game_stats WHERE match_id = ?').run(matchId);
    db.prepare('DELETE FROM match_live_links WHERE match_id = ?').run(matchId);
}

// 每局详细数据：只在本次响应确实带有对局时整体替换，避免一次空响应抹掉已存数据。
function writeGameStats(link, state, team1GridId, team2GridId, now) {
    const gameType = link.game_type || 'cs2';
    const rows = (Array.isArray(state.games) ? state.games : [])
        .map(game => normalizeGameStats(gameType, game, team1GridId, team2GridId))
        .filter(stats => stats && Number.isInteger(stats.sequence));
    if (!rows.length) return;
    db.prepare('DELETE FROM match_game_stats WHERE match_id = ?').run(link.match_id);
    const insert = db.prepare(`INSERT INTO match_game_stats (match_id, sequence, game_type, status, payload, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
    for (const stats of rows) insert.run(link.match_id, stats.sequence, gameType, stats.status, JSON.stringify(stats), now);
}

// 把一次 seriesState 写库；返回 'pending' | 'updated' | 'unlinked' | 'mismatch'。
// backfill：补历史数据时不产生群播报。
function applySeriesState(link, state, now, { backfill = false } = {}) {
    if (!state) {
        db.prepare('UPDATE match_live_links SET last_polled_at = ?, last_error = NULL WHERE match_id = ?').run(now, link.match_id);
        return 'pending';
    }
    const teamMap = JSON.parse(link.team_map || '{}');
    const team1GridId = teamMap[link.match_team1_id];
    const team2GridId = teamMap[link.match_team2_id];
    const oriented = team1GridId && team2GridId ? orientSeriesState(state, team1GridId, team2GridId) : null;
    if (!oriented) {
        // 本地对阵已变化（如 PandaScore 换了队伍）：自动关联直接解除，下一轮重新配对；
        // 手动关联保留，只记录错误等待管理员处理。
        if (link.link_method === 'auto') {
            dropLink(link.match_id);
            return 'unlinked';
        }
        db.prepare('UPDATE match_live_links SET last_polled_at = ?, last_error = ? WHERE match_id = ?')
            .run(now, 'GRID 队伍与本地对阵不一致', link.match_id);
        return 'mismatch';
    }
    const tx = db.transaction(() => {
        const previousGames = db.prepare('SELECT sequence, status FROM match_games WHERE match_id = ?').all(link.match_id);
        db.prepare(`
            UPDATE match_live_links SET started = ?, finished = ?, team1_score = ?, team2_score = ?, team1_id = ?,
                veto = ?, state_updated_at = ?, last_polled_at = ?, last_error = NULL
            WHERE match_id = ?
        `).run(oriented.started ? 1 : 0, oriented.finished ? 1 : 0, oriented.team1Score, oriented.team2Score,
            link.match_team1_id, oriented.veto.length ? JSON.stringify(oriented.veto) : null, oriented.updatedAt, now, link.match_id);
        db.prepare('DELETE FROM match_games WHERE match_id = ?').run(link.match_id);
        const insert = db.prepare(`
            INSERT INTO match_games (match_id, sequence, map_name, team1_rounds, team2_rounds, winner, status, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const game of oriented.games) {
            insert.run(link.match_id, game.sequence, game.mapName, game.team1Rounds, game.team2Rounds, game.winner, game.status, now);
        }
        writeGameStats(link, state, team1GridId, team2GridId, now);
        // 刚结束的地图记为群播报事件；关联后的首次轮询只作基线。
        if (!backfill) {
            captureMapResults(db, { matchId: link.match_id, previousGames, games: oriented.games,
                firstPoll: !link.last_polled_at, seriesFinished: oriented.finished, nowMs: Date.parse(now) });
        }
    });
    tx();
    return 'updated';
}

async function poll(nowMs = Date.now()) {
    const now = new Date(nowMs).toISOString();
    const outcome = { polled: 0, updated: 0, unlinked: 0, backfilled: 0, errors: [] };
    for (const games of gamesByToken().values()) {
        const byKey = new Map(games.map(game => [game.key, game]));
        const links = pollCandidates([...byKey.keys()], nowMs, stateBudget());
        let used = 0;
        let limited = false;
        for (const link of links) {
            const game = byKey.get(link.game_type);
            used++;
            try {
                const state = await fetchSeriesState(game, link.series_id);
                const result = applySeriesState(link, state, now);
                outcome.polled++;
                if (result === 'updated') outcome.updated++;
                if (result === 'unlinked') outcome.unlinked++;
            } catch (error) {
                // 该 token 被限流：本轮跳过它剩下的比赛，其他 token 照常
                if (error instanceof GridRateLimitError) {
                    outcome.errors.push(`${game.label}: ${error.message}`);
                    limited = true;
                    break;
                }
                db.prepare('UPDATE match_live_links SET last_polled_at = ?, last_error = ? WHERE match_id = ?')
                    .run(now, error.message.slice(0, 300), link.match_id);
                outcome.errors.push(`#${link.match_id}: ${error.message}`);
            }
        }
        if (!limited) await backfillStates(byKey, nowMs, stateBudget() - used, outcome);
    }
    stats.polled_last_tick = outcome.polled;
    stats.backfilled_last_tick = outcome.backfilled;
    return outcome;
}

// 用实时轮询剩下的额度补拉已结束比赛的详细数据（不产生群播报）
async function backfillStates(byKey, nowMs, remaining, outcome) {
    const now = new Date(nowMs).toISOString();
    for (const link of backfillStateCandidates([...byKey.keys()], nowMs, remaining)) {
        const game = byKey.get(link.game_type);
        try {
            const state = await fetchSeriesState(game, link.series_id);
            const result = applySeriesState(link, state, now, { backfill: true });
            if (result === 'unlinked') {
                // 历史比赛的队伍对不上：记为查不到，避免下次配对又把它关联回来
                db.prepare('INSERT OR IGNORE INTO grid_backfill_misses (match_id, checked_at) VALUES (?, ?)').run(link.match_id, now);
            } else {
                db.prepare('UPDATE match_live_links SET backfill_at = ? WHERE match_id = ?').run(now, link.match_id);
            }
            outcome.backfilled++;
        } catch (error) {
            if (error instanceof GridRateLimitError) {
                outcome.errors.push(`${game.label}: ${error.message}`);
                return;
            }
            db.prepare('UPDATE match_live_links SET backfill_at = ?, last_error = ? WHERE match_id = ?')
                .run(now, error.message.slice(0, 300), link.match_id);
            outcome.errors.push(`#${link.match_id}: ${error.message}`);
        }
    }
}

async function runGridLiveTick(mode = 'scheduled', options = {}) {
    if (!enabled()) return { status: 'disabled' };
    if (running) return { status: 'skipped', message: 'GRID 任务正在运行' };
    running = true;
    const nowMs = Date.now();
    const result = { status: 'success' };
    try {
        if (options.forceDiscovery || nowMs - lastDiscoveryAt >= discoveryIntervalMs()) {
            result.discovery = await discover(nowMs);
            // 配对失败不影响已关联比赛的轮询；1 分钟后重试，而不是等满整个配对间隔。
            if (result.discovery.error) lastDiscoveryAt = nowMs - discoveryIntervalMs() + MIN_DISCOVERY_INTERVAL_MS;
        }
        result.poll = await poll(nowMs);
        const errors = [result.discovery?.error, ...(result.poll.errors || [])].filter(Boolean);
        stats.last_error = errors.length ? errors.join('；').slice(0, 500) : null;
        if (errors.length) result.status = 'partial';
        if (errors.length && mode !== 'scheduled') console.warn('[GRID]', stats.last_error);
        return result;
    } catch (error) {
        stats.last_error = error.message;
        throw error;
    } finally {
        stats.last_tick_at = new Date().toISOString();
        running = false;
    }
}

// ===== 管理员手动关联 =====

function matchForLink(matchId) {
    return db.prepare(`
        SELECT ${MATCH_COLUMNS}, tour.game_type
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        WHERE m.id = ?
    `).get(matchId);
}

async function linkMatchToSeries(matchId, seriesId) {
    const match = matchForLink(matchId);
    if (!match) throw Object.assign(new Error('比赛不存在'), { status: 404 });
    const game = gridGame(match.game_type);
    if (!game) throw Object.assign(new Error(`${GAMES[match.game_type]?.label || match.game_type} 未配置 GRID token`), { status: 400 });
    const series = await fetchSeries(game, seriesId);
    if (!series) throw Object.assign(new Error('GRID series 不存在或无权访问'), { status: 404 });
    if (series.title?.id != null && Number(series.title.id) !== Number(game.titleId)) {
        throw Object.assign(new Error(`该 series 不是 ${game.label} 的比赛`), { status: 400 });
    }
    const other = db.prepare('SELECT match_id FROM match_live_links WHERE source = ? AND series_id = ? AND match_id != ?').get(SOURCE, String(series.id), match.id);
    if (other) throw Object.assign(new Error(`该 series 已关联到比赛 #${other.match_id}`), { status: 409 });
    // 管理员指定时不限制时间和相似度，只用名称相似度判断主客方向。
    const pick = pickSeriesForMatch(match, [series], { maxTimeDiffMs: Infinity, minScore: 0 });
    if (!pick) throw Object.assign(new Error('GRID series 缺少双方队伍信息'), { status: 400 });
    db.prepare('DELETE FROM match_games WHERE match_id = ?').run(match.id);
    insertLink(match, pick, 'manual', new Date().toISOString());
    return getLink(match.id);
}

// block=true：屏蔽该比赛的自动配对（例如自动配错且 GRID 上并无对应 series）。
function unlinkMatch(matchId, { block = false } = {}) {
    dropLink(matchId);
    if (block) {
        db.prepare(`INSERT INTO match_live_links (match_id, source, series_id, link_method, linked_at) VALUES (?, ?, NULL, 'none', ?)`)
            .run(matchId, SOURCE, new Date().toISOString());
    }
    return getLink(matchId);
}

function getLink(matchId) {
    return db.prepare('SELECT * FROM match_live_links WHERE match_id = ?').get(matchId) || null;
}

// ===== 读取：给比赛列表附加 live 字段 =====

function attachLiveScores(matches) {
    const ids = matches.map(match => match.id);
    if (!ids.length) return matches;
    const placeholders = ids.map(() => '?').join(',');
    const links = db.prepare(`SELECT * FROM match_live_links WHERE match_id IN (${placeholders}) AND series_id IS NOT NULL`).all(...ids);
    if (!links.length) return matches;
    const games = db.prepare(`SELECT * FROM match_games WHERE match_id IN (${placeholders}) ORDER BY sequence ASC`).all(...ids);
    const gamesByMatch = new Map();
    for (const game of games) {
        if (!gamesByMatch.has(game.match_id)) gamesByMatch.set(game.match_id, []);
        gamesByMatch.get(game.match_id).push(game);
    }
    const linkByMatch = new Map(links.map(link => [link.match_id, link]));
    const statsCount = new Map(db.prepare(`SELECT match_id, COUNT(*) n FROM match_game_stats WHERE match_id IN (${placeholders}) GROUP BY match_id`)
        .all(...ids).map(row => [row.match_id, row.n]));
    for (const match of matches) {
        const link = linkByMatch.get(match.id);
        if (!link) continue;
        const rows = gamesByMatch.get(match.id) || [];
        let veto = [];
        try { veto = JSON.parse(link.veto || '[]'); } catch { veto = []; }
        if (!link.started && !rows.length && !veto.length) continue;
        // 写入后 PandaScore 对调了主客队：按当前 team1/team2 翻转。
        const flip = link.team1_id != null && Number(link.team1_id) === Number(match.team2_id);
        const side = value => (flip ? { team1: 'team2', team2: 'team1' }[value] || null : value);
        match.live = {
            source: SOURCE,
            started: !!link.started,
            finished: !!link.finished,
            team1_score: flip ? link.team2_score : link.team1_score,
            team2_score: flip ? link.team1_score : link.team2_score,
            updated_at: link.state_updated_at || link.last_polled_at,
            // 有每局详细数据（选手 / LoL 经济与资源），详情接口 /api/matches/:id/details 可取
            has_stats: (statsCount.get(match.id) || 0) > 0,
            games: rows.map(game => ({
                sequence: game.sequence,
                map: game.map_name,
                team1_rounds: flip ? game.team2_rounds : game.team1_rounds,
                team2_rounds: flip ? game.team1_rounds : game.team2_rounds,
                status: game.status,
                winner: side(game.winner)
            })),
            veto: veto.map(entry => ({
                ...entry,
                team: side(entry.team),
                side: entry.side ? { ...entry.side, team: side(entry.side.team) } : undefined
            }))
        };
    }
    return matches;
}

// 一场比赛的每局详细数据，按当前 team1 / team2 方向返回（PandaScore 对调过主客队则翻转）。
function getGameStats(match) {
    const link = getLink(match.id);
    const rows = db.prepare('SELECT sequence, payload FROM match_game_stats WHERE match_id = ? ORDER BY sequence ASC').all(match.id);
    const flip = link?.team1_id != null && Number(link.team1_id) === Number(match.team2_id);
    return rows.map(row => {
        let stats;
        try { stats = JSON.parse(row.payload); } catch { return null; }
        return flip ? flipGameStats(stats) : stats;
    }).filter(Boolean);
}

// 历史补齐进度（管理接口 /api/admin/grid/status 展示）
function backfillStatus() {
    const days = backfillDays();
    if (!days) return { days: 0 };
    const nowMs = Date.now();
    const range = [new Date(nowMs - days * 86400000).toISOString(), new Date(nowMs - LOOKBACK_MS).toISOString()];
    const keys = gridGames().map(game => game.key);
    if (!keys.length) return { days };
    const inGames = `tour.game_type IN (${keys.map(() => '?').join(',')})`;
    const unlinked = db.prepare(`SELECT COUNT(*) n FROM matches m JOIN tournaments tour ON tour.id = m.tournament_id
        LEFT JOIN match_live_links l ON l.match_id = m.id LEFT JOIN grid_backfill_misses miss ON miss.match_id = m.id
        WHERE ${inGames} AND tour.is_active = 1 AND m.status = 'finished' AND l.match_id IS NULL AND miss.match_id IS NULL
        AND datetime(m.match_time) BETWEEN datetime(?) AND datetime(?)`).get(...keys, ...range).n;
    const statsPending = db.prepare(`SELECT COUNT(*) n FROM match_live_links l JOIN matches m ON m.id = l.match_id
        JOIN tournaments tour ON tour.id = m.tournament_id
        WHERE ${inGames} AND tour.is_active = 1 AND m.status = 'finished' AND l.series_id IS NOT NULL AND l.link_method != 'none'
        AND l.backfill_at IS NULL AND NOT EXISTS (SELECT 1 FROM match_game_stats s WHERE s.match_id = l.match_id)
        AND datetime(m.match_time) BETWEEN datetime(?) AND datetime(?)`).get(...keys, ...range).n;
    const withStats = db.prepare('SELECT COUNT(DISTINCT match_id) n FROM match_game_stats').get().n;
    return { days, unlinked_pending: unlinked, stats_pending: statsPending, matches_with_stats: withStats };
}

function gridLiveStatus() {
    const counts = db.prepare(`
        SELECT COUNT(*) total,
            SUM(CASE WHEN link_method = 'auto' THEN 1 ELSE 0 END) auto,
            SUM(CASE WHEN link_method = 'manual' THEN 1 ELSE 0 END) manual,
            SUM(CASE WHEN link_method = 'none' THEN 1 ELSE 0 END) blocked,
            SUM(CASE WHEN started = 1 AND finished = 0 THEN 1 ELSE 0 END) live
        FROM match_live_links WHERE source = ?
    `).get(SOURCE);
    return {
        enabled: enabled(),
        configured: gridGames().length > 0,
        games: gridGames().map(game => ({ key: game.key, title_id: game.titleId, token_env: game.tokenEnv })),
        running,
        interval_ms: intervalMs(),
        discovery_interval_ms: discoveryIntervalMs(),
        state_budget: stateBudget(),
        backfill: backfillStatus(),
        links: counts,
        ...stats
    };
}

function startGridLiveService() {
    if (!enabled()) {
        if (!gridGames().length) console.log('[GRID] 未配置任何游戏的 GRID token，实时比分关闭');
        return;
    }
    if (timer) return;
    const tick = () => runGridLiveTick('scheduled').catch(error => console.error('[GRID]', error.message));
    // 错开 PandaScore 启动同步，先让本地比赛入库再配对。
    setTimeout(tick, 30000).unref?.();
    timer = setInterval(tick, intervalMs());
    timer.unref?.();
    console.log(`[GRID] 实时比分已启用（${gridGames().map(game => game.label).join(' / ')}）：每 ${intervalMs() / 1000}s 轮询，配对间隔 ${discoveryIntervalMs() / 1000}s`);
}

module.exports = {
    runGridLiveTick,
    discover,
    poll,
    applySeriesState,
    attachLiveScores,
    getGameStats,
    linkMatchToSeries,
    unlinkMatch,
    getLink,
    gridLiveStatus,
    startGridLiveService
};
