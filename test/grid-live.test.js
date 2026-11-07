const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3');
const { normalizeTeamName, teamSimilarity, pickSeriesForMatch, orientSeriesState } = require('../server/services/gridMatching');

function gridSeries(id, time, [a, b]) {
    return {
        id: String(id),
        startTimeScheduled: time,
        teams: [{ baseInfo: { id: a[0], name: a[1], nameShortened: '' } }, { baseInfo: { id: b[0], name: b[1], nameShortened: '' } }]
    };
}

test('normalizeTeamName strips noise words, accents and applies aliases', () => {
    assert.equal(normalizeTeamName('Natus Vincere'), 'natusvincere');
    assert.equal(normalizeTeamName('NAVI'), 'natusvincere');
    assert.equal(normalizeTeamName('NAVI Junior'), 'natusvincerejunior');
    assert.equal(normalizeTeamName('  Team Spirit '), 'spirit');
    assert.equal(normalizeTeamName('Sökerorg'), 'sokerorg');
    assert.equal(normalizeTeamName('PARIVISION Esports'), 'parivision');
});

test('teamSimilarity keeps academy / junior rosters apart', () => {
    assert.equal(teamSimilarity(['NAVI'], ['Natus Vincere']), 1);
    assert.ok(teamSimilarity(['Phantom'], ['Phantom Academy']) < 0.8);
    assert.ok(teamSimilarity(['G2'], ['G2 Ares']) < 0.8);
    assert.ok(teamSimilarity(['Four Magic'], ['Four Magic Gaming']) >= 0.8);
});

test('pickSeriesForMatch handles swapped order and prefers the closest start time', () => {
    const match = { team1_name: 'Natus Vincere', team1_short_name: 'NAVI', team2_name: 'PARIVISION', team2_short_name: null, match_time: '2026-11-06T06:30:00Z' };
    const series = [
        gridSeries(1, '2026-11-06T09:30:00Z', [['51814', 'Natus Vincere'], ['52389', 'Parivision']]),
        gridSeries(2, '2026-11-06T06:30:00Z', [['52389', 'Parivision'], ['51814', 'Natus Vincere']]),
        gridSeries(3, '2026-11-06T06:30:00Z', [['1', 'Other'], ['2', 'Team']])
    ];
    const pick = pickSeriesForMatch(match, series);
    assert.equal(pick.series.id, '2');
    assert.equal(pick.team1GridId, '51814');
    assert.equal(pick.team2GridId, '52389');

    assert.equal(pickSeriesForMatch(match, series, { excludeSeriesIds: new Set(['1', '2']) }), null);
    assert.equal(pickSeriesForMatch({ ...match, match_time: '2026-11-07T06:30:00Z' }, series), null);
});

test('orientSeriesState maps GRID teams onto local team1/team2', () => {
    const state = {
        started: true,
        finished: false,
        updatedAt: '2026-11-06T08:00:00Z',
        teams: [{ id: '52389', score: 1 }, { id: '51814', score: 0 }],
        games: [
            { sequenceNumber: 1, started: true, finished: true, map: { name: 'mirage' }, teams: [{ id: '52389', won: true, score: 16 }, { id: '51814', won: false, score: 14 }] },
            { sequenceNumber: 2, started: true, finished: false, map: { name: 'inferno' }, teams: [{ id: '52389', score: 3 }, { id: '51814', score: 5 }] },
            { sequenceNumber: 3, started: false, finished: false, map: null, teams: [] }
        ]
    };
    const oriented = orientSeriesState(state, '51814', '52389');
    assert.equal(oriented.team1Score, 0);
    assert.equal(oriented.team2Score, 1);
    assert.deepEqual(oriented.games, [
        { sequence: 1, mapName: 'mirage', team1Rounds: 14, team2Rounds: 16, status: 'finished', winner: 'team2' },
        { sequence: 2, mapName: 'inferno', team1Rounds: 5, team2Rounds: 3, status: 'ongoing', winner: null }
    ]);
    assert.equal(orientSeriesState(state, '51814', '999'), null);
});

test('orientVeto turns GRID draft actions into bans, picks, side choices and the decider', () => {
    // IEM Beijing 2026 NAVI vs PARIVISION 的真实 draftActions（GRID series 3019595）
    const act = (seq, type, drafter, drafterType, name, draftableType = 'map') => ({ type, sequenceNumber: String(seq), drafter: { id: drafter, type: drafterType }, draftable: { type: draftableType, name } });
    const actions = [
        act(9, 'pick', '3019595', 'series', 'ancient'),
        act(1, 'ban', '51814', 'team', 'dust2'),
        act(2, 'ban', '52389', 'team', 'nuke'),
        act(3, 'pick', '51814', 'team', 'mirage'),
        act(4, 'pick', '52389', 'team', 'counter-terrorists', 'side'),
        act(5, 'pick', '52389', 'team', 'inferno'),
        act(6, 'pick', '51814', 'team', 'counter-terrorists', 'side'),
        act(7, 'ban', '51814', 'team', 'cache'),
        act(8, 'ban', '52389', 'team', 'anubis')
    ];
    // 本地 team1 = PARIVISION，验证方向翻转
    const veto = require('../server/services/gridMatching').orientVeto(actions, '52389', '51814');
    assert.deepEqual(veto, [
        { sequence: 1, type: 'ban', map: 'dust2', team: 'team2' },
        { sequence: 2, type: 'ban', map: 'nuke', team: 'team1' },
        { sequence: 3, type: 'pick', map: 'mirage', team: 'team2', side: { team: 'team1', side: 'ct' } },
        { sequence: 4, type: 'pick', map: 'inferno', team: 'team1', side: { team: 'team2', side: 'ct' } },
        { sequence: 5, type: 'ban', map: 'cache', team: 'team2' },
        { sequence: 6, type: 'ban', map: 'anubis', team: 'team1' },
        { sequence: 7, type: 'decider', map: 'ancient', team: null }
    ]);
});

