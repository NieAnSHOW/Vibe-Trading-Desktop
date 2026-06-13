## Context

桌面端通过 Tauri 嵌入一份基于 python-build-standalone 的可重定位 Python 运行时，打包时由 `install-deps.sh`（uv）将 `agent/requirements.txt` 的核心依赖预装进 bundle 内的 `site-packages`。该目录随 `.app`/`.exe` 分发，对终端用户**只读**。

现状缺口：
1. 10+ 个券商/数据源 SDK（`python-okx`、`futu-api`、`ib_async`、`longbridge`、`tigeropen`、`alpaca-py`、`dhanhq`、`shoonya`、`NorenRestApiPy`、`vnpy_ctp`）未打包；agent 在 `trading/connectors/*/sdk.py` 中仅以错误字符串提示 `pip install xxx`。
2. sidecar 启动时 `PYTHONPATH` 仅指向可写的 `~/.vibe-trading/runtime/agent`（agent 源码副本），**没有**一个可写且能被 `import` 的第三方包目录。
3. 无任何后端端点可触发安装；无镜像配置；国内默认 PyPI 下载极慢。

约束：macOS（arm64 + x86_64）与 Windows 双平台；bundle 体积敏感；agent 不得获得自主 `pip install` 权限（安全）。

## Goals / Non-Goals

**Goals:**
- 桌面用户通过设置页 UI 手动触发，即可安装/卸载可选 Python 依赖，全程无需命令行、无需理解 Python 环境。
- 安装产物落入可写目录并被 sidecar 正常 `import`，不触碰只读 bundle。
- 默认走国内镜像，国内网络下载速度显著优于官方 PyPI；镜像可切换/关闭。
- 已装可选依赖在 app 版本升级后保留。
- 安装状态/进度对用户可见；失败可重试。

**Non-Goals:**
- 不做插件市场 / CDN lazy fetch（长期演进，本次不做）。
- 不让 agent 自主 `pip install`（保持手动触发）。
- 不改变核心依赖的打包预装方式。
- 不解决 weasyprint 的系统原生库问题（独立 change `desktop-weasyprint-native-libs`）。
- 不提供跨设备同步已装依赖的能力。

## Decisions

### D1：可写依赖目录位置 — `~/.vibe-trading/runtime/libs/`
紧邻现有可写的 `runtime/agent/`，纳入 `runtime_dir::Layout` 统一管理。升级时作为用户数据保留（与 `.env` 同级处理），不随 bundle 模板覆盖。
- 备选：`~/.vibe-trading/libs/`（独立顶层）——拒绝，分散管理增加迁移逻辑复杂度。

### D2：模块搜索路径注入 — 代码层 `sys.path.append`，而非 `PYTHONPATH`
`PYTHONPATH` 注入的目录在 `sys.path` 中**优先于** bundle 内 `site-packages`，可能导致 libs 中误装的同名包覆盖核心依赖（如旧版 `pandas` 覆盖打包的新版）。改为在 sidecar 启动的 Python 入口（`cli` 加载早期）用 `sys.path.append(libs_dir)`，使其排在 `site-packages` **之后**，核心依赖始终优先。
- 备选：`.pth` 文件 —— bundle `site-packages` 只读，写不进；放弃。
- 备选：`PYTHONPATH` 追加 —— 优先级风险，放弃。
- 细节待 comet-design 确认注入点（`cli/main.py` 最早可执行处）。

### D3：包管理器 — 倾向内嵌 uv，spike 后定稿
uv 安装速度比 pip 快 10-100×，对国内下载大体积原生扩展（券商 SDK 常依赖 numpy/scipy 等传递依赖）体验提升显著。代价是 bundle +~20MB。
- 备选：python-build-standalone 自带的 pip —— 体积零增，但慢；且首次可能需联网自举。
- 待 spike：uv 是否支持 `--target <libs_dir>` 写入指定目录、uv 二进制的跨架构体积、是否需要额外自举网络。
- 决策门槛：若 uv `--target` 可用且 +20MB 可接受 → uv；否则回退 pip。

