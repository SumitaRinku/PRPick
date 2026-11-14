// 前端游戏注册表（与 server/config/games.js 对应）：标签、厂牌顺序、级别口径等。
// 需在 shared.js / admin.js / bot-report.js 等之前加载。新增游戏只改这里和服务端注册表。
const GAME_REGISTRY = {
    cs2: {
        label: 'CS2',
        short: 'CS2',
        pill: 'CS2',
        gameUnit: '图',
        brandOrder: ['BLAST', 'EPL', 'IEM', 'PGL', 'XPL', 'Stake', 'PWE', 'EWC'],
        tierHints: { 1: 'Major 级顶级大赛', 2: 'BLAST / IEM / EPL 等常规国际赛事', 3: '预选赛' },
        topTierWords: ['Major'],
        streamUrl: 'https://live.bilibili.com/1883358196',
        // 分享图上的游戏标签配色
        sharePill: { color: '#f2c46b', bg: 'rgba(242,182,50,0.10)', border: 'rgba(242,182,50,0.32)' }
    },
    valorant: {
        label: 'Valorant',
        short: 'VAL',
        pill: 'VALORANT',
        gameUnit: '图',
        brandOrder: ['Masters', 'Champions', 'EMEA', 'CN', 'AMER', 'Pacific', 'EWC'],
        tierHints: { 1: 'Masters / Champions 国际大赛', 2: '赛区联赛（EMEA / CN / AMER / Pacific）', 3: '预选赛' },
        topTierWords: ['Masters', 'Champions', '大师赛', '冠军赛'],
        streamUrl: 'https://live.bilibili.com/24160384',
        sharePill: { color: '#ff8a96', bg: 'rgba(255,70,85,0.12)', border: 'rgba(255,70,85,0.35)' }
    },
    lol: {
        label: 'LoL',
        short: 'LoL',
        pill: 'LOL',
        // LoL 每局都在召唤师峡谷，单局用「第 N 局」称呼，比分是击杀数
        gameUnit: '局',
        brandOrder: ['Worlds', 'MSI', 'First Stand', 'LPL', 'LCK', 'LEC', 'LCS', 'EWC', 'LCK CL'],
        tierHints: { 1: 'Worlds / MSI / First Stand 国际赛', 2: '赛区联赛（LPL / LCK / LEC / LCS）', 3: '预选赛' },
        topTierWords: ['Worlds', 'MSI', 'First Stand', '全球总决赛', '季中冠军赛', '先锋赛'],
        streamUrl: '',
        sharePill: { color: '#e3c27a', bg: 'rgba(200,155,60,0.12)', border: 'rgba(200,155,60,0.36)' }
    }
};

const GAME_KEYS = Object.keys(GAME_REGISTRY);
const isGameKey = value => typeof value === 'string' && Object.prototype.hasOwnProperty.call(GAME_REGISTRY, value);
// 未知或空值：fallback（默认"全部游戏"），保证旧调用方行为不变
const gameLabelOf = (game, fallback = '全部游戏') => (isGameKey(game) ? GAME_REGISTRY[game].label : fallback);
const gameTopTierWords = () => [...new Set(GAME_KEYS.flatMap(key => GAME_REGISTRY[key].topTierWords))];
const gameUnitOf = game => (isGameKey(game) && GAME_REGISTRY[game].gameUnit) || '图';

// 游戏切换控件按注册表生成，新增游戏不用再改各页面 HTML。
// 用法：<div data-game-switch data-all="last|first|none" data-all-label="全部" data-labels="short" data-role="tab"></div>
//       <select data-game-switch ...></select> 生成 <option>。
// games.js 在各页面脚本之前加载、位于 body 末尾，此时 DOM 已就绪，同步生成即可被后续脚本查询到。
function renderGameSwitches(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const escapeAttr = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    root.querySelectorAll('[data-game-switch]').forEach(el => {
        const isSelect = el.tagName === 'SELECT';
        const useShort = el.dataset.labels === 'short';
        const role = el.dataset.role ? ` role="${escapeAttr(el.dataset.role)}"` : '';
        const items = GAME_KEYS.map(key => [key, useShort ? GAME_REGISTRY[key].short : GAME_REGISTRY[key].label]);
        const allPos = el.dataset.all || 'last';
        if (allPos !== 'none') {
            const all = ['', el.dataset.allLabel || '全部'];
            if (allPos === 'first') items.unshift(all); else items.push(all);
        }
        el.innerHTML = items.map(([value, label]) => isSelect
            ? `<option value="${escapeAttr(value)}">${escapeAttr(label)}</option>`
            : `<button type="button"${role} data-game="${escapeAttr(value)}">${escapeAttr(label)}</button>`).join('');
    });
}

if (typeof document !== 'undefined') renderGameSwitches(document);
