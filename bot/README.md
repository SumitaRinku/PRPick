# NapCat QQ 群赛事提醒

Windows 端推送程序。只需要 Node.js 20+（网站风格图片需 22+），无需 `npm install`，不复制网站数据库。Windows 定时拉取 Linux 网站的 `/api/bot/schedule`，经本机 NapCat 发群消息。群内竞猜、账号绑定、管理员指令和结算推送见 [COMMANDS.md](COMMANDS.md)。

推送内容（统一北京时间，以 06:00 为一天分界，不 @全体成员）：

- 日报：默认 12:00 发「昨日赛果 + 今日赛程（含次日凌晨）」；当天 06:00–11:59 有比赛时，提前到最早开赛前 10 分钟发，中午不重复。今日无比赛时改为近期赛程。
- 临赛提醒：开赛前 30 分钟，每场只提醒一次。
- 周日 20:00 未来七天预告。
- 已播报比赛的改期、取消、对阵变化。
- 日报与周日预告默认以网站风格图片发送（一条消息：一行摘要 + 赛程图），减少刷屏，见「图片版日报」。
- 一轮比赛全部结束时，推送该阶段最新赛程图，见「轮次结束赛程图」。

昨日赛果按前一天 06:00 至当天 06:00 的计划开赛时间归属，最多列 `resultsLimit` 场，未出比分的标为待更新。

## 消息示例

示例中的队伍、赛事、ID 和域名均为占位值。

| 情形 | 消息开头 |
| --- | --- |
| 日报 | `【2026-10-16 赛事日报】` |
| 临赛提醒 | `【即将开赛】约 20 分钟后` |
| 周日预告 | `【未来七天赛事预告】` |
| 赛程变化 | `【赛程更新】` |
| 群指令回复 | `QQ 234567：` |
| 赛后结算 | `【比赛结算】`，修正为 `【赛果更正】`，下一行为 `#123 赛事名`；多场合并为 `【比赛结算】本次共 N 场` |
| 数据过期 | 不发消息，暂停本轮并写日志 |

日报：

```text
【2026-10-16 赛事日报】

昨日赛果

BLAST Open（CS2）
#122 Alpha 2:1 Beta
1 场赛果待更新

今日赛程

BLAST Open（CS2）
#123 10/16 18:00  Alpha vs Beta（BO3）
#124 次日 10/17 02:00  Gamma vs Delta（BO1）
```

无赛果显示 `暂无赛果`；弃权显示 `Alpha 1:0 Beta（弃权）`；超出部分显示 `另有 N 场见网站`。今日无比赛时显示 `今日无比赛，近期赛程：` 及未来七天赛程，仍无则为 `未来七天暂无赛程`。时间未确认的比赛不列入，只提示 `另有 N 场时间待定`。

临赛提醒：

```text
【即将开赛】约 20 分钟后
BLAST Open（CS2）
#123 10/16 18:00  Alpha vs Beta（BO3）
回复比分或发送 /pick 竞猜 123 2:1
```

前场拖时导致的顺延（同队伍、仍为已确认时间、推迟不超过 `slipMinutes`）不单独发 `【赛程更新】`：提醒发出前顺延的，提醒按最新时间发，标题行加 `，开赛时间已顺延`，并在比赛行下附 `原定 10/16 18:00 开赛`；提醒已发出后的顺延不再提醒，除非累计推迟超过上次提醒时间 `remindAgainMinutes`，此时补发一次。提前开赛、更换对手、取消、时间待定或推迟超过 `slipMinutes` 仍照常发赛程更新；`reminderMinutes` 为 `0` 时顺延也照常发。

开赛时间即竞猜截止时间。最后一行在启用群指令的群是上面这样，只接收提醒的群为 `可在网站竞猜`，比赛未开放竞猜时为 `竞猜未开放`。TBD、时间未确认、已开始、取消或延期的比赛不提醒。

周日预告每个赛事最多列 4 场，其余为 `另有 N 场见网站`。赛程更新：

```text
【赛程更新】
BLAST Open（CS2）
#123 Alpha vs Beta
原定：10/16 18:00
现为：10/18 20:00  Alpha vs Gamma
```

取消、延期、下架或时间重新未知时，最后一行状态分别为 `已取消`、`已延期`、`已下架或停止展示`、`开赛时间待确认`。

