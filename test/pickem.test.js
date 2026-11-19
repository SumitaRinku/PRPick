const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const pickem = require('../server/services/pickem');
const { createPickemRouter } = require('../server/routes/pickem');
const { ensurePickemSchema } = require('../server/config/pickem-schema');

// ---------- 构造数据 ----------

let nextId = 1;
function match(team1, team2, winner, overrides = {}) {
    return {
        id: nextId++,
        name: '',
        status: winner ? 'finished' : 'upcoming',
        match_time: '2026-06-02T10:00:00.000Z',
        team1_id: team1,
        team2_id: team2,
        team1_name: `T${team1}`,
        team2_name: `T${team2}`,
        team1_score: winner ? (winner === team1 ? 1 : 0) : null,
        team2_score: winner ? (winner === team2 ? 1 : 0) : null,
        winner_team_id: winner || null,
        ...overrides
    };
}

// 16 队瑞士轮首轮：1v2, 3v4 ... 15v16
function swissRoundOne(winners = false) {
    const list = [];
    for (let i = 1; i <= 16; i += 2) list.push(match(i, i + 1, winners ? i : null));
    return list;
}

// ---------- 识别 ----------

test('detects Major swiss, GSL groups and playoffs; ignores round robin', () => {
    assert.deepEqual(pickem.detectStage('Stage 1 Swiss', swissRoundOne()),
        { kind: 'record', wins: 3, losses: 3, top_count: 2, bottom_count: 2, advance_count: 6 });
    const gsl = [match(1, 2), match(3, 4)];
    assert.deepEqual(pickem.detectStage('Group A', gsl),
        { kind: 'record', wins: 2, losses: 2, top_count: 1, bottom_count: 1, advance_count: 1 });
    const roundRobin = [match(1, 2), match(3, 4), match(1, 3), match(2, 4), match(1, 4), match(2, 3)];
    assert.equal(pickem.detectStage('Group A', roundRobin), null);
    assert.deepEqual(pickem.detectStage('Playoffs', [match(1, 2), match(3, 4), match(5, 6), match(7, 8)]),
        { kind: 'elimination', semi_count: 2 });
    assert.equal(pickem.detectStage('Regular Season', swissRoundOne()), null);
});

// 真实同步数据形态：16 队瑞士轮只公布首轮，后续轮次是 TBD 占位（team id 99，external_id cs2:__tbd__）
const TBD = 99;
function tbdMatch(round, overrides = {}) {
    return match(TBD, TBD, null, { name: `Round ${round}: TBD vs TBD`, team1_name: 'TBD', team2_name: 'TBD', team1_external_id: 'cs2:__tbd__', team2_external_id: 'cs2:__tbd__', ...overrides });
}
function namedSwiss({ roundOneTbd = 0 } = {}) {
    const list = swissRoundOne().map((m, i) => ({ ...m, name: `Round 1: T${m.team1_id} vs T${m.team2_id}` }));
    for (let i = 0; i < roundOneTbd; i++) list[i] = tbdMatch(1);
    for (let i = 0; i < 8; i++) list.push(tbdMatch(2));
    for (let i = 0; i < 8; i++) list.push(tbdMatch(3));
    return list;
}

test('TBD placeholders are not teams; swiss is detected by round structure without "Swiss" in the name', () => {
    const list = namedSwiss();
    assert.equal(pickem.stageTeams(list).size, 16);
    assert.equal(pickem.stageTeams(list).has(TBD), false);
    for (const name of ['Stage 1', 'Group Stage', 'Opening Stage']) {
        assert.deepEqual(pickem.detectStage(name, list), { kind: 'record', wins: 3, losses: 3, top_count: 2, bottom_count: 2, advance_count: 6 }, name);
    }
});

