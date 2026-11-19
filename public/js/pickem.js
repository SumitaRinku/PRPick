// 赛事整体竞猜（Pick'em）：赛事回看详情页的「Pick'em」视图。
// 数据来自 /api/pickem/tournaments/:id；规则与结算在服务端 server/services/pickem.js。
// 交互：先点名额（如「3-0 全胜晋级」），再点队伍放入该名额；再次点击移除。开赛即锁定。
const pickem = {
    tournamentId: null,
    data: null,
    drafts: new Map(),     // stageId -> { slotKey: [teamId] }（未保存的编辑）
    activeSlot: new Map(), // stageId -> slotKey
    busy: new Set()
};

function pkEsc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function pkSlots(config) {
    if (config.kind === 'record') {
        return [
            { key: 'top', label: `${config.wins}-0 全胜晋级`, count: config.top_count, points: 1, tone: 'advance' },
            { key: 'advance', label: '晋级', hint: '任意战绩晋级都算对', count: config.advance_count, points: 1, tone: 'advance' },
            { key: 'bottom', label: `0-${config.losses} 全败出局`, count: config.bottom_count, points: 1, tone: 'eliminate' }
        ].filter(slot => slot.count > 0);
    }
    return [
        { key: 'champion', label: '冠军', count: 1, points: 3, tone: 'gold' },
        { key: 'runner_up', label: '亚军', count: 1, points: 2, tone: 'silver' },
        { key: 'semis', label: '其余四强', count: config.semi_count, points: 1, tone: '' }
    ].filter(slot => slot.count > 0);
}

function pkKindText(config) {
    if (config.kind === 'record') return `${config.wins} 胜晋级 · ${config.losses} 负淘汰`;
    return '淘汰赛';
}

// API 结构 ↔ 统一的 { slot: [ids] } 结构
function pkFromApi(config, picks) {
    const result = {};
    for (const slot of pkSlots(config)) {
        const value = picks?.[slot.key];
        result[slot.key] = (Array.isArray(value) ? value : value ? [value] : []).map(Number);
    }
    return result;
}

function pkToApi(config, draft) {
    if (config.kind === 'record') return { top: draft.top || [], bottom: draft.bottom || [], advance: draft.advance || [] };
    return { champion: draft.champion?.[0] || null, runner_up: draft.runner_up?.[0] || null, semis: draft.semis || [] };
}

function pkStage(stageId) {
    return pickem.data?.stages.find(stage => stage.id === Number(stageId));
}

// 显示用：有草稿（用户改过）用草稿，否则直接取已保存的竞猜。
// 只读时不创建草稿，避免服务器数据更新后一份没动过的旧草稿被误判为「未保存的修改」。
function pkDraft(stage) {
    return pickem.drafts.get(stage.id) || pkFromApi(stage.config, stage.mine?.picks);
}

// 编辑用：首次修改时才从已保存的竞猜复制出草稿。
function pkEditDraft(stage) {
    if (!pickem.drafts.has(stage.id)) pickem.drafts.set(stage.id, pkFromApi(stage.config, stage.mine?.picks));
    return pickem.drafts.get(stage.id);
}

function pkDirty(stage) {
    if (!pickem.drafts.has(stage.id)) return false;
    return JSON.stringify(pkDraft(stage)) !== JSON.stringify(pkFromApi(stage.config, stage.mine?.picks));
}

function pkEditable(stage) {
    return !stage.locked && Boolean(sharedState.user);
}

function pkActiveSlot(stage) {
    const slots = pkSlots(stage.config);
    const current = pickem.activeSlot.get(stage.id);
    if (slots.some(slot => slot.key === current)) return current;
    const draft = pkDraft(stage);
    return (slots.find(slot => (draft[slot.key] || []).length < slot.count) || slots[0]).key;
}

function pkTeamMap(stage) {
    return new Map(stage.teams.map(team => [team.id, team]));
}

function pkLogo(team) {
    return `<span class="pk-logo">${logoHtml(team?.logo_url, team?.dark_logo_url)}</span>`;
}

