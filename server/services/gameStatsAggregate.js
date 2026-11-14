// 赛事数据统计：把一项赛事内所有已结束对局的详细数据（match_game_stats）汇总成队伍 / 选手 / 英雄榜。纯函数。
//
// rows：[{ match_id, team1: { id, name, short_name, logo_url }, team2: {...}, stats }]，
// stats 已按本场比赛当前的 team1 / team2 方向（见 gridStats.flipGameStats）。
// 只统计 status = finished 的对局；平均值都按「局（图）」计算。

const round = (value, digits = 1) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);
const ratio = (a, b, digits = 1) => (b > 0 ? round(a / b, digits) : null);

function teamInfo(team) {
    return { id: team.id, name: team.name, short_name: team.short_name || null, logo_url: team.logo_url || null };
}

// 选手按「名字 + 队伍」区分：同名不同队视为不同人，赛事内转会的少见情况会拆成两行。
const playerKey = (teamId, name) => `${teamId}:${String(name || '').toLowerCase()}`;

function lolAggregate(rows) {
    const teams = new Map();
    const players = new Map();
    const champions = new Map();
    let games = 0;

    const champion = name => {
        if (!champions.has(name)) champions.set(name, { name, picks: 0, wins: 0, bans: 0 });
        return champions.get(name);
    };

    for (const row of rows) {
        const stats = row.stats;
        if (!stats || stats.status !== 'finished' || !stats.teams) continue;
        games++;
        const minutes = stats.duration_s ? stats.duration_s / 60 : null;
        for (const side of ['team1', 'team2']) {
            const local = row[side];
            const team = stats.teams[side] || {};
            const won = stats.winner === side;
            if (!teams.has(local.id)) {
                teams.set(local.id, { ...teamInfo(local), games: 0, wins: 0, duration_s: 0, kills: 0, deaths: 0, gold_diff: 0,
                    towers: 0, dragons: 0, barons: 0, heralds: 0, grubs: 0, blue_games: 0, blue_wins: 0, red_games: 0, red_wins: 0 });
            }
            const t = teams.get(local.id);
            t.games++;
            if (won) t.wins++;
            t.duration_s += stats.duration_s || 0;
            for (const key of ['kills', 'deaths', 'gold_diff', 'towers', 'dragons', 'barons', 'heralds', 'grubs']) t[key] += team[key] || 0;
            if (team.side === 'blue' || team.side === 'red') {
                t[`${team.side}_games`]++;
                if (won) t[`${team.side}_wins`]++;
            }

            for (const p of stats.players?.[side] || []) {
                if (!p.name) continue;
                const key = playerKey(local.id, p.name);
                if (!players.has(key)) {
                    players.set(key, { name: p.name, team: teamInfo(local), games: 0, wins: 0, kills: 0, deaths: 0, assists: 0,
                        cs: 0, gold: 0, damage: 0, minutes: 0, damage_share_sum: 0, kp_sum: 0, vision: 0, champions: new Map() });
                }
                const agg = players.get(key);
                agg.games++;
                if (won) agg.wins++;
                for (const field of ['kills', 'deaths', 'assists', 'cs', 'gold', 'damage', 'vision']) agg[field] += p[field] || 0;
                agg.minutes += minutes || 0;
                agg.damage_share_sum += p.damage_share || 0;
                agg.kp_sum += p.kill_participation || 0;
                if (p.champion) {
                    const pool = agg.champions.get(p.champion) || { name: p.champion, games: 0, wins: 0 };
                    pool.games++;
                    if (won) pool.wins++;
                    agg.champions.set(p.champion, pool);
                    const c = champion(p.champion);
                    c.picks++;
                    if (won) c.wins++;
                }
            }
        }
        for (const action of stats.draft || []) {
            if (action.type === 'ban' && action.champion) champion(action.champion).bans++;
        }
    }

    return {
        game: 'lol',
        games,
        teams: [...teams.values()].map(t => ({
            id: t.id, name: t.name, short_name: t.short_name, logo_url: t.logo_url,
            games: t.games, wins: t.wins, win_rate: ratio(t.wins * 100, t.games),
            avg_duration_s: t.games ? Math.round(t.duration_s / t.games) : null,
            kills_pg: ratio(t.kills, t.games), deaths_pg: ratio(t.deaths, t.games),
            gold_diff_pg: t.games ? Math.round(t.gold_diff / t.games) : null,
            towers_pg: ratio(t.towers, t.games), dragons_pg: ratio(t.dragons, t.games),
            barons_pg: ratio(t.barons, t.games), heralds_pg: ratio(t.heralds, t.games), grubs_pg: ratio(t.grubs, t.games),
            blue: { games: t.blue_games, wins: t.blue_wins }, red: { games: t.red_games, wins: t.red_wins }
        })).sort((a, b) => b.win_rate - a.win_rate || b.games - a.games),
        players: [...players.values()].map(p => ({
            name: p.name, team: p.team, games: p.games, wins: p.wins,
            kills: p.kills, deaths: p.deaths, assists: p.assists,
            kda: round((p.kills + p.assists) / Math.max(1, p.deaths), 2),
            kills_pg: ratio(p.kills, p.games), deaths_pg: ratio(p.deaths, p.games), assists_pg: ratio(p.assists, p.games),
            cs_pm: p.minutes ? round(p.cs / p.minutes) : null,
            gold_pm: p.minutes ? Math.round(p.gold / p.minutes) : null,
            damage_pm: p.minutes ? Math.round(p.damage / p.minutes) : null,
            damage_share: ratio(p.damage_share_sum, p.games),
            kill_participation: ratio(p.kp_sum, p.games),
            vision_pm: p.minutes ? round(p.vision / p.minutes, 2) : null,
            champions: [...p.champions.values()].sort((a, b) => b.games - a.games || b.wins - a.wins)
        })).sort((a, b) => b.kda - a.kda || b.games - a.games),
        champions: [...champions.values()].map(c => ({
            ...c,
            win_rate: ratio(c.wins * 100, c.picks),
            presence: ratio((c.picks + c.bans) * 100, games)
        })).sort((a, b) => b.presence - a.presence || b.picks - a.picks)
    };
}

