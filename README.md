# 全平台内容数据监控台

24 小时运行的内容数据监控系统，由两部分组成：

- `index.html` — 看板页面（单文件，无外部依赖）
- `realtime/` — 采集服务：定时拉取真实数据 → 入库 → 实时推送到看板 → 异常告警推送

监控对象：抖音、快手、小红书、视频号、B站。指标：作品数、播放、点赞、评论、分享、收藏、涨粉、互动率，以及 24 小时发布趋势、平台对比、标签分布、爆款与异常预警、作品明细。

页面分六个板块：**总览 / 对标账号 / 赛道分析 / 人群与需求 / 平台热榜**，作品明细在总览里。

## 三个平台现在能拿到什么数据（真实、免密钥）

| 平台 | 数据内容 | 口径 | 更新方式 |
| --- | --- | --- | --- |
| **抖音** | 官方热搜榜 50 条 | 词条 + 热度值（如「国足vs塔吉克斯坦」1209.6 万） | 公开接口，每轮采集，可看新上榜 / 名次升降 / 热度增量 |
| **快手** | 官方热搜榜约 50 条 | 词条 + 热度值（如「央视曝缅北四大家族罪恶产业链」1330.1 万） | 同上 |
| **B站** | 热门 + 全站排行 + 最新投稿，约 250 条**作品级**数据 | 标题、UP主、播放、点赞、评论、收藏、分享、发布时段 | 有作品级指标，所以对标账号 / 赛道 / 人群需求分析都基于它 |

`realtime\start.bat`（或 `启动看板.bat`）默认跑的就是这份三平台配置 `realtime/config.all.json`，全部免密钥、免资质。

**边界必须说清楚**：抖音、快手的**作品级数据**（某条视频的播放/点赞、某账号当日发布明细）属于平台数据资产，只能通过开放平台授权接口或第三方数据服务获取，我无法也不应伪造。拿到密钥后按下面「接口字段映射」填进 `config.json`，作品数据会自动并入总览和赛道板块，两个热榜照常保留。热榜是这两个平台公开数据里真实可用的一部分，反映的是全网注意力流向，本身就有参考价值。

## 一分钟跑起来（推荐：双击启动）

双击项目根目录里的 **`启动看板.bat`**：

- 自动找到电脑里的 Node.js（找不到会明确提示怎么装）
- 自动用 B站公开接口（免密钥真实数据）启动采集
- 服务就绪后**自动打开浏览器**，看板地址 http://localhost:8787/
- 出错时窗口不会闪退，会显示原因并停在屏幕上

窗口不要关，关了服务就停了。要停止服务，双击 **`停止服务.bat`**；想让它在后台长期跑、开机自启，看下面的「24 小时运行」。

### 命令行方式（等价）

```bat
cd outputs\media-monitor
realtime\start.bat
```

浏览器打开 <http://localhost:8787/>。服务会自动把看板切到实时模式：右上角数据源显示「实时接口」，右下角显示采集器状态与下次采集倒计时。

没配置数据源时页面显示内置演示数据。想先验证「采集 → 入库 → 实时推送」整条链路，用自检数据源：

```bat
realtime\start.bat selftest
```

它会临时拉起一个数据每次都在变的上游接口（**假数据，仅联调用**），可以直观看到页面自己刷新、数字自己往上走。

**想看真实数据、又还没有任何密钥**，用免密钥的真实数据源（B站公开接口）：

```bat
realtime\start.bat bilibili
```

启动后打开 <http://localhost:8787/>，页面里就是真实的 B站作品：真实 UP 主、真实标题、真实播放/点赞/评论/收藏/分享，每 5 分钟自动采集一次，数值随播放量增长而变化。它抓的是 B站「热门视频 + 全站排行 + 最新投稿」三个公开接口，约 400 条作品，其中最新投稿都是近几小时发布的。

