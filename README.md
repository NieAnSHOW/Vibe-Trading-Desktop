<p align="center">
  <b>中文正文</b> &nbsp;|&nbsp; <a href="#english-summary">English summary</a> &nbsp;|&nbsp; <a href="https://github.com/HKUDS/Vibe-Trading#readme">上游多语言版（EN / 日本語 / 한국어 / العربية）</a>
</p>

<p align="center">
  <img src="assets/icon.png" width="120" alt="Vibe Trading Desktop Logo"/>
</p>

<h1 align="center">Vibe Trading Desktop</h1>

<p align="center">
  <b>把 Vibe Trading 装进一个双击即用的桌面应用 —— 免装 Python、免装 Node，macOS / Windows 原生运行</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Desktop-Tauri%202.x-FFC131?style=flat&logo=tauri&logoColor=white" alt="Tauri">
  <img src="https://img.shields.io/badge/Python-3.11%2B-3776AB?style=flat&logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/Backend-FastAPI-009688?style=flat" alt="FastAPI">
  <img src="https://img.shields.io/badge/Frontend-React%2019-61DAFB?style=flat&logo=react&logoColor=white" alt="React">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat" alt="License"></a>
  <a href="https://github.com/NieAnSHOW/Vibe-Trading-Desktop/releases"><img src="https://img.shields.io/badge/Releases-DMG%20%2F%20NSIS-blue?style=flat" alt="Releases"></a>
</p>

<p align="center">
  <a href="#-这是什么">介绍</a> &nbsp;&middot;&nbsp;
  <a href="#-核心特性">特性</a> &nbsp;&middot;&nbsp;
  <a href="#-快速开始">快速开始</a> &nbsp;&middot;&nbsp;
  <a href="#-桌面应用构建与发布本-fork-独有">构建</a> &nbsp;&middot;&nbsp;
  <a href="#-与上游upstream的关系">上游关系</a> &nbsp;&middot;&nbsp;
  <a href="#-文档导航">文档</a> &nbsp;&middot;&nbsp;
  <a href="#-安全">安全</a>
</p>

---

## English summary

