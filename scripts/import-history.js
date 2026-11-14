// 一次性导入历史赛程（PandaScore），供 GRID 历史补齐关联详细数据。
// 用法：npm run import:history -- [--game lol] [--days 90]
//   --game  逗号分隔，默认 lol；cs2 / valorant 只会导入库里已启用赛事的历史比赛
//   --days  往回导入多少天，默认 90（与 GRID_BACKFILL_DAYS 默认值一致），最近 48 小时由常规同步负责
// 只写比赛与赛果，不结算、不触发机器人播报；可以重复运行（按外部 ID 更新）。
require('dotenv').config({ quiet: true });

function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
    const games = String(arg('game', 'lol')).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const days = Number(arg('days', 90));
    require('../server/config/init-db').ensureDatabase();
    const { importPandascoreHistory } = require('../server/services/pandascoreService');
    const result = await importPandascoreHistory({ games, days });
    console.log(JSON.stringify(result, null, 2));
}

main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