function shooterAggregate(gameType, rows) {
    const teams = new Map();
    const players = new Map();
    const maps = new Map();
    const agents = new Map();
    let games = 0;

    for (const row of rows) {
        const stats = row.stats;
        if (!stats || stats.status !== 'finished' || !stats.teams) continue;
        games++;
        const r1 = stats.teams.team1?.rounds || 0;
        const r2 = stats.teams.team2?.rounds || 0;
        const totalRounds = r1 + r2;
        if (stats.map) {
            const m = maps.get(stats.map) || { name: stats.map, games: 0 };
            m.games++;
            maps.set(stats.map, m);
        }
        for (const side of ['team1', 'team2']) {
            const local = row[side];
            const won = stats.winner === side;
            const own = side === 'team1' ? r1 : r2;
            const opp = side === 'team1' ? r2 : r1;
            if (!teams.has(local.id)) teams.set(local.id, { ...teamInfo(local), maps: 0, wins: 0, rounds_won: 0, rounds_lost: 0 });
            const t = teams.get(local.id);
            t.maps++;
            if (won) t.wins++;
            t.rounds_won += own;
            t.rounds_lost += opp;

            for (const p of stats.players?.[side] || []) {
                if (!p.name) continue;
                const key = playerKey(local.id, p.name);
                if (!players.has(key)) {
                    players.set(key, { name: p.name, team: teamInfo(local), maps: 0, wins: 0, kills: 0, deaths: 0, assists: 0,
                        damage: 0, rounds: 0, headshots: 0, hs_kills: 0, agents: new Map() });
                }
                const agg = players.get(key);
                agg.maps++;
                if (won) agg.wins++;
                agg.kills += p.kills || 0;
                agg.deaths += p.deaths || 0;
                agg.assists += p.assists || 0;
                if (p.damage != null) {
                    agg.damage += p.damage;
                    agg.rounds += totalRounds;
                }
                // 只存了爆头率：按击杀数还原爆头数再汇总
                if (p.hs_pct != null && p.kills) {
                    agg.headshots += (p.hs_pct / 100) * p.kills;
                    agg.hs_kills += p.kills;
                }
                if (p.agent) {
                    agg.agents.set(p.agent, (agg.agents.get(p.agent) || 0) + 1);
                    const a = agents.get(p.agent) || { name: p.agent, picks: 0, wins: 0 };
                    a.picks++;
                    if (won) a.wins++;
                    agents.set(p.agent, a);
                }
            }
        }
    }

    return {
        game: gameType,
        games,
        teams: [...teams.values()].map(t => ({
            id: t.id, name: t.name, short_name: t.short_name, logo_url: t.logo_url,
            maps: t.maps, wins: t.wins, win_rate: ratio(t.wins * 100, t.maps),
            rounds_won: t.rounds_won, rounds_lost: t.rounds_lost, round_diff: t.rounds_won - t.rounds_lost
        })).sort((a, b) => b.win_rate - a.win_rate || b.round_diff - a.round_diff),
        players: [...players.values()].map(p => ({
            name: p.name, team: p.team, maps: p.maps, wins: p.wins,
            kills: p.kills, deaths: p.deaths, assists: p.assists,
            kd: ratio(p.kills, Math.max(1, p.deaths), 2),
            kd_diff: p.kills - p.deaths,
            kills_pm: ratio(p.kills, p.maps),
            adr: p.rounds ? round(p.damage / p.rounds) : null,
            hs_pct: p.hs_kills ? round((p.headshots / p.hs_kills) * 100) : null,
            agents: [...p.agents.entries()].map(([name, count]) => ({ name, games: count })).sort((a, b) => b.games - a.games)
        })).sort((a, b) => (b.adr ?? -1) - (a.adr ?? -1) || b.kd - a.kd),
        maps: [...maps.values()].sort((a, b) => b.games - a.games),
        agents: [...agents.values()].map(a => ({ ...a, win_rate: ratio(a.wins * 100, a.picks) })).sort((a, b) => b.picks - a.picks)
    };
}

function aggregateTournamentStats(gameType, rows) {
    return gameType === 'lol' ? lolAggregate(rows) : shooterAggregate(gameType, rows);
}

module.exports = { aggregateTournamentStats };
