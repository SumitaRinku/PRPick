// GRID 单局（单图）详细数据 → 本站存储格式：纯函数，便于单测。
//
// 输出以本地 team1 / team2 为方向（与 match_games 一致），读取时若 PandaScore 之后对调了主客队，
// 由 flipGameStats 翻转。每个游戏一种结构，字段都已换成展示 / 统计直接可用的口径：
//   LoL：每局 BP、红蓝方、队伍汇总（击杀 / 经济 / 推塔 / 各类龙 / 大龙 / 先锋 / 虚空幼虫…）、选手明细
//   CS2 / Valorant：每图选手 K/D/A、伤害、ADR、爆头率（Valorant 另有英雄）
// 数据仅用于展示与统计，不参与结算。
const STATS_VERSION = 1;

const num = value => (Number.isFinite(value) ? value : null);
const round1 = value => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

// ISO 8601 时长（PT30M21.243S）→ 秒
function durationSeconds(value) {
    const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(String(value || ''));
    if (!match) return null;
    const [, d, h, m, s] = match.map(part => Number(part) || 0);
    return Math.round(d * 86400 + h * 3600 + m * 60 + s);
}

function objectiveCounts(objectives) {
    const counts = {};
    for (const objective of Array.isArray(objectives) ? objectives : []) {
        if (objective?.type) counts[objective.type] = (counts[objective.type] || 0) + (Number(objective.completionCount) || 0);
    }
    return counts;
}


// slayInfernalDrake → infernal；元素龙不含远古龙（单独计 elders）
function dragonTypes(counts) {
    const types = {};
    for (const [type, count] of Object.entries(counts)) {
        const match = /^slay(\w+)Drake$/.exec(type);
        if (match && count) types[match[1].toLowerCase()] = count;
    }
    return types;
}

function unitCount(unitKills, name) {
    const row = (Array.isArray(unitKills) ? unitKills : []).find(unit => unit?.unitName === name);
    return row ? Number(row.count) || 0 : 0;
}

function lolPlayer(player) {
    const counts = objectiveCounts(player.objectives);
    const laneCs = unitCount(player.unitKills, 'minion');
    const jungleCs = unitCount(player.unitKills, 'neutralMinion');
    return {
        name: player.name || null,
        champion: player.character?.name || null,
        kills: num(player.kills),
        deaths: num(player.deaths),
        assists: num(player.killAssistsGiven),
        cs: laneCs + jungleCs,
        lane_cs: laneCs,
        jungle_cs: jungleCs,
        wards_killed: unitCount(player.unitKills, 'ward'),
        gold: num(player.totalMoneyEarned) ?? num(player.netWorth),
        damage: num(player.damageDealt),
        damage_share: round1(player.damagePercentage),
        kill_participation: round1(player.killParticipation),
        vision: round1(player.visionScore),
        // 初始 1 级，每次升级一条 increaseLevel
        level: counts.increaseLevel ? counts.increaseLevel + 1 : null,
        items: (player.inventory?.items || []).map(item => item?.name).filter(Boolean)
    };
}

function lolTeam(team) {
    const counts = objectiveCounts(team.objectives);
    return {
        side: team.side || null,
        kills: num(team.kills),
        deaths: num(team.deaths),
        assists: num(team.killAssistsGiven),
        gold: num(team.totalMoneyEarned) ?? num(team.netWorth),
        gold_diff: num(team.moneyDifference),
        damage: num(team.damageDealt),
        vision: round1(team.visionScore),
        towers: counts.destroyTower || 0,
        inhibitors: counts.destroyFortifier || 0,
        // 不存镀层：GRID 的 destroyTurretPlate{Top,Mid,Bot}{1,2,3} 计数口径不明（实测一局能到 40），宁缺毋错
        dragons: Object.values(dragonTypes(counts)).reduce((a, b) => a + b, 0),
        dragon_types: dragonTypes(counts),
        elders: counts.slayElderDragon || 0,
        barons: counts.slayBaron || 0,
        heralds: counts.slayRiftHerald || 0,
        grubs: counts.slayVoidGrub || 0
    };
}

