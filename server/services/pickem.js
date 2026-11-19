// 赛事整体竞猜（Pick'em）：纯函数模块，无数据库依赖，结算口径全部由本地比赛结果推导。
//
// 两类阶段：
// - record（战绩门槛）：队伍达到 wins 胜晋级、losses 负淘汰。瑞士轮为 3/3，GSL 四队小组为 2/2。
//   竞猜项：全胜晋级（top）、全败出局（bottom）、晋级（advance，任意战绩晋级都算对）。每项 1 分。
// - elimination（淘汰赛，单败 / 双败通用）：冠军 3 分、亚军 2 分、其余四强每队 1 分。
//   名次按「每队在本阶段最后一场比赛的时间」推导，不需要识别具体赛制；阶段全部结束后才结算。
//
// 积分不落库：每次读取按当前赛果重算，赛果被修正后自动纠正（与单场竞猜的全量重建口径一致）。

const RECORD = 'record';
const ELIMINATION = 'elimination';
const ELIMINATION_POINTS = { champion: 3, runner_up: 2, semi: 1 };

// 硬币等级（参照 V 社 Major Pick'em：25 项竞猜里猜中 5 / 10 / 15 项升级银 / 金 / 钻石，参与即得铜币），
// 换算成积分达成率 20% / 40% / 60%，按赛事内全部 Pick'em 阶段的满分合计计算，赛制不同也能套用。
const COIN_TIERS = [
    { key: 'silver', label: '银币', rate: 0.2 },
    { key: 'gold', label: '金币', rate: 0.4 },
    { key: 'diamond', label: '钻石币', rate: 0.6 }
];

// 各等级的门槛分数（向上取整，至少 1 分）。
function coinThresholds(maxTotal) {
    return COIN_TIERS.map(tier => ({ ...tier, points: Math.max(1, Math.ceil(maxTotal * tier.rate)) }));
}

// 当前硬币与下一级差距。participated = false 时没有硬币。
function coinFor(points, maxTotal, participated = true) {
    if (!participated || !maxTotal) return null;
    const thresholds = coinThresholds(maxTotal);
    let coin = { key: 'bronze', label: '铜币', points: 0 };
    for (const tier of thresholds) if (points >= tier.points) coin = tier;
    const next = thresholds.find(tier => points < tier.points) || null;
    return { key: coin.key, label: coin.label, next: next ? { key: next.key, label: next.label, need: next.points - points } : null };
}

const SWISS_RE = /swiss|瑞士/i;
const GROUP_RE = /group|小组/i;
const ELIMINATION_RE = /playoff|knockout|bracket|final|淘汰赛|季后赛|决赛/i;
const THIRD_PLACE_RE = /3rd|third|bronze|季军/i;

function timeOf(match) {
    const time = Date.parse(match.match_time);
    return Number.isNaN(time) ? 0 : time;
}

// 胜者：winner_team_id 为准，缺失时按比分判断；未结束或无法判断返回 null。
function matchWinner(match) {
    if (match.status !== 'finished') return null;
    const winner = Number(match.winner_team_id);
    if (winner && (winner === Number(match.team1_id) || winner === Number(match.team2_id))) return winner;
    const s1 = Number(match.team1_score);
    const s2 = Number(match.team2_score);
    if (match.team1_score == null || match.team2_score == null || s1 === s2) return null;
    return s1 > s2 ? Number(match.team1_id) : Number(match.team2_id);
}

function matchLoser(match) {
    const winner = matchWinner(match);
    if (!winner) return null;
    return winner === Number(match.team1_id) ? Number(match.team2_id) : Number(match.team1_id);
}

// 参与本阶段的比赛：取消（非弃权）的比赛不计。
function activeMatches(matches) {
    return (matches || []).filter(match => match.status !== 'cancelled');
}

// 未定对阵的占位队伍（PandaScore 同步写入的 TBD，external_id 为 <game>:__tbd__）：不是参赛队，不可竞猜。
function isPlaceholderSide(match, side) {
    return String(match[`${side}_external_id`] || '').endsWith('__tbd__')
        || String(match[`${side}_name`] || '').trim().toUpperCase() === 'TBD';
}

function hasPlaceholder(match) {
    return isPlaceholderSide(match, 'team1') || isPlaceholderSide(match, 'team2');
}

// 比赛名里的轮次（"Round 3: A vs B" → 3）；"Round of 16" 不算。
function roundOf(match) {
    const found = String(match.name || '').match(/\bround\s*(\d+)\b/i);
    return found ? Number(found[1]) : null;
}

