const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGameStats, flipGameStats, durationSeconds } = require('../server/services/gridStats');

// 真实 GRID Open Access 数据（每个游戏取一局）：
//   lol  — Worlds 2026 半决赛 T1 vs BLG 第 1 局（T1=47494，BLG=356）
//   val  — VCT Champions 2026 决赛 Vitality vs LOUD 第 1 图（Vitality=90，LOUD=3412）
//   cs2  — CCT South America RED Canids Academy vs GREMIO 第 1 图（54069 / 57954）
const fixture = name => require(`./fixtures/grid-${name}-game.json`);

test('durationSeconds parses GRID ISO durations', () => {
    assert.equal(durationSeconds('PT30M21.243S'), 1821);
    assert.equal(durationSeconds('PT1H2M3S'), 3723);
    assert.equal(durationSeconds(null), null);
    assert.equal(durationSeconds('garbage'), null);
});

test('LoL game: draft, objectives and player lines oriented to local team1 = BLG', () => {
    const { game } = fixture('lol');
    const stats = normalizeGameStats('lol', game, '356', '47494');
    assert.equal(stats.status, 'finished');
    assert.equal(stats.winner, 'team1');
    assert.equal(stats.duration_s, 1821);

    assert.equal(stats.draft.length, 20);
    assert.deepEqual(stats.draft[0], { sequence: 1, type: 'ban', team: 'team2', champion: 'Renata Glasc' });
    assert.equal(stats.draft.filter(a => a.type === 'pick').length, 10);

    const blg = stats.teams.team1;
    const t1 = stats.teams.team2;
    assert.equal(blg.side, 'blue');
    assert.equal(t1.side, 'red');
    assert.deepEqual([blg.kills, t1.kills], [18, 6]);
    assert.deepEqual([blg.towers, t1.towers], [10, 3]);
    assert.deepEqual(blg.dragon_types, { hextech: 1, infernal: 2 });
    assert.equal(blg.dragons, 3);
    assert.deepEqual([blg.barons, blg.heralds, blg.grubs, blg.inhibitors], [1, 1, 3, 2]);
    assert.equal(blg.gold_diff, 7734);
    assert.equal(t1.gold_diff, -7734);

    assert.equal(stats.players.team1.length, 5);
    const viper = stats.players.team1.find(p => p.name === 'Viper');
    assert.equal(viper.champion, 'Corki');
    assert.deepEqual([viper.kills, viper.deaths, viper.assists], [6, 2, 7]);
    assert.equal(viper.cs, 225 + 26);
    assert.equal(viper.level, 15);
    assert.equal(viper.damage_share, 25.9);
    assert.ok(viper.items.includes('Trinity Force'));
    const oner = stats.players.team2.find(p => p.name === 'Oner');
    assert.equal(oner.jungle_cs, 174);
});

test('Valorant and CS2 maps: per-player K/D/A, ADR and headshot rate', () => {
    const val = normalizeGameStats('valorant', fixture('val').game, '3412', '90');
    assert.equal(val.map, 'summit');
    const rounds = val.teams.team1.rounds + val.teams.team2.rounds;
    assert.equal(rounds, 24);
    const chronicle = [...val.players.team1, ...val.players.team2].find(p => p.name === 'Chronicle');
    assert.equal(chronicle.agent, 'neon');
    assert.equal(chronicle.adr, Math.round((2187 / 24) * 10) / 10);
    assert.equal(chronicle.hs_pct, Math.round((15 / 18) * 1000) / 10);

    const cs = normalizeGameStats('cs2', fixture('cs2').game, '54069', '57954');
    assert.equal(cs.teams.team1.rounds, 13);
    assert.equal(cs.players.team1.length, 5);
    assert.equal(cs.players.team1[0].agent, undefined, 'CS2 sides are not agents');
    assert.ok(cs.players.team1.every(p => p.adr > 0));
});

test('unstarted games or unknown teams yield nothing; flipping swaps every side', () => {
    const { game } = fixture('lol');
    assert.equal(normalizeGameStats('lol', { ...game, started: false, finished: false }, '356', '47494'), null);
    assert.equal(normalizeGameStats('lol', game, '1', '2'), null);

    const stats = normalizeGameStats('lol', game, '356', '47494');
    const flipped = flipGameStats(stats);
    assert.equal(flipped.winner, 'team2');
    assert.equal(flipped.teams.team1.side, 'red');
    assert.equal(flipped.players.team2[0].name, stats.players.team1[0].name);
    assert.equal(flipped.draft[0].team, 'team1');
    assert.deepEqual(flipGameStats(flipped), stats);
});