网址仅在 `/pick 帮助` 的回复中提供，日报、周报、临赛提醒和赛程更新不再重复附带。启用群指令的群可回复任意单场比赛消息并发送比分提交或修改预测，具体规则见 [COMMANDS.md](COMMANDS.md)。新版会持久化每条成功发送消息对应的单场比赛 ID；同时更新 `run.js`、`core.js`、`interactions.js` 和服务端 `botCommands.js`，保留原配置与 `data/`，无需数据库迁移。

## 图片版日报

`imageReports: true`（默认）时，日报和周日预告各发**一条**消息：一行摘要文字 + 一张赛程图，内容与文字版一致：

```text
【2026-10-16 赛事日报】昨日 3 场赛果，今日 5 场比赛，详见图片
[图片]
```

- **网站风格**（`siteImages: true`，默认）：`browser.js` 在本机以无界面方式启动 Windows 自带的 Microsoft Edge，打开网站的 `/bot-report.html`，用网站自己的 CSS、MiSans 字体和队标渲染后截图；Edge 每张图启动一次、截完即关（约 2 秒，峰值约 150–250MB）。需要 **Node.js 22+**（内置 WebSocket）。
- 网站截图失败（网站不可达、找不到 Edge、Node 版本过低等）时改用 `render-card.ps1`（PowerShell 5.1 + System.Drawing + 微软雅黑）绘制的简版图；再失败则发原文字版。日志会写明 `图片已生成（site / basic）`。
- **日报每个赛事一张图**（同一条消息内）：
  - 该赛事的比赛都属于有名称的轮次（胜者组/败者组、瑞士轮、GSL 小组等）时，截取网站赛程图：**绿框 = 昨日赛果，主题色框 = 今日赛程**，其余比赛淡化；昨日小组赛/瑞士轮结束、今日季后赛开打时，两个阶段上下拼在同一张图里，各自标注阶段名。
  - 联赛等无轮次名的赛事，或赛程图截图失败时，改用该赛事的列表图（每个轮次只在分组标题中写一次）。
  - 主题色：**CS2 蓝色、Valorant 红色、LoL 金色**（标题栏、强调线、高亮框）；轮次结束图同样按游戏配色。
  - 标题栏显示**赛事 logo + 赛事名**（管理员上传的 logo 优先，其次是网站内置的厂牌 logo）；没有 logo 时只显示赛事名。多赛事的总图在每个赛事分组标题前放 logo，没有 logo 时改为游戏标签。
  - `dailyBrackets: false` 可关闭赛程图，日报只用列表图。
  - 昨日今日都没有比赛时，仍发一张「近期赛程」总图。
- 文字版（图片失败时发送）在每场比赛后标出轮次与去向（如「#10 T1 2:1 Legacy（胜者组半决赛）Legacy 落败者组」，瑞士轮「战绩 T2 0-2，T4 1-1」）。瑞士轮战绩仅在第 1 轮也在数据窗口内且每轮都按同战绩配对时显示。为此机器人拉取的数据从 3 天前开始（服务器上限共 10 天）。
- 每份报告只生成一次，所有群共用，存于 `data\images\`，15 天后自动清理。
- NapCat 明确拒绝图片（HTTP 4xx、`status: failed`、图片文件丢失）时，下一轮改发文字版；结果不确定（超时等）时与文字消息一样不自动重发，避免重复。
- 临赛提醒、赛程更新、结算和指令回复仍为文字：它们很短，且「回复比分竞猜」依赖消息中的 `#比赛ID`。
- `node run.js --preview` 会同时生成 `data\preview-daily.png` 供检查；设为 `false` 恢复纯文字。

## 轮次结束赛程图

`roundImages: true`（默认）时，某赛事某阶段的一轮比赛全部结束（如 `Playoffs 胜者组四分之一决赛`、`Group Stage 第2轮`），向所有群发一条「摘要 + 该阶段最新赛程图」：

```text
【BLAST Open 轮次结束】Playoffs 胜者组四分之一决赛已全部结束，最新赛程图如下
[图片：网站赛事页中该阶段的赛程图]
```

- 轮次取自比赛名冒号前的部分（`Upper bracket quarterfinal 2: A vs B` → `Upper bracket quarterfinal`），按「赛事 + 阶段 + 轮次」分组；同一阶段同一轮询内结束的多轮合并为一张图。没有轮次前缀的联赛（如 `Regular Season`）不推送。
- 只在推送程序亲眼看到「未完成 → 全部结束」时发一次；首次启动/升级时已经结束的轮次只记录不推送，最后一场开赛超过 12 小时的轮次也不再补发，重启不会刷屏。
- 图片是 Edge 打开网站 `tournaments.html?tournament=<ID>` 后，只保留该阶段的赛程图截图，与网站显示完全一致。截图失败时改发文字版（含该轮比分）。