function stageTeams(matches) {
    const teams = new Map();
    for (const match of activeMatches(matches)) {
        for (const side of ['team1', 'team2']) {
            const id = Number(match[`${side}_id`]);
            if (!id || teams.has(id) || isPlaceholderSide(match, side)) continue;
            teams.set(id, {
                id,
                name: match[`${side}_name`] || '',
                short_name: match[`${side}_short_name`] || null,
                logo_url: match[`${side}_logo_url`] || null,
                dark_logo_url: match[`${side}_dark_logo_url`] || null
            });
        }
    }
    return teams;
}

// 标准对称门槛下的名额：全胜 = N / 2^W，晋级共 N / 2 队（其余晋级 = N/2 - 全胜）。
function recordCounts(teamCount, wins) {
    if (!Number.isInteger(teamCount) || teamCount < 4 || teamCount % 2) return null;
    const perfect = teamCount / 2 ** wins;
    if (!Number.isInteger(perfect) || perfect < 1) return null;
    const advance = teamCount / 2 - perfect;
    if (advance < 1) return null;
    return { top_count: perfect, bottom_count: perfect, advance_count: advance };
}

function recordConfig(teamCount, wins) {
    const counts = recordCounts(teamCount, wins);
    return counts ? { kind: RECORD, wins, losses: wins, ...counts } : null;
}

function eliminationConfig(teamCount) {
    if (!Number.isInteger(teamCount) || teamCount < 3) return null;
    return { kind: ELIMINATION, semi_count: Math.min(2, teamCount - 2) };
}

// 瑞士轮结构：比赛按 "Round N" 命名、至少两轮，且总场数接近队数的两倍（16 队 33 场）；
// 循环赛场数远多于此（8 队单循环 28 场），不会命中。用于名称里没有 "Swiss" 的阶段
// （如 Major 的 "Stage 1"、PGL 的 "Group Stage"）。
function looksLikeSwiss(list, teamCount) {
    const rounds = new Set(list.map(roundOf).filter(Boolean));
    return rounds.size >= 2 && teamCount >= 8 && list.length <= teamCount * 2.25;
}

// 首轮：按 "Round N" 取最小轮次；没有轮次名时取首场开赛后 12 小时内的比赛。
function firstRound(list) {
    const rounds = list.map(roundOf).filter(Boolean);
    if (rounds.length) {
        const min = Math.min(...rounds);
        return list.filter(match => roundOf(match) === min);
    }
    const start = Math.min(...list.map(timeOf));
    return list.filter(match => timeOf(match) - start <= 12 * 3600000);
}

// 自动识别：按阶段名称 + 赛程结构 + 参赛队数。返回 { config, reason }：
// config 为 null 时 reason 说明原因（识别不了的循环赛 / 积分赛，或首轮对阵还没定）。
function detectStageInfo(stageName, matches) {
    const name = String(stageName || '');
    const list = activeMatches(matches);
    const teamCount = stageTeams(list).size;
    if (!list.length) return { config: null, reason: '暂无比赛' };
    if (!teamCount) return { config: null, reason: '对阵未定' };
    const opening = firstRound(list);
    // 首轮全部对阵已定，且参赛队恰好都在首轮出现：名单完整才开放
    const openingReady = opening.length > 0 && !opening.some(hasPlaceholder);
    let config = null;
    if (!ELIMINATION_RE.test(name) && (SWISS_RE.test(name) || looksLikeSwiss(list, teamCount))) {
        if (!openingReady || teamCount !== opening.length * 2) return { config: null, reason: '瑞士轮首轮对阵未定' };
        config = recordConfig(teamCount, teamCount >= 12 ? 3 : 2);
    } else if (GROUP_RE.test(name) && teamCount === 4 && list.length <= 5) {
        // GSL 四队小组：开局两场 + 胜者局 + 败者局 + 决胜局，最多 5 场；单循环 4 队为 6 场，不会命中。
        config = recordConfig(4, 2);
    } else if (ELIMINATION_RE.test(name)) {
        if (!openingReady) return { config: null, reason: '淘汰赛首轮对阵未定' };
        config = eliminationConfig(teamCount);
    } else {
        return { config: null, reason: '赛制无法识别（如循环赛）' };
    }
    return config ? { config, reason: null } : { config: null, reason: `${teamCount} 队无法套用标准名额` };
}

function detectStage(stageName, matches) {
    return detectStageInfo(stageName, matches).config;
}

// 管理员覆盖：mode = auto（用自动识别）/ off（关闭）/ record / elimination（手动参数）。
function resolveConfig(detected, override, teamCount) {
    const mode = override?.mode || 'auto';
    if (mode === 'off') return null;
    if (mode === 'auto') return detected;
    const params = override.config || {};
    if (mode === ELIMINATION) return eliminationConfig(teamCount) || { kind: ELIMINATION, semi_count: 0 };
    if (mode === RECORD) {
        const config = {
            kind: RECORD,
            wins: Number(params.wins),
            losses: Number(params.losses),
            top_count: Number(params.top_count),
            bottom_count: Number(params.bottom_count),
            advance_count: Number(params.advance_count)
        };
        return validateRecordConfig(config) ? null : config;
    }
    return null;
}