// ===== 服务层：内存库 + 模拟 fetch =====

function loadModule(relative, db, fetchImpl, env = {}) {
    const filename = path.resolve(__dirname, '..', relative);
    const module = { exports: {} };
    const nativeRequire = createRequire(filename);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module,
        __dirname: path.dirname(filename),
        Buffer, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
        fetch: fetchImpl,
        process: { env: { ADMIN_PASSWORD: 'test-password-only', GRID_API_TOKEN: 'test-key', ...env } },
        console: { log() {}, warn() {}, error() {} },
        require(name) {
            if (['./database', '../config/database'].includes(name)) return db;
            if (name === '../utils/settlement') return { settleMatch() {}, recalculateUserScores() {} };
            if (name === './gridMatching') return require('../server/services/gridMatching');
            return nativeRequire(name);
        }
    }, { filename });
    return module.exports;
}

function jsonResponse(data, { status = 200, headers = {} } = {}) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { status, ok: status < 400, headers: { get: name => lower[name.toLowerCase()] ?? null }, json: async () => data };
}

function fixture(handlers, env = {}) {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const calls = [];
    const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        const handler = url.includes('series-state') ? handlers.state : handlers.central;
        return handler(body, calls.length);
    };
    loadModule('server/config/init-db.js', db, fetchImpl).ensureDatabase();
    const soon = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO tournaments(id, name, game_type, is_active) VALUES(1, 'IEM', 'cs2', 1)").run();
    db.prepare("INSERT INTO teams(id, name, short_name, game_type) VALUES(1, 'Natus Vincere', 'NAVI', 'cs2'), (2, 'PARIVISION', NULL, 'cs2'), (3, 'MOUZ', NULL, 'cs2')").run();
    db.prepare("INSERT INTO matches(id, tournament_id, team1_id, team2_id, format, match_time, status) VALUES(1, 1, 1, 2, 'BO3', ?, 'ongoing')").run(soon);
    const service = loadModule('server/services/gridLiveService.js', db, fetchImpl, env);
    return { db, service, calls, soon };
}

const liveState = {
    id: '900', started: true, finished: false, updatedAt: '2026-11-06T08:00:00Z',
    teams: [{ id: '52389', score: 0 }, { id: '51814', score: 1 }],
    games: [
        { sequenceNumber: 1, started: true, finished: true, map: { name: 'mirage' }, teams: [{ id: '52389', won: false, score: 9 }, { id: '51814', won: true, score: 13 }] },
        { sequenceNumber: 2, started: true, finished: false, map: { name: 'dust2' }, teams: [{ id: '52389', score: 4 }, { id: '51814', score: 6 }] }
    ]
};

test('tick links a local match, stores live state and exposes it oriented to the match', async () => {
    const { db, service, soon } = fixture({
        central: () => jsonResponse({ data: { allSeries: { pageInfo: { hasNextPage: false }, edges: [{ node: gridSeries(900, soon, [['52389', 'Parivision'], ['51814', 'Natus Vincere']]) }] } } }),
        state: () => jsonResponse({ data: { seriesState: liveState } })
    });

    const result = await service.runGridLiveTick('manual', { forceDiscovery: true });
    assert.equal(result.discovery.linked, 1);
    assert.equal(result.poll.updated, 1);

    const [match] = service.attachLiveScores([{ id: 1, team1_id: 1, team2_id: 2 }]);
    assert.equal(match.live.team1_score, 1);
    assert.equal(match.live.team2_score, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(match.live.games.map(g => [g.map, g.team1_rounds, g.team2_rounds, g.status, g.winner]))), [
        ['mirage', 13, 9, 'finished', 'team1'],
        ['dust2', 6, 4, 'ongoing', null]
    ]);

    // PandaScore 之后对调主客队：读取时自动翻转
    const [flipped] = service.attachLiveScores([{ id: 1, team1_id: 2, team2_id: 1 }]);
    assert.equal(flipped.live.team1_score, 0);
    assert.equal(flipped.live.games[0].winner, 'team2');
    assert.equal(flipped.live.games[0].team1_rounds, 9);

    // 本地对阵换了队伍：自动关联被解除，等待重新配对
    db.prepare('UPDATE matches SET team2_id = 3 WHERE id = 1').run();
    const again = await service.runGridLiveTick('manual');
    assert.equal(again.poll.unlinked, 1);
    assert.equal(service.getLink(1), null);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM match_games').get().c, 0);
});

