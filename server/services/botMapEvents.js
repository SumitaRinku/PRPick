// 单图结果播报：GRID 轮询发现某张地图刚结束时，记录一条事件供 QQ 机器人推送到群里。
//
// 只记录「亲眼看到结束」的地图：关联后的第一次轮询只作基线，不补发已经结束的地图，
// 避免晚配对或管理员手动补关联旧比赛时刷屏。UNIQUE(match_id, sequence) 保证每张图只播一次。
const RETENTION_MS = 14 * 86400000;

const WINS_NEEDED = { BO1: 1, BO3: 2, BO5: 3 };

function captureMapResults(db, { matchId, previousGames, games, firstPoll, seriesFinished, nowMs = Date.now() }) {
    if (firstPoll) return 0;
    const finishedBefore = new Set(previousGames.filter(g => g.status === 'finished').map(g => g.sequence));
    const fresh = games.filter(g => g.status === 'finished' && g.winner && !finishedBefore.has(g.sequence));
    if (!fresh.length) return 0;
    const m = db.prepare(`SELECT m.id, m.format, t.name tournament_name, t.game_type, t.is_active,
        a.name team1_name, b.name team2_name FROM matches m
        JOIN tournaments t ON t.id = m.tournament_id JOIN teams a ON a.id = m.team1_id
        JOIN teams b ON b.id = m.team2_id WHERE m.id = ?`).get(matchId);
    if (!m || !m.is_active) return 0;
    const needed = WINS_NEEDED[m.format] || null;
    const insert = db.prepare(`INSERT OR IGNORE INTO bot_map_events(match_id, sequence, payload, created_at)
        VALUES(?, ?, ?, ?)`);
    let added = 0;
    for (const game of fresh) {
        // 大比分按本图及之前已结束的地图计算，同一轮里结束两张图时各自的比分也正确。
        const upTo = games.filter(g => g.sequence <= game.sequence && g.status === 'finished');
        const team1 = upTo.filter(g => g.winner === 'team1').length;
        const team2 = upTo.filter(g => g.winner === 'team2').length;
        const isLast = game.sequence === Math.max(...games.map(g => g.sequence));
        const decided = needed ? Math.max(team1, team2) >= needed : !!(seriesFinished && isLast);
        const payload = {
            match: { id: m.id, tournament_name: m.tournament_name, game_type: m.game_type, format: m.format,
                team1_name: m.team1_name, team2_name: m.team2_name },
            map: { sequence: game.sequence, name: game.mapName, team1_rounds: game.team1Rounds,
                team2_rounds: game.team2Rounds, winner: game.winner },
            series: { team1, team2, wins_needed: needed, decided }
        };
        added += insert.run(matchId, game.sequence, JSON.stringify(payload), nowMs).changes;
    }
    db.prepare('DELETE FROM bot_map_events WHERE created_at < ?').run(nowMs - RETENTION_MS);
    return added;
}

module.exports = { captureMapResults, WINS_NEEDED };