function pkResultOf(stage, slotKey, teamId) {
    const slot = slotKey === 'semis' ? 'semi' : slotKey;
    return stage.mine?.result?.items.find(item => item.slot === slot && item.team_id === teamId)?.result || null;
}

function pkChip(stage, slotKey, team, teamId) {
    // 结果只对已保存的竞猜显示；编辑中的草稿不标记
    const result = pkDirty(stage) ? null : pkResultOf(stage, slotKey, teamId);
    const mark = result === 'correct' ? '<i class="pk-mark" aria-label="猜中">✓</i>' : result === 'wrong' ? '<i class="pk-mark" aria-label="未中">✕</i>' : '';
    return `<span class="pk-chip ${result || ''}" title="${pkEsc(team?.name || '')}">${pkLogo(team)}<b>${pkEsc(team?.short_name || team?.name || '?')}</b>${mark}</span>`;
}

function pkPopular(stage, slotKey) {
    const counts = stage.distribution?.[slotKey];
    if (!counts || !stage.participants) return '';
    const teams = pkTeamMap(stage);
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (!top.length) return '';
    return `<p class="pk-popular">热门：${top.map(([id, n]) => `${pkEsc(teams.get(Number(id))?.short_name || teams.get(Number(id))?.name || '?')} <b>${Math.round(n / stage.participants * 100)}%</b>`).join(' · ')}</p>`;
}

function pkSlotRow(stage, slot, active) {
    const draft = pkDraft(stage);
    const teams = pkTeamMap(stage);
    const ids = draft[slot.key] || [];
    const editable = pkEditable(stage);
    const chips = ids.map(id => pkChip(stage, slot.key, teams.get(id), id));
    if (editable) for (let i = ids.length; i < slot.count; i++) chips.push('<span class="pk-chip empty">待选</span>');
    else if (!ids.length) chips.push('<span class="pk-none">未选</span>');
    const tag = editable ? 'button' : 'div';
    const attrs = editable ? ` type="button" aria-pressed="${active}" onclick="pkSelectSlot(${stage.id}, '${slot.key}')"` : '';
    return `<${tag} class="pk-slot ${slot.tone} ${active && editable ? 'active' : ''}"${attrs}>
        <span class="pk-slot-label"><b>${pkEsc(slot.label)}</b><small>${ids.length}/${slot.count} · ${slot.count > 1 ? '每队 ' : ''}${slot.points} 分${slot.hint ? ` · ${pkEsc(slot.hint)}` : ''}</small></span>
        <span class="pk-slot-teams">${chips.join('')}</span>
        ${pkPopular(stage, slot.key)}
    </${tag}>`;
}

function pkTeamRecord(stage, team) {
    if (stage.config.kind !== 'record' || (team.wins == null)) return '';
    if (!team.wins && !team.losses) return '';
    return `<small class="pk-record ${team.status || ''}">${team.wins}-${team.losses}</small>`;
}

function pkTeamButton(stage, team, slotOf, activeKey) {
    const slots = pkSlots(stage.config);
    const inSlot = slotOf.get(team.id);
    const slotLabel = inSlot ? slots.find(slot => slot.key === inSlot)?.label : '';
    const editable = pkEditable(stage);
    const classes = ['pk-team', inSlot ? `picked ${slots.find(slot => slot.key === inSlot)?.tone || ''}` : '', inSlot === activeKey ? 'in-active' : '', team.status && team.status !== 'alive' ? `is-${team.status}` : ''].join(' ');
    const body = `${pkLogo(team)}<span class="pk-team-name"><b>${pkEsc(team.short_name || team.name)}</b>${slotLabel ? `<em>${pkEsc(slotLabel)}</em>` : ''}</span>${pkTeamRecord(stage, team)}`;
    if (!editable) return `<div class="${classes}" title="${pkEsc(team.name)}">${body}</div>`;
    return `<button type="button" class="${classes}" title="${pkEsc(team.name)}" onclick="pkToggleTeam(${stage.id}, ${team.id})">${body}</button>`;
}

function pkStatusLine(stage) {
    if (stage.locked) return '<span class="pk-pill locked">已锁定</span>';
    return `<span class="pk-pill open">开放中</span><span>${pkEsc(formatDateTime(stage.lock_at))} 截止</span>`;
}