test('stages stay closed until the opening round is fully known', () => {
    assert.match(pickem.detectStageInfo('Stage 1', namedSwiss({ roundOneTbd: 2 })).reason, /首轮对阵未定/);
    const playoffs = [
        match(1, 2, null, { match_time: at(1) }), match(3, 4, null, { match_time: at(2) }),
        tbdMatch(0, { name: 'Semifinal 1', match_time: '2026-06-11T12:00:00.000Z' })
    ];
    assert.deepEqual(pickem.detectStage('Playoffs', playoffs), { kind: 'elimination', semi_count: 2 });
    playoffs[1] = { ...playoffs[1], team2_id: TBD, team2_name: 'TBD', team2_external_id: 'cs2:__tbd__' };
    assert.match(pickem.detectStageInfo('Playoffs', playoffs).reason, /首轮对阵未定/);
});

test('round robin leagues with round names are not mistaken for swiss', () => {
    const teams = [1, 2, 3, 4, 5, 6, 7, 8];
    const list = [];
    let round = 1;
    for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) list.push(match(teams[i], teams[j], null, { name: `Round ${round++ % 7 + 1}` }));
    assert.equal(pickem.detectStage('Regular Season', list), null);
    assert.match(pickem.detectStageInfo('Regular Season', list).reason, /无法识别/);
});

test('admin override can disable, force record params, or force elimination', () => {
    const detected = pickem.detectStage('Stage 1 Swiss', swissRoundOne());
    assert.equal(pickem.resolveConfig(detected, { mode: 'off' }, 16), null);
    assert.equal(pickem.resolveConfig(detected, { mode: 'auto' }, 16), detected);
    assert.deepEqual(
        pickem.resolveConfig(null, { mode: 'record', config: { wins: 3, losses: 3, top_count: 1, bottom_count: 1, advance_count: 4 } }, 12),
        { kind: 'record', wins: 3, losses: 3, top_count: 1, bottom_count: 1, advance_count: 4 });
    assert.equal(pickem.resolveConfig(null, { mode: 'record', config: { wins: 0 } }, 12), null);
    assert.deepEqual(pickem.resolveConfig(null, { mode: 'elimination' }, 8), { kind: 'elimination', semi_count: 2 });
});

// ---------- 战绩门槛结算 ----------

test('record picks: 3-0 / 0-3 / advance resolve as soon as a team is decided', () => {
    const config = { kind: 'record', wins: 3, losses: 3, top_count: 2, bottom_count: 2, advance_count: 6 };
    // 队伍 1 三连胜；队伍 2 三连败；队伍 3 先负后三胜（3-1）；队伍 4 1-0 仍在比赛
    const matches = [
        match(1, 2, 1), match(1, 5, 1), match(1, 6, 1),
        match(2, 7, 7), match(2, 8, 8),
        match(3, 9, 9), match(3, 10, 3), match(3, 11, 3), match(3, 12, 3),
        match(4, 13, 4)
    ];
    const context = pickem.stageContext(config, matches);
    const score = pickem.scorePicks(context, { top: [1, 3], bottom: [2, 4], advance: [3, 9] });
    const byKey = Object.fromEntries(score.items.map(item => [`${item.slot}:${item.team_id}`, item.result]));
    assert.equal(byKey['top:1'], 'correct');
    assert.equal(byKey['top:3'], 'wrong'); // 已有一负，不可能 3-0
    assert.equal(byKey['bottom:2'], 'correct');
    assert.equal(byKey['bottom:4'], 'wrong'); // 已有一胜，不可能 0-3
    assert.equal(byKey['advance:3'], 'correct');
    assert.equal(byKey['advance:9'], 'pending');
    assert.equal(score.points, 3);
    assert.equal(score.max, 10);
});

test('advance picks count any advancing record, including 3-0', () => {
    const config = { kind: 'record', wins: 2, losses: 2, top_count: 1, bottom_count: 1, advance_count: 1 };
    const context = pickem.stageContext(config, [match(1, 2, 1), match(1, 3, 1)]);
    assert.equal(pickem.scorePicks(context, { advance: [1] }).points, 1);
});

test('winner falls back to scores and cancelled matches are ignored', () => {
    const config = { kind: 'record', wins: 1, losses: 1, top_count: 1, bottom_count: 1, advance_count: 0 };
    const matches = [
        match(1, 2, null, { status: 'finished', team1_score: 2, team2_score: 0 }),
        match(3, 4, 4, { status: 'cancelled' })
    ];
    const context = pickem.stageContext(config, matches);
    assert.deepEqual(context.records.get(1), { wins: 1, losses: 0 });
    assert.equal(context.records.get(4), undefined);
});

