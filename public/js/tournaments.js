// 赛事回看：列表页（筛选 + 按状态分组）与赛事详情页（阶段标签 + 赛程图 + 精简比赛行）。
// 赛程图由 bracket.js / bracket-ui.js 渲染；机器人截图（bot/browser.js）依赖详情页中的
// .ar-focus-stages、.tournament-stage-block(details) 与 .tournament-stage-head h3，改结构时需同步。
const state = {
    game: localStorage.getItem('gameFilter') ?? 'cs2',
    status: localStorage.getItem('tournamentStatusFilter') || '',
    tournaments: [],
    brand: localStorage.getItem('tournamentBrandFilter') || '',
    tier: localStorage.getItem('tournamentTierFilter') || '',
    search: '',
    activeTournamentId: new URLSearchParams(location.search).get('tournament') || '',
    activeTournamentData: null,
    activeStageKey: '',
    // 赛事详情：schedule（赛程）/ stats（数据统计，GRID 每局详细数据汇总）
    detailView: 'schedule',
    previews: [],
    previewDays: 0
};

const toolbarEl = document.querySelector('.rv-toolbar');
const gameSegEl = document.querySelector('#gameSeg');
const statusSegEl = document.querySelector('#statusSeg');
const tierSegEl = document.querySelector('#tierSeg');
const searchEl = document.querySelector('#tournamentSearch');
const brandFiltersEl = document.querySelector('#brandFilters');
const tournamentsEl = document.querySelector('#tournaments');
const detailModalEl = document.querySelector('#detailModal');
const detailModalBodyEl = document.querySelector('#detailModalBody');
const previewSectionEl = document.querySelector('#previewSection');
const previewMetaEl = document.querySelector('#previewMeta');
const previewListEl = document.querySelector('#previewList');

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

// 只显示日期（沿用 formatDateTime 的年份规则，去掉时分）
const formatDay = value => formatDateTime(value).split(' ')[0];

function dateRange(start, end) {
    const a = start ? formatDay(start) : '';
    const b = end ? formatDay(end) : '';
    return a && b && a !== b ? `${a} – ${b}` : (a || b);
}

// ---------- 工具栏：游戏 / 状态 / 级别 / 厂牌 / 搜索 ----------

function syncSegments() {
    gameSegEl?.querySelectorAll('button[data-game]').forEach(button => {
        button.classList.toggle('active', button.dataset.game === state.game);
    });
    statusSegEl?.querySelectorAll('button[data-status]').forEach(button => {
        button.classList.toggle('active', button.dataset.status === state.status);
    });
}

function setGame(game) {
    state.game = game;
    state.activeTournamentId = '';
    // 切换游戏后原厂牌大概率不存在于新列表，重置避免空结果
    state.brand = '';
    localStorage.setItem('gameFilter', game);
    localStorage.setItem('tournamentBrandFilter', '');
    syncSegments();
    updateTournamentUrl();
    renderTierChips();
    renderPreviews();
    loadTournaments();
}

function setStatus(status) {
    state.status = status;
    localStorage.setItem('tournamentStatusFilter', status);
    syncSegments();
    loadTournaments();
}

// 厂牌 chip 展示顺序（见 games.js brandOrder，与服务端 brands 对应；全部游戏时按游戏顺序取并集）
const BRAND_ORDER = Object.fromEntries(GAME_KEYS.map(key => [key, GAME_REGISTRY[key].brandOrder]));

function setBrand(brand) {
    state.brand = brand;
    localStorage.setItem('tournamentBrandFilter', brand);
    renderBrandChips();
    renderArchiveList();
}

function setTier(tier) {
    state.tier = tier;
    localStorage.setItem('tournamentTierFilter', tier);
    renderTierChips();
    renderArchiveList();
}

// 级别口径（与后端 tournamentTier.js 一致）只放在悬停提示里，不占页面文字
const TIER_HINTS = {
    ...Object.fromEntries(GAME_KEYS.map(key => [key, GAME_REGISTRY[key].tierHints])),
    '': {
        1: GAME_KEYS.map(key => `${GAME_REGISTRY[key].label} ${GAME_REGISTRY[key].topTierWords.filter(word => /^[A-Za-z]/.test(word)).join(' / ')}`).join('、'),
        2: '其余常规赛事',
        3: '预选赛'
    }
};
const TIER_LABELS = { 1: '顶级', 2: '常规', 3: '预选' };