function pkScoreLine(stage) {
    const result = stage.mine?.result;
    if (!result) return '';
    const pending = result.items.length - result.decided;
    return `<span class="pk-myscore"><b>${result.points}</b><small>/${stage.config.max_points} 分${pending ? ` · ${pending} 项待定` : ''}</small></span>`;
}

function pkOutcomeLine(stage) {
    const outcome = stage.outcome;
    if (!outcome?.complete) return '';
    const teams = pkTeamMap(stage);
    const name = id => pkEsc(teams.get(id)?.short_name || teams.get(id)?.name || '?');
    return `<p class="pk-outcome">冠军 <b>${name(outcome.champion)}</b> · 亚军 <b>${name(outcome.runner_up)}</b> · 四强 ${outcome.top4.slice(2).map(name).join('、')}</p>`;
}

function pkStageHtml(stage) {
    const slots = pkSlots(stage.config);
    const activeKey = pkActiveSlot(stage);
    const draft = pkDraft(stage);
    const slotOf = new Map();
    for (const slot of slots) for (const id of draft[slot.key] || []) slotOf.set(id, slot.key);
    const editable = pkEditable(stage);
    const dirty = pkDirty(stage);
    const busy = pickem.busy.has(stage.id);
    const loginHint = !stage.locked && !sharedState.user ? '<p class="pk-hint">登录后即可参与 Pick\'em。</p>' : '';
    const editHint = editable ? `<p class="pk-hint">先点上方名额，再点队伍放入；再次点击移除。当前名额：<b>${pkEsc(slots.find(slot => slot.key === activeKey)?.label || '')}</b></p>` : '';
    const actions = editable ? `<footer class="pk-actions ${dirty ? 'dirty' : ''}">
            ${stage.mine ? `<button type="button" class="ghost" ${busy ? 'disabled' : ''} onclick="pkClear(${stage.id})">清除竞猜</button>` : ''}
            ${dirty ? `<button type="button" class="ghost" ${busy ? 'disabled' : ''} onclick="pkReset(${stage.id})">撤销修改</button>` : ''}
            <button type="button" ${busy || !dirty ? 'disabled' : ''} onclick="pkSave(${stage.id})">${busy ? '保存中…' : stage.mine ? (dirty ? '保存修改' : '已保存') : '提交竞猜'}</button>
        </footer>` : '';
    return `<section class="pk-stage" data-pk-stage="${stage.id}">
        <header class="pk-stage-head">
            <div class="pk-stage-title">
                <h3>${pkEsc(typeof stageLabel === 'function' ? stageLabel(stage.name) : stage.name)}</h3>
                <p>${pkEsc(pkKindText(stage.config))} · 满分 ${stage.config.max_points} · ${stage.participants} 人参与</p>
            </div>
            <div class="pk-stage-meta">${pkStatusLine(stage)}${pkScoreLine(stage)}</div>
        </header>
        ${pkOutcomeLine(stage)}
        <div class="pk-slots ${editable ? 'editing' : ''}">${slots.map(slot => pkSlotRow(stage, slot, slot.key === activeKey)).join('')}</div>
        ${loginHint}${editHint}
        <div class="pk-team-grid">${stage.teams.map(team => pkTeamButton(stage, team, slotOf, activeKey)).join('')}</div>
        ${stage.teams.length && !stage.locked ? '<p class="pk-note">队伍名单以已确定的对阵为准。</p>' : ''}
        ${actions}
    </section>`;
}

// ---------- 硬币（参照 V 社 Major Pick'em：铜 → 银 → 金 → 钻石） ----------

const PK_COIN_LABELS = { bronze: '铜币', silver: '银币', gold: '金币', diamond: '钻石币' };

function pkCoinIcon(key, size = '') {
    if (!key) return '';
    return `<span class="pk-coin ${key} ${size}" role="img" aria-label="${PK_COIN_LABELS[key]}" title="${PK_COIN_LABELS[key]}"><i></i></span>`;
}

