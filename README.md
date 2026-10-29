# 🎬 清影下载器 (QingYing Downloader)

<p align="center">
  <img src="./renderer/assets/app-icon.png" width="96" height="96" alt="轻影下载器图标" />
</p>

<p align="center">
  <b>全网多平台无水印视频与高清原图批量下载神器</b><br>
  内置 <code>yt-dlp</code> 与 <code>gallery-dl</code> 双下载内核 · 一键解析下载 抖音 / B站(4K) / 小红书 / TikTok / YouTube / Instagram<br>
  100% 纯本地运行 · 登录态本地安全存储 · 永久免费开源
</p>

<p align="center">
  <a href="./README.en.md">English Documentation</a> | <b>简体中文</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/Platform-Windows%2010%2B-0078D6?logo=windows&logoColor=white" alt="Platform" />
  <img src="https://img.shields.io/badge/双引擎-yt--dlp%20%2B%20gallery--dl-red" alt="Dual Engines" />
  <img src="https://img.shields.io/badge/画质-最高支持%204K%2F8K-brightgreen" alt="Quality" />
  <img src="https://img.shields.io/badge/100%25-纯本地安全-success" alt="Local Security" />
  <img src="https://img.shields.io/badge/Agent-MCP%20Ready-orange" alt="MCP" />
</p>

---

## 🆕 v1.6.0 更新（2026-10-29）

- **修复抖音解析/下载失败**（issue #1）：抖音的详情接口要网页现算的签名，命令行复现不了，yt-dlp 只能报 `Fresh cookies`。现在改为在应用内已登录的浏览器里取作品数据，再把签名好的直链交给 yt-dlp 下载 —— 进度、暂停续传、自动重试都保持不变。
- **抖音图文笔记**：`/note/` 链接改从页面直接取无水印大图，一键批量保存。
- **修复封面不显示**：Electron 会拦掉手工设置的 `Referer` 头，改用标准 `referrer` 选项。
- **失败原因说人话**：抖音不再被误报成“链接不支持（不是具体内容页）”。

---

## 🎯 为什么选择清影下载器？

很多创作者和普通用户在下载视频素材时，常常遇到以下痛点：
1. **第三方网页解析陷阱重重**：充斥弹窗广告、诱导付费、画质严重压缩，甚至暗藏恶意木马。
2. **账号隐私泄露风险**：要求你手动提取并上传 Cookie，随时可能导致账号异地登录、被盗或被平台封禁。
3. **图集与视频无法兼顾**：遇到小红书多图笔记、Instagram 轮播图或 B站 4K 画质时，普通工具要么报错，要么只能下缩略图。
4. **命令行工具门槛过高**：`yt-dlp` 和 `gallery-dl` 虽然强大，但对普通用户来说命令行参数繁复难记，反爬风控一变就无从下手。

**轻影下载器专为解决这些问题而生！**  
它将业界最顶尖的两个开源引擎打包进颜值极高、操作极简的 Windows 桌面客户端，让你只需粘贴一个链接，就能自动把超清视频或原图带回家！

---

## ✨ 核心特性

| 功能模块 | 亮点说明 |
| :--- | :--- |
| 🚀 **双内核智能自动降级** | 视频优先调用 `yt-dlp` 高速下载；遇到图集或多图笔记自动无缝回退至 `gallery-dl`，图文全搞定！ |
| 💎 **画质无损与音频合并** | 支持自动将最佳视频流与最佳音频流进行无损合并，支持 B站 4K/1080P60 极清画质！ |
| 🔑 **五大平台安全会话持久化** | 应用内集成隔离浏览器环境，支持一键登录 B站、抖音、小红书、TikTok、Instagram，Cookie **全本地存储，绝不外泄**！ |
| 🛡️ **独家反爬虫机制对抗** | 深度优化请求头与浏览器指纹，轻松绕过 TikTok JS challenge、抖音 `modal_id` 鉴权与小红书反爬拦截 |
| 📋 **极简下载队列** | 支持实时查看下载进度、下载速率、剩余时间与状态，一键直接打开所在下载文件夹 |
| 🤖 **AI Agent & MCP 支持** | 内置本地 API 网关与 MCP 协议服务，支持让 Cursor、Claude Code、智能体自动批量搜索并拉取创作素材 |

---

## 🌐 支持的平台与内容

* **抖音 (Douyin)**：无水印单视频、实况视频、图集无水印大图批量下载（图文笔记取页面上的大图，非站内原始文件）。
* **哔哩哔哩 (Bilibili)**：支持最高 4K / 1080P60 高码率下载，音视频自动无缝合成，支持分 P 批量解析。
* **小红书 (Xiaohongshu)**：无水印原图批量下载、视频无水印原画导出。
* **YouTube**：支持 4K/8K 视频下载、独立音轨提取 (MP3/M4A)、字幕抓取。
* **TikTok**：穿透海外地区与风控验证，一键下载无水印高清视频。
* **Instagram**：帖子单图/多图、Reels 短视频全格式抓取。
* **海量站点扩展**：原生兼容 `yt-dlp` 支持的 1000+ 主流媒体网站。

---

## 🚀 快速上手

### 方式一：下载安装包（推荐）
1. 到 [Releases](https://github.com/zhangtt08/multi-platform-video-downloader/releases/latest) 下载 `qingying-downloader-1.6.0-win-x64.exe`，双击安装。
2. 打开 **清影下载器**，首次使用可在左侧「平台登录」中登录你的账号（抖音、B站等站点需要登录后解析；登录态只存在本机）。
3. 在顶部输入框粘贴想要下载的分享链接，点击 **「解析并下载」** 即可！

### 方式二：开发者源码运行
确保系统已安装 Node.js 18+：

```bash
# 1. 克隆代码仓库
git clone https://github.com/zhangtt08/multi-platform-video-downloader.git
cd multi-platform-video-downloader

# 2. 安装项目依赖
npm install

# 3. 启动应用
npx electron .
```

---

## 🤖 自动化与 Agent API (MCP 协议)

轻影下载器原生支持本地自动化调度，非常适合自媒体工作流、AI 批量创作管线：

```bash
# 启动面向 Agent 的 API 服务（默认端口 8793）
npm run agent:serve
```

* **MCP 桥接**：运行 `npm run agent:mcp`，即可以 stdio 方式接入 Cursor、Claude Code 或 Antigravity。
* **支持工具**：
  * `qingying.analyze`：传入视频 URL，返回标题、作者、封面以及清晰度格式列表
  * `qingying.download`：提交下载任务到后台队列，自动调用对应平台已登录的 Cookie
  * `qingying.status`：查询下载进度与任务状态

---

## ⭐ 支持与社区

如果轻影下载器帮您解决了视频下载和素材采集的烦恼，请为本项目点亮一颗 **Star ⭐**！您的支持是它持续维护对抗反爬策略的最大动力。

---

## 📄 开源许可证

本项目基于 [MIT License](./LICENSE) 协议开源。请勿用于商业侵权或盗版用途，请遵守各平台服务协议与版权规范。
