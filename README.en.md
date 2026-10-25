# 🎬 QingYing Downloader

<p align="center">
  <img src="./renderer/assets/app-icon.png" width="96" height="96" alt="QingYing Downloader Icon" />
</p>

<p align="center">
  <b>Multi-platform HD Video & Image Downloader for Windows</b><br>
  Dual-engine powered by <code>yt-dlp</code> & <code>gallery-dl</code> · Bilibili (4K) / Douyin / TikTok / Instagram / Xiaohongshu / YouTube<br>
  100% Local · Safe Cookie Persistence · Open-Source & Ad-Free
</p>

<p align="center">
  <b>English</b> | <a href="./README.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/Platform-Windows%2010%2B-0078D6?logo=windows&logoColor=white" alt="Platform" />
  <img src="https://img.shields.io/badge/Engines-yt--dlp%20%2B%20gallery--dl-red" alt="Dual Engines" />
  <img src="https://img.shields.io/badge/Quality-Up%20to%204K%2F8K-brightgreen" alt="Quality" />
  <img src="https://img.shields.io/badge/Agent-MCP%20Ready-orange" alt="MCP" />
</p>

---

## 🎯 Highlights & Features

- **Dual Engine Architecture**: Combines `yt-dlp` for videos and `gallery-dl` for multi-image galleries with automatic seamless fallback.
- **Top Video Sites Supported**: Douyin, TikTok (bypasses JS challenge), Bilibili (up to 4K 60fps), Xiaohongshu, Instagram, YouTube, and 1000+ sites.
- **Local Isolated Cookie Manager**: Per-site login session kept in a local partition. No cookies are ever transmitted to third-party cloud servers.
- **Zero Watermark & Lossless Audio Merge**: Automatically downloads and merges the highest resolution video & audio streams with FFmpeg.
- **AI Agent & MCP Integration**: Native MCP (Model Context Protocol) and REST API for automation by Cursor, Claude Code, and autonomous agents.

---

## 🚀 Quick Start

### Option 1: Run Pre-built Desktop App
1. Launch the executable from the project directory.
2. Paste any supported video or post URL into the search bar.
3. Click **Download**!

### Option 2: Run from Source
```bash
git clone https://github.com/zhangtt08/multi-platform-video-downloader.git
cd multi-platform-video-downloader
npm install
npx electron .
```

---

## ⭐ Star & License

If you find QingYing Downloader useful, please give it a **Star ⭐** on GitHub!
Licensed under the [MIT License](./LICENSE).
