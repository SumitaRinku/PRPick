const crypto = require('node:crypto');
const DAY = 86400000;
const OFFSET = 8 * 3600000; // Beijing has no DST.
const iso = ms => new Date(ms).toISOString();
const dateKey = ms => new Date(ms + OFFSET).toISOString().slice(0, 10);
const midnight = ms => Date.parse(`${dateKey(ms)}T00:00:00+08:00`);
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const at = (day, time) => day + minutes(time) * 60000;
const label = ms => new Date(ms + OFFSET).toISOString().slice(5, 16).replace('T', ' ').replace('-', '/');
const clean = value => String(value || '').replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 160);
const gameLabel = game => game === 'cs2' ? 'CS2' : 'Valorant';
const tournamentName = m => clean(m.tournament_short_name || m.tournament_name);
// Text headings name the game after the tournament: "IEM Cologne（CS2）".
const title = m => `${tournamentName(m)}（${gameLabel(m.game_type)}）`;
// Image headings show the tournament logo beside its name. Only admin uploads (/uploads/) are passed on;
// the report page resolves the site's curated logos from the full name (public/js/tournament-logos.js).
const brand = m => ({ name: tournamentName(m), fullName: clean(m.tournament_name), game: m.game_type,
    logo: typeof m.tournament_logo_url === 'string' && /^\/uploads\//.test(m.tournament_logo_url) ? m.tournament_logo_url.slice(0, 500) : '' });
const versus = m => `${clean(m.team1_name)} vs ${clean(m.team2_name)}`;
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const snapshot = m => ({ id: m.id, match_time: m.match_time, team1_name: m.team1_name,
    team2_name: m.team2_name, status: m.status, game_type: m.game_type,
    tournament_name: m.tournament_name, time_confirmed: m.time_confirmed });
const isFixture = m => m.time_confirmed === 1 && !['cancelled', 'postponed'].includes(m.status);
const between = (m, start, end) => Date.parse(m.match_time) >= start && Date.parse(m.match_time) < end;

function bounds(now, config, day = midnight(now)) {
    const start = at(day, config.dayStart);
    return { day, start, end: start + DAY, previous: start - DAY };
}

function dailyDue(matches, day, config) {
    const normal = at(day, config.dailyTime);
    const early = matches.filter(m => isFixture(m) && between(m, at(day, config.dayStart), normal));
    return early.length ? Math.min(...early.map(m => Date.parse(m.match_time))) - config.earlyMinutes * 60000 : normal;
}

function freshness(feed, config, now) {
    const maxAge = config.freshnessMinutes * 60000;
    return config.games.filter(game => {
        const stamp = feed.sync.find(row => row.game_type === game)?.last_success_at;
        const age = now - Date.parse(stamp);
        return !Number.isFinite(age) || age < -60000 || age > maxAge;
    });
}

function splitMessage(text, max = 1200) {
    const parts = [];
    let current = '';
    for (const line of text.split('\n')) {
        // Also bound unusually long individual lines.
        for (let offset = 0; offset < Math.max(1, line.length); offset += max - 30) {
            const piece = line.slice(offset, offset + max - 30);
            if (current.length + piece.length + 1 > max - 30) { parts.push(current); current = ''; }
            current += (current ? '\n' : '') + piece;
        }
    }
    if (current) parts.push(current);
    return parts.length > 1 ? parts.map((part, i) => `（${i + 1}/${parts.length}）\n${part}`) : parts;
}

// Match only IDs present in the trusted payload and visibly identified in this exact message part.
function messageMatchId(text, matchIds = []) {
    const allowed = new Set(matchIds.map(String));
    const found = new Set([...String(text).matchAll(/(?:^#|^竞猜已(?:提交|修改)：#|^已取消 #)([1-9]\d{0,14})(?=\s|$)/gm)]
        .map(match => match[1]));
    return found.size === 1 && allowed.has([...found][0]) ? Number([...found][0]) : null;
}

function splitMatchMessage(text, matchIds = []) {
    const multiple = new Set(matchIds.map(String)).size > 1;
    return splitMessage(text).map((text, index) => {
        const content = text.replace(/^（\d+\/\d+）\n/, '');
        // A continuation can contain the tail of another match before its first visible ID.
        const startsMatch = /^(?:#[1-9]\d*\s|【[^\n】]*】\n#[1-9]\d*\s)/.test(content);
        return { text, matchId: index && multiple && !startsMatch ? null : messageMatchId(text, matchIds) };
    });
}

function fixtureLine(m, now, reportDay, stakes = {}) {
    const time = Date.parse(m.match_time);
    const nextDay = reportDay !== undefined && midnight(time) > reportDay;
    const status = m.status === 'finished' ? '，已结束' : m.status === 'ongoing' ? '，进行中'
        : time <= now ? '，已过计划时间' : '';
    const details = [m.format, roundText(stakes)].filter(Boolean).join(' ');
    return `#${m.id} ${nextDay ? '次日 ' : ''}${label(time)}  ${versus(m)}（${details}）${status}`;
}

// "瑞士轮第2轮（1-0组）": the Swiss pool reads as a note on its round.
function roundText(stakes) {
    return stakes.label && stakes.pool ? `${stakes.label}（${stakes.pool}）` : stakes.label || stakes.pool || '';
}

// Structured twin of fixtureLine / result lines, used to draw the image version of a report.
function fixtureRow(m, now, reportDay, stakes = {}) {
    const time = Date.parse(m.match_time);
    const nextDay = reportDay !== undefined && midnight(time) > reportDay;
    const status = m.status === 'finished' ? '已结束' : m.status === 'ongoing' ? '进行中' : time <= now ? '已过计划时间' : '';
    // The daily card header already carries the date, so rows show HH:mm (次日 for after-midnight).
    const when = reportDay === undefined ? label(time) : `${nextDay ? '次日 ' : ''}${label(time).slice(6)}`;
    // format / status are drawn as separate pieces; meta is the plain-text form for the basic renderer.
    return { t: 'row', id: m.id, time: when, ...teams(m), mid: 'vs', format: m.format, status,
        meta: [m.format, status].filter(Boolean).join(' '), round: roundText(stakes), win: 0 };
}

function resultRow(m, stakes = {}) {
    const win = m.team1_score > m.team2_score ? 1 : m.team2_score > m.team1_score ? 2 : 0;
    const tag = side => !win || !stakes.win ? null : side === win ? { text: stakes.win, tone: stakes.winTone || 'up' } : { text: stakes.lose, tone: stakes.tone || 'out' };
    return { t: 'row', id: m.id, time: '', ...teams(m), mid: `${m.team1_score}:${m.team2_score}`,
        status: m.is_forfeit ? '弃权' : '', meta: m.is_forfeit ? '弃权' : '', round: stakes.label || '', atag: tag(1), btag: tag(2), win };
}

// Text twin: "#1 A 2:0 B（胜者组半决赛）B 落败者组"
function resultLine(m, stakes = {}) {
    const row = resultRow(m, stakes);
    const tags = [[row.a, row.atag], [row.b, row.btag]].filter(([, tag]) => tag && tag.tone !== 'up' && tag.tone !== 'record').map(([name, tag]) => `${name} ${tag.text}`);
    const records = stakes.pool && row.atag ? `战绩 ${row.a} ${row.atag.text}，${row.b} ${row.btag.text}` : '';
    const notes = [row.round, m.is_forfeit && '弃权'].filter(Boolean).join('，');
    const outcome = records || tags.join('，');
    return `#${m.id} ${row.a} ${m.team1_score}:${m.team2_score} ${row.b}${notes ? `（${notes}）` : outcome ? ' ' : ''}${outcome}`;
}

// Only http(s) or site-relative logo URLs reach the report page (it proxies them through /api/images).
const logoUrl = url => typeof url === 'string' && /^(https?:\/\/|\/(?!\/))/.test(url) ? url.slice(0, 500) : '';
const teams = m => ({ a: clean(m.team1_name), b: clean(m.team2_name), alogo: logoUrl(m.team1_logo_url), blogo: logoUrl(m.team2_logo_url) });

// "Upper bracket quarterfinal 2" / "Lower bracket round 1 match 1" / "Round 3" → one round per stage.
function roundOf(m) {
    const name = String(m.name || '');
    let round = name.includes(':') ? name.slice(0, name.indexOf(':')).trim() : '';
    round = round.replace(/\s+match\s+\d+$/i, '');
    if (!/round\s+\d+$/i.test(round)) round = round.replace(/\s+\d+$/, '');
    const stage = clean(m.stage_name).trim();
    const label = stage && round && stage.toLowerCase() !== round.toLowerCase() ? `${stage} ${roundName(round)}` : stage || roundName(round) || '本阶段';
    return { key: `${m.game_type}:${m.tournament_id}|${stage.toLowerCase()}|${round.toLowerCase()}`, stage, round, label: clean(label) };
}

// "Upper bracket semifinal" → "胜者组半决赛"; unknown names stay as they are.
function roundName(round) {
    let text = String(round || '').trim(), side = '';
    const bracket = text.match(/^(upper|lower)\s+bracket\s*(.*)$/i);
    if (bracket) { side = bracket[1].toLowerCase() === 'upper' ? '胜者组' : '败者组'; text = bracket[2]; }
    const words = [[/^grand\s+finals?$/i, '总决赛'], [/^quarter-?finals?$/i, '四分之一决赛'], [/^semi-?finals?$/i, '半决赛'],
        [/^finals?$/i, '决赛'], [/^round\s+(\d+)$/i, '第$1轮'], [/^elimination\s+match$/i, '淘汰赛'], [/^decider\s+match$/i, '决胜赛'],
        [/^opening\s+match$/i, '首轮'], [/^winners?'?\s+match$/i, '胜者赛'], [/^(third|3rd)[\s-]+place(\s+(match|decider))?$/i, '季军赛']];
    const found = words.find(([pattern]) => pattern.test(text));
    const name = found ? text.replace(found[0], found[1]) : text;
    return clean(side + (side && !found && name ? ' ' : '') + name).trim();
}

// What a finished match meant for each side, from its round name (bracket rounds) or from the
// teams' running records (Swiss rounds). Rounds it cannot classify get a label but no tags.
function stakesIndex(matches) {
    const byStage = new Map();
    for (const m of matches) {
        const key = `${m.game_type}:${m.tournament_id}|${clean(m.stage_name).trim().toLowerCase()}`;
        if (!byStage.has(key)) byStage.set(key, []);
        byStage.get(key).push(m);
    }
    const index = new Map();
    for (const list of byStage.values()) {
        const rounds = list.map(m => ({ m, round: roundOf(m).round }));
        const hasLower = rounds.some(({ round }) => /^lower\s+bracket/i.test(round));
        const numbered = rounds.filter(({ round }) => /^round\s+\d+$/i.test(round))
            .map(item => ({ ...item, n: Number(item.round.match(/\d+/)[0]) }))
            .sort((a, b) => a.n - b.n || Date.parse(a.m.match_time) - Date.parse(b.m.match_time) || a.m.id - b.m.id);
        const swiss = swissRecords(numbered);
        for (const { m, round } of rounds) {
            const record = swiss.get(m.id);
            index.set(m.id, { label: (record ? '瑞士轮' : '') + roundName(round), winTone: 'up', ...bracketTags(round, hasLower), ...(record || {}) });
        }
    }
    return index;
}

function bracketTags(round, hasLower) {
    const r = round.toLowerCase();
    if (/^upper\s+bracket/.test(r)) return { win: /final$/.test(r) && !/(quarter|semi)/.test(r) ? '晋级总决赛' : '晋级', lose: '落败者组', tone: 'drop' };
    if (/^opening\s+match$/.test(r)) return { win: '晋级', lose: '落败者组', tone: 'drop' };
    if (/^winners?'?\s+match$/.test(r)) return { win: '晋级', lose: '进决胜赛', tone: 'drop' };
    if (/^grand\s+finals?$/.test(r)) return { win: '夺冠', lose: '亚军', tone: 'out' };
    if (/^(third|3rd)[\s-]+place/.test(r)) return { win: '季军', lose: '淘汰', tone: 'out' };
    if (/^(lower\s+bracket|elimination\s+match|decider\s+match)/.test(r)) return { win: '晋级', lose: '淘汰', tone: 'out' };
    // Plain quarter/semi/final is single elimination unless the stage also has a lower bracket.
    if (!hasLower && /^(quarter-?finals?|semi-?finals?|finals?)$/.test(r)) return { win: /^finals?$/.test(r) ? '夺冠' : '晋级', lose: /^finals?$/.test(r) ? '亚军' : '淘汰', tone: 'out' };
    return {};
}

// Swiss only when round 1 is in the feed and every later pairing matched equal records;
// a team reaching 3 wins / 3 losses then advances / is eliminated (records past 3 mean another format).
function swissRecords(numbered) {
    const result = new Map();
    if (!numbered.length || numbered[0].n !== 1) return result;
    const records = new Map(), steps = [];
    const get = id => records.get(id) || { w: 0, l: 0 };
    for (const { m, n } of numbered) {
        if (!m.team1_id || !m.team2_id || m.team1_name === 'TBD' || m.team2_name === 'TBD') continue;
        const a = get(m.team1_id), b = get(m.team2_id);
        if (n > 1 && (a.w !== b.w || a.l !== b.l)) return result;
        if (m.status !== 'finished' || m.team1_score === null || m.team2_score === null || m.team1_score === m.team2_score) {
            steps.push({ m, before: a });
            continue;
        }
        const first = m.team1_score > m.team2_score;
        const winner = first ? m.team1_id : m.team2_id, loser = first ? m.team2_id : m.team1_id;
        const w = get(winner), l = get(loser);
        records.set(winner, { w: w.w + 1, l: w.l });
        records.set(loser, { w: l.w, l: l.l + 1 });
        steps.push({ m, before: a, after: [records.get(winner), records.get(loser)] });
    }
    if ([...records.values()].some(r => r.w > 3 || r.l > 3)) return result;
    for (const { m, before, after } of steps) {
        if (!after) { result.set(m.id, { pool: `${before.w}-${before.l}组` }); continue; }
        const [w, l] = after;
        result.set(m.id, { win: `${w.w}-${w.l}${w.w === 3 ? ' 晋级' : ''}`, lose: `${l.w}-${l.l}${l.l === 3 ? ' 淘汰' : ''}`,
            tone: l.l === 3 ? 'out' : 'record', winTone: w.w === 3 ? 'up' : 'record', pool: `${before.w}-${before.l}组` });
    }
    return result;
}

const roundDone = m => m.status === 'cancelled' || (m.status === 'finished' && m.team1_score !== null && m.team2_score !== null);

// A round is announced once, on the open → finished transition the worker itself observed
// (rounds already finished when first seen are recorded silently, so a restart never floods the group).
// Rounds finishing in the same tick and stage share one bracket image.
function roundJobs(feed, config, now, seen) {
    const rounds = new Map();
    for (const m of feed.matches.filter(m => config.games.includes(m.game_type))) {
        const round = roundOf(m);
        // No "Round x:" prefix (league "Regular Season" etc.): the 8-day feed window cannot tell when it ends.
        if (!round.round) continue;
        if (!rounds.has(round.key)) rounds.set(round.key, { ...round, matches: [] });
        rounds.get(round.key).matches.push(m);
    }
    const finished = [];
    for (const round of rounds.values()) {
        const done = round.matches.every(roundDone) && round.matches.some(m => m.status === 'finished');
        const previous = seen[round.key]?.status;
        seen[round.key] = { status: done ? 'done' : 'open', at: now };
        const latest = Math.max(...round.matches.map(m => Date.parse(m.match_time)).filter(Number.isFinite));
        if (done && previous === 'open' && now - latest <= 12 * 3600000) finished.push(round);
    }
    const stages = new Map();
    for (const round of finished) {
        const first = round.matches[0];
        const key = `${first.game_type}:${first.tournament_id}|${round.stage}`;
        if (!stages.has(key)) stages.set(key, { first, rounds: [] });
        stages.get(key).rounds.push(round);
    }
    return [...stages.values()].map(({ first, rounds: list }) => {
        const matches = list.flatMap(round => round.matches).sort((a, b) => Date.parse(a.match_time) - Date.parse(b.match_time) || a.id - b.id);
        const labels = list.map(round => round.label).join('、');
        const results = matches.filter(m => m.status === 'finished').map(m =>
            `#${m.id} ${clean(m.team1_name)} ${m.team1_score}:${m.team2_score} ${clean(m.team2_name)}${m.is_forfeit ? '（弃权）' : ''}`);
        return { key: `round:${fingerprint(list.map(round => round.key).sort())}`, kind: 'round', expires: now + 3 * 3600000,
            matchIds: matches.map(m => m.id), watched: [],
            text: [`【${tournamentName(first)} 轮次结束】`, `${labels}已全部结束`, ...results].join('\n'),
            summary: `【${tournamentName(first)} 轮次结束】${labels}已全部结束，最新赛程图如下`,
            bracket: { tournamentId: first.tournament_id, theme: first.game_type, matchIds: matches.map(m => m.id),
                brand: brand(first), caption: [tournamentName(first), `${labels}已全部结束`] } };
    });
}

function groupItems(matches, row) {
    const groups = new Map();
    for (const m of matches) {
        const key = `${m.game_type}:${m.tournament_id}`;
        if (!groups.has(key)) groups.set(key, { brand: brand(m), matches: [] });
        groups.get(key).matches.push(m);
    }
    return [...groups.values()].flatMap(group => [{ t: 'group', text: group.brand.name, brand: group.brand }, ...group.matches.map(row)]);
}

function previewItems(matches, start, end, now) {
    const future = matches.filter(m => isFixture(m) && m.status === 'upcoming' && between(m, start, end));
    if (!future.length) return [{ t: 'note', text: '未来七天暂无赛程' }];
    const groups = new Map();
    for (const m of future) {
        if (!groups.has(m.tournament_id)) groups.set(m.tournament_id, []);
        groups.get(m.tournament_id).push(m);
    }
    return [...groups.values()].flatMap(rows => [{ t: 'group', text: tournamentName(rows[0]), brand: brand(rows[0]) },
        ...rows.slice(0, 4).map(m => fixtureRow(m, now)),
        ...(rows.length > 4 ? [{ t: 'note', text: `另有 ${rows.length - 4} 场见网站` }] : [])]);
}

function weeklyReport(matches, now) {
    const count = matches.filter(m => isFixture(m) && m.status === 'upcoming' && between(m, now, now + 7 * DAY)).length;
    return { text: ['【未来七天赛事预告】', ...previewLines(matches, now, now + 7 * DAY, now)].join('\n'),
        summary: `【未来七天赛事预告】${count ? `共 ${count} 场，赛程见图` : '未来七天暂无赛程'}`,
        card: { title: '未来七天赛事预告', subtitle: `北京时间 ${label(now).slice(0, 5)} 起`,
            items: previewItems(matches, now, now + 7 * DAY, now), footer: footer(now) } };
}

const footer = now => `生成于 ${label(now)}，数据以网站为准`;

function groupedFixtures(matches, now, day, of = () => ({})) {
    const groups = new Map();
    for (const m of matches) {
        const key = `${m.game_type}:${m.tournament_id}`;
        if (!groups.has(key)) groups.set(key, { name: title(m), matches: [] });
        groups.get(key).matches.push(m);
    }
    return [...groups.values()].flatMap(group => ['', group.name, ...group.matches.map(m => fixtureLine(m, now, day, of(m)))]);
}

function previewLines(matches, start, end, now) {
    const future = matches.filter(m => isFixture(m) && m.status === 'upcoming' && between(m, start, end));
    if (!future.length) return ['未来七天暂无赛程'];
    const groups = new Map();
    for (const m of future) {
        if (!groups.has(m.tournament_id)) groups.set(m.tournament_id, []);
        groups.get(m.tournament_id).push(m);
    }
    return [...groups.values()].flatMap(rows => [
        '', title(rows[0]),
        ...rows.slice(0, 4).map(m => fixtureLine(m, now)),
        ...(rows.length > 4 ? [`另有 ${rows.length - 4} 场见网站`] : [])
    ]);
}

// List rows grouped under one heading per stage/round, so the round is named once instead of on every row.
function roundItems(matches, of, row) {
    const groups = new Map();
    for (const m of matches) {
        const stage = clean(m.stage_name).trim(), round = of(m).label || '';
        const text = [stage, round].filter((part, i, all) => part && (i === 0 || part.toLowerCase() !== all[0].toLowerCase())).join(' ') || '比赛';
        if (!groups.has(text)) groups.set(text, []);
        groups.get(text).push(m);
    }
    return [...groups].flatMap(([text, list]) => [{ t: 'group', text }, ...list.map(row)]);
}

// Daily report as one image per tournament: its bracket from the site (yesterday's results and today's
// matches highlighted, every stage involved stacked, e.g. groups ended yesterday + playoffs today) when all
// its matches belong to named bracket/Swiss rounds; otherwise, or if the bracket fails, a list card.
function dailyImages(yesterday, today, config, now, day, of) {
    const tournaments = new Map();
    const add = (m, side) => {
        const key = `${m.game_type}:${m.tournament_id}`;
        if (!tournaments.has(key)) tournaments.set(key, { first: m, yesterday: [], today: [] });
        tournaments.get(key)[side].push(m);
    };
    for (const m of yesterday) add(m, 'yesterday');
    for (const m of today) add(m, 'today');
    const start = item => Date.parse((item.today[0] || item.yesterday[0]).match_time);
    return [...tournaments.values()]
        .sort((a, b) => (a.today.length ? 0 : 1) - (b.today.length ? 0 : 1) || start(a) - start(b))
        .map(({ first, yesterday: y, today: t }) => {
            const name = tournamentName(first);
            const subtitle = `${dateKey(day)} 赛事日报（北京时间）`;
            const card = { title: name, brand: brand(first), subtitle, theme: first.game_type, footer: footer(now), items: [
                ...(y.length ? [{ t: 'section', text: '昨日赛果' }, ...roundItems(y, of, m => m.team1_score !== null && m.team2_score !== null ? resultRow(m) : fixtureRow(m, now, day))] : []),
                ...(t.length ? [{ t: 'section', text: '今日赛程' }, ...roundItems(t, of, m => fixtureRow(m, now, day))] : [])] };
            const all = [...y, ...t];
            if (config.dailyBrackets === false || !all.every(m => roundOf(m).round)) return { card };
            return { card, bracket: { tournamentId: first.tournament_id, theme: first.game_type, brand: brand(first), matchIds: all.map(m => m.id),
                yesterday: y.map(m => m.id), today: t.map(m => m.id), caption: [name, subtitle] } };
        });
}

function dailyReport(feed, config, now, day = midnight(now)) {
    const matches = feed.matches.filter(m => config.games.includes(m.game_type))
        .sort((a, b) => Date.parse(a.match_time) - Date.parse(b.match_time) || a.id - b.id);
    const { start, end, previous } = bounds(now, config, day);
    const yesterday = matches.filter(m => between(m, previous, start));
    const finished = yesterday.filter(m => m.status === 'finished' && m.team1_score !== null && m.team2_score !== null);
    const pending = yesterday.filter(m => ['upcoming', 'ongoing'].includes(m.status)
        || (m.status === 'finished' && (m.team1_score === null || m.team2_score === null)));
    const stakes = stakesIndex(matches), of = m => stakes.get(m.id) || {};
    const lines = [`【${dateKey(day)} 赛事日报】`, '', '昨日赛果'];
    const resultGroups = new Map();
    for (const m of finished.slice(0, config.resultsLimit)) {
        const key = `${m.game_type}:${m.tournament_id}`;
        if (!resultGroups.has(key)) resultGroups.set(key, { name: title(m), matches: [] });
        resultGroups.get(key).matches.push(m);
    }
    for (const group of resultGroups.values()) {
        lines.push('', group.name);
        for (const m of group.matches) {
            lines.push(resultLine(m, of(m)));
        }
    }
    if (!finished.length) lines.push('暂无赛果');
    if (finished.length > config.resultsLimit) lines.push(`另有 ${finished.length - config.resultsLimit} 场见网站`);
    if (pending.length) lines.push(`${pending.length} 场赛果待更新`);
    const cancelled = yesterday.filter(m => ['cancelled', 'postponed'].includes(m.status)).length;
    if (cancelled) lines.push(`${cancelled} 场取消或延期`);
    const today = matches.filter(m => isFixture(m) && between(m, start, end));
    lines.push('', '今日赛程');
    if (today.length) lines.push(...groupedFixtures(today, now, day, of));
    else {
        lines.push('今日无比赛，近期赛程：',
            ...previewLines(matches, end, now + 7 * DAY, now));
    }
    const unknown = matches.filter(m => m.time_confirmed !== 1 && m.status === 'upcoming' && between(m, start, end)).length;
    if (unknown) lines.push(`另有 ${unknown} 场时间待定`);
    const note = text => ({ t: 'note', text });
    const items = [{ t: 'section', text: '昨日赛果' },
        ...(finished.length ? groupItems(finished.slice(0, config.resultsLimit), m => resultRow(m, { label: of(m).label })) : [note('暂无赛果')]),
        ...(finished.length > config.resultsLimit ? [note(`另有 ${finished.length - config.resultsLimit} 场见网站`)] : []),
        ...(pending.length ? [note(`${pending.length} 场赛果待更新`)] : []),
        ...(cancelled ? [note(`${cancelled} 场取消或延期`)] : []),
        { t: 'section', text: '今日赛程' },
        ...(today.length ? groupItems(today, m => fixtureRow(m, now, day, { label: of(m).label }))
            : [note('今日无比赛，近期赛程：'), ...previewItems(matches, end, now + 7 * DAY, now)]),
        ...(unknown ? [note(`另有 ${unknown} 场时间待定`)] : [])];
    const extra = [pending.length && `${pending.length} 场赛果待更新`, cancelled && `${cancelled} 场取消或延期`, unknown && `${unknown} 场时间待定`].filter(Boolean);
    const summary = `【${dateKey(day)} 赛事日报】昨日 ${finished.length} 场赛果，今日 ${today.length} 场比赛${extra.length ? `（${extra.join('，')}）` : ''}，详见图片`;
    const shown = [...finished, ...pending].sort((a, b) => Date.parse(a.match_time) - Date.parse(b.match_time) || a.id - b.id);
    // No match yesterday or today: the single card with the coming days' preview.
    const images = shown.length || today.length ? dailyImages(shown, today, config, now, day, of) : undefined;
    return { text: lines.join('\n'), summary, images, card: { title: '赛事日报', subtitle: `${dateKey(day)}（北京时间）`, items, footer: footer(now) }, matchIds: matches.map(m => m.id), watched: today.filter(m => Date.parse(m.match_time) > now).map(snapshot) };
}

function plan(feed, config, now, watched = {}) {
    const matches = feed.matches.filter(m => config.games.includes(m.game_type));
    const jobs = [];
    // Check both calendar dates: a 06:00 match's report is due at 05:50.
    for (const day of [midnight(now), midnight(now) + DAY]) {
        const due = dailyDue(matches, day, config);
        if (now >= due && now <= due + 2 * 3600000) {
            jobs.push({ key: `daily:${dateKey(day)}`, kind: 'daily', expires: due + 2 * 3600000,
                ...dailyReport(feed, config, now, day) });
        }
    }
    const remindersOn = config.reminderMinutes > 0;
    const slipMs = (config.slipMinutes ?? 180) * 60000;
    const remindAgainMs = (config.remindAgainMinutes ?? 60) * 60000;
    for (const m of matches) {
        const time = Date.parse(m.match_time), remaining = time - now;
        const seen = watched[String(m.id)];
        // One reminder per match: a start that merely slipped (earlier match ran long) is not re-announced
        // until it has moved remindAgainMinutes past the time the group was last reminded of.
        const remindedAt = seen?.reminded_time ? Date.parse(seen.reminded_time) : NaN;
        if (Number.isFinite(remindedAt) && time - remindedAt < remindAgainMs) continue;
        const announcedAt = seen ? Date.parse(seen.match_time) : NaN;
        const slipped = Number.isFinite(announcedAt) && time > announcedAt;
        const syncedAge = now - Date.parse(m.last_synced_at);
        const fresh = m.external_source !== 'pandascore' || (Number.isFinite(syncedAge) && syncedAge >= -60000 && syncedAge <= config.freshnessMinutes * 60000);
        if (remindersOn && isFixture(m) && m.status === 'upcoming' && fresh
            && remaining > 0 && remaining <= config.reminderMinutes * 60000
            && m.team1_name !== 'TBD' && m.team2_name !== 'TBD') {
            jobs.push({ key: `reminder:${m.id}:${iso(time)}`, kind: 'reminder', expires: time,
                matchIds: [m.id], watched: [{ ...snapshot(m), reminded_time: m.match_time }], text: [
                    `【即将开赛】约 ${Math.ceil(remaining / 60000)} 分钟后${slipped ? '，开赛时间已顺延' : ''}`, title(m),
                    `#${m.id} ${label(time)}  ${versus(m)}（${m.format}）`,
                    ...(slipped ? [`原定 ${label(announcedAt)} 开赛`] : []),
                    ...(m.betting_enabled ? (config.commandsEnabled ? [
                        `回复比分或发送 /pick 竞猜 ${m.id} ${m.format === 'BO1' ? '1:0' : m.format === 'BO5' ? '3:1' : '2:1'}`
                    ] : ['可在网站竞猜']) : ['竞猜未开放'])
                ].join('\n') });
        }
    }
    const day = midnight(now), weeklyDue = at(day, config.weeklyTime);
    if (config.weeklyEnabled && new Date(day + OFFSET).getUTCDay() === 0 && now >= weeklyDue && now <= weeklyDue + 2 * 3600000) {
        jobs.push({ key: `weekly:${dateKey(day)}`, kind: 'weekly', expires: weeklyDue + 2 * 3600000, watched: [], matchIds: matches.map(m => m.id),
            ...weeklyReport(matches, now) });
    }
    const byId = new Map(matches.map(m => [String(m.id), m]));
    for (const [id, old] of Object.entries(watched)) {
        const m = byId.get(id);
        if (!m && !feed.unavailable_ids.includes(id)) continue;
        const next = m ? snapshot(m) : { ...old, status: 'unavailable' };
        const changed = next.match_time !== old.match_time || next.team1_name !== old.team1_name
            || next.team2_name !== old.team2_name || next.time_confirmed !== old.time_confirmed
            || (['cancelled', 'postponed', 'unavailable'].includes(next.status) && next.status !== old.status);
        if (!changed) continue;
        // A same-day slip with unchanged teams (e.g. 12:30 → 12:40 → 13:00 as an earlier series overruns)
        // is left to the reminder, which carries the latest time and the originally announced one.
        const delay = Date.parse(next.match_time) - Date.parse(old.match_time);
        const slip = remindersOn && next.status === 'upcoming' && next.time_confirmed === 1 && old.time_confirmed === 1
            && next.team1_name === old.team1_name && next.team2_name === old.team2_name && delay > 0 && delay <= slipMs;
        if (slip) continue;
        const state = { cancelled: '已取消', postponed: '已延期', unavailable: '已下架或停止展示' }[next.status];
        jobs.push({ key: `change:${id}:${fingerprint(next)}`, kind: 'change', expires: now + 2 * 3600000,
            matchIds: [next.id], watched: [next], text: ['【赛程更新】', title(old), `#${old.id} ${old.team1_name} vs ${old.team2_name}`,
                `原定：${label(Date.parse(old.match_time))}`,
                state || (next.time_confirmed !== 1 ? '开赛时间待确认' : `现为：${label(Date.parse(next.match_time))}  ${next.team1_name} vs ${next.team2_name}`)].join('\n') });
    }
    return jobs;
}

module.exports = { roundName, stakesIndex, DAY, iso, dateKey, midnight, bounds, dailyDue, freshness, splitMessage, messageMatchId, splitMatchMessage, dailyReport, weeklyReport, roundOf, roundJobs, plan };
