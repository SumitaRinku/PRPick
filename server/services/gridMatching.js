// GRID 与本地（PandaScore）比赛的对应关系：纯函数，便于单测。
// 两个数据源没有互通 ID，只能按「双方队名 + 开赛时间」配对。

// 只影响写法、不影响身份的通用词；"academy"/"junior" 等代表不同阵容，不能去掉。
// 冠名赞助商也算（GRID 常带赞助商全名：Team Liquid Alienware、Cloud9 Kia）。
const NOISE_TOKENS = new Set(['team', 'esports', 'esport', 'gaming', 'clan', 'gg', 'alienware', 'kia']);

// 常见缩写 ↔ 全称：归一化后整体替换（键值都是归一化后的形式）。
const ALIASES = new Map([
    ['navi', 'natusvincere'],
    ['vp', 'virtuspro'],
    ['faze', 'fazeclan'],
    ['mibr', 'makingitbr'],
    ['nip', 'ninjasinpyjamas'],
    ['col', 'complexity'],
    ['big', 'berlininternationalgaming'],
    // LoL：GRID 有时把 Gaming 连写（WeiboGaming）
    ['weibogaming', 'weibo']
]);

// 代表「另一套阵容」的词：两边这类词不一致时绝不配对（Phantom ≠ Phantom Academy、MOUZ ≠ MOUZ NXT）。
// blue：LoL 二队（Karmine Corp Blue）。
const ROSTER_TOKENS = new Set(['academy', 'junior', 'juniors', 'jr', 'youth', 'young', 'youngsters', 'nxt', 'next', 'ares', 'reload', 'fe', 'female', 'fem', 'women', 'ladies', 'u21', 'u19', 'u18', 'blue']);

const MIN_TEAM_SIMILARITY = 0.8;
const DEFAULT_MAX_TIME_DIFF_MS = 4 * 60 * 60 * 1000;

function tokenize(value) {
    if (!value) return [];
    return String(value)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(token => token && !NOISE_TOKENS.has(token));
}

function normalizeTeamName(value) {
    return tokenize(value).map(token => ALIASES.get(token) || token).join('');
}

function rosterTag(value) {
    return tokenize(value).filter(token => ROSTER_TOKENS.has(token)).sort().join(' ');
}

function bigrams(value) {
    const grams = new Map();
    for (let i = 0; i < value.length - 1; i++) {
        const gram = value.slice(i, i + 2);
        grams.set(gram, (grams.get(gram) || 0) + 1);
    }
    return grams;
}

function dice(a, b) {
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    const left = bigrams(a);
    const right = bigrams(b);
    let overlap = 0;
    for (const [gram, count] of left) overlap += Math.min(count, right.get(gram) || 0);
    return (2 * overlap) / (a.length - 1 + b.length - 1);
}

function variants(names) {
    const seen = new Map();
    for (const name of names) {
        const key = normalizeTeamName(name);
        if (key && !seen.has(key)) seen.set(key, { key, roster: rosterTag(name) });
    }
    return [...seen.values()];
}

// 0~1：完全相同 1；一方包含另一方（如 "Four Magic" ⊂ "Four Magic Gaming"）0.9；否则 bigram Dice。
// 阵容标记（academy / junior / nxt…）不同的名字直接视为不同队伍。
function teamSimilarity(localNames, gridNames) {
    let best = 0;
    for (const { key: a, roster: rosterA } of variants(localNames)) {
        for (const { key: b, roster: rosterB } of variants(gridNames)) {
            if (rosterA !== rosterB) continue;
            if (a === b) return 1;
            const [short, long] = a.length <= b.length ? [a, b] : [b, a];
            if (short.length >= 4 && long.includes(short) && short.length / long.length >= 0.5) best = Math.max(best, 0.9);
            best = Math.max(best, dice(a, b));
        }
    }
    return best;
}

function gridTeamNames(team) {
    const info = team?.baseInfo || team || {};
    return [info.name, info.nameShortened];
}

/**
 * 为一场本地比赛挑选最匹配的 GRID series。
 * match: { team1_name, team1_short_name, team2_name, team2_short_name, match_time }
 * series: GRID allSeries 节点数组 { id, startTimeScheduled, teams: [{ baseInfo: { id, name, nameShortened } }] }
 * 返回 { series, score, timeDiffMs, team1GridId, team2GridId } 或 null。
 */
