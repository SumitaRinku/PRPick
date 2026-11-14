const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { autoActivates, gameUnit, gameKeys } = require('../server/config/games');
const { TIER_SQL } = require('../server/services/tournamentTier');

test('LoL international events and the four major leagues are switched on when first synced', () => {
    for (const league of ['Worlds', 'MSI', 'First Stand', 'LPL', 'LCK', 'LEC', 'LCS', 'lpl']) assert.ok(autoActivates('lol', league), league);
    for (const league of ['LCK Challengers League', 'EMEA Masters', 'CBLOL', 'World Star Challengers Invitational', '', null]) {
        assert.equal(autoActivates('lol', league), false, String(league));
    }
    // CS2 / Valorant keep the old behaviour: every new event waits for an admin
    assert.equal(autoActivates('cs2', 'IEM'), false);
    assert.equal(autoActivates('valorant', 'VCT Champions'), false);
});

test('LoL games are called 局, maps elsewhere', () => {
    assert.deepEqual(gameKeys(), ['cs2', 'valorant', 'lol']);
    assert.equal(gameUnit('lol'), '局');
    assert.equal(gameUnit('cs2'), '图');
    assert.equal(gameUnit('unknown'), '图');
});

test('LoL tournament tiers follow the registry keywords', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE tournaments (id INTEGER PRIMARY KEY, name TEXT, game_type TEXT, tier INTEGER)');
    const insert = db.prepare('INSERT INTO tournaments (name, game_type) VALUES (?, ?)');
    const cases = [
        ['Worlds 2026', 'lol', 1], ['MSI 2027', 'lol', 1], ['First Stand 2027', 'lol', 1],
        ['LPL Split 1 2027', 'lol', 2], ['LCK Challengers League 2027', 'lol', 2],
        ['Worlds 2026 Qualifier', 'lol', 3],
        // CS2 Major stays CS2-only: a LoL event called "Major" is not top tier
        ['Some Major', 'lol', 2], ['Some Major', 'cs2', 1]
    ];
    for (const [name, game] of cases) insert.run(name, game);
    const rows = db.prepare(`SELECT name, game_type, ${TIER_SQL} tier FROM tournaments t ORDER BY id`).all();
    assert.deepEqual(rows.map(row => [row.name, row.game_type, row.tier]), cases);
});
