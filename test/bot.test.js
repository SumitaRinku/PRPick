const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const Database = require('better-sqlite3');
const { dailyDue, dailyReport, freshness, plan, midnight, splitMessage, messageMatchId, splitMatchMessage, roundOf, roundJobs, roundName, stakesIndex } = require('../bot/core');
const { tick, loadState, saveState, sendMessage } = require('../bot/run');
const { createBotRouter } = require('../server/routes/bot');
const { ensureBotSchema } = require('../server/config/bot-schema');

const stamp = time => Date.parse(time);
const config = { siteUrl: 'https://example.test', groupIds: ['123456'], games: ['cs2', 'valorant'],
    dayStart: '06:00', dailyTime: '12:00', earlyMinutes: 10, reminderMinutes: 30,
    weeklyEnabled: true, weeklyTime: '20:00', resultsLimit: 12, freshnessMinutes: 20 };
const now = stamp('2026-09-22T12:00:00+08:00');
function match(id, time, extra = {}) {
    return { id, tournament_id: 1, tournament_name: 'Test Cup', game_type: 'cs2',
        match_time: new Date(stamp(time)).toISOString(), time_confirmed: 1,
        team1_name: 'Alpha', team2_name: 'Beta', status: 'upcoming', format: 'BO3',
        team1_score: null, team2_score: null, external_source: null, ...extra };
}
function feed(matches = [], at = now) {
    return { version: 1, generated_at: new Date(at).toISOString(), matches,
        sync: ['cs2', 'valorant'].map(game_type => ({ game_type, last_success_at: new Date(at).toISOString() })), unavailable_ids: [] };
}

test('early daily ignores predawn, includes 06:00, and keeps noon boundary', () => {
    const day = midnight(now);
    assert.equal(dailyDue([match(1, '2026-09-22T02:00:00+08:00')], day, config), now);
    assert.equal(dailyDue([match(1, '2026-09-22T09:00:00+08:00')], day, config), stamp('2026-09-22T08:50:00+08:00'));
    assert.equal(dailyDue([match(1, '2026-09-22T06:00:00+08:00')], day, config), stamp('2026-09-22T05:50:00+08:00'));
    assert.equal(dailyDue([match(1, '2026-09-22T12:00:00+08:00')], day, config), now);
    assert.equal(dailyDue([match(1, '2026-09-22T09:00:00+08:00', { time_confirmed: 0 })], day, config), now);
    assert.equal(dailyDue([match(1, '2026-09-22T09:00:00+08:00', { status: 'cancelled' })], day, config), now);
});

test('daily includes next predawn, excludes next 06:00, and reports yesterday scores', () => {
    const report = dailyReport(feed([
        match(1, '2026-09-21T06:00:00+08:00', { status: 'finished', team1_score: 2, team2_score: 1 }),
        match(2, '2026-09-22T05:59:00+08:00', { status: 'finished', team1_score: 1, team2_score: 0, is_forfeit: 1 }),
        match(3, '2026-09-22T18:00:00+08:00'),
        match(4, '2026-09-23T05:59:00+08:00'),
        match(5, '2026-09-23T06:00:00+08:00', { team1_name: 'TomorrowMorning' })
    ]), config, now);
    assert.match(report.text, /Alpha 2:1 Beta/);
    assert.match(report.text, /Alpha 1:0 Beta（弃权）/);
    assert.match(report.text, /次日 09\/23 05:59/);
    assert.doesNotMatch(report.text, /TomorrowMorning/);
    assert.deepEqual(report.watched.map(m => m.id), [3, 4]);
});

test('no current fixtures falls back to future and pending results are never invented', () => {
    const report = dailyReport(feed([
        match(1, '2026-09-21T18:00:00+08:00', { status: 'finished' }),
        match(2, '2026-09-24T18:00:00+08:00')
    ]), config, now).text;
    assert.match(report, /赛果待更新/);
    assert.match(report, /今日无比赛，近期赛程/);
    assert.match(report, /09\/24 18:00/);
    assert.doesNotMatch(report, /null:null|0:0/);
});

test('only next predawn fixtures still generate today schedule', () => {
    const report = dailyReport(feed([match(1, '2026-09-23T02:00:00+08:00')]), config, now).text;
    assert.match(report, /次日 09\/23 02:00/);
    assert.doesNotMatch(report, /今日无比赛/);
});

