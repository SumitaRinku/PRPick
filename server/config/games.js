// 游戏注册表：服务端所有「支持哪些游戏」的判断都从这里取，新增游戏只改这一处。
//   aliases:    QQ 机器人指令中可识别的游戏写法（小写）
//   pandascore: 比赛 / 系列赛端点
//   grid:       GRID Open Access 的 titleId 与对应 Token 环境变量（无则不接入实时数据）
//   tierHigh:   赛事名命中即判定为高级赛事（tier=1）的关键词（SQLite LIKE，ASCII 不区分大小写）
//   brands:     赛事回看厂牌归类，按数组顺序首次命中生效，顺序即优先级
const GAMES = {
    cs2: {
        key: 'cs2',
        label: 'CS2',
        aliases: ['cs2', 'csgo'],
        pandascore: { endpoint: '/csgo/matches', seriesEndpoint: '/csgo/series/upcoming' },
        grid: { titleId: 28, tokenEnv: 'GRID_API_TOKEN' },
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
    }
};

const gameKeys = () => Object.keys(GAMES);
const isGame = value => typeof value === 'string' && Object.hasOwn(GAMES, value);
const gameLabel = value => (isGame(value) ? GAMES[value].label : value);

module.exports = { GAMES, gameKeys, isGame, gameLabel };
