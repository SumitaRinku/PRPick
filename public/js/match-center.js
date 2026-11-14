// 比赛详情（地图比分 + BP 流程）与单图比分条：主页、赛事回看页共用。
// 数据来自 /api/matches 返回的 match.live（GRID Open Access 补充数据，仅展示）。
// 依赖 shared.js（escapeSharedHtml / logoHtml / formatDateTime / sharedApi）与 tournament-logos.js。

// GRID 地图名为小写代号（mirage / dust2 / de_inferno），统一成展示用写法
function mapLabel(name) {
    const clean = String(name || '').replace(/^de_/i, '').trim();
    if (!clean) return '待定';
    return clean.charAt(0).toUpperCase() + clean.slice(1);
}

// 对局按游戏称呼：CS2 / Valorant 每图地图不同，显示地图名；LoL 每局都在召唤师峡谷，显示「第 N 局」。
const isRoundless = gameType => gameUnitOf(gameType) === '局';

function gameSlotLabel(gameType, game) {
    return isRoundless(gameType) ? `第 ${game.sequence} 局` : mapLabel(game.map);
}

// 单局比分的含义：CS2 / Valorant 是回合数，LoL 是击杀数
function gameScoreHint(gameType) {
    return isRoundless(gameType) ? '击杀' : '回合';
}

// 单图（单局）比分条：GRID 补充数据，进行中与已结束比赛都展示
function mapStripHtml(match) {
    const games = match.live?.games || [];
    if (!games.length) return '';
    const unit = gameUnitOf(match.game_type);
    const chips = games.map(game => {
        const t1 = game.team1_rounds ?? '-';
        const t2 = game.team2_rounds ?? '-';
        return `<span class="map-chip ${game.status}" title="第 ${game.sequence} ${unit}${game.status === 'ongoing' ? '（进行中）' : ''}，${gameScoreHint(match.game_type)}">
            <b>${escapeSharedHtml(gameSlotLabel(match.game_type, game))}</b>
            <span class="${game.winner === 'team1' ? 'won' : ''}">${t1}</span><em>-</em><span class="${game.winner === 'team2' ? 'won' : ''}">${t2}</span>
        </span>`;
    }).join('');
    return `<div class="match-maps" aria-label="单${unit}比分">${chips}</div>`;
}


// ===== 比赛详情：地图比分 + BP 流程（GRID 补充数据） =====
const MAP_ART = new Set(['mirage', 'inferno', 'nuke', 'ancient', 'anubis', 'dust2', 'train', 'overpass', 'vertigo', 'cache']);

function hasMatchCenter(match) {
    return !!(match.live && ((match.live.games || []).length || (match.live.veto || []).length));
}

function mapKey(name) {
    return String(name || '').toLowerCase().replace(/^de_/, '');
}

// 按 BP 顺序（选图 → 决胜图）排地图；BP 缺失时退回实际对局顺序
function matchCenterMaps(live, gameType) {
    const games = live.games || [];
    // LoL 每局同一张地图，不能按地图名合并，按局序列出
    if (isRoundless(gameType)) return games.map(game => ({ map: game.map, game }));
    const byMap = new Map(games.map(game => [mapKey(game.map), game]));
    const rows = (live.veto || []).filter(entry => entry.type !== 'ban').map(entry => ({ map: entry.map, veto: entry, game: byMap.get(mapKey(entry.map)) }));
    for (const game of games) {
        if (!rows.some(row => mapKey(row.map) === mapKey(game.map))) rows.push({ map: game.map, game });
    }
    return rows;
}

