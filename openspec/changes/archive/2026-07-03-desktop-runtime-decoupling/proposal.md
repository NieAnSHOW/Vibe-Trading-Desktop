## Why

当前桌面端把项目全部 Python 依赖在构建时预装进 Tauri bundle(`install-deps.sh` 将整个 `requirements.txt` 除 weasyprint 外装入内嵌运行时),带来三个持续恶化的问题:

1. **体积不可控**:重型原生包(pandas/scipy/scikit-learn/matplotlib/duckdb/ccxt/akshare 等)全部塞进 bundle,随项目演进只增不减,逐步走向失控。
2. **打包运行时是黑箱**:内嵌运行时一旦出问题(原生扩展 rpath/BLAS 链接、平台兼容),用户和维护者都看不到发生了什么,难以定位。
3. **CLI-first 功能对普通用户门槛过高**:新增的消息渠道能力(`vibe-trading channels start`、`channels login weixin`)高度依赖 CLI,普通用户被迫打开终端,与"开箱即用"的初衷背道而驰。

此次借重大重构一并解决:把重依赖从 bundle 解耦到用户目录 venv、让桌面壳从"UI 黑箱"变为"可观测的环境/服务控制台"、把渠道管理从 CLI 提升进 WebUI。

## What Changes

- **依赖三层化,重依赖移出 bundle**:
  - Tier 0(bundle 内,固定被测):Python 运行时 + bootstrap/控制逻辑 + 前端 dist + 能拉起 `serve` 的最小核心依赖。
  - Tier 1(首次运行 bootstrap → `~/.vibe-trading/venv`):整个 `requirements.txt` 装入用户目录标准 venv,默认清华源,对齐本地部署(本地 dev 也是 venv + `pip install`)。
  - Tier 2(按需):券商 SDK,**复用现有 `/optional-deps` 机制,不改动**。
- **BREAKING — Tauri 从 WebUI 宿主重构为环境/服务控制台**:桌面壳不再用 webview 加载业务 UI;改为原生控制台窗口,负责环境状态 / 服务状态 / 首次依赖安装(进度+日志+重试)/ 启停服务 / "在默认浏览器打开 WebUI" / 打开日志目录。WebUI 改由系统默认浏览器访问 `http://127.0.0.1:<port>`。
- **BREAKING — sidecar 改用 venv 解释器启动**:桌面 spawn `~/.vibe-trading/venv` 的 python 跑 `vibe-trading serve`,行为与本地部署一致;不再依赖 bundle 内嵌运行时跑业务。
- **首次运行 bootstrap 面板**:进度可见 + 断点重试 + smoke import 冒烟验证通过才标记"就绪";失败给出可读原因。
- **渠道管理进 WebUI**:`Settings.tsx` 已有渠道列表,补齐"启动服务 + 安装渠道依赖 + 微信扫码"(后端 `/channels/start`、`/channels/status` REST 已就绪),普通用户全程不开终端。
- **CLI 保持一等公民**:命令结构不变,顶多为 `serve` 增加 `--open`(启动后开默认浏览器)。高级用户可直接用 venv 的 `vibe-trading`。
- **BREAKING — 用户目录覆盖边界重定义**:重构升级时仅推倒重建运行时/派生目录(`runtime/`、`cache/`、`fonts/`、`logs/`、`history`、`app/`);**保留全部用户资产**(`.env`、`live/` 实盘授权与审计账本、`channels/`+`pairing.json` 登录态、`memory/`、`shadow_accounts/`、券商配置 json、`runs/`、`workspace/`、`uploads/`)与会话(`sessions.db` 及会话 JSONL)。会话当前物理位于 `runtime/agent/sessions/`,需先迁出 `runtime/` 再重建。
- 用户目录命名保持 `~/.vibe-trading/` 不变(不做改名迁移)。

## Capabilities

### New Capabilities
- `desktop-runtime-bootstrap`: 首次运行把整个 `requirements.txt` 下载安装到 `~/.vibe-trading/venv`,含默认清华源、进度反馈、断点重试、smoke import 冒烟验证与"就绪"判定;升级时按需增量同步依赖。
- `desktop-control-console`: Tauri 桌面窗口从 WebUI 宿主重构为环境/服务管理控制台——环境与服务状态展示、触发依赖安装、启停 `serve`、在默认浏览器打开 WebUI、打开日志目录。
- `channel-management-ui`: 消息渠道的服务启动与依赖安装从 CLI 迁入 WebUI 设置页,含微信渠道页面内扫码登录,普通用户无需终端。

### Modified Capabilities
- `python-runtime-bundling`: 由"构建时预装全部后端依赖进 bundle"改为"bundle 仅装能拉起控制台与 `serve` 空转的 Tier 0 最小核心",重依赖不再进 bundle;资源装配相应调整。
- `desktop-shell`: sidecar 改用 `~/.vibe-trading/venv` 解释器启动(而非 bundle 内嵌运行时跑业务);桌面窗口不再托管业务 WebUI(改控制台 + 默认浏览器);首启/升级的可写目录准备、会话迁出 `runtime/` 与覆盖边界重定义。

## Impact

- **代码**:
  - `src-tauri/`(Rust 壳):`sidecar.rs`(解释器路径改 venv)、`resources.rs`/`runtime_dir.rs`(bundle 内容与目录准备/覆盖边界)、控制台窗口与 bootstrap 编排逻辑(新增)、`tauri.conf.json`(bundle 资源、窗口不再指向业务 dist)。
  - `scripts/desktop/`:`install-deps.sh`(不再全量装进 bundle)、`assemble.sh`、`build-dmg.sh`/`build-windows.ps1`、`fetch-runtime.sh`(Tier 0 精简)。
  - `agent/cli`:可能新增 `serve --open`;bootstrap 相关的最小入口(若需)。
  - `frontend/src/pages/Settings.tsx`:渠道启动 + 依赖安装 + 微信扫码 UI。
- **依赖交付**:构建时依赖装配策略反转;运行时首次联网下载(弱网/断网/缺 wheel 为新增失败面,由 bootstrap 面板的进度/重试/冒烟兜底)。
- **平台**:Windows 一等目标,无系统 Python,Tier 0 仍打包 python-build-standalone 运行时(固定不膨胀)。
- **安全关键**:`live/` 实盘授权与审计账本明确列为保留资产,升级不得清除(对齐 CLAUDE.md 高风险面约束)。
- **不涉及**:agent 推理核心、skills、backtest 引擎、`/optional-deps` 券商 SDK 机制、live 交易安全链路逻辑本身。
