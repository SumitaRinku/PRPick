// 游戏注册表：服务端所有「支持哪些游戏」的判断都从这里取，新增游戏只改这一处。
//   aliases:    QQ 机器人指令中可识别的游戏写法（小写）
//   pandascore: 比赛 / 系列赛端点
//   grid:       GRID Open Access 的 titleId 与对应 Token 环境变量（无则不接入实时数据）
//   tierHigh:   赛事名命中即判定为高级赛事（tier=1）的关键词（SQLite LIKE，ASCII 不区分大小写）
//   brands:     赛事回看厂牌归类，按数组顺序首次命中生效，顺序即优先级
//   autoActivateLeagues: PandaScore league.name（精确、不区分大小写）命中的新赛事入库即开启展示；
//               其余新赛事照旧默认关闭，等管理员手动开启。
//   gameUnit:   单场对局的叫法（CS2 / Valorant 是「图」，LoL 是「局」）
const GAMES = {
    cs2: {
        key: 'cs2',
        label: 'CS2',
        aliases: ['cs2', 'csgo'],
        pandascore: { endpoint: '/csgo/matches', seriesEndpoint: '/csgo/series/upcoming' },
        grid: { titleId: 28, tokenEnv: 'GRID_API_TOKEN' },
        gameUnit: '图',
        tierHigh: ['Major'],
        brands: [
            ['BLAST', ['blast']],
            ['IEM', ['iem']],
            ['PGL', ['pgl']],
            ['EPL', ['esl pro league', 'epl']],
            ['XPL', ['xse pro league', 'xpl']],
            ['Stake', ['stake']],
            ['PWE', ['perfect world', 'cac', '完美世界']],
            ['EWC', ['esports world cup', 'ewc', '电竞世界杯']]
        ]
    },
    valorant: {
        key: 'valorant',
        label: 'Valorant',
        aliases: ['valorant', 'val', '无畏契约'],
        pandascore: { endpoint: '/valorant/matches', seriesEndpoint: '/valorant/series/upcoming' },
        grid: { titleId: 6, tokenEnv: 'RIOT_GRID_API_TOKEN' },
        gameUnit: '图',
        tierHigh: ['Masters', 'Champions', '大师赛', '冠军赛'],
        // EWC 必须排在赛区关键词之前，否则"EWC电竞世界杯2026 美洲预选赛"会误归 AMER。
        brands: [
            ['Masters', ['masters', '大师赛']],
            ['Champions', ['champions', '冠军赛']],
            ['EWC', ['esports world cup', 'ewc', '电竞世界杯']],
            ['EMEA', ['emea']],
            ['CN', ['china', 'cn es', '中国']],
            ['AMER', ['americas', 'amer', '美洲']],
            ['Pacific', ['pacific', '太平洋']]
        ]
    },
    lol: {
        key: 'lol',
        label: 'LoL',
        aliases: ['lol', '英雄联盟'],
        pandascore: { endpoint: '/lol/matches', seriesEndpoint: '/lol/series/upcoming' },
        // GRID Open Access 的 Riot token 同时覆盖 Valorant 与 LoL，两者共享限额
        grid: { titleId: 3, tokenEnv: 'RIOT_GRID_API_TOKEN' },
        gameUnit: '局',
        tierHigh: ['Worlds', 'MSI', 'Mid-Season Invitational', 'First Stand', '全球总决赛', '季中冠军赛', '先锋赛'],
        // 国际赛 + 四大赛区（LCS 在 2025 年曾改名 LTA）。LCK Challengers League 等次级联赛不在此列。
        autoActivateLeagues: ['Worlds', 'MSI', 'First Stand', 'Esports World Cup', 'LPL', 'LCK', 'LEC', 'LCS', 'LTA', 'LTA North', 'LTA South'],
        // 次级联赛（LCK CL、LPL 发展联赛等）不归入四大赛区厂牌
        brands: [
            ['Worlds', ['worlds', '全球总决赛']],
            ['MSI', ['msi', 'mid-season invitational', '季中冠军赛']],
            ['First Stand', ['first stand', '先锋赛']],
            ['EWC', ['esports world cup', 'ewc', '电竞世界杯']],
            ['LPL', ['lpl ', 'lpl-', '英雄联盟职业联赛']],
            ['LCK CL', ['lck challengers', 'lck cl']],
            ['LCK', ['lck ', 'lck-']],
            ['LEC', ['lec ', 'lec-']],
            ['LCS', ['lcs ', 'lcs-', 'lta ', 'lta-']]
        ]
    }
};

const gameKeys = () => Object.keys(GAMES);
const isGame = value => typeof value === 'string' && Object.hasOwn(GAMES, value);
const gameLabel = value => (isGame(value) ? GAMES[value].label : value);
const gameUnit = value => (isGame(value) && GAMES[value].gameUnit) || '图';

// 新同步入库的赛事是否默认开启展示（按 PandaScore league.name 精确匹配）
function autoActivates(gameType, leagueName) {
    const list = isGame(gameType) ? GAMES[gameType].autoActivateLeagues : null;
    if (!list?.length || !leagueName) return false;
    const name = String(leagueName).trim().toLowerCase();
    return list.some(entry => entry.toLowerCase() === name);
}

module.exports = { GAMES, gameKeys, isGame, gameLabel, gameUnit, autoActivates };
