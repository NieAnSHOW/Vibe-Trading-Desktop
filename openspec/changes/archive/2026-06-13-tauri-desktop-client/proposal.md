## Why

Vibe-Trading 当前只能通过 Docker 或本地手动起双服务(`scripts/dev`)运行,要求用户具备 Python、Node、Docker 等环境与依赖,门槛高、不适合作为终端用户产品分发。需要一个**双击即用、零依赖安装**的桌面客户端:把现有 Python 后端与 Web UI 原样封装进一个 Tauri 应用,用户无需了解任何技术细节即可在 macOS / Windows 上使用。

本变更**只做封装与启动编排,不重写任何后端 / 前端业务逻辑**。

## What Changes

- 新增 `src-tauri/`:Tauri(Rust)应用核心,负责在启动时拉起内嵌的 Python 后端作为 sidecar 子进程、选取空闲端口、轮询健康检查、就绪后把 webview 指向 `http://127.0.0.1:<port>`,并在应用退出时干净终止 sidecar 进程。
- 新增 **可重定位 Python 运行时打包流程**:基于 python-build-standalone 制作自包含运行时,预装 `agent/requirements.txt` 全部依赖(排除 weasyprint),连同 `agent/` 源码、`frontend/dist`、`agent/.env` 一并打包进应用资源,实现完全离线、开箱即用。
- 新增 **双平台构建与打包脚本**:macOS 产出 `.app`/`.dmg`,Windows 产出 `.msi`/`.exe`;复用现有 `frontend` 的 `npm run build` 产物与 `agent/` 源码,不引入新的业务依赖。
- **桌面运行模式约束**:后端绑定 `127.0.0.1`(区别于现有 CLI 默认的 `0.0.0.0`),仅本机访问;端口动态分配以规避冲突。
- **PDF 报告降级为 HTML**:打包时不安装 weasyprint 及其系统原生库(cairo/pango/gdk-pixbuf)。`agent/src/shadow_account/reporter.py` 已内建 try/except 降级路径(`reporter.py:304`),weasyprint 不可用时自动产出 HTML —— **零业务代码改动**。
- 用户状态(`~/.vibe-trading/`)继续保存在家目录,不在应用包内,保证升级/重装不丢数据;配置沿用 `.env` 既有搜索顺序(`~/.vibe-trading/.env` → 打包的 `agent/.env` → `$CWD/.env`),用户可在家目录覆盖。

### 不拆分说明
本变更覆盖 macOS 与 Windows 双平台,但属于**单一内聚能力**:两个平台共享同一套 Rust 启动编排、sidecar 生命周期管理、前端复用与 `.env` 加载逻辑,差异仅在 Python 运行时打包细节与 CI 构建矩阵。两个平台无法独立交付(共享核心代码),拆分会产生大量重复的 proposal/design。因此保持单 change,在 tasks 中按平台分组并标注 **macOS 优先验证**。

### 非目标(本次不做)
- 不重写后端 / 前端业务逻辑(仅封装与启动编排)。
- 不移除报告功能(仅降级 PDF→HTML)。
- 不内置本地 LLM(沿用 `agent/.env` 的 OpenRouter 云端模型)。
- 不做应用自动更新(auto-update)机制 —— 可作为后续 change。
- 不做应用内 `.env` 编辑 UI(用户仍可手动编辑 `~/.vibe-trading/.env`)。
- 不做代码签名 / 公证(macOS 首次需右键打开;Windows 可能触发 SmartScreen 警告)—— 作为已知限制,可后续单独处理。

## Capabilities

### New Capabilities
- `desktop-shell`: Tauri 桌面应用外壳与 Python 后端 sidecar 的生命周期编排 —— 端口选择、进程拉起、健康检查、就绪后加载 webview、退出时进程清理、启动期加载反馈与启动失败处理。
- `python-runtime-bundling`: 可重定位 Python 运行时的制作与依赖预装流程 —— 运行时来源、依赖安装(排除 weasyprint)、原生扩展可重定位性验证、资源裁剪,以及运行时与 `agent/` 源码、`frontend/dist`、`agent/.env` 的资源装配。
- `desktop-packaging-build`: 双平台(macOS / Windows)构建与打包产物定义 —— 前端构建复用、Tauri bundle 配置、产物格式、构建环境约束(跨平台构建需各自平台或 CI 矩阵)。

### Modified Capabilities
<!-- 无:openspec/specs/ 为空,且本变更不修改任何已有 spec 级行为。 -->

## Impact

- **新增代码 / 资源**:`src-tauri/`(Rust 源码 + `tauri.conf.json` + 图标资源)、Python 运行时打包脚本(`scripts/` 下新增)、构建脚本。
- **复用不改动**:`agent/`(后端业务)、`frontend/src/`(前端业务,仅复用 `frontend/dist` 构建产物)、`~/.vibe-trading/` 状态结构。
- **依赖**:新增 Rust / Tauri 工具链(构建期),python-build-standalone(打包期);运行期不要求用户安装任何依赖。打包依赖集 = `agent/requirements.txt` 减去 weasyprint。
- **构建环境**:macOS 包需在 macOS 构建,Windows 包需在 Windows 构建(无法交叉编译);项目已有 `.github/`,可用 GitHub Actions 矩阵分别产出。
- **运行行为差异**:后端监听地址由 `0.0.0.0` 变为 `127.0.0.1`、端口由固定 8899 变为动态分配(仅桌面运行模式,不影响现有 CLI/Docker 用法)。
- **已知限制**:不签名导致的首次启动安全提示;应用体积约 800MB–1.5GB(完整内嵌 Python + 科学计算依赖)。