function pkCoinPanel() {
    const coins = pickem.data?.coins;
    if (!coins?.max_points) return '';
    const max = coins.max_points;
    const me = pickem.data.me;
    const ticks = coins.tiers.map(tier => `<span class="pk-coin-tick" style="left:${Math.min(100, tier.points / max * 100)}%">${pkCoinIcon(tier.key, 'xs')}<small>${tier.points}</small></span>`).join('');
    const legend = `<p class="pk-coin-legend">参与即得${pkCoinIcon('bronze', 'xs')}铜币 · ${coins.tiers.map(tier => `${pkCoinIcon(tier.key, 'xs')}${tier.label} ${tier.points} 分`).join(' · ')}<span class="pk-coin-note">按已开放阶段满分 ${max} 计算，后续阶段开放后门槛随之上调</span></p>`;
    if (!me?.participated) {
        return `<section class="pk-coin-panel empty">
            <div class="pk-coin-head">${pkCoinIcon('bronze', 'lg')}<div><b>参与 Pick'em 赢取硬币</b><small>${sharedState.user ? '提交任一阶段即获得铜币' : '登录后提交任一阶段即获得铜币'}</small></div></div>
            ${legend}
        </section>`;
    }
    const pct = Math.min(100, me.points / max * 100);
    const next = me.coin?.next ? `再得 <b>${me.coin.next.need}</b> 分升级${pkEsc(me.coin.next.label)}` : '已获得最高等级';
    return `<section class="pk-coin-panel">
        <div class="pk-coin-head">${pkCoinIcon(me.coin.key, 'lg')}<div><b>${pkEsc(me.coin.label)}</b><small>${me.points}/${max} 分 · ${next}</small></div>
            ${typeof sharePickemSummary === 'function' ? '<button type="button" class="pk-share-btn" onclick="sharePickemSummary()">分享我的作业</button>' : ''}</div>
        <div class="pk-coin-bar"><i style="width:${pct}%"></i>${ticks}</div>
        ${legend}
    </section>`;
}

function pkLeaderboardHtml(rows) {
    if (!rows?.length) return '';
    const me = sharedState.user?.id;
    return `<section class="pk-board">
        <h3>Pick'em 排行</h3>
        <ol>${rows.map(row => `<li class="${row.user_id === me ? 'me' : ''}">
            <span class="pk-rank ${row.rank <= 3 ? `top${row.rank}` : ''}">${row.rank}</span>
            <strong>${pkCoinIcon(row.coin?.key, 'xs')}${pkEsc(row.username)}</strong>
            <small>猜中 ${row.correct}/${row.decided} 项已决</small>
            <b>${row.points} 分</b>
        </li>`).join('')}</ol>
    </section>`;
}

function pkInnerHtml() {
    const stages = pickem.data?.stages || [];
    return `<div class="pk-intro">
            <p>开赛前预测每个阶段的晋级与名次，独立计分，不影响单场竞猜积分。战绩阶段每猜中一项 1 分；淘汰赛冠军 3 分、亚军 2 分、其余四强每队 1 分。</p>
        </div>
        ${stages.length ? pkCoinPanel() : ''}
        ${stages.map(pkStageHtml).join('') || '<div class="rv-empty">本赛事暂无可竞猜的阶段</div>'}
        ${pkLeaderboardHtml(pickem.data?.leaderboard)}`;
}

function pkRender() {
    const root = document.getElementById('pkRoot');
    if (root && pickem.data) root.innerHTML = pkInnerHtml();
}

// 详情页容器：data 为 openTournamentPage 预取的 /pickem/tournaments/:id 结果
function tournamentPickemContainer(tournamentId, data) {
    if (String(pickem.tournamentId) !== String(tournamentId)) {
        pickem.drafts.clear();
        pickem.activeSlot.clear();
    }
    pickem.tournamentId = String(tournamentId);
    if (data) pickem.data = data;
    // 数据已由详情页预取：直接同步输出，避免异步渲染与详情页重绘竞争
    return `<div id="pkRoot" class="pk-root">${pickem.data ? pkInnerHtml() : '<div class="rv-empty">Pick\'em 数据加载失败</div>'}</div>`;
}

async function pkReload() {
    if (!pickem.tournamentId) return;
    const data = await sharedApi(`/pickem/tournaments/${pickem.tournamentId}`);
    pickem.data = data;
    pkRender();
    return data;
}

