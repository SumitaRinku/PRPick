// 每局详细数据（GRID）：比赛详情里的按局数据板 + 赛事回看页的「数据」统计榜。
// 数据来自 /api/matches/:id/details 与 /api/tournaments/:id/stats，仅展示，不参与结算。
// 依赖 shared.js（escapeSharedHtml / sharedApi / logoHtml）、games.js（gameUnitOf）、match-center.js（mapLabel）。

const gameStats = { assets: null, assetsPromise: null, selected: {}, tournaments: new Map(), tSort: {}, tTab: {} };
const gsEsc = value => escapeSharedHtml(value == null ? '' : String(value));
const gsNorm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const gsNum = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : '-');
const gsPct = value => (Number.isFinite(value) ? `${value.toFixed(1)}%` : '-');

// ===== LoL 英雄 / 装备素材 =====
function loadLolAssets() {
    if (!gameStats.assetsPromise) {
        gameStats.assetsPromise = sharedApi('/lol/assets')
            .then(assets => { gameStats.assets = assets; return assets; })
            .catch(() => { gameStats.assetsPromise = null; return null; });
    }
    return gameStats.assetsPromise;
}

const champInfo = name => gameStats.assets?.champions?.[gsNorm(name)] || null;
const champLabel = name => champInfo(name)?.zh || name || '?';

// 图片加载失败时换成文字块
function gsIconFallback(img) {
    const span = document.createElement('span');
    span.className = `${img.className} gs-icon-text`;
    span.title = img.title;
    span.textContent = String(img.alt || '?').slice(0, 2);
    img.replaceWith(span);
}

function champIcon(name, cls = '') {
    const info = champInfo(name);
    const label = champLabel(name);
    if (!info) return `<span class="gs-champ gs-icon-text ${cls}" title="${gsEsc(label)}">${gsEsc(String(label).slice(0, 2))}</span>`;
    return `<img class="gs-champ ${cls}" src="/api/images/lol/champion/${gsEsc(info.id)}" alt="${gsEsc(label)}" title="${gsEsc(label)}" loading="lazy" onerror="gsIconFallback(this)">`;
}

function itemIcon(name) {
    const item = gameStats.assets?.items?.[gsNorm(name)];
    const label = item?.zh || name;
    if (!item) return `<span class="gs-item gs-icon-text" title="${gsEsc(label)}">${gsEsc(String(label).slice(0, 1))}</span>`;
    return `<img class="gs-item" src="/api/images/lol/item/${gsEsc(item.id)}" alt="${gsEsc(label)}" title="${gsEsc(label)}" loading="lazy" onerror="gsIconFallback(this)">`;
}

// ===== LoL 位置 =====
// GRID 不给位置名称，但出装里有分路任务奖励（Top Lane / Jungle / Mid Lane / Support Quest Reward），据此确定位置；
// 没有任务奖励的（射手没有；任务没完成的也没有）再推断：野区补刀最多 → 打野，补刀最少 → 辅助，
// 其余按英雄定位（射手 / 法师刺客 / 战士坦克）分配下路、中路、上路。
const LOL_ROLES = ['上', '野', '中', '下', '辅'];
const QUEST_SLOTS = [[/top lane quest/i, 0], [/jungle quest/i, 1], [/mid lane quest/i, 2], [/(bot lane|adc|bottom lane) quest/i, 3], [/support quest/i, 4]];
const isQuestItem = name => /quest reward/i.test(String(name || ''));
const ROLE_FIT = [
    tags => (tags.includes('Fighter') ? 2 : 0) + (tags.includes('Tank') ? 2 : 0),
    () => 0,
    tags => (tags.includes('Mage') ? 2 : 0) + (tags.includes('Assassin') ? 2 : 0),
    tags => (tags.includes('Marksman') ? 3 : 0),
    () => 0
];

function questSlot(player) {
    for (const item of player.items || []) {
        for (const [pattern, slot] of QUEST_SLOTS) if (pattern.test(item)) return slot;
    }
    return null;
}

