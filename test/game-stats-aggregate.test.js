const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGameStats } = require('../server/services/gridStats');
const { aggregateTournamentStats } = require('../server/services/gameStatsAggregate');

const BLG = { id: 1, name: 'Bilibili Gaming', short_name: 'BLG' };
const T1 = { id: 2, name: 'T1', short_name: 'T1' };

test('LoL tournament stats roll up teams, players and champion presence', () => {
    const { game } = require('./fixtures/grid-lol-game.json');
    const stats = normalizeGameStats('lol', game, '356', '47494');
    // 同一局算两次（模拟两局同样的结果）
    const result = aggregateTournamentStats('lol', [{ match_id: 1, team1: BLG, team2: T1, stats }, { match_id: 1, team1: BLG, team2: T1, stats: { ...stats, sequence: 2 } }]);
    assert.equal(result.games, 2);
    const blg = result.teams.find(t => t.id === 1);
    assert.deepEqual([blg.games, blg.wins, blg.win_rate, blg.kills_pg, blg.blue.wins], [2, 2, 100, 18, 2]);
    assert.equal(result.teams.find(t => t.id === 2).red.games, 2);
    const viper = result.players.find(p => p.name === 'Viper');
    assert.equal(viper.team.id, 1);
    assert.equal(viper.kda, round2((6 + 7) / 2));
    assert.deepEqual(viper.champions, [{ name: 'Corki', games: 2, wins: 2 }]);
    const corki = result.champions.find(c => c.name === 'Corki');
    assert.deepEqual([corki.picks, corki.wins, corki.presence], [2, 2, 100]);
    const banned = result.champions.find(c => c.name === 'Renata Glasc');
    assert.equal(banned.bans, 2);
    assert.equal(banned.win_rate, null);
});

test('shooter stats weight ADR by rounds and skip unfinished maps', () => {
    const { game } = require('./fixtures/grid-val-game.json');
    const LOUD = { id: 3, name: 'LOUD' };
    const VIT = { id: 4, name: 'Team Vitality', short_name: 'VIT' };
    const stats = normalizeGameStats('valorant', game, '3412', '90');
    const result = aggregateTournamentStats('valorant', [
        { match_id: 5, team1: LOUD, team2: VIT, stats },
        { match_id: 5, team1: LOUD, team2: VIT, stats: { ...stats, status: 'ongoing' } }
    ]);
    assert.equal(result.games, 1);
    const chronicle = result.players.find(p => p.name === 'Chronicle');
    assert.equal(chronicle.adr, Math.round((2187 / 24) * 10) / 10);
    assert.equal(chronicle.agents[0].name, 'neon');
    assert.equal(chronicle.hs_pct, null);
    assert.equal(result.maps[0].name, 'summit');
    const loud = result.teams.find(t => t.id === 3);
    assert.equal(loud.rounds_won + loud.rounds_lost, 24);
});

function round2(value) { return Math.round(value * 100) / 100; }
