# LoL 接入 + GRID 详细数据：实施计划

> 2026-11-14 重新整理。原计划文档已丢失，本文基于当前代码和对 GRID / PandaScore 的实测结果重写。

## 一、现状（实测）

### 代码
- **游戏注册表重构已完成（未提交）**：`server/config/games.js` + `public/js/games.js`，后台、队伍、赛事、机器人、PandaScore 同步、级别判断、校验都已从注册表读。`npm test` 109/109 通过。
- **GRID 实时数据只接了 CS2**：`gridLiveService.js` 写死 `titleId: 28`、`game_type = 'cs2'`、只读 `GRID_API_TOKEN`。注册表里的 Valorant `RIOT_GRID_API_TOKEN` 还没被使用 → Valorant 目前也没有实时比分。
- 存的数据只有「系列赛比分 + 每图回合比分 + BP」（`match_live_links` / `match_games`），没有选手数据。
- 前端游戏切换按钮写死在 4 个 HTML 里；地图图片、`mapLabel()` 只考虑了 CS2。
- 队名配对 (`gridMatching.js`) 的别名表只有 CS2 队伍，LoL 会配不上：GRID 叫 `Beijing JDG Esports`，PandaScore 叫 `JD Gaming`。

### GRID Open Access（两个 token 都实测过）
| | CS2 (titleId 28) | Valorant (6) | LoL (3) |
|---|---|---|---|
| 可用 token | `GRID_API_TOKEN` | `RIOT_GRID_API_TOKEN` | `RIOT_GRID_API_TOKEN` |
| 近 120 天 series | 很多（含二三线赛事） | 284（VCT 各赛区 / Champions / GC） | 1098（Worlds / LPL / LCK / LEC / LCS / ERL…） |
| 选手 K/D/A、伤害 | ✅ | ✅ 含英雄（agent）、爆头 | ✅ 见下 |

**LoL 每局可拿到的数据**（以 Worlds T1 vs BLG 第 1 局实测）：
- **BP**：每局 20 步 ban/pick，含英雄名、哪方操作
- **队伍**：红蓝方、击杀、经济、经济差、推塔、伤害、视野、各类目标次数（各元素龙、大龙、先锋、虚空幼虫、峡谷蟹、镀层、水晶）
- **选手**：英雄、K/D/A、KDA、参团率、补刀（minion + neutralMinion）、经济 / 分均经济、伤害 / 伤害占比 / 分均伤害、视野分、经验、出装
- 对局时长、进行中的游戏时钟

注意：
- GRID 有 `GRID-TEST` 测试系列，里面用的是真实队名（如 `Natus Vincere v Beijing JDG Esports`），配对时必须排除，否则会误关联。
- 限流：central-data 约 20 次/分钟，series-state 约 6 次/分钟，**按 token 计**。Valorant 和 LoL 共用一个 Riot token，额度要两游戏分。

### PandaScore
- 现有 token 能拉 `/lol/matches`（已看到 Worlds 决赛 BLG vs GEN，BO5）。
- 时间点：Worlds 2026 决赛就是今天（11/14 19:00 UTC）。之后 LoL 和 VCT 都进休赛期，**新赛季（LPL / LCK 约 2027 年 1 月）前上线**是比较现实的目标，12 月的表演赛可以拿来实测。

## 二、分阶段计划

每个阶段都能单独上线，前一阶段不依赖后一阶段。

### 阶段 0：收尾重构（很小）
- 把当前未提交的注册表重构提交到 `feat/lol-riot-grid`。

### 阶段 1：GRID 服务多游戏化（Valorant 立刻受益）
- 注册表的 `grid.titleId / tokenEnv` 驱动配对和轮询；配对按游戏分别查 `allSeries`。
- 限流 / 退避从「按接口路径」改成「按 token + 接口」；同一 token 下的多个游戏共享每轮额度，进行中的比赛优先。
- 配对时排除 `GRID-TEST` 等测试赛事。
- `match_live_links` 不改表结构（已经有 `source` 字段），按比赛所属游戏选 token。
- 前端 `mapLabel()` 和地图图片按游戏处理（Valorant 地图图）。
- 测试：多游戏配对、共享额度轮转、测试赛事排除。