**Vibe Trading Desktop** is a community fork of [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) — the natural-language finance-research AI agent with backtesting — repackaged as a **double-click desktop app** for macOS and Windows via a Tauri 2.x shell with an embedded Python 3.12 runtime. No Python, no Node, no terminal: download the `.dmg` / `.exe`, install, and run. The full Vibe Trading stack (70+ finance skills, LangGraph ReAct agent, backtesting engine, multi-agent swarm, shadow account) runs locally, bound to `127.0.0.1` only, with API keys stored on your own machine. This fork adds 160+ desktop-focused commits on top of upstream and tracks upstream closely. The rest of this README is in Chinese — see the [upstream repo](https://github.com/HKUDS/Vibe-Trading#readme) for the full feature tour in English / 日本語 / 한국어 / العربية.

---

## 🧭 这是什么

**Vibe Trading Desktop** = [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)（自然语言金融研究 AI agent + 回测引擎）+ **Tauri 2.x 桌面外壳**，把原本需要 Python 环境 + 命令行运行的 Web 服务，封装成 macOS / Windows 上双击即用的原生应用。

三层架构：

| 层 | 目录 | 技术 | 作用 |
|---|---|---|---|
| **Python 后端** | `agent/` | FastAPI + LangGraph ReAct + 70+ 金融技能 + 回测引擎 | 自然语言金融研究、回测、多 agent 协同、影子账户 |
| **React 前端** | `frontend/` | Vite + React 19 + TypeScript + ECharts + Zustand | 对话式 UI、回测可视化、Alpha Zoo |
| **Tauri 外壳**（本 fork 独有） | `src-tauri/` | Rust + 嵌入式 Python 3.12 运行时 | 打包成原生应用，管理 Python sidecar 生命周期 |

> **fork 身份**：本仓库 fork 自 `HKUDS/Vibe-Trading`，在其基础上新增 **160+ 个桌面化 commit**（Tauri 外壳、DMG / NSIS 打包流水线、sidecar 稳定性、tag-driven release CI，外加影子账户 PDF 导出、A 股数据源等增强），并定期同步上游。

<p align="center">
  <img src="assets/feature-shadow-account.png" alt="Shadow Account 影子账户" width="720"/>
</p>

---

## ✨ 核心特性

- 🖱 **双击即用** —— 内嵌完整 Python 3.12 运行时，用户无需安装 Python / Node / 任何命令行工具链，下载安装即跑
- 🧠 **完整的 Vibe Trading 能力** —— 70+ 金融技能、LangGraph ReAct agent、多市场回测（A 股 / 美股 / 港股 / 加密 / 期货 / 外汇）、多 agent swarm、影子账户（paper trading）
- 🔒 **数据本地化** —— 后端仅绑定 `127.0.0.1`，外部网络不可达；API 密钥存储在本地 `~/.vibe-trading/.env`，不随应用打包、不上传任何服务器
- 🔄 **紧跟上游** —— 定期 sync `HKUDS/Vibe-Trading`，桌面化改动以最小侵入方式叠加在上游核心之上

---

## 🚀 快速开始

根据你的角色，三选一：

### 🟢 路径 A：下载桌面应用（普通用户，推荐）

1. 前往 [Releases](https://github.com/NieAnSHOW/Vibe-Trading-Desktop/releases) 下载对应平台安装包：
   - **macOS**：`Vibe Trading_*.dmg`（Apple Silicon 原生）
   - **Windows**：`Vibe Trading_*_x64-setup.exe`（NSIS）
2. 安装后启动。**macOS** 首次打开若提示"已损坏"，在终端执行（仅清除本应用的下载隔离标记，不修改系统设置、不影响其他应用）：
   ```bash
   xattr -cr "/Applications/Vibe Trading.app"
   ```
3. 首次启动会在 `~/.vibe-trading/.env` 自动创建配置文件，填入你的 LLM / 数据源 API 密钥即可开始。

> 完整安装步骤、系统要求、已知限制（未签名、体积 ~800MB、PDF 报告降级 HTML 等）见 [`docs/desktop/README.md`](docs/desktop/README.md)。

### 🛠 路径 B：开发者本地运行（后端 + 前端）

```bash
# 后端（API on :8899）
pip install -e ".[dev]"
vibe-trading serve

# 前端（dev server on :5899，代理 API 到 :8899）
cd frontend
npm install
npm run dev
```

### 🐳 路径 C：Docker

```bash
docker compose up vibe-trading                  # 仅 API，:8899
docker compose --profile frontend up            # API + Vite 前端，:5899
```

---

## 📦 桌面应用构建与发布（本 fork 独有）

桌面应用把三件制品 —— 嵌入式 Python 3.12 运行时、`agent` 代码、`frontend/dist` —— 打包进 Tauri resource bundle。流水线脚本位于 [`scripts/desktop/`](scripts/desktop/)：

```bash
# macOS 端到端（校验工具链 → 自动下载 Python 运行时 → 重建前端 → cargo tauri build → 冒烟检查）
bash scripts/desktop/build-dmg.sh

# Windows 端到端（fetch-runtime → install-deps → assemble → cargo tauri build）
./scripts/desktop/build-windows.ps1

# 单独准备运行时（build-dmg.sh 已自动调用；手动时默认按架构选 asset，无需任何环境变量）
bash scripts/desktop/fetch-runtime.sh

# 版本同步（pyproject.toml / tauri.conf.json / 前端对齐）
node scripts/desktop/sync-version.mjs <vX.Y.Z>
```

> 运行时来自 [python-build-standalone](https://github.com/astral-sh/python-build-standalone)，默认 `PBS_TAG=20260610`（对应 CPython 3.12.13），`fetch-runtime.sh` 会按 `uname -m` 自动挑 asset。换版本时用 `PBS_TAG` / `PBS_ASSET` 环境变量覆盖，详见 `CLAUDE.md`。

发布走 **tag-driven** CI（`.github/workflows/desktop-build.yml`）；代码签名与公证（需 Apple Developer 账号）见 `scripts/desktop/sign-and-notarize.sh`。

> 详细构建流程、内嵌运行时、relocatability 验证见 [`docs/desktop/`](docs/desktop/) 与 [`CLAUDE.md`](CLAUDE.md)。

---

## 🔗 与上游（upstream）的关系

| | |
|---|---|
| **上游** | [`HKUDS/Vibe-Trading`](https://github.com/HKUDS/Vibe-Trading)（HKU Data Science 出品） |
| **本 fork 定位** | 在上游基础上补齐**桌面应用分发**能力，让非技术用户也能零环境配置地使用 Vibe Trading |
| **增量方向** | Tauri 外壳 + 嵌入式 Python 运行时；DMG / NSIS 打包流水线；sidecar 健康检查与优雅退出；影子账户 PDF 导出；A 股数据源；tag-driven release CI |
| **同步策略** | 定期 merge `upstream/main`，桌面化改动尽量不侵入上游核心 |
| **致谢** | 感谢 HKUDS 团队与所有 Vibe-Trading 贡献者打下基础 |

---

## 📚 文档导航

| 文档 | 内容 |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | 架构总览、常用命令、关键代码路径、安全高危面（最全面的技术索引） |
| [`docs/desktop/README.md`](docs/desktop/README.md) | 桌面应用安装、系统要求、已知限制、构建说明 |
| [`AGENT_CONTRIBUTOR_GUIDE.md`](AGENT_CONTRIBUTOR_GUIDE.md) | 贡献指南 + AI / 自动化 PR 的安全规则 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) / [`SECURITY.md`](SECURITY.md) | 社区贡献流程 / 安全上报 |
| [`CHANGELOG.md`](CHANGELOG.md) | 变更记录 |
| [上游 README](https://github.com/HKUDS/Vibe-Trading#readme) | Vibe Trading 完整功能介绍、News、Roadmap（EN / 日 / 韩 / 阿） |

---

## 🗂 项目结构

```
Vibe-Trading-Desktop/
├── agent/              # Python 后端：FastAPI + LangGraph agent + 70+ 技能 + 回测引擎
│   ├── api_server.py   #   REST API + SSE（:8899）
│   ├── src/            #   agent / skills / swarm / live / providers / shadow_account
│   └── backtest/       #   回测 runner / metrics / engines / loaders
├── frontend/           # React 19 + Vite + TS 单页应用（:5899）
├── src-tauri/          # ★ 本 fork 独有：Tauri 2.x Rust 外壳 + 嵌入式 Python 运行时管理
├── scripts/desktop/    # ★ 桌面打包流水线（fetch-runtime / install-deps / assemble / build-dmg / build-windows）
├── docs/desktop/       # 桌面应用文档
└── .github/workflows/  # tag-driven release CI
```

---

## 🔒 安全

- **回环绑定** —— 桌面应用后端仅监听 `127.0.0.1`，外部网络不可达
- **密钥本地化** —— API 密钥存储在 `~/.vibe-trading/.env`，不与应用打包、不上传任何服务器
- **进程隔离** —— 应用退出时终止所有 Python sidecar 子进程，无残留
- **IM 配对管理默认拒绝** —— 需要在聊天中使用 `/pairing` 的现有部署，升级前必须配置全局 `channels.operators`（可跨渠道管理）或各渠道下的 `operators`（仅管理本渠道）。未配置 operator 时，只有 IM 内的 `/pairing` 会被拒绝；经过认证的 CLI 与 REST 配对管理仍可使用。WebSocket 的 `client_id` 由客户端选择，不是经过认证的 operator 身份，因此该传输不接受 `/pairing` 管理命令；请改用经过认证的 CLI 或 REST 管理配对
- **实盘交易高危面** —— 订单闸门、mandate 强制、kill switch、审计账本等安全关键路径，详见 [`AGENT_CONTRIBUTOR_GUIDE.md`](AGENT_CONTRIBUTOR_GUIDE.md)

---

## 📄 License

MIT License — Copyright (c) 2026 Vibe-Trading Contributors。本 fork 遵循上游 [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) 的 MIT 许可证。

桌面应用内嵌的 [python-build-standalone](https://github.com/astral-sh/python-build-standalone) 运行时遵循其各自许可。
