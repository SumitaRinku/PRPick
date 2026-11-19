// 赛事整体竞猜（Pick'em）接口。规则与结算见 server/services/pickem.js。
// 工厂形式注入 db 与鉴权中间件，测试可直接使用内存数据库。
const express = require('express');
const pickem = require('../services/pickem');

function parseJson(text, fallback) {
    try { return JSON.parse(text); } catch { return fallback; }
}

function createPickemRouter(db, { authenticateToken, optionalAuth, requireAdmin }) {
    const router = express.Router();

    const stageMatchesStmt = db.prepare(`
        SELECT m.id, m.name, m.status, m.match_time, m.team1_id, m.team2_id, m.team1_score, m.team2_score,
            m.winner_team_id, m.stage_external_id,
            t1.name team1_name, t1.short_name team1_short_name, t1.logo_url team1_logo_url, t1.dark_logo_url team1_dark_logo_url, t1.external_id team1_external_id,
            t2.name team2_name, t2.short_name team2_short_name, t2.logo_url team2_logo_url, t2.dark_logo_url team2_dark_logo_url, t2.external_id team2_external_id
        FROM matches m
        JOIN teams t1 ON t1.id = m.team1_id
        JOIN teams t2 ON t2.id = m.team2_id
        WHERE m.tournament_id = ? AND m.stage_external_id IS NOT NULL
    `);

    // 赛事下全部阶段的识别结果与结算上下文。includeOff = true 时也返回未开放的阶段（后台用）。
    function loadStages(tournamentId, { includeOff = false, now = Date.now() } = {}) {
        const stages = db.prepare('SELECT id, external_id, name FROM tournament_stages WHERE tournament_id = ?').all(tournamentId);
        const settings = new Map(db.prepare(`
            SELECT s.stage_id, s.mode, s.config FROM pickem_stage_settings s
            JOIN tournament_stages ts ON ts.id = s.stage_id
            WHERE ts.tournament_id = ?
        `).all(tournamentId).map(row => [row.stage_id, { mode: row.mode, config: parseJson(row.config, {}) }]));
        const byStage = new Map();
        for (const match of stageMatchesStmt.all(tournamentId)) {
            const key = String(match.stage_external_id);
            if (!byStage.has(key)) byStage.set(key, []);
            byStage.get(key).push(match);
        }
        const result = [];
        for (const stage of stages) {
            const matches = byStage.get(String(stage.external_id)) || [];
            const teams = pickem.stageTeams(matches);
            const { config: detected, reason } = pickem.detectStageInfo(stage.name, matches);
            const setting = settings.get(stage.id) || { mode: 'auto', config: {} };
            const config = pickem.resolveConfig(detected, setting, teams.size);
            if (!config && !includeOff) continue;
            const lock = pickem.lockInfo(matches, now);
            result.push({
                stage, matches, teams, detected, reason, setting, config, lock,
                context: pickem.stageContext(config, matches),
                firstMatchTime: lock.lock_at ? Date.parse(lock.lock_at) : Infinity
            });
        }
        // 同一天开赛的阶段（如 A/B/C/D 组）按名称排，其余按首场时间
        const day = time => (Number.isFinite(time) ? Math.floor(time / 86400000) : Infinity);
        return result.sort((a, b) => day(a.firstMatchTime) - day(b.firstMatchTime)
            || String(a.stage.name || '').localeCompare(String(b.stage.name || ''))
            || a.stage.id - b.stage.id);
    }

    function activeTournament(id) {
        return db.prepare('SELECT id, name, short_name, game_type, logo_url FROM tournaments WHERE id = ? AND is_active = 1').get(id);
    }

    function stagePicks(stageId) {
        return db.prepare(`
            SELECT p.user_id, p.picks, p.updated_at, u.username, u.role
            FROM pickem_picks p JOIN users u ON u.id = p.user_id
            WHERE p.stage_id = ?
        `).all(stageId).map(row => ({ ...row, picks: parseJson(row.picks, {}) }));
    }

    function teamView(entry, team) {
        const view = { ...team };
        if (entry.config.kind === pickem.RECORD) {
            const record = entry.context.records.get(team.id) || { wins: 0, losses: 0 };
            view.wins = record.wins;
            view.losses = record.losses;
            view.status = pickem.recordStatus(entry.config, record);
        }
        return view;
    }

    function distribution(entry, rows) {
        const slots = entry.config.kind === pickem.RECORD ? ['top', 'bottom', 'advance'] : ['champion', 'runner_up', 'semis'];
        const counts = Object.fromEntries(slots.map(slot => [slot, {}]));
        for (const row of rows) {
            for (const slot of slots) {
                const value = row.picks[slot];
                for (const id of Array.isArray(value) ? value : value ? [value] : []) {
                    counts[slot][id] = (counts[slot][id] || 0) + 1;
                }
            }
        }
        return counts;
    }

    // 公开视图：开赛锁定前只显示参与人数，锁定后公开选择分布。
    router.get('/tournaments/:id', optionalAuth, (req, res) => {
        const tournament = activeTournament(req.params.id);
        if (!tournament) return res.status(404).json({ error: '赛事不存在' });
        const userId = req.user?.id;
        const board = new Map();
        const stages = loadStages(tournament.id).map(entry => {
            const rows = stagePicks(entry.stage.id);
            const mine = userId ? rows.find(row => row.user_id === userId) : null;
            for (const row of rows) {
                if (row.role !== 'user') continue;
                const score = pickem.scorePicks(entry.context, row.picks);
                const total = board.get(row.user_id) || { user_id: row.user_id, username: row.username, points: 0, correct: 0, decided: 0, stages: 0 };
                total.points += score.points;
                total.correct += score.correct;
                total.decided += score.decided;
                total.stages += 1;
                board.set(row.user_id, total);
            }
            const outcome = entry.context.outcome;
            return {
                id: entry.stage.id,
                name: entry.stage.name,
                config: { ...entry.config, max_points: pickem.maxPoints(entry.config) },
                lock_at: entry.lock.lock_at,
                locked: entry.lock.locked,
                teams: [...entry.teams.values()].map(team => teamView(entry, team)).sort((a, b) => a.name.localeCompare(b.name)),
                outcome: outcome || null,
                participants: rows.length,
                distribution: entry.lock.locked ? distribution(entry, rows) : null,
                mine: mine ? { picks: mine.picks, updated_at: mine.updated_at, result: pickem.scorePicks(entry.context, mine.picks) } : null
            };
        });
        // 硬币门槛按赛事内全部已开放阶段的满分合计（后续阶段开放后门槛随之上调）
        const maxTotal = stages.reduce((sum, stage) => sum + stage.config.max_points, 0);
        const leaderboard = [...board.values()]
            .sort((a, b) => b.points - a.points || b.correct - a.correct || a.username.localeCompare(b.username))
            .slice(0, 100)
            .map((row, index) => ({ ...row, rank: index + 1, coin: pickem.coinFor(row.points, maxTotal) }));
        const mineStages = stages.filter(stage => stage.mine);
        const myPoints = mineStages.reduce((sum, stage) => sum + stage.mine.result.points, 0);
        const me = userId ? {
            points: myPoints,
            participated: mineStages.length > 0,
            coin: pickem.coinFor(myPoints, maxTotal, mineStages.length > 0)
        } : null;
        res.json({ tournament, stages, leaderboard, coins: { max_points: maxTotal, tiers: pickem.coinThresholds(maxTotal) }, me });
    });

    // 正在开放提交的阶段（未锁定），供列表页入口提示。
    router.get('/open', (req, res) => {
        const now = Date.now();
        const tournaments = db.prepare(`
            SELECT DISTINCT t.id, t.name, t.short_name, t.game_type, t.logo_url
            FROM tournaments t JOIN matches m ON m.tournament_id = t.id
            WHERE t.is_active = 1 AND m.status = 'upcoming' AND m.stage_external_id IS NOT NULL
                AND datetime(m.match_time) > datetime('now')
        `).all();
        const open = [];
        for (const tournament of tournaments) {
            for (const entry of loadStages(tournament.id, { now })) {
                if (!entry.lock.locked) open.push({ tournament, stage_id: entry.stage.id, stage_name: entry.stage.name, kind: entry.config.kind, lock_at: entry.lock.lock_at });
            }
        }
        open.sort((a, b) => Date.parse(a.lock_at) - Date.parse(b.lock_at));
        res.json({ open });
    });

    function findStageEntry(stageId) {
        const stage = db.prepare(`
            SELECT s.id, s.tournament_id FROM tournament_stages s
            JOIN tournaments t ON t.id = s.tournament_id
            WHERE s.id = ? AND t.is_active = 1
        `).get(stageId);
        if (!stage) return null;
        return loadStages(stage.tournament_id).find(entry => entry.stage.id === stage.id) || null;
    }

    router.put('/stages/:stageId', authenticateToken, (req, res) => {
        const entry = findStageEntry(Number(req.params.stageId));
        if (!entry) return res.status(404).json({ error: '本阶段未开放整体竞猜' });
        if (entry.lock.locked) return res.status(409).json({ error: '本阶段已开赛，竞猜已锁定' });
        let picks;
        try {
            picks = pickem.normalizePicks(entry.config, req.body?.picks, entry.teams.keys());
        } catch (error) {
            if (error instanceof pickem.PickemValidationError) return res.status(400).json({ error: error.message });
            throw error;
        }
        db.prepare(`
            INSERT INTO pickem_picks (user_id, stage_id, picks) VALUES (?, ?, ?)
            ON CONFLICT(user_id, stage_id) DO UPDATE SET picks = excluded.picks, updated_at = CURRENT_TIMESTAMP
        `).run(req.user.id, entry.stage.id, JSON.stringify(picks));
        res.json({ picks });
    });

    router.delete('/stages/:stageId', authenticateToken, (req, res) => {
        const entry = findStageEntry(Number(req.params.stageId));
        if (!entry) return res.status(404).json({ error: '本阶段未开放整体竞猜' });
        if (entry.lock.locked) return res.status(409).json({ error: '本阶段已开赛，竞猜已锁定' });
        db.prepare('DELETE FROM pickem_picks WHERE user_id = ? AND stage_id = ?').run(req.user.id, entry.stage.id);
        res.json({ ok: true });
    });

    // ---------- 管理 ----------

    router.get('/admin/tournaments/:id', authenticateToken, requireAdmin, (req, res) => {
        const tournament = db.prepare('SELECT id, name, game_type FROM tournaments WHERE id = ?').get(req.params.id);
        if (!tournament) return res.status(404).json({ error: '赛事不存在' });
        const stages = loadStages(tournament.id, { includeOff: true }).map(entry => ({
            id: entry.stage.id,
            name: entry.stage.name,
            team_count: entry.teams.size,
            match_count: entry.matches.length,
            mode: entry.setting.mode,
            override: entry.setting.config || {},
            detected: entry.detected,
            reason: entry.detected ? null : entry.reason,
            config: entry.config,
            lock_at: entry.lock.lock_at,
            locked: entry.lock.locked,
            participants: db.prepare('SELECT COUNT(*) n FROM pickem_picks WHERE stage_id = ?').get(entry.stage.id).n
        }));
        res.json({ tournament, stages });
    });

    router.put('/admin/stages/:stageId', authenticateToken, requireAdmin, (req, res) => {
        const stage = db.prepare('SELECT id FROM tournament_stages WHERE id = ?').get(req.params.stageId);
        if (!stage) return res.status(404).json({ error: '阶段不存在' });
        const mode = String(req.body?.mode || '');
        if (!['auto', 'off', 'record', 'elimination'].includes(mode)) return res.status(400).json({ error: '无效的模式' });
        let config = null;
        if (mode === 'record') {
            const raw = req.body?.config || {};
            config = {
                wins: Number(raw.wins), losses: Number(raw.losses),
                top_count: Number(raw.top_count), bottom_count: Number(raw.bottom_count), advance_count: Number(raw.advance_count)
            };
            const error = pickem.validateRecordConfig(config);
            if (error) return res.status(400).json({ error });
        }
        if (mode === 'auto') {
            db.prepare('DELETE FROM pickem_stage_settings WHERE stage_id = ?').run(stage.id);
        } else {
            db.prepare(`
                INSERT INTO pickem_stage_settings (stage_id, mode, config) VALUES (?, ?, ?)
                ON CONFLICT(stage_id) DO UPDATE SET mode = excluded.mode, config = excluded.config, updated_at = CURRENT_TIMESTAMP
            `).run(stage.id, mode, config ? JSON.stringify(config) : null);
        }
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createPickemRouter };