test('429 from series-state stops the tick and backs off', async () => {
    let stateCalls = 0;
    const { service, soon } = fixture({
        central: () => jsonResponse({ data: { allSeries: { pageInfo: { hasNextPage: false }, edges: [{ node: gridSeries(900, soon, [['52389', 'Parivision'], ['51814', 'Natus Vincere']]) }] } } }),
        state: () => { stateCalls++; return jsonResponse({}, { status: 429, headers: { 'Retry-After': 30 } }); }
    });
    const first = await service.runGridLiveTick('manual', { forceDiscovery: true });
    assert.equal(first.status, 'partial');
    assert.match(first.poll.errors[0], /429/);
    const second = await service.runGridLiveTick('manual');
    assert.equal(stateCalls, 1, 'backoff should prevent a second request');
    assert.match(second.poll.errors[0], /限流/);
});

test('blocked matches are not auto-linked again', async () => {
    const { service, soon } = fixture({
        central: () => jsonResponse({ data: { allSeries: { pageInfo: { hasNextPage: false }, edges: [{ node: gridSeries(900, soon, [['52389', 'Parivision'], ['51814', 'Natus Vincere']]) }] } } }),
        state: () => jsonResponse({ data: { seriesState: null } })
    });
    service.unlinkMatch(1, { block: true });
    const result = await service.runGridLiveTick('manual', { forceDiscovery: true });
    assert.equal(result.discovery.candidates, 0);
    assert.equal(service.getLink(1).link_method, 'none');
    assert.equal(service.attachLiveScores([{ id: 1, team1_id: 1, team2_id: 2 }])[0].live, undefined);
});

test('manual links are polled even when the match is outside the lookback window', async () => {
    const series = gridSeries(900, '2026-01-01T00:00:00Z', [['52389', 'Parivision'], ['51814', 'Natus Vincere']]);
    const { db, service } = fixture({
        central: body => jsonResponse({ data: body.query.includes('series(id') ? { series } : { allSeries: { pageInfo: { hasNextPage: false }, edges: [] } } }),
        state: () => jsonResponse({ data: { seriesState: { ...liveState, finished: true } } })
    });
    db.prepare("UPDATE matches SET match_time = ?, status = 'finished' WHERE id = 1").run(new Date(Date.now() - 40 * 3600e3).toISOString());
    const link = await service.linkMatchToSeries(1, '900');
    assert.equal(link.link_method, 'manual');
    const result = await service.runGridLiveTick('manual');
    assert.equal(result.poll.updated, 1);
    assert.equal(service.getLink(1).finished, 1);
});

test('matches in tournaments the admin has not switched on are never polled', async () => {
    let stateCalls = 0;
    const { db, service, soon } = fixture({
        central: () => jsonResponse({ data: { allSeries: { pageInfo: { hasNextPage: false }, edges: [{ node: gridSeries(900, soon, [['52389', 'Parivision'], ['51814', 'Natus Vincere']]) }] } } }),
        state: () => { stateCalls++; return jsonResponse({ data: { seriesState: liveState } }); }
    });
    await service.runGridLiveTick('manual', { forceDiscovery: true });
    assert.equal(stateCalls, 1);
    db.prepare('UPDATE tournaments SET is_active = 0 WHERE id = 1').run();
    const result = await service.runGridLiveTick('manual', { forceDiscovery: true });
    assert.equal(result.poll.polled, 0);
    assert.equal(stateCalls, 1);
});

test('a newly started match is polled even when live matches already fill the budget', async () => {
    const polledIds = [];
    const { db, service, soon } = fixture({
        central: () => jsonResponse({ data: { allSeries: { pageInfo: { hasNextPage: false }, edges: [] } } }),
        state: body => { polledIds.push(body.variables.id); return jsonResponse({ data: { seriesState: null } }); }
    }, { GRID_STATE_BUDGET: '1' });
    db.prepare("INSERT INTO matches(id, tournament_id, team1_id, team2_id, format, match_time, status) VALUES(2, 1, 3, 2, 'BO3', ?, 'ongoing')").run(soon);
    const insert = db.prepare("INSERT INTO match_live_links (match_id, series_id, link_method, team1_id, team_map, started, last_polled_at, linked_at) VALUES (?, ?, 'auto', ?, '{}', ?, ?, ?)");
    // 比赛 1 已在进行中、刚拉取过；比赛 2 刚关联、从未拉取
    insert.run(1, '901', 1, 1, new Date().toISOString(), soon);
    insert.run(2, '902', 3, 0, null, soon);
    await service.runGridLiveTick('manual');
    assert.deepEqual(polledIds, ['902']);
    await service.runGridLiveTick('manual');
    assert.deepEqual(polledIds, ['902', '901']);
});
