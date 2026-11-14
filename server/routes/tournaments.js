const express = require('express');
const db = require('../config/database');
const { TIER_SQL } = require('../services/tournamentTier');
const { GAMES, isGame } = require('../config/games');
const { getPreviewDays } = require('../services/settings');
const { attachLiveScores } = require('../services/gridLiveService');
const { flipGameStats } = require('../services/gridStats');
const { aggregateTournamentStats } = require('../services/gameStatsAggregate');

const router = express.Router();

// 厂牌关键词归类（赛事回看筛选用）：规则见 server/config/games.js 的 brands，
// 按数组顺序首次命中生效。未命中返回 null，前端归入"其他"。仅查询时计算，不落库。
function brandOf(name, gameType) {
    const rules = (isGame(gameType) && GAMES[gameType].brands) || [];
    const lower = String(name || '').toLowerCase();
    for (const [brand, keys] of rules) {
        if (keys.some(key => lower.includes(key))) return brand;
    }
    return null;
}

function matchRows(tournamentId) {
    return db.prepare(`
        SELECT m.*, tour.game_type, t1.name team1_name, t1.short_name team1_short_name, t1.logo_url team1_logo_url, t1.dark_logo_url team1_dark_logo_url,
            t2.name team2_name, t2.short_name team2_short_name, t2.logo_url team2_logo_url, t2.dark_logo_url team2_dark_logo_url,
            (SELECT COUNT(*) FROM predictions p WHERE p.match_id = m.id) prediction_count,
            (SELECT COUNT(*) FROM predictions p WHERE p.match_id = m.id AND p.points_earned > 0) correct_prediction_count
        FROM matches m
        JOIN tournaments tour ON tour.id = m.tournament_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        WHERE m.tournament_id = ?
        ORDER BY m.match_time DESC
    `).all(tournamentId);
}

router.get('/', (req, res) => {
    const { game_type, status } = req.query;
    const params = [];
    let where = 't.is_active = 1';
    if (game_type) {
        where += ' AND t.game_type = ?';
        params.push(game_type);
    }

    let having = '';
    if (status === 'finished') {
        having = 'HAVING match_count > 0 AND unfinished_count = 0';
    } else if (status === 'ongoing') {
        having = 'HAVING unfinished_count > 0';
    }

    const tournaments = db.prepare(`
        SELECT t.*, ${TIER_SQL} effective_tier,
            COUNT(DISTINCT m.id) match_count,
            COUNT(DISTINCT CASE WHEN m.status = 'finished' THEN m.id END) finished_count,
            COUNT(DISTINCT CASE WHEN m.status = 'ongoing' OR (m.status = 'upcoming' AND datetime(m.match_time) <= datetime('now')) THEN m.id END) ongoing_count,
            COUNT(DISTINCT CASE WHEN m.status = 'upcoming' AND datetime(m.match_time) > datetime('now') THEN m.id END) upcoming_count,
            COUNT(DISTINCT CASE WHEN m.status IN ('upcoming', 'ongoing') THEN m.id END) unfinished_count,
            COUNT(p.id) prediction_count
        FROM tournaments t
        LEFT JOIN matches m ON m.tournament_id = t.id
        LEFT JOIN predictions p ON p.match_id = m.id
        WHERE ${where}
        GROUP BY t.id
        ${having}
        ORDER BY effective_tier ASC, COALESCE(t.begin_at, t.created_at) DESC
    `).all(...params);

    // 厂牌为查询时按名称关键词推断，不落库（见文件头 BRAND_RULES）
    tournaments.forEach(t => { t.brand = brandOf(t.name, t.game_type); });
    res.json({ tournaments });
});

// 未来赛事预告（PandaScore serie 层级，不是本地赛事）：仅展示，不参与积分/回看。
// 必须放在 /:id 之前，否则 "previews" 会被当成赛事 id。
router.get('/previews', (req, res) => {
    const { game_type } = req.query;
    const params = [];
    let where = "is_visible = 1 AND datetime(COALESCE(end_at, begin_at)) >= datetime('now')";
    if (game_type) {
        where += ' AND game_type = ?';
        params.push(game_type);
    }
    const previews = db.prepare(`
        SELECT id, game_type, external_id, name, begin_at, end_at
        FROM tournament_previews
        WHERE ${where}
        ORDER BY datetime(begin_at) ASC
        LIMIT 200
    `).all(...params);
    res.json({ previews, days: getPreviewDays() });
});

router.get('/:id', (req, res) => {
    const tournament = db.prepare(`
        SELECT t.*, ${TIER_SQL} effective_tier,
            COUNT(DISTINCT m.id) match_count,
            COUNT(DISTINCT CASE WHEN m.status = 'finished' THEN m.id END) finished_count,
            COUNT(DISTINCT CASE WHEN m.status = 'ongoing' OR (m.status = 'upcoming' AND datetime(m.match_time) <= datetime('now')) THEN m.id END) ongoing_count,
            COUNT(DISTINCT CASE WHEN m.status = 'upcoming' AND datetime(m.match_time) > datetime('now') THEN m.id END) upcoming_count,
            COUNT(DISTINCT CASE WHEN m.status IN ('upcoming', 'ongoing') THEN m.id END) unfinished_count,
            COUNT(p.id) prediction_count,
            (SELECT COUNT(*) FROM match_game_stats s JOIN matches sm ON sm.id = s.match_id
                WHERE sm.tournament_id = t.id AND s.status = 'finished') stats_games
        FROM tournaments t
        LEFT JOIN matches m ON m.tournament_id = t.id
        LEFT JOIN predictions p ON p.match_id = m.id
        WHERE t.id = ? AND t.is_active = 1
        GROUP BY t.id
    `).get(req.params.id);
    if (!tournament) return res.status(404).json({ error: '赛事不存在' });
    res.json({ tournament, matches: attachLiveScores(matchRows(tournament.id)) });
});