function pkSelectSlot(stageId, slotKey) {
    pickem.activeSlot.set(Number(stageId), slotKey);
    pkRender();
}

function pkToggleTeam(stageId, teamId) {
    const stage = pkStage(stageId);
    if (!stage || !pkEditable(stage)) return;
    const slots = pkSlots(stage.config);
    const draft = pkEditDraft(stage);
    const activeKey = pkActiveSlot(stage);
    const slot = slots.find(item => item.key === activeKey);
    const list = draft[activeKey] || (draft[activeKey] = []);
    if (list.includes(teamId)) {
        draft[activeKey] = list.filter(id => id !== teamId);
    } else {
        for (const other of slots) draft[other.key] = (draft[other.key] || []).filter(id => id !== teamId);
        const current = draft[activeKey];
        if (current.length >= slot.count) current.shift(); // 名额已满：替换最早放入的队伍
        current.push(teamId);
        // 本名额填满后自动跳到下一个未满的名额
        if (current.length >= slot.count) {
            const next = slots.find(item => (draft[item.key] || []).length < item.count);
            if (next) pickem.activeSlot.set(stage.id, next.key);
        }
    }
    pkRender();
}

function pkReset(stageId) {
    pickem.drafts.delete(Number(stageId));
    pkRender();
}

async function pkSave(stageId) {
    const stage = pkStage(stageId);
    if (!stage || pickem.busy.has(stage.id)) return;
    pickem.busy.add(stage.id);
    pkRender();
    try {
        await sharedApi(`/pickem/stages/${stage.id}`, { method: 'PUT', body: { picks: pkToApi(stage.config, pkDraft(stage)) } });
        pickem.drafts.delete(stage.id);
        await pkReload();
    } catch (error) {
        alert(error.message);
    } finally {
        pickem.busy.delete(stage.id);
        pkRender();
    }
}

async function pkClear(stageId) {
    const stage = pkStage(stageId);
    if (!stage || pickem.busy.has(stage.id) || !confirm('确定清除本阶段的竞猜？')) return;
    pickem.busy.add(stage.id);
    pkRender();
    try {
        await sharedApi(`/pickem/stages/${stage.id}`, { method: 'DELETE' });
        pickem.drafts.delete(stage.id);
        await pkReload();
    } catch (error) {
        alert(error.message);
    } finally {
        pickem.busy.delete(stage.id);
        pkRender();
    }
}

// 分享图数据（pickem-share.js 使用）：只含当前用户已保存竞猜的阶段，草稿不计入。
function getPickemShareData() {
    const data = pickem.data;
    if (!data?.me?.participated || !sharedState.user) return null;
    const stages = data.stages.filter(stage => stage.mine).map(stage => {
        const teams = pkTeamMap(stage);
        const picks = pkFromApi(stage.config, stage.mine.picks);
        return {
            id: stage.id,
            name: typeof stageLabel === 'function' ? stageLabel(stage.name) : stage.name,
            kind: stage.config.kind,
            kindText: pkKindText(stage.config),
            locked: stage.locked,
            lockAt: stage.lock_at,
            maxPoints: stage.config.max_points,
            result: stage.mine.result,
            slots: pkSlots(stage.config).map(slot => ({
                ...slot,
                picks: (picks[slot.key] || []).map(id => ({ team: teams.get(id) || { id, name: '?' }, result: pkResultOf(stage, slot.key, id) || 'pending' }))
            }))
        };
    });
    return { tournament: data.tournament, coins: data.coins, me: data.me, user: sharedState.user, stages };
}

// 登录状态变化：重新取数（个人竞猜与可编辑状态随之变化）
window.addEventListener('auth-changed', () => {
    if (!document.getElementById('pkRoot')) return;
    pickem.drafts.clear();
    pkReload().catch(() => {});
});

window.tournamentPickemContainer = tournamentPickemContainer;
window.getPickemShareData = getPickemShareData;
window.pkSelectSlot = pkSelectSlot;
window.pkToggleTeam = pkToggleTeam;
window.pkReset = pkReset;
window.pkSave = pkSave;
window.pkClear = pkClear;