赛后结算：

```text
【比赛结算】
#123 BLAST Open
Alpha 2:1 Beta

alice 猜 2:1，比分全中，+2 分
bob 猜 2:0，猜中胜者，+1 分
carol 猜 0:2，未猜中，+0 分
```

赛果更正显示 `0 分（较上次 -2）`；无人参与显示 `本群无人竞猜`。

超过约 1,200 字的消息拆成 `（1/2）`、`（2/2）` 发送，每条间隔 3 秒。

## 首次部署

### 1. Linux 网站

在网站项目根目录生成令牌：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

写入 `.env`（不要放进前端代码）：

```dotenv
BOT_FEED_TOKEN=刚生成的令牌
PANDASCORE_SYNC_ENABLED=true
PANDASCORE_SYNC_RESULTS=true
```

然后：

```bash
npm run backup
npm run init-db
npm run sync:pandascore
pm2 restart prg-cs2-bet-new --update-env
```

PM2 进程名以 `pm2 list` 为准。Nginx 只要把 `/api/` 反代到 Node 即可覆盖 `/api/bot/`，接口响应不能被 CDN 缓存。只有网站后台已启用的赛事会推送，新同步的赛事默认禁用。

### 2. NapCat HTTP 服务端

在 NapCat 网络配置启用 **HTTP 服务端**（不是客户端或 WebSocket）：监听 `127.0.0.1`，端口如 `3001`，设置 Access Token。该端口和 WebUI 都不需要对公网开放。启用群指令还需另加一个 HTTP 客户端，见 [COMMANDS.md](COMMANDS.md)。

### 3. Windows 配置

将整个 `bot` 目录复制到例如 `C:\prbet-bot`：

```powershell
Set-Location C:\prbet-bot
Copy-Item config.example.json config.json
notepad config.json
```

必填项：

| 配置 | 内容 |
| --- | --- |
| `siteUrl` | 网站 HTTPS 地址，末尾不带 `/api` |
| `feedToken` | 与 Linux `BOT_FEED_TOKEN` 相同 |
| `napcatUrl` | NapCat HTTP 服务端地址，如 `http://127.0.0.1:3001` |
| `napcatToken` | NapCat HTTP 服务端 Access Token |
| `groupIds` | 群号字符串数组，如 `["123456789"]` |

`config.json` 含令牌，不要提交到仓库。

### 4. 预览与测试

```powershell
node run.js --preview   # 拉取真实赛程并打印日报、生成预览图，不发送、不写记录
node run.js --test      # 立即向每个群发一条连接测试，需 dryRun: false
node run.js --status    # 查看发送状态
node run.js             # 正式运行，每 pollSeconds 秒检查一次
```

`dryRun: true` 时只预览一次就退出。启动后不会补发全部历史：日报只在计划时间后 2 小时内补发，提醒只发未开始的比赛。

### 5. 开机自启

任务计划程序 → 创建任务：

1. 常规：选择装有 Node.js 的账号，“不管用户是否登录都要运行”。
2. 触发器：系统启动时，延迟 1 分钟。
3. 操作：程序 `powershell.exe`，参数 `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\prbet-bot\start.ps1"`，起始于 `C:\prbet-bot`。
4. 设置：失败后每 1 分钟重启；取消运行时长限制；已运行时“不启动新实例”。

`start.ps1` 自身也是守护进程：`run.js` 因崩溃或内存不足退出后会自动重新启动（连续快速失败间隔 15 秒，稳定运行后间隔 5 秒）；正常结束（`--preview`、`--status`、`dryRun` 预览）返回码为 0 时不再重启。进程按低内存配置启动（`--max-old-space-size=128 --max-semi-space-size=4 --optimize-for-size`），实测约 30—60MB 常驻，适合与 NapCat 共用 2GB 内存的机器。

程序占用本机 `lockPort`（默认 39173）防止重复实例，不要改端口绕过。日志在 `data\worker-日期.log`：

```powershell
Get-Content (Get-ChildItem C:\prbet-bot\data\worker-*.log | Sort-Object LastWriteTime | Select-Object -Last 1).FullName -Tail 50
```

## 更新已部署版本

1. 停止 Windows bot（手动运行按 Ctrl+C，计划任务则结束任务），确认进程已退出。
2. Linux 网站：

   ```bash
   npm run backup
   git pull            # 或上传覆盖代码，保留 .env、data/
   npm install         # 依赖有变化时
   npm run init-db     # 幂等迁移，不清空数据
   npm test
   pm2 restart prg-cs2-bet-new --update-env
   curl -f http://127.0.0.1:3000/api/health
   ```