// 赛事数据统计（GRID 每局详细数据汇总）：队伍 / 选手 / 英雄（LoL）或特工（Valorant）榜。仅展示，不参与结算。
router.get('/:id/stats', (req, res) => {
    const tournament = db.prepare('SELECT id, name, game_type FROM tournaments WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!tournament) return res.status(404).json({ error: '赛事不存在' });
    const rows = db.prepare(`
        SELECT s.match_id, s.payload, l.team1_id link_team1_id, m.team1_id, m.team2_id,
            t1.name team1_name, t1.short_name team1_short_name, t1.logo_url team1_logo_url,
            t2.name team2_name, t2.short_name team2_short_name, t2.logo_url team2_logo_url
        FROM match_game_stats s
        JOIN matches m ON m.id = s.match_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        LEFT JOIN match_live_links l ON l.match_id = m.id
        WHERE m.tournament_id = ? AND s.status = 'finished' AND m.status != 'cancelled'
        ORDER BY m.match_time, s.sequence
    `).all(tournament.id).map(row => {
        let stats = null;
        try { stats = JSON.parse(row.payload); } catch { stats = null; }
        // 写入后 PandaScore 对调了主客队：翻转到当前方向
        if (stats && row.link_team1_id != null && Number(row.link_team1_id) === Number(row.team2_id)) stats = flipGameStats(stats);
        return {
            match_id: row.match_id,
            team1: { id: row.team1_id, name: row.team1_name, short_name: row.team1_short_name, logo_url: row.team1_logo_url },
            team2: { id: row.team2_id, name: row.team2_name, short_name: row.team2_short_name, logo_url: row.team2_logo_url },
            stats
        };
    });
    res.json({ tournament, stats: aggregateTournamentStats(tournament.game_type, rows) });
});

// 官方赛程图数据：阶段 + 节点 + 父子边。节点来自 PandaScore /tournaments/{id}/brackets，
// 因此即使比赛尚未进入近端同步窗口（远期 TBD 场次）也能保留完整骨架。
router.get('/:id/brackets', (req, res) => {
    const tournament = db.prepare('SELECT id, name, game_type FROM tournaments WHERE id = ? AND is_active = 1')
        .get(req.params.id);
    if (!tournament) return res.status(404).json({ error: '赛事不存在' });

    const stages = db.prepare(`
        SELECT id, external_id, name, slug, has_bracket, last_synced_at, bracket_synced_at, bracket_error
        FROM tournament_stages
        WHERE tournament_id = ? AND external_source = 'pandascore'
        ORDER BY id
    `).all(tournament.id);

    const nodeStmt = db.prepare(`
        SELECT bn.*,
            (SELECT m.id FROM matches m
             WHERE m.external_source = 'pandascore'
               AND (m.external_id = bn.external_match_id OR m.external_id = bn.panda_match_id)
             LIMIT 1) AS local_match_id
        FROM bracket_nodes bn
        WHERE bn.stage_id = ?
        ORDER BY bn.position, bn.id
    `);
    const edgeStmt = db.prepare(`
        SELECT match_external_id, source_external_match_id, source_type
        FROM bracket_edges
        WHERE stage_id = ?
        ORDER BY id
    `);

    res.json({
        tournament,
        stages: stages.map(stage => ({
            ...stage,
            nodes: nodeStmt.all(stage.id),
            edges: edgeStmt.all(stage.id)
        }))
    });
});

router.get('/:id/leaderboard', (req, res) => {
    const tournament = db.prepare('SELECT id, name, game_type FROM tournaments WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!tournament) return res.status(404).json({ error: '赛事不存在' });

    const leaderboard = db.prepare(`
        SELECT u.id, u.username,
            COALESCE(SUM(CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 THEN p.points_earned ELSE 0 END), 0) total_score,
            COUNT(CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 THEN 1 END) prediction_count,
            COUNT(p.id) total_predictions,
            CASE WHEN COUNT(CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 THEN 1 END) > 0
                THEN ROUND(100.0 * SUM(CASE WHEN p.points_earned > 0 THEN 1 ELSE 0 END) / COUNT(CASE WHEN m.status = 'finished' AND m.is_forfeit = 0 THEN 1 END), 1)
                ELSE 0 END success_rate
        FROM users u
        JOIN predictions p ON p.user_id = u.id
        JOIN matches m ON m.id = p.match_id
        WHERE u.role = 'user' AND m.tournament_id = ?
        GROUP BY u.id
        HAVING prediction_count > 0
        ORDER BY total_score DESC, success_rate DESC, prediction_count DESC
        LIMIT 100
    `).all(tournament.id);
    leaderboard.forEach((user, index) => user.rank = index + 1);
    res.json({ tournament, leaderboard });
});

router.get('/:id/predictions', (req, res) => {
    const tournament = db.prepare('SELECT id, name FROM tournaments WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!tournament) return res.status(404).json({ error: '赛事不存在' });
    const predictions = db.prepare(`
        SELECT p.*, u.username, m.status match_status, m.match_time, m.team1_score, m.team2_score,
            t1.name team1_name, t2.name team2_name, pw.name predicted_winner_name
        FROM predictions p
        JOIN users u ON u.id = p.user_id
        JOIN matches m ON m.id = p.match_id
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        JOIN teams pw ON pw.id = p.predicted_winner_id
        WHERE m.tournament_id = ? AND m.status = 'finished'
        ORDER BY m.match_time DESC, p.points_earned DESC, p.created_at ASC
    `).all(tournament.id);
    res.json({ tournament, predictions });
});

module.exports = router;