// 返回错误信息；合法返回 null。
function validateRecordConfig(config) {
    const { wins, losses, top_count: top, bottom_count: bottom, advance_count: advance } = config;
    if (![wins, losses].every(value => Number.isInteger(value) && value >= 1 && value <= 5)) return '晋级 / 淘汰门槛须为 1–5 的整数';
    if (![top, bottom, advance].every(value => Number.isInteger(value) && value >= 0 && value <= 16)) return '名额须为 0–16 的整数';
    if (top + bottom + advance < 1) return '至少需要一个竞猜名额';
    return null;
}

function maxPoints(config) {
    if (!config) return 0;
    if (config.kind === RECORD) return config.top_count + config.bottom_count + config.advance_count;
    return ELIMINATION_POINTS.champion + ELIMINATION_POINTS.runner_up + config.semi_count * ELIMINATION_POINTS.semi;
}

// 首场比赛开赛即锁定；任一比赛已开始（状态不再是 upcoming）也锁定。
function lockInfo(matches, now = Date.now()) {
    const list = activeMatches(matches);
    if (!list.length) return { lock_at: null, locked: true };
    const first = list.reduce((min, match) => (timeOf(match) < timeOf(min) ? match : min), list[0]);
    const started = list.some(match => match.status !== 'upcoming' && match.status !== 'postponed');
    return { lock_at: first.match_time, locked: started || timeOf(first) <= now };
}

// ---------- 战绩门槛阶段 ----------

function teamRecords(matches) {
    const records = new Map();
    const entry = id => {
        if (!records.has(id)) records.set(id, { wins: 0, losses: 0 });
        return records.get(id);
    };
    for (const match of activeMatches(matches)) {
        entry(Number(match.team1_id));
        entry(Number(match.team2_id));
        const winner = matchWinner(match);
        if (!winner) continue;
        entry(winner).wins += 1;
        entry(matchLoser(match)).losses += 1;
    }
    return records;
}

function recordStatus(config, record) {
    if (!record) return 'alive';
    if (record.wins >= config.wins) return 'advanced';
    if (record.losses >= config.losses) return 'eliminated';
    return 'alive';
}

function recordPickResult(slot, config, record) {
    const status = recordStatus(config, record);
    const wins = record?.wins || 0;
    const losses = record?.losses || 0;
    if (slot === 'top') {
        if (losses > 0) return 'wrong';
        return status === 'advanced' ? 'correct' : 'pending';
    }
    if (slot === 'bottom') {
        if (wins > 0) return 'wrong';
        return status === 'eliminated' ? 'correct' : 'pending';
    }
    if (status === 'advanced') return 'correct';
    return status === 'eliminated' ? 'wrong' : 'pending';
}

function scoreRecordPicks(config, picks, records) {
    const items = [];
    for (const slot of ['top', 'bottom', 'advance']) {
        for (const teamId of picks?.[slot] || []) {
            const result = recordPickResult(slot, config, records.get(Number(teamId)));
            items.push({ slot, team_id: Number(teamId), result, points: result === 'correct' ? 1 : 0 });
        }
    }
    return summarize(items, maxPoints(config));
}

// ---------- 淘汰阶段 ----------

function eliminationOutcome(matches) {
    const list = activeMatches(matches);
    const finished = list.filter(match => matchWinner(match));
    const complete = finished.length > 0 && list.every(match => match.status === 'finished' && matchWinner(match));
    if (!complete) return { complete: false, champion: null, runner_up: null, top4: [] };
    const byTimeDesc = (a, b) => timeOf(b) - timeOf(a) || Number(b.id || 0) - Number(a.id || 0);
    const final = [...finished].sort(byTimeDesc).find(match => !THIRD_PLACE_RE.test(String(match.name || ''))) || finished.sort(byTimeDesc)[0];
    const lastSeen = new Map();
    for (const match of finished) {
        for (const id of [Number(match.team1_id), Number(match.team2_id)]) {
            lastSeen.set(id, Math.max(lastSeen.get(id) ?? -Infinity, timeOf(match)));
        }
    }
    const champion = matchWinner(final);
    const runnerUp = matchLoser(final);
    const others = [...lastSeen.entries()]
        .filter(([id]) => id !== champion && id !== runnerUp)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([id]) => id);
    return { complete: true, champion, runner_up: runnerUp, top4: [champion, runnerUp, ...others] };
}