3. Windows：备份 `config.json` 和 `data\`，用新版覆盖 `core.js`、`interactions.js`、`run.js`、`browser.js`、`render-card.ps1`、`start.ps1`。保留 `config.json`、`data\delivery.json`、`data\interactions.json` 和日志，不要用 `config.example.json` 覆盖真实配置。若 `config.example.json` 有新字段，手动补到 `config.json`。
4. `node run.js --preview` 确认正常后，按原方式启动。不要同时运行手动进程和计划任务。

已记录为 `sent` 或 `unknown` 的消息不会因更新重发。

## 可调整配置

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `games` | `["cs2", "valorant", "lol"]` | 推送的游戏 |
| `dailyTime` | `"12:00"` | 无早场时的日报时间 |
| `dayStart` | `"06:00"` | 一天的分界 |
| `earlyMinutes` | `10` | 早场提前多少分钟发日报 |
| `reminderMinutes` | `30` | 临赛提醒提前量，`0` 关闭 |
| `slipMinutes` | `180` | 推迟不超过此分钟数视为前场拖时顺延，不单独发赛程更新；`0` 每次都发 |
| `remindAgainMinutes` | `60` | 已提醒的比赛再推迟超过此分钟数才补发提醒 |
| `imageReports` | `true` | 日报与周日预告以「摘要 + 图片」发送，`false` 为纯文字 |
| `siteImages` | `true` | 用 Edge 截取网站风格图片；`false` 只用 PowerShell 简版图 |
| `roundImages` | `true` | 一轮比赛全部结束时推送该阶段赛程图 |
| `dailyBrackets` | `true` | 日报按赛事发赛程图（高亮昨日/今日比赛）；`false` 时只发列表图 |
| `edgePath` | `""` | Edge 不在默认位置时填写 `msedge.exe` 完整路径 |
| `weeklyEnabled` / `weeklyTime` | `true` / `"20:00"` | 周日预告 |
| `resultsLimit` | `12` | 日报最多列多少条赛果 |
| `freshnessMinutes` | `20` | 同步超过多久未成功即暂停发送 |
| `pollSeconds` | `60` | 检查间隔 |

修改后重启任务。所有群共用一套配置。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 找不到 `node` | 安装 Node.js 20+（网站风格图片需 22+）后重开终端；计划任务账号也要能找到 Node |
| 日志 `图片已生成（basic (fallback)）` | 网站截图失败，原因在上一行日志：Node 低于 22、找不到 Edge（设 `edgePath`）、网站 `/bot-report.html` 未部署 |
| 网站 401 | `feedToken` 与 `BOT_FEED_TOKEN` 不一致 |
| 网站 503 | Linux 未配置 `BOT_FEED_TOKEN` 或改后未重启 |
| 返回 HTML / 格式不匹配 | 网站未更新，或 Nginx 未代理 `/api/bot/` |
| 同步过期 | Linux 上运行 `npm run sync:pandascore` 查错误，确认服务器时钟 |
| 缺少赛事 | 后台启用该赛事；确认时间已知且在未来七天内 |
| NapCat 401/403 | 检查 Access Token |
| NapCat 404 | 用的是 WebUI 端口而不是 HTTP 服务端端口 |
| `failed` | 明确被拒；核对群号、QQ 登录和发言权限，最多重试 3 次 |
| `unknown` | 超时或回执不完整，可能已发出；程序不会自动重发 |
| 39173 被占用 | 已有实例在运行 |
| `EPERM ... rename` | 杀毒软件或索引服务短暂占用状态文件，程序会自动重试；持续出现时把 `data\` 加入安全软件排除项 |
| `JavaScript heap out of memory` | 机器内存不足。程序已限制堆并按低内存参数启动，`start.ps1` 会自动重启；反复出现时确认虚拟内存（页面文件）未被关闭 |
| 内存长期 85% 以上 | 2GB 机器上主要是 NapCat；确认页面文件为“系统管理”（建议 2—4GB），否则系统无法提交内存，任何进程都可能被 `FATAL ERROR` 终止 |

发送记录 `data/delivery.json` 原子写入，`data/interactions.json` 相同。Windows 上写入后会短暂重试改名，避免被杀毒或索引占用导致整次保存失败。不要为了重发删除它，否则会丢失去重状态。