test('05:50 schedules the correct calendar report; stale past fixtures do not remind', () => {
    const early = stamp('2026-09-22T05:50:00+08:00');
    const jobs = plan(feed([match(1, '2026-09-22T06:00:00+08:00')], early), config, early);
    assert.ok(jobs.some(job => job.key === 'daily:2026-09-22'));
    const excluded = [match(1, '2026-09-22T11:00:00+08:00'),
        match(2, '2026-09-22T12:20:00+08:00', { team1_name: 'TBD' }),
        match(3, '2026-09-22T12:20:00+08:00', { status: 'postponed' })];
    assert.equal(plan(feed(excluded), config, now).filter(job => job.kind === 'reminder').length, 0);
});

test('reminders include match ID, start time and format-valid command without repeated website links', () => {
    for (const [format, score] of [['BO1', '1:0'], ['BO3', '2:1'], ['BO5', '3:1']]) {
        const m = match(123, '2026-09-22T12:20:00+08:00', { format, betting_enabled: 1 });
        const reminder = plan(feed([m]), { ...config, commandsEnabled: true }, now).find(job => job.kind === 'reminder');
        assert.match(reminder.text, /^#123 09\/22 12:20  Alpha vs Beta（BO\d）$/m);
        assert.doesNotMatch(reminder.text, /竞猜截止|北京时间/);
        assert.ok(reminder.text.includes(`/pick 竞猜 123 ${score}`));
        assert.doesNotMatch(reminder.text, /https?:\/\//);
        const closed = plan(feed([{ ...m, betting_enabled: 0 }]), { ...config, commandsEnabled: true }, now).find(job => job.kind === 'reminder');
        assert.match(closed.text, /竞猜未开放/);
        assert.doesNotMatch(closed.text, /\/pick 竞猜|回复比分/);
    }
});

test('daily, weekly and schedule updates omit URLs and identify visible matches for replies', () => {
    const m = match(123, '2026-09-22T12:20:00+08:00');
    const report = dailyReport(feed([m]), config, now);
    assert.equal(messageMatchId(report.text, report.matchIds), 123);
    assert.doesNotMatch(report.text, /https?:\/\//);
    const changed = plan(feed([{ ...m, match_time: '2026-09-23T13:00:00+08:00' }]), config, now, { 123: m }).find(job => job.kind === 'change');
    assert.equal(messageMatchId(changed.text, changed.matchIds), 123);
    assert.doesNotMatch(changed.text, /https?:\/\//);
    const sunday = stamp('2026-09-27T20:00:00+08:00');
    const weekly = plan(feed([match(124, '2026-09-28T18:00:00+08:00')], sunday), config, sunday).find(job => job.kind === 'weekly');
    assert.doesNotMatch(weekly.text, /https?:\/\//);
    assert.equal(messageMatchId(weekly.text, weekly.matchIds), 124);
});

test('message-part match identity is unique, payload-backed and does not treat scores or continuations as IDs', () => {
    assert.equal(messageMatchId('#1 Alpha vs Beta\n#2 Gamma vs Delta', [1, 2]), null);
    assert.equal(messageMatchId('#1 Alpha vs Beta', [1, 2]), 1);
    assert.equal(messageMatchId('#99 not in payload', [1]), null);
    assert.equal(messageMatchId('alice 猜 2:1，猜中胜者，+2 分', [1]), null);
    assert.equal(messageMatchId('【比赛结算】\n#1 Test Cup\nAlpha 2:1 Beta', [1]), 1);
    assert.equal(messageMatchId('（2/3）\n#2 Gamma vs Delta', [1, 2]), 2);
    assert.equal(messageMatchId('#99 unexpected\n#1 actual', [1]), null);
    const parts = splitMatchMessage('#1 A vs B\n' + '玩家 猜 2:1，猜中胜者，+2 分\n'.repeat(90) + '#2 C vs D\n', [1, 2]);
    const continued = parts.find(part => part.text.includes('#2 C vs D'));
    assert.ok(continued.text.includes('玩家 猜'));
    assert.equal(continued.matchId, null, 'continuation of match 1 plus match 2 is ambiguous');
});

test('reminder command instructions appear only in groups with commands enabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prpick-reminder-groups-'));
    const sent = [];
    try {
        await tick({ ...config, groupIds: ['123456', '123457'], commandGroupIds: ['123456'] },
            loadState(path.join(dir, 'delivery.json')), path.join(dir, 'delivery.json'), {
                now, sleep: async () => {}, fetchFeed: async () => feed([match(123, '2026-09-22T12:20:00+08:00', { betting_enabled: 1 })]),
                sendMessage: async (c, group, text) => { sent.push({ group, text }); return { status: 'sent' }; }
            });
        const reminders = sent.filter(item => item.text.startsWith('【即将开赛'));
        assert.equal(reminders.length, 2);
        assert.match(reminders.find(item => item.group === '123456').text, /\/pick 竞猜 123 2:1/);
        assert.doesNotMatch(reminders.find(item => item.group === '123457').text, /\/pick/);
        assert.match(reminders.find(item => item.group === '123457').text, /可在网站竞猜/);
    } finally { fs.rmSync(dir, { recursive: true }); }
});

test('per-game freshness rejects missing and stale games', () => {
    const data = feed();
    data.sync[1].last_success_at = '2026-09-01T00:00:00Z';
    assert.deepEqual(freshness(data, config, now), ['valorant']);
    assert.deepEqual(freshness({ sync: [] }, config, now), ['cs2', 'valorant']);
});

test('weekly forecast triggers on Sunday only and expires after two hours', () => {
    const sunday = stamp('2026-09-27T20:00:00+08:00');
    assert.ok(plan(feed([], sunday), config, sunday).some(job => job.kind === 'weekly'));
    const monday = stamp('2026-09-28T20:00:00+08:00');
    assert.ok(!plan(feed([], monday), config, monday).some(job => job.kind === 'weekly'));
    const late = stamp('2026-09-27T22:01:00+08:00');
    assert.ok(!plan(feed([], late), config, late).some(job => job.kind === 'weekly'));
});

test('reschedule and disappearance generate explicit corrections for notified matches', () => {
    const old = match(1, '2026-09-22T18:00:00+08:00');
    const moved = match(1, '2026-09-24T18:00:00+08:00');
    assert.match(plan(feed([moved]), config, now, { 1: old }).find(job => job.kind === 'change').text, /09\/24 18:00/);
    const removed = feed(); removed.unavailable_ids = ['1'];
    assert.match(plan(removed, config, now, { 1: old }).find(job => job.kind === 'change').text, /下架/);
});

test('overrunning earlier series: slips stay silent, one reminder carries the latest and original time', () => {
    const kinds = (jobs, kind) => jobs.filter(job => job.kind === kind);
    const announced = match(7, '2026-09-22T12:30:00+08:00'); // listed in the 12:00 daily
    const at = (time, start, watched) => plan(feed([match(7, start)], stamp(time)), config, stamp(time), watched);
    // 12:30 → 12:40 before any reminder: no 【赛程更新】, the reminder shows the new time and the old one.
    let jobs = at('2026-09-22T12:15:00+08:00', '2026-09-22T12:40:00+08:00', { 7: announced });
    assert.equal(kinds(jobs, 'change').length, 0);
    const [reminder] = kinds(jobs, 'reminder');
    assert.match(reminder.text, /^【即将开赛】约 \d+ 分钟后，开赛时间已顺延$/m);
    assert.match(reminder.text, /^#7 09\/22 12:40  Alpha vs Beta（BO3）\n原定 09\/22 12:30 开赛$/m);
    assert.equal(messageMatchId(reminder.text, reminder.matchIds), 7);
    const reminded = { 7: { ...announced, ...reminder.watched[0] } };
    // 12:40 → 13:00 after the reminder: nothing at all.
    jobs = at('2026-09-22T12:35:00+08:00', '2026-09-22T13:00:00+08:00', reminded);
    assert.equal(jobs.filter(job => job.kind !== 'daily').length, 0);
    // 12:40 → 13:40 (60 min past the reminded time): exactly one fresh reminder, still no change message.
    jobs = at('2026-09-22T13:15:00+08:00', '2026-09-22T13:40:00+08:00', reminded);
    assert.equal(kinds(jobs, 'change').length, 0);
    assert.equal(kinds(jobs, 'reminder').length, 1);
    // Beyond the slip window, earlier starts and new opponents are still announced as changes.
    for (const moved of [match(7, '2026-09-22T16:00:00+08:00'), match(7, '2026-09-22T12:00:00+08:00'),
        match(7, '2026-09-22T12:40:00+08:00', { team2_name: 'Gamma' })]) {
        assert.equal(kinds(plan(feed([moved], stamp('2026-09-22T11:00:00+08:00')), config, stamp('2026-09-22T11:00:00+08:00'), { 7: announced }), 'change').length, 1);
    }
    // With reminders off there is nothing to fold a slip into, so it is announced.
    assert.equal(kinds(plan(feed([match(7, '2026-09-22T12:40:00+08:00')]), { ...config, reminderMinutes: 0 }, now, { 7: announced }), 'change').length, 1);
});

test('results say who advanced, dropped to the lower bracket or was eliminated', () => {
    assert.equal(roundName('Upper bracket semifinal'), '胜者组半决赛');
    assert.equal(roundName('Lower bracket round 1'), '败者组第1轮');
    assert.equal(roundName('Grand final'), '总决赛');
    const base = { game_type: 'cs2', tournament_id: 9, status: 'finished', match_time: '2026-11-02T04:00:00Z' };
    const m = (id, stage, name, t1, t2, s1, s2, extra = {}) => ({ ...base, id, stage_name: stage, name: `${name}: X vs Y`,
        team1_id: t1, team2_id: t2, team1_name: 'T' + t1, team2_name: 'T' + t2, team1_score: s1, team2_score: s2, ...extra });
    const swiss = [
        m(1, 'Swiss', 'Round 1', 1, 2, 2, 0), m(2, 'Swiss', 'Round 1', 3, 4, 2, 1),
        m(3, 'Swiss', 'Round 2', 1, 3, 2, 1), m(4, 'Swiss', 'Round 2', 2, 4, 0, 2),
        m(5, 'Swiss', 'Round 3', 1, 5, 2, 0, { team2_id: 9 }),
        m(6, 'Swiss', 'Round 3', 3, 4, null, null, { status: 'upcoming' })
    ];
    const playoff = [m(10, 'Playoffs', 'Upper bracket semifinal 1', 1, 3, 2, 1), m(11, 'Playoffs', 'Lower bracket final', 2, 4, 0, 2),
        m(12, 'Playoffs', 'Grand final', 1, 4, 3, 2)];
    const index = stakesIndex([...swiss.filter(x => x.id !== 5), ...playoff]);
    assert.deepEqual([index.get(10).label, index.get(10).win, index.get(10).lose], ['胜者组半决赛', '晋级', '落败者组']);
    assert.deepEqual([index.get(11).win, index.get(11).lose], ['晋级', '淘汰']);
    assert.deepEqual([index.get(12).win, index.get(12).lose], ['夺冠', '亚军']);
    assert.deepEqual([index.get(4).label, index.get(4).win, index.get(4).lose], ['瑞士轮第2轮', '1-1', '0-2']);
    assert.equal(index.get(6).pool, '1-1组');
    // Team 9 never played rounds 1-2, so round 3 pairs unequal records: the stage is not treated as Swiss.
    assert.equal(stakesIndex(swiss).get(1).win, undefined);
    // Eight teams: 2-0 vs 2-0 and 0-2 vs 0-2 in round 3 decide advance / elimination.
    const r = (id, n, t1, t2) => m(id, 'S2', `Round ${n}`, t1, t2, 2, 0);
    const eight = stakesIndex([r(21, 1, 1, 2), r(22, 1, 3, 4), r(23, 1, 5, 6), r(24, 1, 7, 8), r(25, 2, 1, 3), r(26, 2, 5, 7),
        r(27, 2, 2, 4), r(28, 2, 6, 8), r(29, 3, 1, 5), r(30, 3, 4, 8)]);
    assert.deepEqual([eight.get(29).win, eight.get(29).winTone, eight.get(30).lose, eight.get(30).tone], ['3-0 晋级', 'up', '0-3 淘汰', 'out']);
    // Daily text and image rows carry the tags.
    const at = Date.parse('2026-11-03T12:00:00+08:00');
    const report = dailyReport(feed([...swiss.slice(0, 4), ...playoff].map(x => ({ ...x, tournament_name: 'Cup', time_confirmed: 1, format: 'BO3' })), at),
        config, at);
    assert.match(report.text, /#10 T1 2:1 T3（胜者组半决赛）T3 落败者组/);
    assert.match(report.text, /#4 T2 0:2 T4（瑞士轮第2轮）战绩 T2 0-2，T4 1-1/);
    // Image: one per tournament; Swiss stage and playoffs share it. The list fallback names each round once, no tags.
    assert.equal(report.images.length, 1);
    const [{ bracket, card }] = report.images;
    assert.deepEqual(bracket.yesterday.sort((a, b) => a - b), [1, 2, 3, 4, 10, 11, 12]);
    assert.equal(card.theme, 'cs2');
    assert.deepEqual(card.items.filter(item => item.t === 'group').map(item => item.text),
        ['Swiss 瑞士轮第1轮', 'Swiss 瑞士轮第2轮', 'Playoffs 胜者组半决赛', 'Playoffs 败者组决赛', 'Playoffs 总决赛']);
    assert.ok(card.items.filter(item => item.t === 'row').every(row => !row.atag && !row.btag));
});

test('round names normalise to one round per stage', () => {
    const key = (name, stage = 'Playoffs') => roundOf(match(1, '2026-09-22T12:00:00+08:00', { name, stage_name: stage }));
    assert.equal(key('Upper bracket quarterfinal 1: A vs B').key, key('Upper bracket quarterfinal 4: C vs D').key);
    assert.equal(key('Lower bracket round 1 match 1: A vs B').key, key('Lower bracket round 1 match 2: C vs D').key);
    assert.notEqual(key('Round 1: A vs B', 'Group Stage').key, key('Round 2: A vs B', 'Group Stage').key);
    assert.notEqual(key('Round 1: A vs B', 'Stage 1 Swiss').key, key('Round 1: A vs B', 'Stage 2 Swiss').key);
    assert.equal(key('Upper bracket quarterfinal 2: A vs B').label, 'Playoffs 胜者组四分之一决赛');
    assert.equal(key('Round 2: A vs B', 'Round 2').label, 'Round 2');
    assert.equal(key('EACE vs MASQ', 'Regular Season').round, '');
});

test('finished rounds are posted once on the observed transition, bundled per stage', () => {
    const qf = (id, status, extra = {}) => match(id, `2026-09-22T1${id}:00:00+08:00`, { name: `Upper bracket quarterfinal ${id}: A vs B`, stage_name: 'Playoffs',
        status, ...(status === 'finished' ? { team1_score: 2, team2_score: 1 } : {}), ...extra });
    const lb = (status) => match(9, '2026-09-22T15:00:00+08:00', { name: 'Lower bracket round 1 match 1: C vs D', stage_name: 'Playoffs',
        status, ...(status === 'finished' ? { team1_score: 0, team2_score: 2 } : {}) });
    const league = status => match(20, '2026-09-22T14:00:00+08:00', { name: 'EACE vs MASQ', stage_name: 'Regular Season', status, team1_score: 1, team2_score: 0 });
    const at = stamp('2026-09-22T18:00:00+08:00');
    const seen = {};
    // Already finished when first seen (fresh install / upgrade): recorded, not posted.
    assert.equal(roundJobs(feed([qf(1, 'finished'), qf(2, 'finished')]), config, at, seen).length, 0);
    const fresh = {};
    assert.equal(roundJobs(feed([qf(1, 'finished'), qf(2, 'upcoming'), lb('ongoing'), league('upcoming')]), config, at, fresh).length, 0);
    const jobs = roundJobs(feed([qf(1, 'finished'), qf(2, 'finished'), lb('finished'), league('finished')]), config, at, fresh);
    assert.equal(jobs.length, 1, 'UB QF and LB R1 of one stage share one image; leagues are never tracked');
    assert.match(jobs[0].summary, /Playoffs 胜者组四分之一决赛、Playoffs 败者组第1轮已全部结束/);
    assert.deepEqual(jobs[0].bracket.matchIds.sort(), [1, 2, 9]);
    assert.match(jobs[0].text, /#1 Alpha 2:1 Beta/);
    assert.equal(roundJobs(feed([qf(1, 'finished'), qf(2, 'finished'), lb('finished')]), config, at, fresh).length, 0, 'no repeat');
    // Too old to be news (worker was offline for a day): recorded silently.
    const late = {};
    roundJobs(feed([qf(1, 'finished'), qf(2, 'upcoming')]), config, at, late);
    assert.equal(roundJobs(feed([qf(1, 'finished'), qf(2, 'finished')]), config, at + 2 * 86400000, late).length, 0);
});

test('worker posts a finished round to every group with one shared bracket image', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prpick-round-'));
    const file = path.join(dir, 'state.json');
    const at = stamp('2026-09-22T18:00:00+08:00');
    const round = status => [1, 2].map(id => match(id, `2026-09-22T1${id + 4}:00:00+08:00`, { name: `Semifinal ${id}: A vs B`, stage_name: 'Playoffs',
        status, ...(status === 'finished' ? { team1_score: 2, team2_score: 0 } : {}) }));
    const cfg = { ...config, groupIds: ['123456', '123457'], reminderMinutes: 0, weeklyEnabled: false, dailyTime: '23:00', roundImages: true };
    try {
        const specs = [], sent = [];
        const deps = { now: at, sleep: async () => {},
            renderImage: async (c, spec, out) => { specs.push(spec); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'png'); return 'site'; },
            sendMessage: async (c, group, text, image) => { sent.push({ group, text, image }); return { status: 'sent', messageId: String(sent.length) }; } };
        await tick(cfg, loadState(file), file, { ...deps, fetchFeed: async () => feed(round('upcoming'), at) });
        assert.equal(sent.length, 0);
        await tick(cfg, loadState(file), file, { ...deps, fetchFeed: async () => feed(round('finished'), at) });
        await tick(cfg, loadState(file), file, { ...deps, fetchFeed: async () => feed(round('finished'), at) });
        assert.equal(specs.length, 1);
        assert.equal(specs[0].bracket.tournamentId, 1);
        assert.deepEqual(sent.map(item => item.group), ['123456', '123457']);
        assert.ok(sent.every(item => item.image && /^【Test Cup 轮次结束】Playoffs 半决赛已全部结束/.test(item.text)));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('message splitting bounds text and labels all parts', () => {
    const parts = splitMessage(('测试赛程\n').repeat(1000));
    assert.ok(parts.length > 1);
    assert.ok(parts.every(part => part.length <= 1200));
    assert.match(parts[0], /^（1\//);
});

test('worker persists daily across restart and will not repeat it at noon after early send', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prpick-bot-'));
    const file = path.join(dir, 'state.json');
    try {
        const early = stamp('2026-09-22T08:50:00+08:00');
        const matches = [match(1, '2026-09-22T09:00:00+08:00')];
        let sends = 0;
        const deps = { now: early, fetchFeed: async () => feed(matches, early),
            sendMessage: async () => { sends++; return { status: 'sent', messageId: '1' }; }, sleep: async () => {} };
        const cfg = { ...config, reminderMinutes: 0 };
        await tick(cfg, loadState(file), file, deps);
        await tick(cfg, loadState(file), file, deps);
        await tick(cfg, loadState(file), file, { ...deps, now, fetchFeed: async () => feed(matches) });
        assert.equal(sends, 1);
    } finally { fs.rmSync(dir, { recursive: true }); }
});

test('image reports: one render shared by groups, summary + image in one message, text fallback on failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prpick-image-'));
    const file = path.join(dir, 'state.json');
    // Tournament 1 has no named rounds (list card); tournament 2 is a bracket (bracket image, list card as its fallback).
    const matches = [match(1, '2026-09-22T18:00:00+08:00'),
        match(2, '2026-09-22T20:00:00+08:00', { tournament_id: 2, tournament_name: 'Major', game_type: 'valorant', stage_name: 'Playoffs', name: 'Upper bracket final: A vs B' })];
    const cfg = { ...config, groupIds: ['123456', '123457'], reminderMinutes: 0, imageReports: true };
    try {
        const specs = [];
        const sent = [];
        const renderImage = async (c, spec, out) => { specs.push(spec); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'png'); };
        const deps = { now, fetchFeed: async () => feed(matches), renderImage, sleep: async () => {},
            sendMessage: async (c, group, text, image) => { sent.push({ group, text, image }); return { status: 'sent', messageId: String(sent.length) }; } };
        await tick(cfg, loadState(file), file, deps);
        await tick(cfg, loadState(file), file, deps);
        // One image per tournament, rendered once and shared by both groups.
        assert.equal(specs.length, 2);
        assert.deepEqual([specs[0].card.title, specs[0].card.theme, specs[0].bracket], ['Test Cup', 'cs2', undefined]);
        assert.deepEqual([specs[1].card.title, specs[1].bracket.theme, specs[1].bracket.today, specs[1].bracket.yesterday],
            ['Major', 'valorant', [2], []]);
        assert.equal(sent.length, 2);
        for (const item of sent) {
            assert.match(item.text, /^【2026-09-22 赛事日报】.*今日 2 场比赛/);
            assert.equal(item.image.length, 2);
            assert.ok(item.image.every(image => fs.existsSync(image)));
        }
        // Rendering unavailable (e.g. not Windows): the ordinary text report goes out instead.
        fs.rmSync(dir, { recursive: true }); fs.mkdirSync(dir);
        sent.length = 0;
        await tick(cfg, loadState(file), file, { ...deps, renderImage: async () => { throw new Error('no powershell'); } });
        assert.equal(sent.length, 2);
        assert.ok(sent.every(item => !item.image && item.text.includes('今日赛程')));
        // NapCat definitely rejects the image: that tick sends nothing more, the next sends the text version once.
        fs.rmSync(dir, { recursive: true }); fs.mkdirSync(dir);
        sent.length = 0;
        const rejecting = { ...deps, groupIds: undefined, sendMessage: async (c, group, text, image) => {
            sent.push({ group, text, image }); return image ? { status: 'failed', error: 'NapCat HTTP 400' } : { status: 'sent', messageId: 'x' }; } };
        const single = { ...cfg, groupIds: ['123456'] };
        await tick(single, loadState(file), file, rejecting);
        await tick(single, loadState(file), file, rejecting);
        await tick(single, loadState(file), file, rejecting);
        assert.deepEqual(sent.map(item => Boolean(item.image)), [true, false]);
        assert.match(sent[1].text, /今日赛程/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unknown delivery and crash during sending never retry automatically', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prpick-bot-'));
    const file = path.join(dir, 'state.json');
    try {
        let sends = 0;
        const deps = { now, fetchFeed: async () => feed(),
            sendMessage: async () => { sends++; return { status: 'unknown', error: 'timeout' }; }, sleep: async () => {} };
        await tick(config, loadState(file), file, deps);
        await tick(config, loadState(file), file, deps);
        assert.equal(sends, 1);
        const state = loadState(file);
        Object.values(state.jobs)[0].parts[0].status = 'sending';
        saveState(file, state);
        assert.equal(Object.values(loadState(file).jobs)[0].parts[0].status, 'unknown');
    } finally { fs.rmSync(dir, { recursive: true }); }
});

test('state save retries transient Windows rename locks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prpick-rename-'));
    const file = path.join(dir, 'state.json');
    const original = fs.renameSync;
    let calls = 0;
    try {
        saveState(file, { version: 1, jobs: {}, watched: {} });
        fs.renameSync = (from, to) => {
            calls++;
            if (calls <= 2) { const error = new Error('EPERM: operation not permitted'); error.code = 'EPERM'; throw error; }
            return original(from, to);
        };
        saveState(file, { version: 1, jobs: { job: { parts: [] } }, watched: {} });
    } finally { fs.renameSync = original; }
    assert.equal(calls, 3);
    assert.deepEqual(Object.keys(loadState(file).jobs), ['job']);
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
    fs.rmSync(dir, { recursive: true });
});