### 阶段 2：LoL 基础接入（能看赛程、能竞猜、能结算）
- 注册表加 `lol`：PandaScore `/lol/matches`、`/lol/series/upcoming`；GRID titleId 3 + Riot token；别名 `lol / 英雄联盟 / lpl`…；高级赛事关键词 `Worlds / MSI / 全球总决赛 / 季中冠军赛 / First Stand`；厂牌 `Worlds、MSI、LPL、LCK、LEC、LTA/LCS、LCP、EWC`。
- 前端注册表加 `lol`；4 个页面的游戏切换按钮改成按注册表生成，以后加游戏不用再改 HTML。
- 赛事 logo、分享图配色、直播间链接。
- `gridMatching.js` 加 LoL 队名别名（JDG、BLG、TES、WBG、AL、GEN、HLE、DK、KT…），用 Worlds 的真实 GRID / PandaScore 队名写单测。
- 用语：LoL 是「局」不是「图」，比分条、机器人播报的文案要按游戏区分。
- 积分规则不变（BO1 / BO3 / BO5 已支持）。

### 阶段 3：详细数据入库
- 新表 `match_game_stats(match_id, sequence, payload JSON, updated_at)`：每局一行，按游戏规整后存 JSON（方向同 `team1_id`，读取时按主客对调翻转），不为每个字段建列。
- 每个游戏一个规整函数（纯函数 + 单测）：
  - **LoL**：每局 BP、红蓝方、队伍汇总（击杀 / 经济 / 推塔 / 龙按类型 / 大龙 / 先锋 / 幼虫）、选手明细（英雄、KDA、补刀、经济、伤害占比、视野、出装）、时长
  - **CS2**：每图选手 K/D/A、ADR（伤害 ÷ 回合数）、爆头率
  - **Valorant**：每图选手 agent、K/D/A、伤害、爆头率
- 轮询时一次 seriesState 请求把这些字段一起拉回，**不额外消耗限额**。
- 新接口 `GET /api/matches/:id/details` 按需加载，不让比赛列表接口变重。

### 阶段 4：比赛详情页 UI
- 比赛中心（`match-center.js`）按局 / 按图切 tab：
  - **LoL**：BP 条（英雄头像，ban 灰显）→ 队伍对比条（击杀 / 经济 / 塔 / 龙 / 大龙）→ 5v5 选手表（按位置对位）
  - **CS2 / Valorant**：每图记分板（K/D/A、ADR / 伤害、HS%）
- 英雄头像、中文名用 Riot Data Dragon（`zh_CN`），像 `logo-cache` 一样下载到本地缓存，不在用户浏览器里直连国外 CDN。
- 进行中的 LoL 局显示实时时钟和经济差（受 60 秒轮询限制，不是逐秒更新）。

### 阶段 5：QQ 机器人
- LoL 单局结果播报：「第 2 局 BLG 胜（28 分钟，击杀 18:6）· 大比分 2:1」。
- `/pick` 指令支持 `lol` 过滤。

### 阶段 6（可选，看需求）：统计页
- 队伍 / 选手在某赛事内的汇总数据，英雄 BP 率。需要阶段 3 的数据先积累一段时间。

## 三、已确定的决策（2026-11-14）
- **范围**：做到阶段 6（统计页也做）。
- **LoL 赛事**：国际赛（Worlds / MSI / First Stand / EWC）+ 四大赛区（LPL / LCK / LEC / LTA·LCS）默认开启，其余照常同步、默认关闭，后台可手动开。
- **LoL 直播间**：先留空，之后后台补。
- **部署与限额**：生产跑在远程服务器上，和本地共用同一个 Riot token，额度按 token 计。
  - 本地开发默认关闭 GRID 轮询（或调低额度），只在需要时手动跑，避免抢掉服务器的额度。
  - 本地库的数据不会上传到服务器，所以**历史数据补齐（统计页用）必须做成服务器上能跑的任务**：限速、可中断续跑、和实时轮询共享额度且让实时优先，部署后在服务器上跑一遍。