// 爆头率只给 CS2：Valorant 的 headshots 是爆头命中次数（实测有人爆头数大于击杀数），不能除以击杀。
function shooterPlayer(player, totalRounds, withAgent, withHeadshots) {
    const kills = num(player.kills);
    const damage = num(player.damageDealt);
    const headshots = withHeadshots ? num(player.headshots) : null;
    return {
        name: player.name || null,
        ...(withAgent ? { agent: player.character?.name || null } : {}),
        kills,
        deaths: num(player.deaths),
        assists: num(player.killAssistsGiven),
        damage,
        adr: damage != null && totalRounds > 0 ? round1(damage / totalRounds) : null,
        hs_pct: headshots != null && kills > 0 ? round1((headshots / kills) * 100) : null
    };
}

function shooterTeam(team) {
    return { side: team.side || null, rounds: num(team.score), kills: num(team.kills), deaths: num(team.deaths) };
}

// 每局 BP（LoL 选手 / 英雄 ban-pick）。drafter 不是两队之一的动作忽略。
function lolDraft(actions, sideOf) {
    return (Array.isArray(actions) ? actions : [])
        .filter(action => action?.draftable?.type === 'character' && action.draftable.name && ['ban', 'pick'].includes(action.type))
        .map(action => ({ sequence: Number(action.sequenceNumber), type: action.type, team: sideOf(action.drafter?.id), champion: action.draftable.name }))
        .filter(action => action.team && Number.isInteger(action.sequence))
        .sort((a, b) => a.sequence - b.sequence);
}

/**
 * GRID seriesState 里的一局 → 本站详细数据；未开始或缺少队伍时返回 null。
 * gameType：本地游戏 key（cs2 / valorant / lol）。
 */
function normalizeGameStats(gameType, game, team1GridId, team2GridId) {
    if (!game || !(game.started || game.finished)) return null;
    const teams = new Map((game.teams || []).map(team => [String(team.id), team]));
    const t1 = teams.get(String(team1GridId));
    const t2 = teams.get(String(team2GridId));
    if (!t1 || !t2) return null;
    const sideOf = id => (String(id) === String(team1GridId) ? 'team1' : String(id) === String(team2GridId) ? 'team2' : null);
    const base = {
        v: STATS_VERSION,
        game: gameType,
        sequence: Number(game.sequenceNumber),
        status: game.finished ? 'finished' : 'ongoing',
        winner: game.finished ? (t1.won ? 'team1' : t2.won ? 'team2' : null) : null,
        map: game.map?.name || null,
        duration_s: durationSeconds(game.duration)
    };
    if (gameType === 'lol') {
        return {
            ...base,
            draft: lolDraft(game.draftActions, sideOf),
            teams: { team1: lolTeam(t1), team2: lolTeam(t2) },
            players: { team1: (t1.players || []).map(lolPlayer), team2: (t2.players || []).map(lolPlayer) }
        };
    }
    const totalRounds = (num(t1.score) || 0) + (num(t2.score) || 0);
    const withAgent = gameType === 'valorant';
    return {
        ...base,
        teams: { team1: shooterTeam(t1), team2: shooterTeam(t2) },
        players: {
            team1: (t1.players || []).map(player => shooterPlayer(player, totalRounds, withAgent, gameType === 'cs2')),
            team2: (t2.players || []).map(player => shooterPlayer(player, totalRounds, withAgent, gameType === 'cs2'))
        }
    };
}

// PandaScore 之后对调了主客队：把以旧 team1 为方向的数据翻转到当前方向。
function flipGameStats(stats) {
    if (!stats) return stats;
    const swap = value => ({ team1: 'team2', team2: 'team1' }[value] || value);
    const pair = obj => (obj ? { team1: obj.team2, team2: obj.team1 } : obj);
    // 各队字段（含 gold_diff：该队相对对手的经济差）本身就以该队为视角，整体对调即可
    const flipped = { ...stats, winner: swap(stats.winner), teams: pair(stats.teams), players: pair(stats.players) };
    if (Array.isArray(stats.draft)) flipped.draft = stats.draft.map(action => ({ ...action, team: swap(action.team) }));
    return flipped;
}

module.exports = { normalizeGameStats, flipGameStats, durationSeconds, STATS_VERSION };