function scoreEliminationPicks(config, picks, outcome) {
    const items = [];
    const resolve = correct => (outcome.complete ? (correct ? 'correct' : 'wrong') : 'pending');
    if (picks?.champion) {
        const result = resolve(Number(picks.champion) === outcome.champion);
        items.push({ slot: 'champion', team_id: Number(picks.champion), result, points: result === 'correct' ? ELIMINATION_POINTS.champion : 0 });
    }
    if (picks?.runner_up) {
        const result = resolve(Number(picks.runner_up) === outcome.runner_up);
        items.push({ slot: 'runner_up', team_id: Number(picks.runner_up), result, points: result === 'correct' ? ELIMINATION_POINTS.runner_up : 0 });
    }
    for (const teamId of picks?.semis || []) {
        const result = resolve(outcome.top4.includes(Number(teamId)));
        items.push({ slot: 'semi', team_id: Number(teamId), result, points: result === 'correct' ? ELIMINATION_POINTS.semi : 0 });
    }
    return summarize(items, maxPoints(config));
}

function summarize(items, max) {
    return {
        items,
        points: items.reduce((sum, item) => sum + item.points, 0),
        correct: items.filter(item => item.result === 'correct').length,
        decided: items.filter(item => item.result !== 'pending').length,
        max
    };
}

// 统一入口：按阶段类型结算一份竞猜。context 由 stageContext 预先计算，避免逐用户重复推导。
function stageContext(config, matches) {
    if (!config) return null;
    return config.kind === RECORD
        ? { config, records: teamRecords(matches) }
        : { config, outcome: eliminationOutcome(matches) };
}

function scorePicks(context, picks) {
    if (!context) return summarize([], 0);
    return context.config.kind === RECORD
        ? scoreRecordPicks(context.config, picks, context.records)
        : scoreEliminationPicks(context.config, picks, context.outcome);
}

// ---------- 提交校验 ----------

class PickemValidationError extends Error {}

function teamIdList(value, label) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new PickemValidationError(`${label}格式错误`);
    return value.map(item => {
        const id = Number(item);
        if (!Number.isSafeInteger(id) || id <= 0) throw new PickemValidationError(`${label}包含无效队伍`);
        return id;
    });
}

function optionalTeamId(value, label) {
    if (value == null || value === '') return null;
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new PickemValidationError(`${label}无效`);
    return id;
}

// 返回规范化后的竞猜；允许只填一部分（未填的名额不得分），但不得超额、重复或选择本阶段以外的队伍。
function normalizePicks(config, raw, teamIds) {
    const allowed = new Set([...teamIds].map(Number));
    let picks;
    let all;
    if (config.kind === RECORD) {
        picks = {
            top: teamIdList(raw?.top, '全胜晋级'),
            bottom: teamIdList(raw?.bottom, '全败出局'),
            advance: teamIdList(raw?.advance, '晋级')
        };
        if (picks.top.length > config.top_count) throw new PickemValidationError(`全胜晋级最多选 ${config.top_count} 队`);
        if (picks.bottom.length > config.bottom_count) throw new PickemValidationError(`全败出局最多选 ${config.bottom_count} 队`);
        if (picks.advance.length > config.advance_count) throw new PickemValidationError(`晋级最多选 ${config.advance_count} 队`);
        all = [...picks.top, ...picks.bottom, ...picks.advance];
    } else {
        picks = {
            champion: optionalTeamId(raw?.champion, '冠军'),
            runner_up: optionalTeamId(raw?.runner_up, '亚军'),
            semis: teamIdList(raw?.semis, '四强')
        };
        if (picks.semis.length > config.semi_count) throw new PickemValidationError(`四强最多选 ${config.semi_count} 队`);
        all = [picks.champion, picks.runner_up, ...picks.semis].filter(Boolean);
    }
    if (!all.length) throw new PickemValidationError('请至少选择一支队伍');
    if (new Set(all).size !== all.length) throw new PickemValidationError('同一支队伍只能选一次');
    if (all.some(id => !allowed.has(id))) throw new PickemValidationError('只能选择本阶段的参赛队伍');
    return picks;
}

module.exports = {
    RECORD,
    ELIMINATION,
    ELIMINATION_POINTS,
    COIN_TIERS,
    coinThresholds,
    coinFor,
    PickemValidationError,
    matchWinner,
    stageTeams,
    recordCounts,
    detectStage,
    detectStageInfo,
    isPlaceholderSide,
    resolveConfig,
    validateRecordConfig,
    maxPoints,
    lockInfo,
    teamRecords,
    recordStatus,
    eliminationOutcome,
    stageContext,
    scorePicks,
    normalizePicks
};