### D4：镜像配置 — 环境变量注入 sidecar，默认清华
通过 `PIP_INDEX_URL` / `UV_INDEX_URL`（及 `*_EXTRA_INDEX_URL`）在 sidecar spawn 时注入，默认指向清华源。用户在设置页可切换（清华 / 阿里 / 官方 PyPI / 自定义），写入 `~/.vibe-trading/.env` 或独立配置。
- 备选：`pip.conf`/`uv.toml` 文件 —— 环境变量更灵活、运行时可覆盖；优先环境变量。

### D5：可选依赖清单 — YAML registry
新增 `agent/src/optional_deps/registry.yaml`：券商/能力 → PyPI 包名 + 描述 + 平台 wheel 可用性标记 + 推荐镜像。作为 UI 展示与安装 API 的单一数据源，与现有 `swarm/presets/*.yaml` 风格一致。
- 备选：JSON —— YAML 注释友好，更适合人工维护清单。

### D6：安装 API — REST 路由组 + SSE 进度
新增 `/optional-deps` 路由组：
- `GET /list` — 返回 registry 内容并标注每个包当前是否已装（扫描 `libs/` 的 `.dist-info`）。
- `POST /install {package}` — spawn 包管理器子进程写入 `libs/`，返回任务 id。
- `POST /uninstall {package}`。
- `GET /status/{id}`（SSE）— 推送安装 stdout/进度，复用项目已有的 `sse-starlette`。
- 触发链路：前端选券商 → `POST /install` → 子进程安装 → SSE 进度 → 完成 → agent 可 `import`。

### D7：安全模型 — 仅手动触发，白名单约束
- 安装**仅**由前端 UI 调用 `/optional-deps/install` 触发；agent 运行时无该能力。
- 可装包集合受 registry 白名单约束（不接受任意包名），降低供应链风险。
- 来源为 HTTPS PyPI/镜像；design 阶段评估是否对关键包启用 `--require-hashes`。

## Risks / Trade-offs

- **[包名/版本冲突：libs 覆盖核心依赖]** → D2 的 `sys.path.append` 保证核心依赖优先；安装 API 校验包名不与核心依赖冲突。
- **[平台 wheel 缺失：某券商 SDK 无 macOS arm64 预编译 wheel]** → registry 标注平台支持；安装前预检，缺失时给出明确提示而非触发本地编译。
- **[网络失败/中断]** → 包管理器自带缓存与重试；UI 明确失败状态，支持重试。
- **[镜像同步延迟或临时不可用]** → 可一键切换官方源。
- **[uv 体积/自举问题]** → D3 spike；回退方案为标准库 pip。
- **[升级时 libs 误清空]** → `runtime_dir` 迁移逻辑显式保留 `libs/`（与 `.env` 同级）。
- **[macOS Gatekeeper / Tauri 权限]** → 写入用户目录 `~/.vibe-trading` 通常允许；需在打包后真机验证 sidecar 子进程权限。

## Migration Plan

1. 新增可写 `libs/` 目录 + sidecar `sys.path` 注入（**向后兼容**：无 libs 时正常启动，不影响存量用户）。
2. 后端 `/optional-deps` API + registry。
3. 前端设置页组件。
4. 打包脚本保留 `.dist-info`、纳入包管理器。
5. 回滚：移除 API 路由与前端组件即可；`libs/` 目录残留无害。

## Open Questions（交 comet-design 阶段 spike / 决策）

- uv vs pip 最终定稿（D3 spike：`--target` 支持、体积、自举）。
- 各券商 SDK 在 macOS arm64/x86_64/Windows 的预编译 wheel 可用性矩阵。
- `sys.path` 注入的精确时机与位置（D2）。
- 是否对关键包启用哈希校验（D7）。
- 安装进度反馈：SSE vs 轮询的最终选型（倾向 SSE，复用现有设施）。
- 内嵌 uv 二进制的资源纳入方式（bundle resource 还是首运行下载）。