function matchCenterHtml(match) {
    const live = match.live || {};
    const names = { team1: match.team1_short_name || match.team1_name, team2: match.team2_short_name || match.team2_name };
    const teamName = key => escapeSharedHtml(names[key] || '');
    const isFinished = match.status === 'finished' || live.finished;
    const score1 = match.status === 'finished' && match.team1_score != null ? match.team1_score : live.team1_score;
    const score2 = match.status === 'finished' && match.team2_score != null ? match.team2_score : live.team2_score;
    const seriesWinner = isFinished && score1 != null && score2 != null && score1 !== score2 ? (score1 > score2 ? 'team1' : 'team2') : null;
    const statusLabel = isFinished ? '已结束' : live.started ? '进行中' : '未开始';
    const sideLabel = side => (side === 'ct' ? 'CT' : 'T');
    const roundless = isRoundless(match.game_type);
    const unit = gameUnitOf(match.game_type);

    const maps = matchCenterMaps(live, match.game_type).map(row => {
        const game = row.game;
        // 系列赛已结束却没有对局的地图（如 2-0 后的决胜图）= 未进行
        const state = game ? game.status : isFinished ? 'skipped' : 'upcoming';
        const key = mapKey(row.map);
        const art = !roundless && MAP_ART.has(key) ? ` style="background-image:url('/images/maps/${key}.webp')"` : '';
        const pickLabel = row.veto?.type === 'pick' ? `${teamName(row.veto.team)} 选图` : row.veto?.type === 'decider' ? '决胜图' : '';
        const sideNote = row.veto?.side ? `${teamName(row.veto.side.team)} 先手 ${sideLabel(row.veto.side.side)}` : '';
        const stateNote = state === 'ongoing' ? '<span class="mc-live">进行中</span>' : state === 'upcoming' ? '<span class="mc-pending">待进行</span>' : state === 'skipped' ? '<span class="mc-pending">未进行</span>' : '';
        const teamLine = key2 => {
            const rounds = game ? game[`${key2}_rounds`] : null;
            const won = game?.winner === key2;
            return `<div class="mc-map-team ${won ? 'won' : game?.winner ? 'lost' : ''}">
                <span>${teamName(key2)}</span><b title="${gameScoreHint(match.game_type)}">${rounds ?? '-'}</b>
            </div>`;
        };
        // LoL 每局都是同一张图，没有地图示意图可放：压成一行「第 N 局  BLG 18 : 6 T1」
        if (roundless) {
            const side = key2 => `<span class="mc-game-team ${game?.winner === key2 ? 'won' : game?.winner ? 'lost' : ''}">${teamName(key2)}</span>`;
            const kills = key2 => `<b class="${game?.winner === key2 ? 'won' : ''}">${game?.[`${key2}_rounds`] ?? '-'}</b>`;
            return `<div class="mc-game ${state}">
                <strong>${escapeSharedHtml(gameSlotLabel(match.game_type, game || { sequence: '?' }))}</strong>
                <span class="mc-game-line">${side('team1')}${kills('team1')}<em>:</em>${kills('team2')}${side('team2')}</span>
                ${stateNote || '<small>击杀</small>'}
            </div>`;
        }
        return `<div class="mc-map ${state}">
            <div class="mc-map-art ${art ? '' : 'no-art'}"${art}>
                <strong>${escapeSharedHtml(game ? gameSlotLabel(match.game_type, game) : mapLabel(row.map))}</strong>
                ${pickLabel ? `<small>${pickLabel}</small>` : ''}
            </div>
            <div class="mc-map-result">${teamLine('team1')}${teamLine('team2')}</div>
            ${sideNote || stateNote ? `<div class="mc-map-foot"><span>${sideNote}</span>${stateNote}</div>` : ''}
        </div>`;
    }).join('');

    const veto = (live.veto || []).map(entry => {
        const map = `<b>${escapeSharedHtml(mapLabel(entry.map))}</b>`;
        let text;
        if (entry.type === 'ban') text = `${teamName(entry.team)} 禁用 ${map}`;
        else if (entry.type === 'pick') text = `${teamName(entry.team)} 选择 ${map}${entry.side ? `<em>（${teamName(entry.side.team)} 选择 ${sideLabel(entry.side.side)} 方）</em>` : ''}`;
        else text = `${map} 为决胜图`;
        return `<li class="mc-veto-${entry.type}"><span class="mc-veto-no">${entry.sequence}</span><span>${text}</span></li>`;
    }).join('');

    const heroTeam = key => `<div class="mc-team ${seriesWinner === key ? 'won' : ''}">
        ${logoHtml(match[`${key}_logo_url`], match[`${key}_dark_logo_url`])}
        <strong>${teamName(key)}</strong>
    </div>`;
    const scoreHtml = score1 != null && score2 != null
        ? `<div class="mc-score"><span class="${seriesWinner === 'team1' ? 'won' : ''}">${score1}</span><em>:</em><span class="${seriesWinner === 'team2' ? 'won' : ''}">${score2}</span></div>`
        : '<div class="mc-score mc-score-vs">VS</div>';

    return `<div class="match-center-detail">
        <div class="mc-meta">${tournamentLogo(match.tournament_name, match.game_type, match.tournament_logo_url)}<span>${escapeSharedHtml(match.tournament_name || '')}</span><span>${escapeSharedHtml(match.format || '')}</span><span>${formatDateTime(match.match_time)}</span></div>
        <div class="mc-hero">
            ${heroTeam('team1')}
            <div class="mc-hero-center">${scoreHtml}<span class="mc-status ${isFinished ? 'finished' : live.started ? 'live' : ''}">${statusLabel}</span></div>
            ${heroTeam('team2')}
        </div>
        ${maps ? `<section class="mc-section"><h3>${roundless ? '对局' : '地图'}</h3><div class="${roundless ? 'mc-games' : 'mc-maps'}">${maps}</div></section>` : ''}
        ${veto ? `<section class="mc-section"><h3>BP 流程</h3><ol class="mc-veto">${veto}</ol></section>` : ''}
        ${live.has_stats ? `<section class="mc-section"><h3>${roundless ? '每局数据' : '每图数据'}</h3><div class="gs-host" data-mc-stats><div class="rv-md-loading">加载中…</div></div></section>` : ''}
        <p class="mc-source">${roundless ? `每${unit}比分为击杀数，` : ''}${roundless ? '对局' : '地图'}与 BP 数据来自 GRID Open Access，仅供展示，结算以官方赛果为准。</p>
    </div>`;
}

