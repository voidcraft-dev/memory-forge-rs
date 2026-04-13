<div align="center">

# 🔥 Memory Forge v3

**Stop resetting. Start editing.**

本地 AI 会话管理工具 — 改写 AI 记忆，精准操控对话历史

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=black)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-backend-CE422B?logo=rust&logoColor=white)](https://www.rust-lang.org)

**[English](#english)** · **[中文](#中文)**

</div>

---

<a id="english"></a>

## What is Memory Forge v3?

**Stop resetting. Start editing.**

AI went off track? Don't restart — edit the history directly.

Memory Forge lets you modify AI's "memory" in Claude Code / Codex CLI / OpenCode: inject context, fix errors, remove noise, then seamlessly continue the conversation.

**v3 is a full rewrite** — the Python backend is gone. Everything now runs in Rust inside a single native desktop app. No Python, no server, no ports. Just open and use.

**100% local, zero cloud dependency.** Your data never leaves your machine.

## 📸 Screenshots

<div align="center">
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/1.png" alt="Dashboard" width="45%" />
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/2.png" alt="Session List" width="45%" />
</div>

<div align="center">
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/3.png" alt="Session Detail" width="45%" />
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/4.png" alt="Edit Log" width="45%" />
</div>

<div align="center">
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/5.png" alt="Themes" width="45%" />
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/6.png" alt="Multi Platform" width="45%" />
</div>

<div align="center">
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/7.png" alt="Prompt Library" width="90%" />
</div>

## ✨ What's New in v3

| | v2 | v3 |
|---|---|---|
| **Backend** | Python + FastAPI | Rust (built into Tauri) |
| **Startup** | Launch Python server first | Open app, done |
| **Dependencies** | Node.js + Python + Rust | Node.js + Rust only |
| **Themes** | Dark / Light | 4 themes: Graphite · Linen · Ocean · Ember |
| **i18n** | — | 中文 / English |
| **Tray** | — | ✅ Close to tray, launch on startup |

## ✨ Features

- 🧠 **Memory Manipulation** — Edit any message in AI conversation history. Inject context, remove noise, fix AI's wrong assumptions — then seamlessly continue the session.
- 📊 **Dashboard** — Session statistics + 7-day trend chart across all platforms
- 💬 **Multi-platform** — Claude Code / Codex CLI / OpenCode in one unified view
- 📝 **Edit audit log** — Read-only change tracking for every edit you make
- 🏷️ **Session aliases** — Give sessions memorable names
- 📋 **Quick command copy** — Resume / Fork commands one-click copy
- 🎨 **4 Themes** — Graphite (dark) · Linen (light) · Ocean (dark) · Ember (dark)
- 🌐 **Bilingual** — 简体中文 / English
- 📚 **Prompt Library** — Save, tag, search & one-click copy frequently used prompts
- 🖥️ **System tray** — Close to tray, launch on startup
- 🔒 **100% local** — No data leaves your computer, no Python, no server

## 🖥️ Supported Platforms

| Platform | Resume Command | Fork Command | Data Path |
|----------|---------------|--------------|-----------|
| **Claude Code** | `claude --resume <id>` | `claude --resume <id> --fork-session` | `~/.claude` |
| **Codex CLI** | `codex resume <id>` | — | `~/.codex` |
| **OpenCode** | `opencode -s <id>` | `opencode -s <id> --fork` | `~/.local/share/opencode/opencode.db` |

## 📦 Installation

### Desktop App (Recommended)

Download the latest release for your platform:

| Platform | Format | Notes |
|----------|--------|-------|
| **Windows** | `.exe` installer / `.zip` portable | NSIS installer or unzip & run |
| **macOS** | `.dmg` | Drag to Applications |
| **Linux** | `.AppImage` / `.deb` | AppImage is portable, no install needed |

> Check the [Releases](../../releases) page for downloads.

### Build from Source

#### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) + Tauri CLI prerequisites ([guide](https://tauri.app/start/prerequisites/))

```bash
git clone https://github.com/voidcraft-dev/memory-forge-rs
cd memory-forge-rs
npm install
npm run tauri build
```

#### Development

```bash
npm run tauri dev
```

## 🏗️ Project Structure

```
memory-forge-rs/
├── src/                    # React frontend
│   ├── app/
│   │   ├── routes/         # Page components
│   │   ├── router.tsx      # Route definitions
│   │   └── provider.tsx    # Global providers
│   ├── features/
│   │   ├── desktop/        # Tauri API bridge, state, i18n
│   │   ├── session/        # Session list & detail views
│   │   └── prompts/        # Prompt library UI
│   └── components/         # Shared UI components (shadcn/ui)
├── src-tauri/              # Rust backend
│   └── src/
│       ├── main.rs         # Tauri commands & app setup
│       ├── database.rs     # SQLite (prompt library)
│       ├── settings.rs     # App settings persistence
│       └── shell.rs        # Tray, window management
└── package.json
```

## 🛠️ Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | React 19 · TypeScript · Vite · Tailwind CSS v4 · shadcn/ui · React Router v7 |
| **Backend** | Rust · rusqlite · serde |
| **Desktop** | Tauri v2 |
| **Tooling** | Biome · Husky · lint-staged |

## 🤝 Contributing

Contributions are welcome! Feel free to:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the [MIT License](LICENSE).

## 🌍 Community

Thank you to the LINUX DO community for your support!
感谢 LINUX DO 社区的支持！

<a href="https://linux.do">
  <img src="https://img.shields.io/badge/LINUX%20DO-Community-6366f1?logo=discourse&logoColor=white" alt="LINUX DO" />
</a>

Tech discussions, AI frontiers, AI experience sharing — all at [LINUX DO](https://linux.do)!

## 👤 Author

**VoidCraft** — [GitHub](https://github.com/voidcraft-dev)

> *Full-stack developer | AI tools & automation | Building things from the void ✦*

---

<a id="中文"></a>

## 什么是记忆锻造 v3？

**停止重开，直接编辑。**

AI 对话走偏了？别重新开始 — 直接改掉历史记录。

记忆锻造让你在 Claude Code / Codex CLI / OpenCode 中直接编辑 AI 的"记忆"：注入上下文、纠正错误、删除废话，然后无缝继续对话。

**v3 是完全重写版** — Python 后端已经消失。所有逻辑现在都跑在 Tauri 内嵌的 Rust 里，打包成单一原生桌面应用。没有 Python，没有服务器，没有端口。打开即用。

**100% 本地运行，零云端依赖。** 你的数据不会离开你的电脑。

## 📸 应用截图

<div align="center">
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/1.png" alt="仪表盘" width="45%" />
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/2.png" alt="会话列表" width="45%" />
</div>

<div align="center">
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/3.png" alt="会话详情" width="45%" />
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/4.png" alt="编辑日志" width="45%" />
</div>

<div align="center">
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/5.png" alt="主题" width="45%" />
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/6.png" alt="多平台" width="45%" />
</div>

<div align="center">
  <img src="https://raw.githubusercontent.com/voidcraft-dev/memory-forge-rs/main/images/7.png" alt="提示词库" width="90%" />
</div>

## ✨ v3 新特性

| | v2 | v3 |
|---|---|---|
| **后端** | Python + FastAPI | Rust（内嵌 Tauri） |
| **启动方式** | 先启动 Python 服务 | 打开应用即可 |
| **依赖** | Node.js + Python + Rust | 仅 Node.js + Rust |
| **主题** | 暗色 / 亮色 | 4 套主题：石墨 · 亚麻 · 海湾 · 余烬 |
| **多语言** | — | 简体中文 / English |
| **系统托盘** | — | ✅ 关闭到托盘、开机自启 |

## ✨ 功能特性

- 🧠 **记忆操控** — 编辑 AI 对话历史中的任意消息。注入上下文、删除噪音、纠正 AI 的错误假设 — 然后无缝继续会话。
- 📊 **仪表盘统计** — 跨平台会话数量 + 7 天趋势图
- 💬 **多平台会话浏览** — Claude Code / Codex CLI / OpenCode 统一视图
- 📝 **修改记录追溯** — 每次编辑都有只读审计日志
- 🏷️ **会话别名** — 给会话起一个容易记的名字
- 📋 **快捷命令复制** — Resume / Fork 命令一键复制
- 🎨 **4 套主题** — 石墨夜色（深色）· 亚麻纸感（浅色）· 海湾青蓝（深色）· 余烬铜红（深色）
- 🌐 **双语界面** — 简体中文 / English
- 📚 **提示词库** — 保存、标签、搜索常用提示词，支持一键复制
- 🖥️ **系统托盘** — 关闭到托盘、开机自启
- 🔒 **纯本地运行** — 数据不离开你的电脑，无 Python，无服务器

## 🖥️ 支持平台

| 平台 | 恢复命令 | 分支命令 | 数据路径 |
|------|---------|---------|---------|
| **Claude Code** | `claude --resume <id>` | `claude --resume <id> --fork-session` | `~/.claude` |
| **Codex CLI** | `codex resume <id>` | — | `~/.codex` |
| **OpenCode** | `opencode -s <id>` | `opencode -s <id> --fork` | `~/.local/share/opencode/opencode.db` |

## 📦 安装方式

### 桌面应用（推荐）

下载对应平台的最新版本：

| 平台 | 格式 | 说明 |
|------|------|------|
| **Windows** | `.exe` 安装包 / `.zip` 便携版 | NSIS 安装包或解压即用 |
| **macOS** | `.dmg` | 拖入 Applications 即可 |
| **Linux** | `.AppImage` / `.deb` | AppImage 免安装，双击运行 |

> 前往 [Releases](../../releases) 页面下载。

### 从源码构建

#### 前置要求

- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) + Tauri CLI 前置依赖（[安装指南](https://tauri.app/start/prerequisites/)）

```bash
git clone https://github.com/voidcraft-dev/memory-forge-rs
cd memory-forge-rs
npm install
npm run tauri build
```

#### 开发模式

```bash
npm run tauri dev
```

## 🏗️ 项目结构

```
memory-forge-rs/
├── src/                    # React 前端
│   ├── app/
│   │   ├── routes/         # 页面组件
│   │   ├── router.tsx      # 路由定义
│   │   └── provider.tsx    # 全局 Provider
│   ├── features/
│   │   ├── desktop/        # Tauri API 桥接、状态管理、i18n
│   │   ├── session/        # 会话列表 & 详情视图
│   │   └── prompts/        # 提示词库 UI
│   └── components/         # 共享 UI 组件（shadcn/ui）
├── src-tauri/              # Rust 后端
│   └── src/
│       ├── main.rs         # Tauri 命令注册 & 应用初始化
│       ├── database.rs     # SQLite（提示词库）
│       ├── settings.rs     # 应用设置持久化
│       └── shell.rs        # 托盘、窗口管理
└── package.json
```

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | React 19 · TypeScript · Vite · Tailwind CSS v4 · shadcn/ui · React Router v7 |
| **后端** | Rust · rusqlite · serde |
| **桌面** | Tauri v2 |
| **工具链** | Biome · Husky · lint-staged |

## 🤝 参与贡献

欢迎贡献！你可以：

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 发起 Pull Request

## 📄 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。

## 🌍 社区

感谢 LINUX DO 社区的支持！
Thank you to the LINUX DO community for your support!

<a href="https://linux.do">
  <img src="https://img.shields.io/badge/LINUX%20DO-Community-6366f1?logo=discourse&logoColor=white" alt="LINUX DO" />
</a>

技术讨论、人工智能前沿、AI 工具体验分享——尽在 [LINUX DO](https://linux.do)！

## 👤 作者

**VoidCraft** — [GitHub](https://github.com/voidcraft-dev)

> *Full-stack developer | AI tools & automation | Building things from the void ✦*