// ---------- 淘汰赛结算 ----------

function at(hour) {
    return `2026-06-10T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

test('single elimination with third place match: champion, runner-up, top 4', () => {
    const matches = [
        match(1, 8, 1, { match_time: at(1) }), match(2, 7, 2, { match_time: at(2) }),
        match(3, 6, 3, { match_time: at(3) }), match(4, 5, 4, { match_time: at(4) }),
        match(1, 4, 1, { match_time: at(5) }), match(2, 3, 3, { match_time: at(6) }),
        match(1, 3, 3, { match_time: at(8), name: 'Grand Final' }),
        match(4, 2, 2, { match_time: at(9), name: '3rd Place Match' })
    ];
    const outcome = pickem.eliminationOutcome(matches);
    assert.equal(outcome.complete, true);
    assert.equal(outcome.champion, 3);
    assert.equal(outcome.runner_up, 1);
    assert.deepEqual(new Set(outcome.top4), new Set([1, 2, 3, 4]));
    const context = pickem.stageContext({ kind: 'elimination', semi_count: 2 }, matches);
    const score = pickem.scorePicks(context, { champion: 3, runner_up: 2, semis: [4, 8] });
    assert.equal(score.points, 3 + 0 + 1);
    assert.equal(score.max, 7);
});

test('double elimination: top 4 is grand finalists plus the last two lower bracket losers', () => {
    // 上半区 1 2 3 4，下半区开局 5 6 7 8
    const matches = [
        match(1, 2, 1, { match_time: at(1) }), match(3, 4, 3, { match_time: at(1) }),
        match(5, 2, 2, { match_time: at(2) }), match(6, 4, 4, { match_time: at(2) }), // 下半区首轮
        match(1, 3, 1, { match_time: at(3), name: 'Upper Bracket Final' }),
        match(2, 4, 2, { match_time: at(4), name: 'Lower Bracket Semifinal' }),
        match(3, 2, 3, { match_time: at(5), name: 'Lower Bracket Final' }),
        match(1, 3, 3, { match_time: at(6), name: 'Grand Final' })
    ];
    const outcome = pickem.eliminationOutcome(matches);
    assert.equal(outcome.champion, 3);
    assert.equal(outcome.runner_up, 1);
    assert.deepEqual(new Set(outcome.top4), new Set([1, 2, 3, 4]));
});

test('elimination picks stay pending until every stage match is finished', () => {
    const matches = [match(1, 2, 1, { match_time: at(1) }), match(1, 3, null, { match_time: at(2) })];
    const context = pickem.stageContext({ kind: 'elimination', semi_count: 1 }, matches);
    const score = pickem.scorePicks(context, { champion: 1 });
    assert.equal(score.items[0].result, 'pending');
    assert.equal(score.points, 0);
});

// ---------- 校验与锁定 ----------

test('normalizePicks rejects overfilled slots, duplicates and outside teams', () => {
    const config = { kind: 'record', wins: 3, losses: 3, top_count: 2, bottom_count: 2, advance_count: 6 };
    const ids = new Set([1, 2, 3, 4, 5]);
    assert.deepEqual(pickem.normalizePicks(config, { top: ['1'], advance: [2] }, ids), { top: [1], bottom: [], advance: [2] });
    assert.throws(() => pickem.normalizePicks(config, { top: [1, 2, 3] }, ids), /最多选 2/);
    assert.throws(() => pickem.normalizePicks(config, { top: [1], bottom: [1] }, ids), /只能选一次/);
    assert.throws(() => pickem.normalizePicks(config, { top: [99] }, ids), /参赛队伍/);
    assert.throws(() => pickem.normalizePicks(config, {}, ids), /至少选择/);
    const elim = { kind: 'elimination', semi_count: 2 };
    assert.throws(() => pickem.normalizePicks(elim, { champion: 1, runner_up: 1 }, ids), /只能选一次/);
});

test('stage locks at the first match time or once any match has started', () => {
    const future = Date.parse('2026-06-01T00:00:00.000Z');
    const matches = [match(1, 2, null, { match_time: '2026-06-02T10:00:00.000Z' }), match(3, 4, null, { match_time: '2026-06-02T09:00:00.000Z' })];
    assert.deepEqual(pickem.lockInfo(matches, future), { lock_at: '2026-06-02T09:00:00.000Z', locked: false });
    assert.equal(pickem.lockInfo(matches, Date.parse('2026-06-02T09:00:00.000Z')).locked, true);
    matches[0].status = 'ongoing';
    assert.equal(pickem.lockInfo(matches, future).locked, true);
});

// ---------- 接口 ----------

function createApp() {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT NOT NULL DEFAULT 'user');
        CREATE TABLE tournaments (id INTEGER PRIMARY KEY, name TEXT, short_name TEXT, game_type TEXT, logo_url TEXT, is_active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT, short_name TEXT, logo_url TEXT, dark_logo_url TEXT, external_id TEXT);
        CREATE TABLE tournament_stages (id INTEGER PRIMARY KEY, tournament_id INTEGER, external_id TEXT, name TEXT);
        CREATE TABLE matches (id INTEGER PRIMARY KEY, tournament_id INTEGER, name TEXT, status TEXT, match_time TEXT,
            team1_id INTEGER, team2_id INTEGER, team1_score INTEGER, team2_score INTEGER, winner_team_id INTEGER, stage_external_id TEXT);
    `);
    ensurePickemSchema(db);
    db.prepare("INSERT INTO users (id, username, role) VALUES (1, 'alice', 'user'), (2, 'bob', 'user'), (3, 'root', 'admin')").run();
    db.prepare("INSERT INTO tournaments (id, name, game_type) VALUES (1, 'Major', 'cs2')").run();
    const team = db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)');
    for (let i = 1; i <= 16; i++) team.run(i, `Team ${String(i).padStart(2, '0')}`);
    db.prepare("INSERT INTO tournament_stages (id, tournament_id, external_id, name) VALUES (10, 1, 's1', 'Stage 1 Swiss'), (11, 1, 's2', 'Regular Season')").run();
    const insertMatch = db.prepare("INSERT INTO matches (tournament_id, status, match_time, team1_id, team2_id, stage_external_id) VALUES (1, 'upcoming', ?, ?, ?, ?)");
    const later = new Date(Date.now() + 86400000).toISOString();
    for (let i = 1; i <= 16; i += 2) insertMatch.run(later, i, i + 1, 's1');
    insertMatch.run(later, 1, 2, 's2');

    const app = express();
    app.use(express.json());
    const fakeAuth = (req, res, next) => {
        const id = Number(req.headers['x-user']);
        if (!id) return res.status(401).json({ error: '请先登录' });
        req.user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
        next();
    };
    const optionalAuth = (req, res, next) => {
        const id = Number(req.headers['x-user']);
        req.user = id ? db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) : null;
        next();
    };
    const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: '需要管理员权限' }));
    app.use('/api/pickem', createPickemRouter(db, { authenticateToken: fakeAuth, optionalAuth, requireAdmin }));
    return { app, db };
}