// ===== 比赛详情弹窗（主页 / 回看页共用）：地图（默认）/ 预测 / 交锋 =====
// 依赖：shared.js 的 renderMatchPredictionDetail、h2h.js 的 renderHead2HeadInto。
const matchDetail = { id: null, match: null, tab: null, token: 0, timer: null };

function matchDetailTabs(match) {
    const tbd = match.team1_name === 'TBD' || match.team2_name === 'TBD';
    const tabs = [];
    if (hasMatchCenter(match)) tabs.push(['map', isRoundless(match.game_type) ? '对局' : '地图']);
    // 预测明细接口只对已结束比赛开放
    if (match.status === 'finished') tabs.push(['predictions', '预测']);
    if (!tbd) tabs.push(['h2h', '交锋']);
    return tabs;
}

async function openMatchDetail(matchId, tab) {
    const modalEl = document.getElementById('detailModal');
    const bodyEl = document.getElementById('detailModalBody');
    if (!modalEl || !bodyEl) return;
    stopMatchDetail();
    const token = ++matchDetail.token;
    let match;
    try {
        ({ match } = await sharedApi(`/matches/${matchId}`));
    } catch (error) {
        alert(error.message);
        return;
    }
    if (token !== matchDetail.token) return;
    const tabs = matchDetailTabs(match);
    if (!tabs.length) return;
    matchDetail.id = Number(matchId);
    matchDetail.match = match;
    bodyEl.innerHTML = `<div class="rv-md">
        ${tabs.length > 1 ? `<nav class="rv-md-tabs" role="tablist">${tabs.map(([key, label]) => `<button type="button" role="tab" data-md-tab="${key}" onclick="loadMatchDetailTab('${key}')">${label}</button>`).join('')}</nav>` : ''}
        <div class="rv-md-body" id="matchDetailBody"></div>
    </div>`;
    modalEl.hidden = false;
    document.body.classList.add('modal-open');
    const keys = tabs.map(([key]) => key);
    await loadMatchDetailTab(keys.includes(tab) ? tab : keys[0], { fresh: true });
}

async function loadMatchDetailTab(tab, { silent = false, fresh = false } = {}) {
    const modalEl = document.getElementById('detailModal');
    const body = document.getElementById('matchDetailBody');
    if (!body || matchDetail.id == null) return;
    const matchId = matchDetail.id;
    const token = ++matchDetail.token;
    matchDetail.tab = tab;
    clearTimeout(matchDetail.timer);
    document.querySelectorAll('[data-md-tab]').forEach(button => {
        const active = button.dataset.mdTab === tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
    });
    if (!silent) body.innerHTML = '<div class="rv-md-loading">加载中…</div>';
    try {
        if (tab === 'map') {
            // 刚打开时复用已取到的比赛数据；切回地图或定时刷新时重新拉取
            const match = fresh && matchDetail.match ? matchDetail.match : (await sharedApi(`/matches/${matchId}`)).match;
            if (token !== matchDetail.token) return;
            // 定时刷新时先保留上一次的数据板，避免每 30 秒闪一下「加载中」
            const previousStats = body.querySelector('[data-mc-stats]')?.innerHTML;
            body.innerHTML = matchCenterHtml(match);
            const statsHost = body.querySelector('[data-mc-stats]');
            if (statsHost && typeof renderMatchStatsInto === 'function') {
                if (previousStats && silent) statsHost.innerHTML = previousStats;
                renderMatchStatsInto(match, statsHost);
            }
            // 比赛进行中：地图页每 30 秒刷新（切换标签或关闭弹窗即停止）
            if (match.live?.started && !match.live.finished && match.status !== 'finished') {
                matchDetail.timer = setTimeout(() => {
                    if (modalEl && !modalEl.hidden && matchDetail.id === matchId && matchDetail.tab === 'map') loadMatchDetailTab('map', { silent: true });
                }, 30000);
            }
        } else if (tab === 'predictions') {
            const data = await sharedApi(`/matches/${matchId}/predictions`);
            if (token !== matchDetail.token) return;
            body.innerHTML = renderMatchPredictionDetail(data.match, data.predictions);
        } else {
            await renderHead2HeadInto(matchId, body);
        }
        const panel = modalEl?.querySelector('.modal-panel');
        if (panel && !silent) panel.scrollTop = 0;
    } catch (error) {
        if (token === matchDetail.token && !silent) body.innerHTML = `<div class="rv-md-loading">${escapeSharedHtml(error.message)}</div>`;
    }
}

// 关闭弹窗时由各页 closeDetailModal 调用：停止刷新并作废进行中的请求
function stopMatchDetail() {
    clearTimeout(matchDetail.timer);
    matchDetail.id = null;
    matchDetail.match = null;
    matchDetail.token++;
}

// 旧入口：直接打开地图页
const showMatchCenter = matchId => openMatchDetail(matchId, 'map');

window.mapLabel = mapLabel;
window.gameSlotLabel = gameSlotLabel;
window.mapStripHtml = mapStripHtml;
window.hasMatchCenter = hasMatchCenter;
window.openMatchDetail = openMatchDetail;
window.loadMatchDetailTab = loadMatchDetailTab;
window.stopMatchDetail = stopMatchDetail;
window.showMatchCenter = showMatchCenter;