> 说明：这个源没有密钥门槛，适合先把完整链路跑起来看真实效果；它的口径是「热门/排行池 + 最新投稿」，不等于「当日全平台发布总量」。要监控抖音、快手、小红书的完整当日作品数据，还是需要配置下面这些授权接口。

## 接入真实数据（关键一步）

平台真实数据只能通过授权渠道获取。先确认你能拿到哪一类，再填对应配置：

| 数据来源 | 你需要准备 | config.json 的 adapter |
| --- | --- | --- |
| **抖音热榜 / 快手热榜（免密钥，已内置）** | 无需任何资质，用 `config.all.json` | `http` + `trends` |
| **B站公开接口（免密钥，开箱可用）** | 无需任何资质，用 `config.bilibili.json` | `http` + `sources` |
| 官方开放平台（抖音开放平台、快手开放平台、小红书专业号、视频号助手、B站开放平台） | 企业资质、应用授权、client_key / client_secret | `official` |
| 第三方数据服务商（飞瓜、蝉妈妈、新榜、灰豚等） | 服务商的 API Key 与接口文档 | `http` |
| 自己的采集或导出脚本 | 能产出下面字段表的作品数据 | `none` + `POST /api/ingest` |
| 平台后台导出的文件 | 导出的 CSV / JSON 文件 | `file` |

配置流程：`copy realtime\config.example.json realtime\config.json`，按下面填写，改完重启服务即可。

> 切入真实数据源前，建议先执行一次 `node realtime\tools\reset-data.js --yes`，把演示/联调期间的数据清空，避免混进真实统计（也可以调 `POST /api/reset`）。

### 1）第三方数据服务（最常见）

```json
{
  "adapter": "http",
  "intervalSeconds": 300,
  "url": "https://服务商域名/api/works?date={date}&page={page}",
  "itemsPath": "data.list",
  "pages": 3,
  "headers": { "Authorization": "Bearer 你的密钥" }
}
```

`{date}` `{from}` `{to}` `{page}` 会自动替换；`itemsPath` 指向返回体里作品数组的位置（支持 `data.list`、`data.items` 这类层级）。字段名不用改，服务端会自动识别 `播放量/play/play_count`、`点赞/digg_count`、`标题/desc` 等常见别名。

### 2）官方开放平台

```json
{
  "adapter": "official",
  "platform": "douyin",
  "intervalSeconds": 300,
  "endpoints": {
    "token": "你获批文档里的取 token 地址",
    "list": "你获批文档里的作品列表地址"
  },
  "method": "GET",
  "pageSize": 50,
  "credentials": { "client_key": "xxx", "client_secret": "yyy" }
}
```

服务会自动取 token、缓存并在过期前续期。`endpoints` 必须按你实际获批的接口文档填写，因为不同平台的地址、分页参数、返回结构都不一样。

### 3）自己的脚本推送

```bash
curl -X POST http://localhost:8787/api/ingest \
  -H "Content-Type: application/json" \
  -H "x-ingest-token: 你在 config.json 里设的 ingestToken" \
  -d '[{"platform":"douyin","account":"账号A","title":"作品标题","publish_time":"2026-10-04 12:30:00","views":12000,"likes":800,"comments":60}]'
```

支持 JSON 数组、CSV 文本、`{ "works": [...] }` 三种格式。数据推上来立刻入库，并通过 SSE 推给所有打开的看板，无需刷新。

### 4）读取本地文件

```json
{ "adapter": "file", "inbox": "./data/inbox", "intervalSeconds": 300 }
```

把导出的 CSV/JSON 放进 `realtime/data/inbox`，服务每轮采集都会读取，并按作品 ID 去重更新。

## 24 小时运行

### 方案一：GitHub 部署（不用服务器，电脑关机也在采）

原理：GitHub Pages 只能放静态文件、跑不了服务，所以用 **GitHub Actions 当采集器**——定时抓真实数据 → 提交回仓库 → Pages 直接展示。打开网址就能看，不用开电脑。