async function withServer(app, fn) {
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/pickem`;
    try { await fn(base); } finally { server.close(); }
}

async function call(base, path, { method = 'GET', user, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (user) headers['x-user'] = String(user);
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
}

test('API: submit, hide distribution before lock, settle into the leaderboard after results', async () => {
    const { app, db } = createApp();
    await withServer(app, async base => {
        let res = await call(base, '/tournaments/1', { user: 1 });
        assert.equal(res.status, 200);
        assert.equal(res.data.stages.length, 1, 'Regular Season is not detected');
        assert.equal(res.data.stages[0].config.max_points, 10);

        res = await call(base, '/stages/10', { method: 'PUT', user: 1, body: { picks: { top: [1, 3], bottom: [2], advance: [5] } } });
        assert.equal(res.status, 200);
        res = await call(base, '/stages/10', { method: 'PUT', user: 2, body: { picks: { top: [2] } } });
        assert.equal(res.status, 200);
        res = await call(base, '/stages/10', { method: 'PUT', body: { picks: { top: [1] } } });
        assert.equal(res.status, 401);
        res = await call(base, '/stages/11', { method: 'PUT', user: 1, body: { picks: { top: [1] } } });
        assert.equal(res.status, 404);

        res = await call(base, '/open');
        assert.equal(res.data.open.length, 1);

        res = await call(base, '/tournaments/1', { user: 1 });
        assert.equal(res.data.stages[0].participants, 2);
        assert.equal(res.data.stages[0].distribution, null);
        assert.deepEqual(res.data.stages[0].mine.picks, { top: [1, 3], bottom: [2], advance: [5] });

        // 首轮打完：1 胜 2，3 胜 4，5 胜 6 → 锁定，alice 的 bottom:2 尚未决出，bob 的 top:2 已错
        db.prepare("UPDATE matches SET status = 'finished', winner_team_id = team1_id WHERE stage_external_id = 's1'").run();
        res = await call(base, '/stages/10', { method: 'PUT', user: 1, body: { picks: { top: [1] } } });
        assert.equal(res.status, 409);
        res = await call(base, '/tournaments/1');
        const stage = res.data.stages[0];
        assert.equal(stage.locked, true);
        assert.equal(stage.distribution.top[1], 1);
        assert.equal(stage.teams.find(team => team.id === 1).wins, 1);
        const alice = res.data.leaderboard.find(row => row.username === 'alice');
        assert.equal(alice.points, 0);
        assert.equal(alice.decided, 0);
        const bob = res.data.leaderboard.find(row => row.username === 'bob');
        assert.equal(bob.decided, 1);
    });
});

test('API: admin can switch a stage off and configure an undetected one', async () => {
    const { app } = createApp();
    await withServer(app, async base => {
        let res = await call(base, '/admin/stages/10', { method: 'PUT', user: 1, body: { mode: 'off' } });
        assert.equal(res.status, 403);
        res = await call(base, '/admin/stages/10', { method: 'PUT', user: 3, body: { mode: 'off' } });
        assert.equal(res.status, 200);
        res = await call(base, '/admin/stages/11', { method: 'PUT', user: 3, body: { mode: 'record', config: { wins: 1, losses: 1, top_count: 1, bottom_count: 1, advance_count: 0 } } });
        assert.equal(res.status, 200);
        res = await call(base, '/admin/stages/11', { method: 'PUT', user: 3, body: { mode: 'record', config: { wins: 9 } } });
        assert.equal(res.status, 400);
        res = await call(base, '/tournaments/1');
        assert.deepEqual(res.data.stages.map(stage => stage.id), [11]);
        res = await call(base, '/admin/tournaments/1', { user: 3 });
        assert.equal(res.data.stages.length, 2);
        assert.equal(res.data.stages.find(stage => stage.id === 10).mode, 'off');
        res = await call(base, '/admin/stages/10', { method: 'PUT', user: 3, body: { mode: 'auto' } });
        res = await call(base, '/tournaments/1');
        assert.equal(res.data.stages.length, 2);
    });
});

test('coin tiers follow Valve-style 20% / 40% / 60% of the total max', () => {
    assert.deepEqual(pickem.coinThresholds(25).map(tier => tier.points), [5, 10, 15]);
    assert.deepEqual(pickem.coinThresholds(37).map(tier => tier.points), [8, 15, 23]);
    assert.equal(pickem.coinFor(0, 25, false), null);
    assert.deepEqual(pickem.coinFor(0, 25), { key: 'bronze', label: '铜币', next: { key: 'silver', label: '银币', need: 5 } });
    assert.deepEqual(pickem.coinFor(12, 25), { key: 'gold', label: '金币', next: { key: 'diamond', label: '钻石币', need: 3 } });
    assert.deepEqual(pickem.coinFor(15, 25), { key: 'diamond', label: '钻石币', next: null });
});