test('stale feed never sends an empty-day claim', async () => {
    let sends = 0;
    await assert.rejects(tick(config, { jobs: {}, watched: {} }, 'unused', {
        now, fetchFeed: async () => ({ ...feed(), sync: [] }),
        sendMessage: async () => { sends++; }
    }), /暂停发送/);
    assert.equal(sends, 0);
});

async function serve(app, fn) {
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try { await fn(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise(resolve => server.close(resolve)); }
}

test('OneBot send uses text segments and verifies retcode and message_id', async () => {
    const app = express(); app.use(express.json());
    let mode = 'ok';
    app.post('/send_group_msg', (req, res) => {
        assert.equal(req.get('authorization'), 'Bearer test-token');
        assert.equal(req.body.group_id, '123456');
        assert.deepEqual(req.body.message, [{ type: 'text', data: { text: '[CQ:at,qq=all]' } }]);
        res.json(mode === 'ok' ? { status: 'ok', retcode: 0, data: { message_id: 42 } }
            : mode === 'failed' ? { status: 'failed', retcode: 100 }
            : mode === 'timeout' ? { status: 'failed', retcode: 200, message: 'Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet:\n{}' }
            : { status: 'ok', retcode: 0 });
    });
    await serve(app, async napcatUrl => {
        const cfg = { napcatUrl, napcatToken: 'test-token' };
        assert.deepEqual(await sendMessage(cfg, '123456', '[CQ:at,qq=all]'), { status: 'sent', messageId: '42' });
        mode = 'failed'; assert.equal((await sendMessage(cfg, '123456', '[CQ:at,qq=all]')).status, 'failed');
        mode = 'incomplete'; assert.equal((await sendMessage(cfg, '123456', '[CQ:at,qq=all]')).status, 'unknown');
        // NapCat's own timeout waiting for QQ may still have delivered the message: never resend it.
        mode = 'timeout';
        const timedOut = await sendMessage(cfg, '123456', '[CQ:at,qq=all]');
        assert.equal(timedOut.status, 'unknown');
        assert.match(timedOut.error, /retcode=200/);
    });
});

test('bot API authenticates, returns over 200 fixtures, filters disabled and returns watched IDs outside window', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE matches(id INTEGER PRIMARY KEY, tournament_id INTEGER, name TEXT, match_time TEXT, status TEXT,
        format TEXT, stage_name TEXT, betting_enabled INTEGER, is_forfeit INTEGER, team1_id INTEGER,
        team2_id INTEGER, team1_score INTEGER, team2_score INTEGER, winner_team_id INTEGER, external_source TEXT, last_synced_at TEXT);
        CREATE TABLE tournaments(id INTEGER PRIMARY KEY, name TEXT, short_name TEXT, game_type TEXT, is_active INTEGER, logo_url TEXT);
        CREATE TABLE teams(id INTEGER PRIMARY KEY, name TEXT, logo_url TEXT, dark_logo_url TEXT);
        INSERT INTO tournaments VALUES(1, 'Cup', NULL, 'cs2', 1, NULL), (2, 'Disabled', NULL, 'cs2', 0, NULL);
        INSERT INTO teams VALUES(1, 'Alpha', 'https://cdn.test/a.png', NULL), (2, 'Beta', NULL, NULL);`);
    ensureBotSchema(db); ensureBotSchema(db);
    const insert = db.prepare(`INSERT INTO matches(id,tournament_id,match_time,team1_id,team2_id,status) VALUES(?,?,?,1,2,'upcoming')`);
    for (let id = 1; id <= 250; id++) insert.run(id, 1, '2026-09-22T18:00:00Z');
    insert.run(251, 2, '2026-09-22T18:00:00Z');
    insert.run(252, 1, '2026-10-20T18:00:00Z');
    let token = 'secret-token';
    const app = express(); app.use('/api/bot', createBotRouter(db, () => token));
    try {
        await serve(app, async base => {
            const url = `${base}/api/bot/schedule?from=2026-09-22T00:00:00Z&to=2026-09-23T00:00:00Z&ids=251,252,999`;
            assert.equal((await fetch(url)).status, 401);
            const headers = { Authorization: 'Bearer secret-token' };
            const response = await fetch(url, { headers });
            assert.equal(response.headers.get('cache-control'), 'no-store');
            const data = await response.json();
            assert.equal(data.matches.length, 251);
            assert.deepEqual(data.unavailable_ids, ['251', '999']);
            assert.ok(data.matches.some(m => m.id === 252));
            assert.equal(data.matches[0].team1_logo_url, 'https://cdn.test/a.png');
            assert.ok(Object.hasOwn(data.matches[0], 'name'));
            assert.equal((await fetch(`${base}/api/bot/schedule?from=bad&to=bad`, { headers })).status, 400);
            token = ''; assert.equal((await fetch(url, { headers })).status, 503);
        });
    } finally { db.close(); }
});

test('real schema and sync insert/update confirm source times and isolate partial game failures', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const load = (relative, extra = {}) => {
        const filename = path.resolve(__dirname, '..', relative);
        const nativeRequire = createRequire(filename);
        const module = { exports: {} };
        const context = { module, console: { log() {}, error() {} }, URL, AbortController, setTimeout, clearTimeout,
            process: { env: { ADMIN_PASSWORD: 'test-only-password', PANDASCORE_API_TOKEN: 'test-only-token' } },
            require(name) {
                if (['./database', '../config/database'].includes(name)) return db;
                if (name === '../utils/settlement') return { settleMatch: () => ({ changed: false }), recalculateUserScores() {} };
                return nativeRequire(name);
            }, ...extra };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
        return module.exports;
    };
    try {
        const init = load('server/config/init-db.js'); init.ensureDatabase(); init.ensureDatabase();
        let sourceTime = '2026-09-22T10:00:00Z';
        let failValorant = false;
        const service = load('server/services/pandascoreService.js', { fetch: async url => {
            if (String(url).includes('/valorant/')) return failValorant
                ? { ok: false, status: 401, text: async () => 'test failure' }
                : { ok: true, json: async () => [] };
            if (String(url).includes('/lol/')) return { ok: true, json: async () => [] };
            return { ok: true, json: async () => [{ id: 123, status: 'not_started', scheduled_at: sourceTime,
                serie: { id: 4, full_name: '2026' }, league: { id: 3, name: 'Test Cup' },
                opponents: [{ opponent: { id: 1, name: 'Alpha' } }, { opponent: { id: 2, name: 'Beta' } }] }] };
        } });
        assert.equal((await service.syncPandascoreMatches('cli')).status, 'success');
        let row = db.prepare('SELECT * FROM matches').get();
        assert.equal(row.time_confirmed, 1);
        assert.equal(row.match_time, '2026-09-22T10:00:00.000Z');
        assert.equal(db.prepare('SELECT count(*) n FROM bot_sync_state').get().n, 3); // cs2 / valorant / lol
        sourceTime = null;
        failValorant = true;
        db.prepare("UPDATE bot_sync_state SET last_success_at = '2000-01-01T00:00:00Z' WHERE game_type = 'valorant'").run();
        assert.equal((await service.syncPandascoreMatches('cli')).status, 'partial');
        row = db.prepare('SELECT * FROM matches').get();
        assert.equal(row.time_confirmed, 0);
        assert.equal(db.prepare("SELECT last_success_at FROM bot_sync_state WHERE game_type='valorant'").get().last_success_at, '2000-01-01T00:00:00Z');
        sourceTime = '2026-09-22T11:00:00Z';
        await service.syncPandascoreMatches('cli');
        row = db.prepare('SELECT * FROM matches').get();
        assert.equal(row.time_confirmed, 1);
        assert.equal(row.match_time, '2026-09-22T11:00:00.000Z');
    } finally { db.close(); }
});