```bash
cd media-monitor
git init && git add . && git commit -m "初始化：内容数据监控台"
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库.git
git push -u origin main
```

推上去之后做三件事：

1. **打开 Actions 写权限**（关键）：仓库 → Settings → Actions → General → Workflow permissions → 选 **Read and write permissions** → Save。不打开这步，采集成功但数据提交不回去，页面永远不会更新。
2. **开启 Pages**：仓库 → Settings → Pages → Source 选 *Deploy from a branch* → Branch 选 `main`、目录选 `/ (root)` → Save。一两分钟后访问 `https://你的用户名.github.io/你的仓库名/`。
3. **手动跑一次**：仓库 → Actions → 「采集数据并更新看板」→ Run workflow。跑完刷新页面就有真实数据了，之后每 30 分钟自动更新。

关于「实时」要说实话：Pages 是静态托管、没有后端，所以是**准实时**（默认 30 分钟一轮，GitHub 定时任务还可能延迟几分钟）。想要秒级推送 + 异常告警，就用下面的本机启动器或 VPS。两者可以并用：Pages 上看数据，本机的 `启动看板.bat` 做实时监控和告警。

换自己的数据源：把密钥存到仓库 Settings → Secrets and variables → Actions，然后在 `.github/workflows/collect.yml` 里取消注释 `ADAPTER/URL/AUTH_HEADER` 三行即可，密钥不会出现在页面和仓库里。

注意事项：

- **私有仓库**：Pages 需要 GitHub Pro；私有仓库 Actions 每月 2000 分钟免费额度，每 30 分钟一轮约用 1400 分钟，建议把 cron 改成每小时（`0 * * * *`）。**公开仓库** Actions 不限量、Pages 免费，但 `data/works.json` 里的数据是公开的。
- 定时任务在仓库连续 60 天无活动后会被停用；本流水线每轮都会提交数据，等于持续有活动，不会被停。
- 数据是累积的：每轮先读回仓库里已有的 `data/works.json`，再补采新数据，所以赛道和账号分析会越用越准。

| 方式 | 命令 | 适用 |
| --- | --- | --- |
| Windows 后台常驻 | `realtime\start.bat` | 自带崩溃重启循环，关窗口即停止 |
| Windows 开机自启 | `powershell -File realtime\install-autostart.ps1` | 注册计划任务，开机自动拉起，崩溃每分钟重启 |
| 服务器 / VPS | `docker compose up -d` | `restart: unless-stopped`，最稳 |
| 手动 | `node realtime/server.js` | 调试用 |

```powershell
powershell -File realtime\install-autostart.ps1 -Action Status      # 查看运行状态
powershell -File realtime\install-autostart.ps1 -Action Uninstall   # 取消自启
```

采集日志在 `realtime/data/logs/server-YYYY-MM-DD.log`，采集记录也可在页面或 `GET /api/polls` 查看。数据存在 `realtime/data/monitor.db`（SQLite；Node 版本较旧时自动回退成 `works.json`）。

### 部署上线（给域名、给同事看）

`deploy/` 目录里是现成的上线材料，详细步骤见 [deploy/README.md](deploy/README.md)：

| 文件 | 用途 |
| --- | --- |
| `deploy/README.md` | 三种上线方案的完整步骤 + 上线检查清单 + 常见问题 |
| `deploy/env.example` | 服务器环境变量模板（纯环境变量部署，不用改代码里的配置） |
| `deploy/nginx.conf` | Nginx 反向代理（已关缓冲，SSE 才能实时；含子路径写法） |
| `deploy/Caddyfile` | Caddy 版反代，自动申请续期 HTTPS 证书 |
| `deploy/media-monitor.service` | systemd 服务单元（开机自启、崩溃自动重启、日志落盘） |
| `deploy/docker-compose.prod.yml` | 生产 compose（健康检查、日志轮转、只监听 127.0.0.1） |
| `deploy/backup-cron.txt` | 定时备份配置（Linux / Windows / Docker 三种写法） |
| `realtime/tools/backup.js` | 在线一致性备份（`VACUUM INTO`，服务在跑也能备份） |

