## Context

Vibe-Trading 现状:Python(FastAPI + uvicorn)后端通过 `vibe-trading serve` 启动,生产模式下用 `SPAStaticFiles` 把 `frontend/dist` 挂载到 `/`(`agent/api_server.py:3100-3118`),即**后端本身就是 Web 服务器**。前端所有 API 请求走同源相对路径(`frontend/src/lib/api.ts:3` `BASE=""`)。用户状态统一落在 `~/.vibe-trading/`,`.env` 搜索顺序为 `~/.vibe-trading/.env → agent/.env → $CWD/.env`(`agent/src/providers/llm.py:246`)。

当前分发依赖 Docker 或本地手动起服务,要求用户具备 Python/Node/Docker 环境。目标是封装成 macOS/Windows 双平台、零依赖、双击即用的 Tauri 桌面客户端,**不重写任何业务逻辑**。

约束:
- 完整内嵌 Python(已确认),体积 ~800MB–1.5GB 可接受。
- PDF 报告降级为 HTML(已确认),`reporter.py:304` 已内建降级,无需改代码。
- 后端绑 `127.0.0.1`、端口动态分配(仅桌面模式)。
- 无法交叉编译,双平台需各自构建环境。

## Goals / Non-Goals

**Goals:**
- 双击即用、完全离线、零依赖安装的 macOS + Windows 桌面客户端。
- 后端与 Web UI 原样复用,封装层与业务层解耦。
- sidecar 生命周期可靠:端口选择、健康检查、就绪加载、退出清理。
- 用户状态在家目录持久,升级不丢数据;用户可覆盖配置。

**Non-Goals:**
- 不重写后端 / 前端业务逻辑。
- 不做 auto-update、不做应用内配置 UI、不内置本地 LLM。
- 不做代码签名 / 公证(列为已知限制)。
- 不保留 PDF 渲染(降级 HTML)。

## Decisions

### D1: webview 指向后端托管的 UI,而非 Tauri 静态托管前端
后端生产模式已托管 `frontend/dist` 且前端走同源相对路径。让 webview 直接指向 `http://127.0.0.1:<port>`,前端零改动、零跨域、无需注入 API base。
- **Alternative**:Tauri 用 `frontendDist` 直接托管前端、API 指向 sidecar。被否:前端 `BASE=""` 同源假设会破裂,需改前端并处理 CORS,违背"不改业务"。

### D2: Python 运行时用 python-build-standalone,作为 Tauri `resources` 打包
完整内嵌一份预装依赖的可重定位 Python。打包整目录用 Tauri `resources`(而非仅适合单二进制的 `externalBin`),Rust 侧用 `Command` spawn `resources/python/bin/python`(Windows 为 `python.exe`)运行 `agent` 的 serve 入口。
- **Alternative A**:PyInstaller/Nuitka 冻结。被否:scipy/duckdb/weasyprint 等重原生依赖隐藏导入与动态库易踩坑、脆弱难维护。
- **Alternative B**:首启 uv 联网引导。被否:违背"开箱即用 / 完全离线"。

### D3: 依赖预装排除 weasyprint
打包时安装 `requirements.txt` 但剔除 weasyprint。`reporter.py` 已 try/except 降级到 HTML(`reporter.py:304`),零代码改动即满足"降级 HTML"。同时省去 vendoring cairo/pango 原生库的复杂度。

### D4: 端口动态分配 + 健康检查门控加载
Rust 侧先探测空闲端口(绑定 `127.0.0.1:0` 取系统分配,或从 8899 起递增探测),以 `--host 127.0.0.1 --port <port>` 启动后端;轮询 `/health`(`scripts/dev` 已有同款就绪探测模式)通过后再加载 webview,期间显示加载态;超时显示可读错误。

### D5: sidecar 进程生命周期与平台差异
- macOS/Linux:用进程组(`start_new_session` / setsid 风格),退出时按组终止 —— 复用 `scripts/dev:69-90` 同款思路。
- Windows:无 POSIX 进程组,用 Job Object 关联子进程(随父进程结束自动终止)或退出时 `taskkill /T`。
- Tauri 监听窗口关闭 / `RunEvent::ExitRequested`,统一触发清理。

### D6: 配置与状态沿用既有机制
打包 `agent/.env` 作兜底配置;`.env` 既有搜索顺序使用户可在 `~/.vibe-trading/.env` 覆盖。首启 onboarding 仅当 `.env` 缺失才触发(`cli/main.py:253`),已打包 `.env` 故真正开箱即用。状态目录 `~/.vibe-trading/` 不进应用包。

### D7: 双平台构建走 CI 矩阵
项目已有 `.github/`。用 GitHub Actions macOS + Windows runner 分别构建产物,文档明确"不可交叉编译"约束。本地可单平台(macOS 优先)验证。

## Risks / Trade-offs

- [python-build-standalone 装重型科学包后可重定位性未知:scipy/sklearn 的 BLAS 链接、duckdb `.so/.pyd` 的 rpath 在迁移路径后可能 import 失败] → design 阶段先打 spike 实测;提供原生扩展导入冒烟测试(spec 已要求)。**这是头号风险,brainstorming 须优先攻克。**
- [应用体积 800MB–1.5GB] → 资源裁剪(去 tests/`__pycache__`/`dist-info`);接受为内嵌完整 Python 的必然代价。
- [Windows 进程清理不彻底致残留后端] → Job Object 方案;补进程清理验收测试。
- [不签名导致首次启动安全提示] → 文档说明 macOS 右键打开 / Windows SmartScreen "仍要运行";列为已知限制。
- [无法交叉编译] → CI 矩阵双平台分别构建。
- [动态端口 / 健康检查竞态致偶发加载失败] → 就绪轮询 + 超时 + 可读错误兜底。

## Migration Plan

封装层为新增,不改动现有运行方式,无数据迁移。回滚 = 不分发桌面包,Docker/CLI 路径不受影响。交付顺序:先 macOS 打通端到端(含可重定位性 spike),再补 Windows 差异(进程清理 / 运行时打包)。

## Open Questions

1. python-build-standalone 具体发行版/版本与各平台架构(mac arm64+x64 是否都要?Windows x64)—— design/brainstorming 阶段定。
2. 依赖预装方式:在目标平台直接 `pip install` 进内嵌 site-packages,还是用 `uv` 锁定后装入 —— 影响可重现性,brainstorming 决策。
3. 加载态 UI 形态:Tauri 原生 splash 窗口 vs. 简单 HTML 加载页 —— 实现细节,可在 build 阶段定。
4. 是否需要 mac 双架构(universal / 分架构产物)—— 取决于分发目标,可延后。