function renderTierChips() {
    if (!tierSegEl) return;
    const hints = TIER_HINTS[state.game] || TIER_HINTS[''];
    tierSegEl.innerHTML = ['1', '2', '3'].map(tier =>
        `<button type="button" class="rv-chip ${state.tier === tier ? 'active' : ''}" title="${escapeHtml(hints[tier])}" onclick="setTier('${state.tier === tier ? '' : tier}')">${TIER_LABELS[tier]}</button>`
    ).join('');
}

function renderBrandChips() {
    if (!brandFiltersEl) return;
    const counts = new Map();
    state.tournaments.forEach(t => {
        const key = t.brand || '其他';
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    // 持久化的厂牌在当前列表不存在（如换游戏后残留）时自动回退"全部"
    if (state.brand && !counts.has(state.brand)) {
        state.brand = '';
        localStorage.setItem('tournamentBrandFilter', '');
    }
    const order = [...new Set(GAME_KEYS.flatMap(key => BRAND_ORDER[key]))];
    const keys = [...counts.keys()].sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    const chip = (key, label) => `<button type="button" class="rv-chip ${state.brand === key ? 'active' : ''}" onclick="setBrand('${key}')">${escapeHtml(label)}</button>`;
    brandFiltersEl.innerHTML = chip('', '全部') + keys.map(key => chip(key, key)).join('');
}

function filteredTournaments() {
    const keyword = state.search.trim().toLowerCase();
    return state.tournaments.filter(t => {
        if (state.brand && (state.brand === '其他' ? t.brand : t.brand !== state.brand)) return false;
        if (state.tier && String(t.effective_tier) !== state.tier) return false;
        if (keyword) {
            const haystack = `${t.name || ''} ${t.short_name || ''}`.toLowerCase();
            if (!haystack.includes(keyword)) return false;
        }
        return true;
    });
}

// ---------- 列表 ----------

// 级别徽章：只标顶级与预选，常规不显示
function tierBadge(tournament) {
    const name = tournament.name || '';
    if (tournament.effective_tier === 1) {
        const keyword = name.match(new RegExp(gameTopTierWords().join('|'), 'i'));
        const fallback = isGameKey(tournament.game_type) ? GAME_REGISTRY[tournament.game_type].topTierWords[0] : '顶级';
        const label = keyword ? keyword[0] : fallback;
        return `<span class="tier-badge tier-top">${escapeHtml(label)}</span>`;
    }
    if (tournament.effective_tier === 3) return '<span class="tier-badge tier-low">预选</span>';
    return '';
}

// 「全部」游戏时才需要区分游戏
function gameTag(gameType) {
    return state.game ? '' : `<span class="rv-game ${gameType}">${escapeHtml(gameName(gameType))}</span>`;
}

// 无上传 logo 时用字母徽标兜底
function tournamentMark(tournament) {
    const name = String(tournament.short_name || tournament.name || '').trim();
    const letters = name.replace(/[^A-Za-z0-9一-龥]/g, '').slice(0, 2).toUpperCase() || '?';
    return `<span class="rv-mark ${tournament.game_type}">${escapeHtml(letters)}</span>`;
}

function tournamentLogoHtml(tournament) {
    return tournamentLogo(tournament.name, tournament.game_type, tournament.logo_url) || tournamentMark(tournament);
}

// 卡片用真实链接（可新标签打开）；普通点击走单页切换并记录列表滚动位置
function tournamentLink(tournament) {
    return `href="/tournaments.html?tournament=${tournament.id}" onclick="return openFromList(event, ${tournament.id})"`;
}

function openFromList(event, id) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return true;
    event.preventDefault();
    enterTournament(id);
    return false;
}

function activeCard(tournament) {
    const total = tournament.match_count || 0;
    const finished = tournament.finished_count || 0;
    const live = tournament.ongoing_count || 0;
    const progress = total ? Math.round((finished / total) * 100) : 0;
    return `<a class="rv-card ${live ? 'is-live' : ''}" ${tournamentLink(tournament)}>
        <span class="rv-logo">${tournamentLogoHtml(tournament)}</span>
        <span class="rv-card-body">
            <strong class="rv-name" title="${escapeHtml(tournament.name)}">${tournamentNameHtml(tournament.name, tournament.short_name)}</strong>
            <span class="rv-sub">${gameTag(tournament.game_type)}${tierBadge(tournament)}<span>${dateRange(tournament.begin_at, tournament.end_at)}</span></span>
            ${total ? `<span class="rv-progress" aria-label="已结束 ${finished}/${total}"><i style="width:${progress}%"></i></span>` : ''}
        </span>
        <span class="rv-card-side">
            ${live ? `<span class="rv-live"><i></i>${live}</span>` : ''}
            ${total ? `<span class="rv-count">${finished}<small>/${total}</small></span>` : ''}
        </span>
    </a>`;
}

function finishedTile(tournament) {
    return `<a class="rv-tile" ${tournamentLink(tournament)}>
        <span class="rv-logo sm">${tournamentLogoHtml(tournament)}</span>
        <span class="rv-tile-body">
            <strong class="rv-name" title="${escapeHtml(tournament.name)}">${tournamentNameHtml(tournament.name, tournament.short_name)}</strong>
            <span class="rv-sub">${gameTag(tournament.game_type)}${tierBadge(tournament)}<span>${dateRange(tournament.begin_at, tournament.end_at)}</span></span>
        </span>
    </a>`;
}

function renderArchiveList() {
    const rows = tournamentOrder.sortTournaments(filteredTournaments());
    const groups = { ongoing: [], upcoming: [], finished: [] };
    rows.forEach(t => groups[tournamentOrder.tournamentStatus(t)].push(t));
    const section = (title, items, render, layout) => items.length
        ? `<section class="rv-group"><h2 class="rv-group-title">${title}<span>${items.length}</span></h2><div class="${layout}">${items.map(render).join('')}</div></section>`
        : '';
    tournamentsEl.innerHTML = section('进行中', groups.ongoing, activeCard, 'rv-cards')
        + section('即将开始', groups.upcoming, activeCard, 'rv-cards')
        + section('已结束', groups.finished, finishedTile, 'rv-tiles')
        || '<div class="rv-empty">没有符合条件的赛事</div>';
}

// ---------- 赛事预告（赛事级，不参与积分/回看）：一行横向滚动 ----------

function previewItem(preview) {
    const name = preview.name || '';
    const logo = tournamentLogo(name, preview.game_type) || tournamentMark({ name, game_type: preview.game_type });
    return `<div class="rv-preview" title="${escapeHtml(name)}">
        <span class="rv-logo xs">${logo}</span>
        <span class="rv-preview-body"><strong>${escapeHtml(name)}</strong><small>${gameTag(preview.game_type)}${dateRange(preview.begin_at, preview.end_at)}</small></span>
    </div>`;
}

// 回看列表已有对应赛事时不再重复出现在预告里（external_id 与名称兜底匹配）
function listedTournamentKeys() {
    const keys = { externalIds: new Set(), names: new Set() };
    state.tournaments.forEach(tournament => {
        if (tournament.external_id) keys.externalIds.add(tournament.external_id);
        keys.names.add(`${tournament.game_type}:${String(tournament.name || '').trim().toLowerCase()}`);
    });
    return keys;
}

function previewAlreadyListed(preview, keys) {
    if (preview.external_id && keys.externalIds.has(preview.external_id)) return true;
    return keys.names.has(`${preview.game_type}:${String(preview.name || '').trim().toLowerCase()}`);
}

function renderPreviews() {
    if (!previewSectionEl) return;
    const listed = listedTournamentKeys();
    const rows = state.previews.filter(preview => {
        if (state.game && preview.game_type !== state.game) return false;
        return !previewAlreadyListed(preview, listed);
    });
    // 只在列表页、未筛选「已结束」时展示
    if (state.activeTournamentId || state.status === 'finished' || !rows.length) { previewSectionEl.hidden = true; return; }
    previewSectionEl.hidden = false;
    previewMetaEl.textContent = rows.length;
    previewListEl.innerHTML = rows.map(previewItem).join('');
}

async function loadPreviews() {
    try {
        const data = await sharedApi('/tournaments/previews');
        state.previews = data.previews || [];
        state.previewDays = data.days || 0;
        renderPreviews();
    } catch (error) {
        console.warn('[previews]', error.message);
    }
}

// 列表与详情共用同一容器：详情页隐藏工具栏和预告
function applyPageMode() {
    const detail = Boolean(state.activeTournamentId);
    if (toolbarEl) toolbarEl.hidden = detail;
    if (detail && previewSectionEl) previewSectionEl.hidden = true;
    tournamentsEl?.classList.toggle('rv-list', !detail);
    tournamentsEl?.classList.toggle('rv-detail-host', detail);
}

function updateTournamentUrl(push = false) {
    const url = new URL(location.href);
    if (state.activeTournamentId) url.searchParams.set('tournament', state.activeTournamentId);
    else url.searchParams.delete('tournament');
    if (push) {
        // 从列表进入详情时新增历史记录，浏览器后退即回到列表
        url.hash = '';
        history.pushState({ fromList: true }, '', url);
    } else history.replaceState(history.state, '', url);
}

// ---------- 详情页：比赛行 ----------

const isRowLive = match => !!(match.live?.started && !match.live.finished) || match.status === 'ongoing';

function matchScore(match) {
    const live = match.live;
    if (match.status !== 'finished' && live?.started && !live.finished && live.team1_score != null && live.team2_score != null) {
        return `<span class="rv-score live" title="实时比分"><b>${live.team1_score}</b><em>:</em><b>${live.team2_score}</b></span>`;
    }
    if (match.status !== 'finished' || match.team1_score == null) return '<span class="rv-score vs">VS</span>';
    const w1 = match.team1_score > match.team2_score;
    const w2 = match.team2_score > match.team1_score;
    return `<span class="rv-score"><b class="${w1 ? 'won' : ''}">${match.team1_score}</b><em>:</em><b class="${w2 ? 'won' : ''}">${match.team2_score}</b></span>`;
}

function teamCell(match, side) {
    const prefix = side === 1 ? 'team1' : 'team2';
    const name = match[`${prefix}_name`] || 'TBD';
    const label = match[`${prefix}_short_name`] || name;
    const finished = match.status === 'finished' && match.team1_score != null;
    const won = finished && (side === 1 ? match.team1_score > match.team2_score : match.team2_score > match.team1_score);
    const lost = finished && !won && match.team1_score !== match.team2_score;
    const tbd = name === 'TBD';
    const logo = logoHtml(match[`${prefix}_logo_url`], match[`${prefix}_dark_logo_url`]);
    const inner = side === 1
        ? `<span class="rv-team-name">${escapeHtml(label)}</span>${logo}`
        : `${logo}<span class="rv-team-name">${escapeHtml(label)}</span>`;
    const cls = `rv-team side-${side} ${won ? 'won' : ''} ${lost ? 'lost' : ''}`;
    return tbd
        ? `<span class="${cls} tbd">${inner}</span>`
        : `<a class="${cls}" href="/teams.html?team=${match[`${prefix}_id`]}" title="${escapeHtml(name)}" onclick="event.stopPropagation()">${inner}</a>`;
}

function whenCell(match) {
    if (match.is_forfeit) return '<span class="rv-when-tag">弃权</span>';
    if (match.status === 'cancelled') return '<span class="rv-when-tag">取消</span>';
    if (match.status === 'postponed') return '<span class="rv-when-tag">延期</span>';
    if (isRowLive(match)) return '<span class="rv-when-live"><i></i>LIVE</span>';
    const [day, time] = formatDateTime(match.match_time).split(' ');
    return `<span class="rv-when-day">${escapeHtml(day || '')}</span><span class="rv-when-time">${escapeHtml(time || '')}</span>`;
}

// 比赛卡片：只放时间、对阵与比分。点击打开比赛详情（地图 / 预测 / 交锋），对阵未定的不可点。
function matchRow(match) {
    const tbd = isTbdMatch(match);
    const finished = match.status === 'finished';
    const live = isRowLive(match);
    const predictions = match.prediction_count || 0;
    const stateClass = live ? 'live' : finished ? 'finished' : tbd ? 'tbd' : 'upcoming';
    const open = tbd ? '' : ` onclick="openMatchDetail(${match.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openMatchDetail(${match.id})}" tabindex="0" role="button" aria-label="查看比赛详情"`;
    return `<article class="rv-match ${stateClass} ${tbd ? '' : 'clickable'}" id="match-row-${match.id}" data-match-id="${match.id}" title="${escapeHtml(match.name || '')}"${open}>
        <div class="rv-match-meta">
            <span class="rv-when">${whenCell(match)}</span>
            <span class="rv-meta-right">${predictions ? `<span>${predictions} 预测</span>` : ''}<span>${escapeHtml(match.format || '')}</span></span>
        </div>
        <div class="rv-teams">
            ${teamCell(match, 1)}
            <span class="rv-mid">${matchScore(match)}</span>
            ${teamCell(match, 2)}
        </div>
    </article>`;
}

// 比赛详情弹窗（地图 / 预测 / 交锋）在 match-center.js：openMatchDetail

// ---------- 详情页：阶段标签 + 阶段面板 ----------

function stageLive(stage) {
    return stageMatches(stage).some(isRowLive);
}

// 默认打开：有进行中比赛的阶段 → 第一个未完赛阶段 → 最后一个阶段
function defaultStageKey(stages) {
    const live = stages.find(stageLive);
    if (live) return live.key;
    const open = stages.find(stage => stageMatches(stage).some(match => match.status !== 'finished' && !isTbdMatch(match)));
    return (open || stages[stages.length - 1])?.key || '';
}

function stageTabs(stages) {
    if (stages.length < 2) return '';
    return `<nav class="rv-tabs" role="tablist" aria-label="赛事阶段">${stages.map(stage => {
        const metrics = stageItemMetrics(stage);
        const done = metrics.total > 0 && metrics.finished >= metrics.total;
        const active = stage.key === state.activeStageKey;
        const status = stageLive(stage) ? '<i class="rv-tab-live" aria-label="进行中"></i>'
            : done ? '<i class="rv-tab-done" aria-label="已完成">✓</i>'
                : `<small>${metrics.finished}/${metrics.total}</small>`;
        return `<button type="button" role="tab" class="rv-tab ${active ? 'active' : ''}" aria-selected="${active}" data-stage-tab="${escapeHtml(stage.key)}" onclick="selectStage(this.dataset.stageTab)">
            <span>${escapeHtml(stage.label)}</span>${status}
        </button>`;
    }).join('')}</nav>`;
}

function roundBlock(group, showTitle) {
    const rows = group.matches || [];
    if (!rows.length) return '';
    return `<section class="rv-round">
        ${showTitle ? `<h4 class="rv-round-title">${escapeHtml(group.label)}</h4>` : ''}
        <div class="rv-match-list">${rows.map(matchRow).join('')}</div>
    </section>`;
}

function stagePanel(stage) {
    let diagram = '';
    let rounds;
    if (stage.groups) {
        diagram = stageDiagram(stage);
        rounds = stage.groups;
    } else {
        const roundGroups = roundGroupsFromMatches(stage.matches || []);
        diagram = roundGroups.length ? stageDiagram(stage, roundGroups) : stageDiagram(stage);
        rounds = roundGroups.length ? roundGroups : [{ label: '', matches: stage.matches || [] }];
    }
    const showTitles = rounds.length > 1;
    // <details> 保留给机器人截图：它通过 open=true 展开需要的阶段；页面上由标签控制 open。
    return `<details class="tournament-stage-block rv-stage" id="stage-${escapeHtml(stage.key)}" data-stage-key="${escapeHtml(stage.key)}"${stage.key === state.activeStageKey ? ' open' : ''}>
        <summary class="tournament-stage-head"><h3>${escapeHtml(stage.label)}</h3></summary>
        <div class="tournament-stage-content">
            ${diagram ? `<div class="rv-bracket">${diagram}</div>` : ''}
            <div class="rv-rounds">${rounds.map(group => roundBlock(group, showTitles)).join('')}</div>
        </div>
    </details>`;
}

function selectStage(key) {
    if (!key) return;
    state.activeStageKey = key;
    document.querySelectorAll('.rv-stage').forEach(stage => { stage.open = stage.dataset.stageKey === key; });
    document.querySelectorAll('[data-stage-tab]').forEach(tab => {
        const active = tab.dataset.stageTab === key;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
    });
}

function tournamentDetailPage(data) {
    const tournament = data.tournament;
    const matches = data.matches || [];
    const finished = tournament.finished_count || matches.filter(match => match.status === 'finished').length;
    const total = tournament.match_count || matches.length;
    const live = matches.filter(isRowLive).length;
    const progress = total ? Math.round((finished / total) * 100) : 0;
    const stages = buildTournamentStagesWithOfficial(matches, data.bracketStages, { gameType: tournament.game_type });
    if (!stages.some(stage => stage.key === state.activeStageKey)) state.activeStageKey = defaultStageKey(stages);
    // 只统计本地已入库比赛：官方 nodes 可能包含尚未进入同步窗口的未来场次。
    const stageTotal = new Set(stages.flatMap(stage => stageMatches(stage)).filter(match => match.id).map(match => String(match.id))).size;
    const notice = stageTotal === matches.length ? '' : `<p class="rv-notice">部分比赛暂未归入阶段（${stageTotal}/${matches.length}）</p>`;
    const hasStats = (tournament.stats_games || 0) > 0 && typeof tournamentStatsContainer === 'function';
    const view = hasStats ? state.detailView : 'schedule';
    return `<section class="rv-detail">
        <button type="button" class="rv-back" onclick="backToTournamentList()">‹ 赛事回看</button>
        <header class="rv-hero ${tournament.game_type}">
            <span class="rv-logo lg">${tournamentLogoHtml(tournament)}</span>
            <div class="rv-hero-text">
                <h2 title="${escapeHtml(tournament.name)}">${tournamentNameHtml(tournament.name, tournament.short_name)}</h2>
                <p class="rv-sub">${gameTag(tournament.game_type)}${tierBadge(tournament)}<span>${dateRange(tournament.begin_at, tournament.end_at)}</span></p>
            </div>
            <div class="rv-hero-side">
                ${live ? `<span class="rv-live"><i></i>${live} 场进行中</span>` : ''}
                <span class="rv-count lg">${finished}<small>/${total} 场</small></span>
                <span class="rv-progress"><i style="width:${progress}%"></i></span>
            </div>
        </header>
        ${hasStats ? `<nav class="rv-view-switch" role="tablist" aria-label="赛事视图">
            <button type="button" role="tab" class="${view === 'schedule' ? 'active' : ''}" onclick="setDetailView('schedule')">赛程</button>
            <button type="button" role="tab" class="${view === 'stats' ? 'active' : ''}" onclick="setDetailView('stats')">数据</button>
        </nav>` : ''}
        ${view === 'stats' ? tournamentStatsContainer(tournament.id, tournament.game_type) : `${notice}
        ${stageTabs(stages)}
        <div class="ar-focus-stages rv-stages">${stages.map(stagePanel).join('') || '<div class="rv-empty">暂无比赛</div>'}</div>`}
    </section>`;
}

let lastBracketCompactMode = isCompactBracketViewport();
window.addEventListener('resize', () => {
    const compact = isCompactBracketViewport();
    if (compact === lastBracketCompactMode) return;
    lastBracketCompactMode = compact;
    // 仅布局随断点变化：用缓存数据重绘（保留当前阶段），不再重新请求。
    if (state.activeTournamentData) tournamentsEl.innerHTML = tournamentDetailPage(state.activeTournamentData);
});

function setDetailView(view) {
    state.detailView = view === 'stats' ? 'stats' : 'schedule';
    if (state.activeTournamentData && tournamentsEl) tournamentsEl.innerHTML = tournamentDetailPage(state.activeTournamentData);
}

async function openTournamentPage(id) {
    if (!tournamentsEl) return;
    if (String(id) !== state.activeTournamentId || !state.activeTournamentData) {
        state.activeStageKey = '';
        state.detailView = 'schedule';
    }
    state.activeTournamentId = String(id);
    state.activeTournamentData = null;
    updateTournamentUrl();
    applyPageMode();
    tournamentsEl.innerHTML = '<div class="rv-loading">加载中…</div>';
    try {
        // bracket 是增强数据：失败时照常展示比赛列表和旧推断赛程图。
        const [detail, bracket] = await Promise.all([
            sharedApi(`/tournaments/${id}`),
            sharedApi(`/tournaments/${id}/brackets`).catch(() => null)
        ]);
        const data = { ...detail, bracketStages: (bracket && bracket.stages) || [] };
        state.activeTournamentData = data;
        tournamentsEl.innerHTML = tournamentDetailPage(data);
        const matchAnchor = location.hash.match(/^#match-row-(\d+)$/);
        const stageAnchor = location.hash.match(/^#stage-(.+)$/);
        if (matchAnchor) requestAnimationFrame(() => focusTournamentMatch(matchAnchor[1]));
        else if (stageAnchor) selectStage(decodeURIComponent(stageAnchor[1]));
    } catch (error) {
        tournamentsEl.innerHTML = `<div class="rv-empty">加载失败：${escapeHtml(error.message)}<br><button type="button" class="rv-act" onclick="backToTournamentList()">返回赛事列表</button></div>`;
    }
}

// 列表卡片入口：记录列表滚动位置并新增历史记录
function enterTournament(id) {
    state.listScrollY = window.scrollY;
    state.activeTournamentId = String(id);
    updateTournamentUrl(true);
    window.scrollTo(0, 0);
    openTournamentPage(id);
}

function showTournamentList() {
    state.activeTournamentId = '';
    state.activeTournamentData = null;
    applyPageMode();
    const restore = () => window.scrollTo(0, state.listScrollY || 0);
    // 已加载过列表时直接重绘并恢复滚动位置，避免重新请求后跳回顶部
    if (state.tournaments.length) {
        syncSegments();
        renderArchiveList();
        renderPreviews();
        requestAnimationFrame(restore);
    } else loadTournaments().then(restore);
}

function backToTournamentList() {
    // 由列表进入时等同浏览器后退，避免历史记录里叠出重复的列表页
    if (history.state?.fromList) { history.back(); return; }
    state.activeTournamentId = '';
    updateTournamentUrl();
    showTournamentList();
}

window.addEventListener('popstate', () => {
    const id = new URLSearchParams(location.search).get('tournament') || '';
    if (id === state.activeTournamentId) return; // 仅 hash 变化
    if (id) {
        state.activeTournamentId = id;
        openTournamentPage(id);
    } else showTournamentList();
});

// 赛程图卡片 / 外部链接定位到比赛：先切到所在阶段，再滚动并高亮
function focusTournamentMatch(matchId) {
    const row = document.getElementById(`match-row-${matchId}`);
    if (!row) return;
    const stage = row.closest('.rv-stage');
    if (stage && !stage.open) selectStage(stage.dataset.stageKey);
    requestAnimationFrame(() => {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.remove('match-row-highlight');
        requestAnimationFrame(() => row.classList.add('match-row-highlight'));
        window.setTimeout(() => row.classList.remove('match-row-highlight'), 1800);
    });
}

// 旧入口（首页等处的阶段链接）兼容
function openTournamentStage(stageKey, event) {
    event?.preventDefault();
    selectStage(stageKey);
}

function closeDetailModal() {
    stopMatchDetail();
    if (detailModalEl) detailModalEl.hidden = true;
    if (detailModalBodyEl) detailModalBodyEl.innerHTML = '';
    document.body.classList.remove('modal-open');
}

async function showMatchPredictions(matchId) {
    if (!detailModalEl || !detailModalBodyEl) return;
    try {
        const data = await sharedApi(`/matches/${matchId}/predictions`);
        // 渲染结构由 shared.js 统一提供（主页/回看页共用）
        detailModalBodyEl.innerHTML = renderMatchPredictionDetail(data.match, data.predictions);
        detailModalEl.hidden = false;
        document.body.classList.add('modal-open');
    } catch (error) {
        alert(error.message);
    }
}

async function loadTournaments() {
    if (!tournamentsEl) return;
    applyPageMode();
    if (state.activeTournamentId) {
        await openTournamentPage(state.activeTournamentId);
        return;
    }
    syncSegments();
    tournamentsEl.innerHTML = '<div class="rv-loading">加载中…</div>';
    const params = new URLSearchParams();
    if (state.game) params.set('game_type', state.game);
    if (state.status) params.set('status', state.status);
    const data = await sharedApi(`/tournaments${params.toString() ? `?${params}` : ''}`);
    state.tournaments = data.tournaments;
    renderBrandChips();
    renderTierChips();
    renderArchiveList();
    renderPreviews();
}

// ---------- 回到顶部悬浮按钮：下滑超过一屏后出现在右下角 ----------
(function ensureBackToTop() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'back-to-top';
    button.setAttribute('aria-label', '回到顶部');
    button.title = '回到顶部';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5l-7 7h4v7h6v-7h4z" fill="currentColor"/></svg>';
    button.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    document.body.appendChild(button);
    const toggle = () => button.classList.toggle('visible', window.scrollY > window.innerHeight * 0.6);
    window.addEventListener('scroll', toggle, { passive: true });
    toggle();
})();

window.setGame = setGame;
window.setStatus = setStatus;
window.setBrand = setBrand;
window.setTier = setTier;
window.selectStage = selectStage;
window.openFromList = openFromList;
window.loadTournaments = loadTournaments;
window.openTournamentPage = openTournamentPage;
window.enterTournament = enterTournament;
window.backToTournamentList = backToTournamentList;
window.showMatchPredictions = showMatchPredictions;
window.focusTournamentMatch = focusTournamentMatch;
window.setDetailView = setDetailView;
window.openTournamentStage = openTournamentStage;
window.closeDetailModal = closeDetailModal;
// showMatchHead2Head 由 /js/h2h.js、showMatchCenter 由 /js/match-center.js 提供

gameSegEl?.addEventListener('click', event => {
    const button = event.target.closest('button[data-game]');
    if (button) setGame(button.dataset.game);
});
statusSegEl?.addEventListener('click', event => {
    const button = event.target.closest('button[data-status]');
    if (button) setStatus(button.dataset.status);
});
// 搜索：对已加载列表做本地过滤，无需重新请求
searchEl?.addEventListener('input', () => {
    state.search = searchEl.value;
    clearTimeout(searchEl._timer);
    searchEl._timer = setTimeout(renderArchiveList, 140);
});

syncSegments();
renderTierChips();
applyPageMode();
loadTournaments().catch(error => {
    if (tournamentsEl) tournamentsEl.innerHTML = `<div class="rv-empty">加载失败：${escapeHtml(error.message)}</div>`;
    console.error(error);
});
loadPreviews();

// 详情页：有实时比分（GRID）的比赛每 30 秒局部刷新——只替换对应比赛行，
// 不重绘整页与赛程图；页面在后台时不刷新。
(function startArchiveLiveRefresh() {
    setInterval(async () => {
        const data = state.activeTournamentData;
        if (!data || document.visibilityState !== 'visible' || !(data.matches || []).some(isRowLive)) return;
        try {
            const id = state.activeTournamentId;
            const fresh = await sharedApi(`/tournaments/${id}`);
            if (id !== state.activeTournamentId) return;
            const previous = new Map(data.matches.map(match => [match.id, match]));
            for (const match of fresh.matches || []) {
                const row = document.getElementById(`match-row-${match.id}`);
                if (row && (isRowLive(match) || isRowLive(previous.get(match.id) || {}))) row.outerHTML = matchRow(match);
            }
            data.matches = fresh.matches;
        } catch { /* 下一轮再试 */ }
    }, 30000);
})();
