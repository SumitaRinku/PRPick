// h2h.js — 对阵历史弹窗（主页 app.js 与回看页 tournaments.js 共用）。
// 两页的全局依赖名不同（index: api/logo；tournaments: sharedApi/logoHtml），
// 这里做运行时适配；弹窗元素约定 #detailModal / #detailModalBody（两页均已存在）。
//
// 布局：对阵头图（双方队标 + 交手比分 + 近 5 场走势）→ 数据对比条（交手胜场 / 近况胜率）
// → 内容区。PC 端交手记录通栏 + 近况双栏并排；移动端（≤640px）改为分段标签
// 「交手记录 / 队伍1近况 / 队伍2近况」逐个查看，避免两栏挤压导致队名被截断。
(function () {
    const h2hApi = (...args) => (typeof sharedApi === 'function' ? sharedApi(...args) : api(...args));
    const h2hLogo = (url, darkUrl) => (typeof logoHtml === 'function' ? logoHtml(url, darkUrl) : logo(url, darkUrl));
    const esc = value => escapeHtml(value);

    // 短日期：当年 MM-DD，非当年 YY-MM-DD（列表行只需要日期，完整时间放 title）
    function shortDate(value) {
        const full = formatDateTime(value);
        return full ? full.slice(0, full.lastIndexOf(' ')) : '';
    }

    const pct = (wins, total) => (total ? Math.round(wins / total * 100) : 0);

    // 近 5 场走势小方块：从旧到新排列，最新一场在最右侧
    function formStreak(recent) {
        const last = recent.slice(0, 5).reverse();
        if (!last.length) return '<span class="hh-streak is-empty">暂无战绩</span>';
        return `<span class="hh-streak" aria-label="近 ${last.length} 场：${last.map(r => (r.result === 'W' ? '胜' : '负')).join('')}">${
            last.map(r => `<i class="${r.result === 'W' ? 'w' : 'l'}">${r.result}</i>`).join('')
        }</span>`;
    }

    function recentRows(items) {
        if (!items.length) return '<p class="hh-empty">该队赛前暂无已结算比赛</p>';
        return `<ol class="hh-list">${items.map(item => {
            const win = item.result === 'W';
            return `<li class="hh-row ${win ? 'is-win' : 'is-loss'}">
                <span class="hh-badge">${win ? '胜' : '负'}</span>
                <a class="hh-opp" href="/teams.html?team=${item.opponent_id}" title="${esc(item.tournament_name || '')}">
                    ${h2hLogo(item.opponent_logo_url, item.opponent_dark_logo_url)}
                    <span><small>vs</small> ${esc(item.opponent)}</span>
                </a>
                <b class="hh-score">${esc(item.score)}</b>
                <time datetime="${esc(item.match_time)}" title="${esc(formatDateTime(item.match_time))}">${shortDate(item.match_time)}</time>
            </li>`;
        }).join('')}</ol>`;
    }

    function meetingRows(list, m) {
        if (!list.length) return '<p class="hh-empty">两队赛前暂无交手记录</p>';
        return `<ol class="hh-list">${list.map(h => {
            const t1Won = h.winner === 'team1';
            const t2Won = h.winner === 'team2';
            return `<li class="hh-meet">
                <div class="hh-meet-meta">
                    <span title="${esc(h.tournament_name || '')}">${esc(h.tournament_name || '—')}</span>
                    <time datetime="${esc(h.match_time)}" title="${esc(formatDateTime(h.match_time))}">${shortDate(h.match_time)}</time>
                </div>
                <div class="hh-meet-line">
                    <span class="hh-meet-team ${t1Won ? 'is-win' : ''}">${h2hLogo(m.team1_logo_url, m.team1_dark_logo_url)}<b>${esc(m.team1_name)}</b></span>
                    <span class="hh-meet-score"><b class="${t1Won ? 'is-win' : ''}">${h.team1_score}</b><i>:</i><b class="${t2Won ? 'is-win' : ''}">${h.team2_score}</b></span>
                    <span class="hh-meet-team is-right ${t2Won ? 'is-win' : ''}"><b>${esc(m.team2_name)}</b>${h2hLogo(m.team2_logo_url, m.team2_dark_logo_url)}</span>
                </div>
            </li>`;
        }).join('')}</ol>`;
    }

    // 对比条：左右两队数值按占比分配宽度；两边都为 0 时各占一半
    function compareBar(label, leftVal, rightVal, leftText, rightText) {
        const sum = leftVal + rightVal;
        const left = sum ? Math.round(leftVal / sum * 100) : 50;
        return `<div class="hh-compare-row${sum ? '' : ' is-empty'}">
            <b class="${leftVal > rightVal ? 'is-lead' : ''}">${leftText}</b>
            <div class="hh-compare-track" role="img" aria-label="${label}：${leftText} 对 ${rightText}">
                <span>${label}</span>
                <i class="t1" style="width:${left}%"></i><i class="t2" style="width:${100 - left}%"></i>
            </div>
            <b class="${rightVal > leftVal ? 'is-lead' : ''}">${rightText}</b>
        </div>`;
    }

    function render(data) {
        const m = data.match;
        const meets = data.head_to_head;
        const t1Meet = meets.filter(h => h.winner === 'team1').length;
        const t2Meet = meets.filter(h => h.winner === 'team2').length;
        const t1Total = data.team1.wins + data.team1.losses;
        const t2Total = data.team2.wins + data.team2.losses;
        const t1Rate = pct(data.team1.wins, t1Total);
        const t2Rate = pct(data.team2.wins, t2Total);

        const heroTeam = (side, team) => `
            <a class="hh-hero-team" href="/teams.html?team=${m[`${side}_id`]}">
                <span class="hh-hero-logo">${h2hLogo(m[`${side}_logo_url`], m[`${side}_dark_logo_url`])}</span>
                <strong title="${esc(m[`${side}_name`])}">${esc(m[`${side}_name`])}</strong>
                ${formStreak(team.recent)}
            </a>`;

        const formPanel = (side, team, rate, total) => `
            <section class="hh-panel" data-pane="${side}">
                <header class="hh-panel-head">
                    <a href="/teams.html?team=${m[`${side}_id`]}">${h2hLogo(m[`${side}_logo_url`], m[`${side}_dark_logo_url`])}<b>${esc(m[`${side}_name`])}</b></a>
                    <span>近 ${total} 场 <b>${team.wins}胜 ${team.losses}负</b> 胜率 ${rate}%</span>
                </header>
                ${recentRows(team.recent)}
            </section>`;

        return `
        <div class="hh" data-active="meet">
            <div class="hh-hero">
                <div class="hh-kicker"><span>对阵历史</span><em>${m.format ? `<span class="meta-part">${esc(m.format)}</span>` : ''}<span class="meta-part">${esc(formatDateTime(m.match_time))}</span></em></div>
                <div class="hh-hero-grid">
                    ${heroTeam('team1', data.team1)}
                    <div class="hh-tally" aria-label="交手战绩 ${t1Meet} 比 ${t2Meet}">
                        <div class="hh-tally-num"><b class="${t1Meet > t2Meet ? 'is-lead' : ''}">${t1Meet}</b><i>:</i><b class="${t2Meet > t1Meet ? 'is-lead' : ''}">${t2Meet}</b></div>
                        <small>${meets.length ? `交手 ${meets.length} 场` : '首次交手'}</small>
                    </div>
                    ${heroTeam('team2', data.team2)}
                </div>
                <div class="hh-compare">
                    ${compareBar('交手胜场', t1Meet, t2Meet, String(t1Meet), String(t2Meet))}
                    ${compareBar('近况胜率', t1Rate, t2Rate, t1Total ? `${t1Rate}%` : '—', t2Total ? `${t2Rate}%` : '—')}
                </div>
            </div>
            <div class="hh-tabs" role="tablist" aria-label="对阵历史分类">
                <button type="button" role="tab" data-tab="meet" aria-selected="true">交手记录<small>${meets.length}</small></button>
                <button type="button" role="tab" data-tab="team1" aria-selected="false">${esc(m.team1_name)}</button>
                <button type="button" role="tab" data-tab="team2" aria-selected="false">${esc(m.team2_name)}</button>
            </div>
            <div class="hh-body">
                <section class="hh-panel hh-meets" data-pane="meet">
                    <header class="hh-panel-head"><b>交手记录</b><span>开赛前最近 ${meets.length} 场</span></header>
                    ${meetingRows(meets, m)}
                </section>
                <div class="hh-forms">
                    ${formPanel('team1', data.team1, t1Rate, t1Total)}
                    ${formPanel('team2', data.team2, t2Rate, t2Total)}
                </div>
            </div>
        </div>`;
    }

    function bindTabs(root) {
        const tabs = root.querySelectorAll('.hh-tabs [data-tab]');
        tabs.forEach(tab => tab.addEventListener('click', () => {
            root.dataset.active = tab.dataset.tab;
            tabs.forEach(t => t.setAttribute('aria-selected', String(t === tab)));
        }));
    }

    async function showMatchHead2Head(matchId) {
        const modalEl = document.getElementById('detailModal');
        const bodyEl = document.getElementById('detailModalBody');
        if (!modalEl || !bodyEl) return;
        try {
            const data = await h2hApi(`/matches/${matchId}/head2head`);
            bodyEl.innerHTML = render(data);
            bindTabs(bodyEl.querySelector('.hh'));
            modalEl.hidden = false;
            document.body.classList.add('modal-open');
            const panel = modalEl.querySelector('.modal-panel');
            if (panel) panel.scrollTop = 0;
        } catch (error) {
            alert(error.message);
        }
    }

    // 渲染到指定容器（回看页的比赛详情弹窗把对阵历史作为其中一个标签页）
    async function renderHead2HeadInto(matchId, container) {
        const data = await h2hApi(`/matches/${matchId}/head2head`);
        container.innerHTML = render(data);
        bindTabs(container.querySelector('.hh'));
    }

    window.showMatchHead2Head = showMatchHead2Head;
    window.renderHead2HeadInto = renderHead2HeadInto;
})();