function permutations(list) {
    if (list.length <= 1) return [list];
    return list.flatMap((value, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map(rest => [value, ...rest]));
}

function orderLolPlayers(players) {
    if (!Array.isArray(players) || players.length !== 5) return (players || []).map(p => ({ p, role: '', sure: false }));
    const slots = Array(5).fill(null);
    const sure = new Set();
    players.forEach((player, i) => {
        const slot = questSlot(player);
        if (slot != null && slots[slot] == null) { slots[slot] = i; sure.add(i); }
    });
    let free = players.map((_, i) => i).filter(i => !slots.includes(i));
    const pick = (slot, better) => {
        if (slots[slot] != null || !free.length) return;
        slots[slot] = free.reduce((best, i) => (better(players[i], players[best]) ? i : best), free[0]);
        free = free.filter(i => i !== slots[slot]);
    };
    pick(1, (a, b) => (a.jungle_cs || 0) > (b.jungle_cs || 0));
    pick(4, (a, b) => (a.cs || 0) < (b.cs || 0));
    const open = [0, 2, 3].filter(slot => slots[slot] == null);
    if (open.length) {
        const tags = i => champInfo(players[i].champion)?.tags || [];
        let best = null;
        for (const order of permutations(free)) {
            const score = order.reduce((sum, i, k) => sum + ROLE_FIT[open[k]](tags(i)) + (open[k] === 3 ? (players[i].lane_cs || 0) / 1e6 : 0), 0);
            if (!best || score > best.score) best = { score, order };
        }
        open.forEach((slot, k) => { slots[slot] = best.order[k]; });
    }
    return slots.map((i, slot) => ({ p: players[i], role: LOL_ROLES[slot], sure: sure.has(i) }));
}

// ===== 格式化 =====
function fmtDuration(seconds) {
    if (!Number.isFinite(seconds)) return '-';
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function fmtK(value) {
    if (!Number.isFinite(value)) return '-';
    return Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

const DRAGON_NAMES = { infernal: '炼狱', ocean: '海洋', mountain: '山脉', cloud: '云端', hextech: '海克斯', chemtech: '化学科技' };

function dragonText(types) {
    const parts = Object.entries(types || {}).map(([type, count]) => `${DRAGON_NAMES[type] || type}${count > 1 ? `×${count}` : ''}`);
    return parts.join(' ');
}

function teamNames(match) {
    return { team1: match.team1_short_name || match.team1_name || '队伍 1', team2: match.team2_short_name || match.team2_name || '队伍 2' };
}

// ===== 比赛详情：按局数据板 =====
function compareRow(label, a, b, format = value => value ?? '-') {
    const left = Number(a) || 0;
    const right = Number(b) || 0;
    const total = left + right;
    const share = total > 0 ? Math.round((left / total) * 100) : 50;
    return `<div class="gs-cmp">
        <b class="${left > right ? 'lead' : ''}">${format(a)}</b>
        <div class="gs-cmp-mid"><span>${label}</span><i style="--gs-share:${share}%"></i></div>
        <b class="${right > left ? 'lead' : ''}">${format(b)}</b>
    </div>`;
}

function draftRow(name, side, actions) {
    const bans = actions.filter(a => a.type === 'ban').map(a => champIcon(a.champion, 'ban')).join('');
    const picks = actions.filter(a => a.type === 'pick').map(a => champIcon(a.champion)).join('');
    return `<div class="gs-draft-row ${side || ''}">
        <span class="gs-draft-team">${gsEsc(name)}${side ? `<small>${side === 'blue' ? '蓝方' : '红方'}</small>` : ''}</span>
        <span class="gs-draft-picks">${picks || '<em>-</em>'}</span>
        <span class="gs-draft-bans" title="禁用">${bans}</span>
    </div>`;
}

function lolPlayerTable(name, side, players, minutes, won) {
    const rows = orderLolPlayers(players).map(({ p, role, sure }) => `<tr>
        <td class="gs-role ${sure ? '' : 'guess'}" title="${sure ? '按分路任务奖励确定' : '按补刀与英雄定位推断'}">${role}</td>
        <td class="gs-player">${champIcon(p.champion)}<span><b>${gsEsc(p.name)}</b><small>${gsEsc(champLabel(p.champion))}${p.level ? ` · ${p.level} 级` : ''}</small></span></td>
        <td class="gs-kda"><b>${p.kills ?? '-'}/${p.deaths ?? '-'}/${p.assists ?? '-'}</b></td>
        <td>${p.cs ?? '-'}<small>${minutes && Number.isFinite(p.cs) ? (p.cs / minutes).toFixed(1) : ''}</small></td>
        <td>${fmtK(p.gold)}</td>
        <td>${gsPct(p.damage_share)}</td>
        <td>${gsPct(p.kill_participation)}</td>
        <td>${gsNum(p.vision)}</td>
        <td class="gs-items">${(p.items || []).filter(item => !isQuestItem(item)).map(itemIcon).join('')}</td>
    </tr>`).join('');
    return `<div class="gs-table-wrap"><table class="gs-table">
        <thead><tr><th colspan="2" class="gs-team-head ${side || ''} ${won ? 'won' : ''}">${gsEsc(name)}${won ? ' <em>胜</em>' : ''}</th>
            <th>K/D/A</th><th>补刀<small>/分</small></th><th>经济</th><th>伤害占比</th><th>参团</th><th>视野</th><th>出装</th></tr></thead>
        <tbody>${rows}</tbody>
    </table></div>`;
}

function lolGameHtml(match, game) {
    const names = teamNames(match);
    const t1 = game.teams?.team1 || {};
    const t2 = game.teams?.team2 || {};
    const minutes = game.duration_s ? game.duration_s / 60 : null;
    const draft = game.draft || [];
    const dragons = [t1, t2].some(t => (t.dragons || 0) + (t.elders || 0));
    return `<div class="gs-game">
        <div class="gs-game-head">
            <span>第 ${game.sequence} 局${game.status === 'ongoing' ? ' <em class="mc-live">进行中</em>' : ''}</span>
            <span>时长 ${fmtDuration(game.duration_s)}</span>
            ${game.winner ? `<span class="gs-winner">${gsEsc(names[game.winner])} 胜</span>` : ''}
        </div>
        ${draft.length ? `<div class="gs-draft">${draftRow(names.team1, t1.side, draft.filter(a => a.team === 'team1'))}${draftRow(names.team2, t2.side, draft.filter(a => a.team === 'team2'))}</div>` : ''}
        <div class="gs-compare">
            <div class="gs-cmp gs-cmp-head"><b>${gsEsc(names.team1)}</b><div class="gs-cmp-mid"></div><b>${gsEsc(names.team2)}</b></div>
            ${compareRow('击杀', t1.kills, t2.kills)}
            ${compareRow('经济', t1.gold, t2.gold, fmtK)}
            ${compareRow('推塔', t1.towers, t2.towers)}
            ${compareRow('小龙', t1.dragons, t2.dragons)}
            ${(t1.elders || t2.elders) ? compareRow('远古龙', t1.elders, t2.elders) : ''}
            ${compareRow('大龙', t1.barons, t2.barons)}
            ${compareRow('峡谷先锋', t1.heralds, t2.heralds)}
            ${compareRow('虚空幼虫', t1.grubs, t2.grubs)}
            ${compareRow('水晶', t1.inhibitors, t2.inhibitors)}
            ${compareRow('伤害', t1.damage, t2.damage, fmtK)}
            ${dragons ? `<p class="gs-dragons"><span>${gsEsc(dragonText(t1.dragon_types)) || '-'}</span><span>${gsEsc(dragonText(t2.dragon_types)) || '-'}</span></p>` : ''}
        </div>
        ${lolPlayerTable(names.team1, t1.side, game.players?.team1, minutes, game.winner === 'team1')}
        ${lolPlayerTable(names.team2, t2.side, game.players?.team2, minutes, game.winner === 'team2')}
    </div>`;
}

const SIDE_NAMES = { 'counter-terrorists': 'CT', terrorists: 'T', attacker: '进攻', defender: '防守' };

function shooterTable(name, team, players, withAgent, won) {
    const withHs = (players || []).some(p => p.hs_pct != null);
    const rows = [...(players || [])].sort((a, b) => (b.adr ?? -1) - (a.adr ?? -1) || (b.kills || 0) - (a.kills || 0)).map(p => {
        const diff = (p.kills || 0) - (p.deaths || 0);
        return `<tr>
            <td class="gs-player"><span><b>${gsEsc(p.name)}</b>${withAgent && p.agent ? `<small>${gsEsc(mapLabel(p.agent))}</small>` : ''}</span></td>
            <td>${p.kills ?? '-'}</td><td>${p.deaths ?? '-'}</td><td>${p.assists ?? '-'}</td>
            <td class="${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}">${diff > 0 ? '+' : ''}${diff}</td>
            <td><b>${gsNum(p.adr, 1)}</b></td>${withHs ? `<td>${gsPct(p.hs_pct)}</td>` : ''}
        </tr>`;
    }).join('');
    const side = SIDE_NAMES[team?.side] ? ` <small>上半场 ${SIDE_NAMES[team.side]}</small>` : '';
    return `<div class="gs-table-wrap"><table class="gs-table">
        <thead><tr><th class="gs-team-head ${won ? 'won' : ''}">${gsEsc(name)} <b>${team?.rounds ?? '-'}</b>${side}</th>
            <th>K</th><th>D</th><th>A</th><th>±</th><th>ADR</th>${withHs ? '<th>爆头率</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
    </table></div>`;
}

function shooterGameHtml(match, game) {
    const names = teamNames(match);
    const withAgent = match.game_type === 'valorant';
    return `<div class="gs-game">
        <div class="gs-game-head">
            <span>第 ${game.sequence} 图 ${gsEsc(mapLabel(game.map))}${game.status === 'ongoing' ? ' <em class="mc-live">进行中</em>' : ''}</span>
            ${game.duration_s ? `<span>时长 ${fmtDuration(game.duration_s)}</span>` : ''}
            ${game.winner ? `<span class="gs-winner">${gsEsc(names[game.winner])} 胜</span>` : ''}
        </div>
        ${shooterTable(names.team1, game.teams?.team1, game.players?.team1, withAgent, game.winner === 'team1')}
        ${shooterTable(names.team2, game.teams?.team2, game.players?.team2, withAgent, game.winner === 'team2')}
    </div>`;
}

function matchStatsHtml(match, games) {
    if (!games?.length) return '';
    const roundless = gameUnitOf(match.game_type) === '局';
    const unit = gameUnitOf(match.game_type);
    const ongoing = games.find(game => game.status === 'ongoing');
    let selected = gameStats.selected[match.id];
    if (!games.some(game => game.sequence === selected)) selected = (ongoing || games[0]).sequence;
    gameStats.selected[match.id] = selected;
    const tabs = games.map(game => `<button type="button" class="gs-tab ${game.sequence === selected ? 'active' : ''}" data-gs-seq="${game.sequence}" onclick="gsSelectGame(this)">
        第 ${game.sequence} ${unit}${roundless ? '' : ` · ${gsEsc(mapLabel(game.map))}`}${game.status === 'ongoing' ? ' ●' : ''}</button>`).join('');
    const panels = games.map(game => `<div class="gs-panel" data-gs-panel="${game.sequence}"${game.sequence === selected ? '' : ' hidden'}>
        ${roundless ? lolGameHtml(match, game) : shooterGameHtml(match, game)}</div>`).join('');
    return `<div class="gs-root" data-gs-match="${match.id}"><nav class="gs-tabs">${tabs}</nav>${panels}</div>`;
}

function gsSelectGame(button) {
    const root = button.closest('.gs-root');
    if (!root) return;
    const seq = Number(button.dataset.gsSeq);
    gameStats.selected[root.dataset.gsMatch] = seq;
    root.querySelectorAll('[data-gs-seq]').forEach(tab => tab.classList.toggle('active', Number(tab.dataset.gsSeq) === seq));
    root.querySelectorAll('[data-gs-panel]').forEach(panel => { panel.hidden = Number(panel.dataset.gsPanel) !== seq; });
}

// 比赛详情弹窗里调用：拉取详细数据并渲染到 container
async function renderMatchStatsInto(match, container) {
    if (!container) return;
    try {
        const [details] = await Promise.all([
            sharedApi(`/matches/${match.id}/details`),
            match.game_type === 'lol' ? loadLolAssets() : null
        ]);
        container.innerHTML = matchStatsHtml(match, details.games) || '';
        if (!container.innerHTML) container.closest('.mc-section')?.remove();
    } catch (error) {
        container.innerHTML = `<p class="gs-empty">数据加载失败：${gsEsc(error.message)}</p>`;
    }
}

// ===== 赛事回看：数据统计榜 =====
function gsTeamCell(team) {
    return `<span class="gs-tteam">${logoHtml(team.logo_url)}<b title="${gsEsc(team.name)}">${gsEsc(team.short_name || team.name)}</b></span>`;
}

// 列定义：[key, 表头, 渲染函数, 排序取值]
const T_COLUMNS = {
    lol: {
        players: [
            ['name', '选手', p => `<span class="gs-tplayer"><b>${gsEsc(p.name)}</b>${gsTeamCell(p.team)}</span>`, p => p.name.toLowerCase()],
            ['games', '局数', p => p.games],
            ['win_rate', '胜率', p => gsPct(p.games ? (p.wins / p.games) * 100 : null), p => (p.games ? p.wins / p.games : 0)],
            ['kda', 'KDA', p => `<b>${gsNum(p.kda, 2)}</b>`],
            ['kills_pg', '场均 K/D/A', p => `${gsNum(p.kills_pg, 1)}/${gsNum(p.deaths_pg, 1)}/${gsNum(p.assists_pg, 1)}`, p => p.kills_pg],
            ['cs_pm', '分均补刀', p => gsNum(p.cs_pm, 1)],
            ['gold_pm', '分均经济', p => p.gold_pm ?? '-'],
            ['damage_share', '伤害占比', p => gsPct(p.damage_share)],
            ['kill_participation', '参团率', p => gsPct(p.kill_participation)],
            ['vision_pm', '分均视野', p => gsNum(p.vision_pm, 2)],
            ['champions', '常用英雄', p => `<span class="gs-pool">${p.champions.slice(0, 3).map(c => `<span title="${gsEsc(champLabel(c.name))} ${c.games} 局 ${c.wins} 胜">${champIcon(c.name, 'sm')}<small>${c.games}</small></span>`).join('')}</span>`, p => p.champions.length]
        ],
        teams: [
            ['name', '队伍', t => gsTeamCell(t), t => t.name.toLowerCase()],
            ['games', '局数', t => t.games],
            ['win_rate', '胜率', t => gsPct(t.win_rate)],
            ['avg_duration_s', '平均时长', t => fmtDuration(t.avg_duration_s)],
            ['kills_pg', '场均击杀', t => gsNum(t.kills_pg, 1)],
            ['deaths_pg', '场均死亡', t => gsNum(t.deaths_pg, 1)],
            ['gold_diff_pg', '场均经济差', t => (t.gold_diff_pg > 0 ? '+' : '') + fmtK(t.gold_diff_pg)],
            ['towers_pg', '场均推塔', t => gsNum(t.towers_pg, 1)],
            ['dragons_pg', '场均小龙', t => gsNum(t.dragons_pg, 1)],
            ['barons_pg', '场均大龙', t => gsNum(t.barons_pg, 1)],
            ['grubs_pg', '场均幼虫', t => gsNum(t.grubs_pg, 1)],
            ['blue', '蓝方', t => `${t.blue.wins}-${t.blue.games - t.blue.wins}`, t => (t.blue.games ? t.blue.wins / t.blue.games : -1)],
            ['red', '红方', t => `${t.red.wins}-${t.red.games - t.red.wins}`, t => (t.red.games ? t.red.wins / t.red.games : -1)]
        ],
        champions: [
            ['name', '英雄', c => `<span class="gs-tplayer">${champIcon(c.name, 'sm')}<b>${gsEsc(champLabel(c.name))}</b></span>`, c => champLabel(c.name)],
            ['presence', 'BP 率', c => `<b>${gsPct(c.presence)}</b>`],
            ['picks', '选用', c => c.picks],
            ['bans', '禁用', c => c.bans],
            ['win_rate', '胜率', c => gsPct(c.win_rate), c => c.win_rate ?? -1]
        ]
    },
    shooter: {
        players: [
            ['name', '选手', p => `<span class="gs-tplayer"><b>${gsEsc(p.name)}</b>${gsTeamCell(p.team)}</span>`, p => p.name.toLowerCase()],
            ['maps', '图数', p => p.maps],
            ['adr', 'ADR', p => `<b>${gsNum(p.adr, 1)}</b>`, p => p.adr ?? -1],
            ['kd', 'K/D', p => gsNum(p.kd, 2)],
            ['kd_diff', 'K-D', p => `${p.kd_diff > 0 ? '+' : ''}${p.kd_diff}`],
            ['kills_pm', '图均击杀', p => gsNum(p.kills_pm, 1)],
            ['hs_pct', '爆头率', p => gsPct(p.hs_pct), p => p.hs_pct ?? -1],
            ['agents', '常用英雄', p => p.agents.slice(0, 3).map(a => gsEsc(mapLabel(a.name))).join(' / ') || '-', p => p.agents.length]
        ],
        teams: [
            ['name', '队伍', t => gsTeamCell(t), t => t.name.toLowerCase()],
            ['maps', '图数', t => t.maps],
            ['win_rate', '胜率', t => gsPct(t.win_rate)],
            ['rounds', '回合', t => `${t.rounds_won}-${t.rounds_lost}`, t => t.rounds_won],
            ['round_diff', '净胜回合', t => `${t.round_diff > 0 ? '+' : ''}${t.round_diff}`]
        ],
        agents: [
            ['name', '英雄', a => `<b>${gsEsc(mapLabel(a.name))}</b>`, a => a.name],
            ['picks', '选用', a => a.picks],
            ['win_rate', '胜率', a => gsPct(a.win_rate), a => a.win_rate ?? -1]
        ],
        maps: [
            ['name', '地图', m => `<b>${gsEsc(mapLabel(m.name))}</b>`, m => m.name],
            ['games', '场次', m => m.games]
        ]
    }
};

function tournamentTabs(stats) {
    if (stats.game === 'lol') return [['players', '选手'], ['teams', '队伍'], ['champions', '英雄']];
    const tabs = [['players', '选手'], ['teams', '队伍']];
    if (stats.agents?.length) tabs.push(['agents', '英雄']);
    if (stats.maps?.length) tabs.push(['maps', '地图']);
    return tabs;
}

function sortedRows(rows, column, dir) {
    const value = column[3] || (row => row[column[0]]);
    return [...rows].sort((a, b) => {
        const x = value(a);
        const y = value(b);
        if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y)) * dir;
        return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
    });
}

function tournamentStatsHtml(id, stats) {
    if (!stats || !stats.games) return '<div class="rv-empty">暂无详细数据（比赛需关联 GRID 数据，结束后自动汇总）</div>';
    const columns = T_COLUMNS[stats.game === 'lol' ? 'lol' : 'shooter'];
    const tabs = tournamentTabs(stats);
    const tab = tabs.some(([key]) => key === gameStats.tTab[id]) ? gameStats.tTab[id] : tabs[0][0];
    // Valorant 没有爆头率（GRID 只给爆头命中次数）
    const cols = columns[tab].filter(col => !(col[0] === 'hs_pct' && stats.game !== 'cs2'));
    const sort = gameStats.tSort[`${id}:${tab}`];
    const rows = sort ? sortedRows(stats[tab] || [], cols.find(c => c[0] === sort.key) || cols[0], sort.dir) : (stats[tab] || []);
    const unit = stats.game === 'lol' ? '局' : '图';
    return `<div class="gs-tstats" data-gs-tid="${gsEsc(id)}">
        <div class="gs-tstats-head">
            <nav class="gs-tabs">${tabs.map(([key, label]) => `<button type="button" class="gs-tab ${key === tab ? 'active' : ''}" onclick="gsTournamentTab('${gsEsc(id)}', '${key}')">${label}</button>`).join('')}</nav>
            <small>共 ${stats.games} ${unit}有详细数据 · 点表头排序${stats.game === 'lol' ? ' · 数据来自 GRID Open Access' : ''}</small>
        </div>
        <div class="gs-table-wrap"><table class="gs-table gs-ttable">
            <thead><tr>${cols.map(([key, label]) => `<th class="sortable ${sort?.key === key ? (sort.dir > 0 ? 'asc' : 'desc') : ''}" onclick="gsTournamentSort('${gsEsc(id)}', '${tab}', '${key}')">${label}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(row => `<tr>${cols.map(col => `<td>${col[2](row)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="gs-empty">暂无</td></tr>`}</tbody>
        </table></div>
    </div>`;
}

function rerenderTournamentStats(id) {
    const stats = gameStats.tournaments.get(String(id));
    document.querySelectorAll(`[data-gs-tournament="${CSS.escape(String(id))}"]`).forEach(el => { el.innerHTML = tournamentStatsHtml(id, stats); });
}

function gsTournamentTab(id, tab) {
    gameStats.tTab[id] = tab;
    rerenderTournamentStats(id);
}

function gsTournamentSort(id, tab, key) {
    const current = gameStats.tSort[`${id}:${tab}`];
    // 第一次点击降序（数值榜大多看最高），再点切换
    gameStats.tSort[`${id}:${tab}`] = { key, dir: current?.key === key ? -current.dir : (key === 'name' ? 1 : -1) };
    rerenderTournamentStats(id);
}

// 已加载过的直接返回 HTML（页面重绘时不闪烁）；否则返回占位并异步加载
function tournamentStatsContainer(id, gameType) {
    const key = String(id);
    if (gameStats.tournaments.has(key)) return `<div data-gs-tournament="${gsEsc(key)}">${tournamentStatsHtml(key, gameStats.tournaments.get(key))}</div>`;
    setTimeout(async () => {
        try {
            const [data] = await Promise.all([sharedApi(`/tournaments/${key}/stats`), gameType === 'lol' ? loadLolAssets() : null]);
            gameStats.tournaments.set(key, data.stats);
        } catch (error) {
            document.querySelectorAll(`[data-gs-tournament="${CSS.escape(key)}"]`).forEach(el => { el.innerHTML = `<div class="rv-empty">数据加载失败：${gsEsc(error.message)}</div>`; });
            return;
        }
        rerenderTournamentStats(key);
    }, 0);
    return `<div data-gs-tournament="${gsEsc(key)}"><div class="rv-loading">加载数据中…</div></div>`;
}

window.gsIconFallback = gsIconFallback;
window.gsSelectGame = gsSelectGame;
window.gsTournamentTab = gsTournamentTab;
window.gsTournamentSort = gsTournamentSort;
window.renderMatchStatsInto = renderMatchStatsInto;
window.tournamentStatsContainer = tournamentStatsContainer;
window.orderLolPlayers = orderLolPlayers;