最省事的路径：Linux VPS + `docker compose -f deploy/docker-compose.prod.yml up -d`，前面挂 Nginx 或 Caddy 上 HTTPS。服务器配置 1核2G 就够。

## 异常自动告警（24 小时值守的关键）

凌晨没人看页面，所以异常要主动推到你手机上。在 `config.json` 里打开：

```json
{
  "notify": {
    "enabled": true,
    "format": "wecom",
    "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
    "minIntervalSeconds": 600,
    "cooldownSeconds": 3600,
    "rules": { "dropRate": 0.3, "spikeRate": 0.6, "engagementChange": 0.25, "viralTimes": 20 }
  }
}
```

`format` 支持 `wecom`（企业微信）、`dingtalk`（钉钉）、`feishu`（飞书）、`generic`（任意 webhook，POST `{"text":"..."}`）。同类告警有冷却时间，不会刷屏。

触发条件（可在 `rules` 里调整）：

- 某平台某小时发布量比昨日同期下滑 ≥30%（可能被限流或断更）
- 某平台平均互动率较昨日变化 ≥25%（内容质量或流量结构异动）
- 单条作品播放超过该平台中位数的 20 倍（爆款，只在看板提示，不打扰推送）
- 单平台播放不足 500 的作品占比 ≥35%（大量无效内容）

## 采集服务接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/status` | 采集器状态：数据源、间隔、上次/下次采集、今日入库量、告警配置 |
| `GET /api/works?from=2026-10-03&to=2026-10-04` | 作品明细（看板实时同步用） |
| `GET /api/summary?date=2026-10-04` | 当日汇总：总量、分平台、24 小时分布、标签 Top |
| `GET /api/export?date=2026-10-04` | 导出当天 CSV |
| `GET /api/polls?limit=30` | 最近采集记录（成功/失败、拉取量、错误信息） |
| `GET /api/stream` | SSE 实时推送：`status` / `update` / `alert` 三类事件 |
| `POST /api/ingest` | 外部推送作品数据（可用 `ingestToken` 鉴权） |
| `GET /api/health` | 健康检查，给容器或外部监控用 |
| `POST /api/reset` | 清空所有已采集数据（演示/测试数据清理用，可用 `ingestToken` 鉴权） |

## 接口字段映射（接任意数据源的关键）

不同接口的返回结构千差万别，所以采集服务支持用 `map` 把任意结构翻译成内部字段，用 `sources` 一次拉多个接口。`config.bilibili.json` 就是现成例子，可以直接照抄改：

```json
{
  "adapter": "http",
  "headers": { "Authorization": "Bearer 你的密钥" },
  "map": {
    "platform": { "value": "douyin" },
    "id": "aweme_id",
    "account": "author.nickname",
    "title": "desc",
    "publish_time": { "path": "create_time", "type": "unix" },
    "views": { "path": "statistics.play_count", "default": 0 },
    "likes": { "path": "statistics.digg_count", "default": 0 },
    "comments": { "path": "statistics.comment_count", "default": 0 },
    "shares": { "path": "statistics.share_count", "default": 0 },
    "collects": { "path": "statistics.collect_count", "default": 0 }
  },
  "sources": [
    { "name": "抖音作品", "url": "https://你的接口?date={date}&page={page}", "itemsPath": "data.list", "pages": 3 }
  ]
}
```

写法：`"字段": "a.b.c"` 取嵌套路径；`{ "value": x }` 写死值；`{ "path": "...", "type": "unix" }` 做类型转换（`unix` / `unixMs` / `number` / `string`，支持 `multiply`、`default`）；`"tags": ["a", "b"]` 表示从多个路径取标签合并。没映射到的字段会走内置别名兜底（`播放量/play_count/digg_count` 等）。

