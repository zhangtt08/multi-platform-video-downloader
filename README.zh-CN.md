# 清影下载器 (QingYingDownloader)

[English](README.md)

Windows 桌面视频/图片下载器（Electron 壳 + yt-dlp / gallery-dl 双引擎），v1.6.1。本仓库即应用源码，配套工具（yt-dlp / gallery-dl / ffmpeg）随打包版内置在 `resources/bin`。

## 功能特性

- **视频下载**：yt-dlp 引擎，视频/音频格式分离选择，可选合并
- **图片下载**：yt-dlp 失败或空结果时自动降级 gallery-dl
- **多平台**：Bilibili / 抖音 / TikTok / Instagram / 小红书登录会话；YouTube 等公开内容经 yt-dlp 免登录直接下载
- **登录会话**：五平台 Cookie 登录态注入（Bilibili 风控严格时 API 链路仍可用）
- **TikTok 反爬**：内置浏览器 UA（过反爬 JS challenge）
- 图片落盘使用 Node 原生 https（绕开 Electron net.fetch 挂死问题）
- 下载队列与进度展示

## 引擎版本

| 工具 | 版本 | 说明 |
|---|---|---|
| yt-dlp | 2026.10.26 | 内置版。2026.07.04 已被 YouTube 判为旧客户端（媒体流全 403）；2026.08.19 曾破坏 TikTok 解析。当前这版实测：YouTube 4K 链接可下载、抖音走应用内浏览器链路可下载（2026-10-30 回归）。B站匿名请求在本机被站点 412 拦下（与本版本无关的站点风控），应用内 B站 请登录后再试。 |
| gallery-dl | 1.31.10 | 新版 release 不再附 exe |
| ffmpeg | 6.1.1 | 复用打包版自带 |

设置页「检查更新」会去官方发布页比对版本，只接受 `https` + 官方域名，校验 sha256 后原子替换 `resources/bin` 里的引擎 —— 站点改版不必等重新发版。冷启动预算按 40s 计（yt-dlp 换版后第一次执行要等杀毒扫描，本机实测 34.5s），避免把冷启动误判成"引擎不可用"。

## 源码结构

```
electron/main.cjs        主进程：窗口、下载队列、历史、登录窗口、引擎升级
electron/engine-core.cjs 引擎核心：探测 / 解析 / 下载 / 失败归因 / 历史存储（界面与 Agent API 共用）
electron/preload.cjs     预加载桥（IPC 白名单）
electron/agent-api.cjs   应用内本机接口（127.0.0.1:8392）
electron/local-guard.cjs 本机接口守卫（令牌 + 来源 + 下载根）
electron/douyin-browser.cjs 抖音：应用内浏览器取数与签名直链
renderer/                界面（index.html / app.js / styles.css / 图标）
agent/                   无头 Agent 服务（8793）与 MCP stdio 桥
resources/bin/           内置引擎 exe（引擎不进 git）
scripts/                 构建、验收、变异台、界面验收
```

## 运行（源码方式，Windows）

```powershell
npm install
# 把 yt-dlp.exe / gallery-dl.exe / ffmpeg.exe 放进 resources/bin（打包版已内置）
npm start
```

## 构建与打包

```powershell
npm run build   # dist/app.asar + dist/win-unpacked（win-unpacked\清影下载器.exe 可直接双击）
npm run dist    # 另出 NSIS 安装包
# 部署到已有的打包目录：把 dist/app.asar 覆盖到 <打包目录>\resources\app.asar，引擎放 <打包目录>\resources\bin
```

## 验收

```powershell
npm run check        # 静态 + 行为门（引擎优先级、目录自愈、403 归因、历史删除与刷新、升级取址）
npm run check:api    # 本机接口守卫（令牌、跨源、下载根）
npm run check:mutate # 变异台：把每处修复逐个退回，确认对应的门真的会红
npm run ui:verify    # 真实界面验收：先以 --remote-debugging-port=9345 启动打包版
```

## 许可证

[MIT](LICENSE)

## 🤖 Agent API

应用运行期间，本地 HTTP 接口监听 `127.0.0.1:8392`。接口复用应用内的 yt-dlp / gallery-dl 引擎**与各站点登录会话**（抖音/TikTok/B站/小红书/Instagram 的 Cookie 注入），已登录站点的下载行为与界面一致。另有无头接口 `npm run agent:serve`（8793）把同一份引擎核心暴露成带 schema 的工具，并附 MCP stdio 桥。

| 路由 | 方法 | 请求体 | 返回 |
|---|---|---|---|
| `/health` | GET | — | 版本、引擎，以及守卫自己正在执行哪几条 |
| `/api/status` | GET | — | 接口自身的真实监听状态（在不在、端口、失败原因） |
| `/api/queue` | GET | — | 当前队列快照 |
| `/api/analyze` | POST | `{url}` + 令牌头 | 标题/作者/`videos[]` + `audios[]` 格式列表，或 gallery-dl 图片清单 |
| `/api/download` | POST | `{url, outputDir, mode: "combined"\|"video"\|"audio"\|"images", videoId?, audioId?, audioFormat?, images?}` + 令牌头 | `{files: [落盘路径]}` |

端口覆盖：`QINGYING_API_PORT`。

### 接口拒绝什么，以及为什么必须拒绝

接口是拿用户的登录会话去下载文件的，所以"只监听 127.0.0.1"并不是一条边界：本机任何进程、以及任何网页发出的跨源简单 POST，都打得到回环端口。两个接口因此走同一份守卫（`electron/local-guard.cjs`）：

- **只绑回环**：绑到非回环地址是直接拒绝，不是提醒。
- **`Host` 逐字白名单**：只认 `127.0.0.1:<端口>` / `localhost:<端口>` / `[::1]:<端口>`，其余 `403 HOST_NOT_ALLOWED`。Origin 判据从不与"请求自己的 Host"相比 —— 那个等式正是 DNS rebinding 自然产生的东西。
- **外部 `Origin`/`Referer` → `403` + JSON 错误体**：浏览器标签页驱动不了下载器。
- **所有非 GET 都要带令牌**：`x-qingying-token: <令牌>`（或 `Authorization: Bearer`）。令牌存在当前用户 app-data 的 `%APPDATA%\qingying-downloader\qingying\agent-api.token`，首次使用时按 `0600` 创建，所以 MCP 桥和命令行调用方不需要谁给它发环境变量也能继续工作；`QINGYING_API_TOKEN` 优先于文件。令牌读不出来也写不出来时写请求 fail-closed（`503 TOKEN_UNAVAILABLE`），绝不因为"没有密钥"就放开。
- **`outputDir` 被收住**：必须 realpath 之后落在用户指定的下载根目录之内 —— 也就是界面「保存位置」那个目录（`settings.outputDir`，另可加 `allowedOutputRoots` / `QINGYING_DOWNLOAD_ROOTS`）。其它一律拒绝（无关的绝对路径、`..\` 越界、根目录里一个指向外面的 junction），返回 `403 output_dir_outside_root`，消息里写清允许的根目录和怎么改；判定通过之前不创建任何目录。
- **状态变更路由没有通配 CORS**；返回值里只有状态、大小与路径。

Cookie 值从不出进程：`/health`、`/api/status`、Agent 工具与界面都只报登录状态、Cookie **名称**与过期时间。

## 许可证