function pickSeriesForMatch(match, series, options = {}) {
    const maxTimeDiffMs = options.maxTimeDiffMs ?? DEFAULT_MAX_TIME_DIFF_MS;
    const minScore = options.minScore ?? MIN_TEAM_SIMILARITY;
    const exclude = options.excludeSeriesIds || new Set();
    const matchTime = new Date(match.match_time).getTime();
    const local1 = [match.team1_name, match.team1_short_name];
    const local2 = [match.team2_name, match.team2_short_name];
    let best = null;

    for (const candidate of series) {
        if (!candidate || exclude.has(String(candidate.id))) continue;
        const teams = Array.isArray(candidate.teams) ? candidate.teams : [];
        if (teams.length !== 2) continue;
        const timeDiffMs = Math.abs(new Date(candidate.startTimeScheduled).getTime() - matchTime);
        if (!Number.isFinite(timeDiffMs) || timeDiffMs > maxTimeDiffMs) continue;

        const [g1, g2] = teams.map(gridTeamNames);
        const straight = Math.min(teamSimilarity(local1, g1), teamSimilarity(local2, g2));
        const swapped = Math.min(teamSimilarity(local1, g2), teamSimilarity(local2, g1));
        const score = Math.max(straight, swapped);
        if (score < minScore) continue;

        const ids = teams.map(team => String(team?.baseInfo?.id ?? team?.id));
        const result = {
            series: candidate,
            score,
            timeDiffMs,
            team1GridId: straight >= swapped ? ids[0] : ids[1],
            team2GridId: straight >= swapped ? ids[1] : ids[0]
        };
        // 名称更像的优先；同分时选开赛时间更接近的（同一对手一天内可能交手两次）。
        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && timeDiffMs < best.timeDiffMs)) {
            best = result;
        }
    }
    return best;
}

function gameStatus(game) {
    if (game?.finished) return 'finished';
    if (game?.started) return 'ongoing';
    return 'upcoming';
}

const SIDE_NAMES = { 'counter-terrorists': 'ct', 'terrorists': 't' };

/**
 * GRID draftActions → BP 流程（以本地 team1/team2 为方向）。
 * 地图动作：ban / pick（队伍选图）/ decider（drafter 为 series，即剩下的决胜图）。
 * 选边动作不单独成行，而是挂到它之前最近一张选出的地图上：{ team, side: 'ct' | 't' }。
 */
function orientVeto(actions, team1GridId, team2GridId) {
    const sideOf = id => (String(id) === String(team1GridId) ? 'team1' : String(id) === String(team2GridId) ? 'team2' : null);
    const veto = [];
    const sorted = (Array.isArray(actions) ? actions : [])
        .filter(action => action?.draftable?.name)
        .sort((a, b) => Number(a.sequenceNumber) - Number(b.sequenceNumber));
    for (const action of sorted) {
        const name = String(action.draftable.name).toLowerCase();
        const team = action.drafter?.type === 'team' ? sideOf(action.drafter.id) : null;
        if (action.draftable.type === 'side' || SIDE_NAMES[name]) {
            const target = [...veto].reverse().find(entry => entry.type !== 'ban' && !entry.side);
            if (target && SIDE_NAMES[name]) target.side = { team, side: SIDE_NAMES[name] };
            continue;
        }
        const type = action.type === 'ban' ? 'ban' : team ? 'pick' : 'decider';
        veto.push({ sequence: veto.length + 1, type, map: name.replace(/^de_/, ''), team });
    }
    return veto;
}

/**
 * 把 GRID seriesState 转成以本地 team1/team2 为方向的结构。
 * 返回 { started, finished, team1Score, team2Score, updatedAt, games: [...] }；
 * 若 GRID 的队伍 id 与已知映射对不上，返回 null（调用方应解除关联重新配对）。
 */
function orientSeriesState(state, team1GridId, team2GridId) {
    if (!state) return null;
    const teams = Array.isArray(state.teams) ? state.teams : [];
    const byId = new Map(teams.map(team => [String(team.id), team]));
    if (teams.length && (!byId.has(String(team1GridId)) || !byId.has(String(team2GridId)))) return null;
    const t1 = byId.get(String(team1GridId));
    const t2 = byId.get(String(team2GridId));

    const games = (Array.isArray(state.games) ? state.games : [])
        .filter(game => game && (game.started || game.finished))
        .map(game => {
            const gameTeams = new Map((game.teams || []).map(team => [String(team.id), team]));
            const g1 = gameTeams.get(String(team1GridId));
            const g2 = gameTeams.get(String(team2GridId));
            const status = gameStatus(game);
            let winner = null;
            if (status === 'finished') {
                if (g1?.won) winner = 'team1';
                else if (g2?.won) winner = 'team2';
            }
            return {
                sequence: Number(game.sequenceNumber),
                mapName: game.map?.name || null,
                team1Rounds: Number.isFinite(g1?.score) ? g1.score : null,
                team2Rounds: Number.isFinite(g2?.score) ? g2.score : null,
                status,
                winner
            };
        })
        .filter(game => Number.isInteger(game.sequence))
        .sort((a, b) => a.sequence - b.sequence);

    return {
        started: !!state.started,
        finished: !!state.finished,
        team1Score: Number.isFinite(t1?.score) ? t1.score : null,
        team2Score: Number.isFinite(t2?.score) ? t2.score : null,
        updatedAt: state.updatedAt || null,
        games,
        veto: orientVeto(state.draftActions, team1GridId, team2GridId)
    };
}

module.exports = {
    normalizeTeamName,
    teamSimilarity,
    pickSeriesForMatch,
    orientSeriesState,
    orientVeto,
    MIN_TEAM_SIMILARITY
};