## 字段规范

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `platform` | 是 | `douyin` / `kuaishou` / `xhs` / `shipinhao` / `bilibili`，也接受「抖音」「快手」等中文名 |
| `account` | 是 | 发布账号名 |
| `title` | 是 | 作品标题或文案 |
| `publish_time` | 是 | `2026-10-04 12:30:00`、ISO 时间或 10/13 位时间戳 |
| `views` | 是 | 播放量 |
| `likes` / `comments` | 是 | 点赞、评论 |
| `shares` / `collects` / `follows` | 否 | 分享、收藏、新增粉丝，缺省按 0 |
| `tags` | 否 | 数组或 `美食,探店` 这类分隔字符串 |
| `work_id` | 否 | 作品唯一 ID，缺省用发布时间生成；有 ID 时按 ID 去重更新 |

## 统计口径

- 互动率 =（点赞 + 评论 + 分享 + 收藏）÷ 播放量
- 24 小时趋势按作品发布小时聚合；同一作品后续数据增长会覆盖原记录，不重复计数
- 「较昨日」需要前一天数据；实时模式下没有历史数据时显示「今日实时累计」
- 页面按浏览器本地时区解析时间，跨天会自动切到新的一天

## 看板内嵌接口

```js
window.mediaMonitor.summary();                 // 当前汇总
window.mediaMonitor.alerts();                  // 当前预警
window.mediaMonitor.rows();                    // 当前筛选排序后的作品
window.mediaMonitor.importWorks(list, '来源');  // 手工灌数据
window.mediaMonitor.state.platforms = ['douyin', 'kuaishou'];
window.mediaMonitor.render();
```

## 目录结构

```
media-monitor/
├── index.html                     看板（演示数据 / 真实数据自动切换）
├── realtime/
│   ├── server.js                  采集调度 + API + SSE + 静态托管
│   ├── adapters.js                file / http / official / none 四种数据源
│   ├── config.example.json        配置模板
│   ├── config.bilibili.json       免密钥真实数据源（B站公开接口）
│   ├── config.selftest.json       联调用配置
│   ├── lib/normalize.js           字段归一化
│   ├── lib/store.js               SQLite 存储（自动回退 JSON）
│   ├── lib/alerts.js              预警规则
│   ├── lib/notify.js              企业微信/钉钉/飞书告警推送
│   ├── tools/selftest.js          自检数据源（假数据，仅联调）
│   ├── tools/reset-data.js        清空历史数据
│   ├── tools/backup.js            在线备份（VACUUM INTO，自动保留 N 份）
├── deploy/
│   ├── README.md                  部署上线指南
│   ├── env.example                环境变量模板
│   ├── nginx.conf / Caddyfile     反向代理（含 SSE 必需配置）
│   ├── media-monitor.service      systemd 服务
│   ├── docker-compose.prod.yml    生产容器编排
│   └── backup-cron.txt            定时备份配置
│   ├── start.bat                  Windows 一键启动 + 崩溃重启
│   ├── install-autostart.ps1      开机自启 / 状态 / 卸载
│   └── data/                      数据库、inbox、日志（运行时生成）
├── Dockerfile
└── docker-compose.yml
```

## 注意事项

- 采集真实数据必须使用你有权访问的授权接口。平台开放平台需要企业资质与授权，第三方服务需要付费 Key；请遵守各平台协议与数据合规要求。
- 页面要通过 <http://localhost:8787/> 打开才能进入实时模式；直接双击 `index.html`（file:// 协议）时浏览器不允许连接采集服务，会自动回退到演示数据。
- 只在本地电脑上跑，关机就停；要真正 7×24 请放到 VPS 或常开的机器上，用 `docker compose up -d` 或计划任务自启。
