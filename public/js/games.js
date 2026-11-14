// 前端游戏注册表（与 server/config/games.js 对应）：标签、厂牌顺序、级别口径等。
// 需在 shared.js / admin.js / bot-report.js 等之前加载。新增游戏只改这里和服务端注册表。
const GAME_REGISTRY = {
    cs2: {
        label: 'CS2',
        pill: 'CS2',
        brandOrder: ['BLAST', 'EPL', 'IEM', 'PGL', 'XPL', 'Stake', 'PWE', 'EWC'],
        tierHints: { 1: 'Major 级顶级大赛', 2: 'BLAST / IEM / EPL 等常规国际赛事', 3: '预选赛' },
        topTierWords: ['Major'],
        streamUrl: 'https://live.bilibili.com/1883358196',
        // 分享图上的游戏标签配色
        sharePill: { color: '#f2c46b', bg: 'rgba(242,182,50,0.10)', border: 'rgba(242,182,50,0.32)' }
    },
    valorant: {
        label: 'Valorant',
        pill: 'VALORANT',
        brandOrder: ['Masters', 'Champions', 'EMEA', 'CN', 'AMER', 'Pacific', 'EWC'],
        tierHints: { 1: 'Masters / Champions 国际大赛', 2: '赛区联赛（EMEA / CN / AMER / Pacific）', 3: '预选赛' },
        topTierWords: ['Masters', 'Champions', '大师赛', '冠军赛'],
        streamUrl: 'https://live.bilibili.com/24160384',
        sharePill: { color: '#ff8a96', bg: 'rgba(255,70,85,0.12)', border: 'rgba(255,70,85,0.35)' }
    }
};

const GAME_KEYS = Object.keys(GAME_REGISTRY);
const isGameKey = value => typeof value === 'string' && Object.prototype.hasOwnProperty.call(GAME_REGISTRY, value);
// 未知或空值：fallback（默认"全部游戏"），保证旧调用方行为不变
const gameLabelOf = (game, fallback = '全部游戏') => (isGameKey(game) ? GAME_REGISTRY[game].label : fallback);
const gameTopTierWords = () => [...new Set(GAME_KEYS.flatMap(key => GAME_REGISTRY[key].topTierWords))];
