# Comet Design Handoff

- Change: desktop-runtime-deps-on-demand
- Phase: design
- Mode: compact
- Context hash: f53640f8092c6904bc217ea438ca4649629e0220fdc81aead36e57558772157f

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/desktop-runtime-deps-on-demand/proposal.md

- Source: openspec/changes/desktop-runtime-deps-on-demand/proposal.md
- Lines: 1-37
- SHA256: 55b2a3152b3c921773897fcd44db8ee6bc086e0d16c46aa4d0b8939e8d0c8840

```md
## Why

桌面端已将核心 Python 依赖（langchain/pandas/numpy/ccxt/tushare 等）预装进只读 bundle，但大量券商/数据源 SDK（`python-okx`、`futu-api`、`ib_async`、`longbridge`、`tigeropen`、`alpaca-py`、`dhanhq`、`shoonya`、`NorenRestApiPy`、`vnpy_ctp` 等 10+ 个）未打包。当用户在桌面端配置这些券商连接时，后端只能抛出形如 `pip install xxx` 的错误提示——而桌面用户没有命令行、不知道装到哪个 Python、即便手动装了也写不进只读 bundle 内的 `site-packages`。同时，国内用户从默认 PyPI 下载依赖速度极慢。当前**不存在**一条让桌面用户「零命令行获得可选依赖」的路径，导致大量券商/数据源能力在桌面端实际不可用。

## What Changes

- **新增可写的可选依赖目录**：在 `~/.vibe-trading/runtime/` 下建立可写的依赖目录（如 `libs/`），sidecar 启动时将其加入 Python 模块搜索路径（`PYTHONPATH` 追加或 `.pth` 文件），使运行时装入的第三方包可被 agent 正常 `import`。
- **后端新增「可选依赖管理」REST API**：提供「列出可装/已装依赖」「安装」「卸载」端点；安装过程调用内嵌的包管理器（uv 或 pip），将包写入上述可写目录，不走只读 bundle。
- **预置国内 PyPI 镜像配置**：默认指向清华/阿里镜像，通过环境变量（`PIP_INDEX_URL` 等）或 `pip.conf` 注入；用户可在设置页切换镜像源或关闭（回退官方 PyPI）。
- **前端设置页新增管理组件**：按券商分组展示可选依赖，一键「安装支持」/「卸载」，实时显示安装状态与进度。
- **打包脚本调整**：`assemble.sh` / `install-deps.sh` 确保 `.dist-info` 元数据被保留（包管理器需要它们管理已装包）；将选定的包管理器（内嵌 uv 或标准库 pip）纳入 bundle 或确认其可用。
- **维护「可选依赖清单」**：券商/能力 → PyPI 包名 + 元数据（描述、平台 wheel 可用性、推荐镜像）的映射文件，作为 UI 展示与安装 API 的单一数据源。

## Capabilities

### New Capabilities

- `python-runtime-optional-deps`: 桌面端运行时按需安装与管理可选 Python 依赖（券商/数据源 SDK 等）的完整能力——可写依赖目录、sidecar 路径集成、内嵌包管理器与国内镜像、后端安装/卸载/列表 API、前端 UI 手动触发。

### Modified Capabilities

无。本次不改 `python-runtime-bundling` 的现有 requirement（「打包时预装核心依赖」行为不变）；可写目录与运行时按需安装是新增的能力维度。`scripts/desktop` 对 `.dist-info` 保留与包管理器纳入 bundle 的调整属于实现细节，不构成 spec 级行为变更。

## Impact

- **代码**：
  - `src-tauri/src/sidecar.rs`：启动 sidecar 时将可写依赖目录注入模块搜索路径
  - `src-tauri/src/runtime_dir.rs`：新增可写 `libs/` 目录的创建、版本升级时的保留逻辑
  - `src-tauri/src/resources.rs`：bundle 内包管理器二进制与可选依赖清单资源的解析
  - `agent/`：新增可选依赖管理模块 + REST API 路由（挂载到 `api_server.py`）
  - `frontend/src/`：设置页新增「可选依赖/券商支持」管理组件，接入 agent store / api 层
  - `scripts/desktop/assemble.sh`、`install-deps.sh`：保留 `.dist-info`、纳入包管理器
- **依赖与体积**：可能新增内嵌 uv 二进制（约 +20MB，换取 10-100× 安装速度）或复用 Python 标准库 pip（体积零增但慢）；券商 SDK 本身**不进 bundle**，全部按需下载。
- **API**：新增可选依赖管理路由组（如 `/optional-deps`）。
- **配置**：新增镜像源配置项（用户可切换/关闭）；新增可选依赖清单数据文件。
- **安全**：安装来源为 PyPI / 镜像，需在 design 阶段评估镜像信任模型与是否需要哈希校验；安装**仅由用户在 UI 手动触发**，agent 不获得自主 `pip install` 权限。
- **平台**：macOS（主，含 arm64/x86_64）+ Windows；需在 design 阶段确认各券商 SDK 在目标平台的预编译 wheel 可用性。
```

## openspec/changes/desktop-runtime-deps-on-demand/design.md

- Source: openspec/changes/desktop-runtime-deps-on-demand/design.md
- Lines: 1-92
- SHA256: ac3cb124922af700281f3ed310f80d64cd8dd3ab336d61029dee5acc9f2b26df

[TRUNCATED]

```md
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
```

Full source: openspec/changes/desktop-runtime-deps-on-demand/design.md

## openspec/changes/desktop-runtime-deps-on-demand/tasks.md

- Source: openspec/changes/desktop-runtime-deps-on-demand/tasks.md
- Lines: 1-61
- SHA256: 91635f0ed2f0e344174db8ef5fc7eee47a6d1b8a96b304200ae83a7f128c1c71

```md
# Implementation Tasks — desktop-runtime-deps-on-demand

> 任务按依赖排序。标注 `[spike]` 的为需先验证才能定稿的探查任务，建议在 comet-design 阶段优先处理。

## 1. 可写依赖目录与 sidecar 模块搜索集成

- [ ] 1.1 在 `src-tauri/src/runtime_dir.rs` 扩展 `Layout`，新增 `runtime_libs: ~/.vibe-trading/runtime/libs` 字段及其创建逻辑
- [ ] 1.2 实现 `runtime_libs` 在版本升级迁移时被显式保留（与 `.env` 同级，不随 bundle 模板覆盖）
- [ ] 1.3 在 Python 入口（`cli` 加载早期）以 `sys.path.append(runtime_libs)` 注入，确保排在 bundle `site-packages` **之后**
- [ ] 1.4 编写断言：可写目录中同名包不覆盖核心打包依赖（核心版本优先）

## 2. 包管理器选型与平台 wheel 探查 [spike]

- [ ] 2.1 `[spike]` 验证 uv 是否支持 `--target <libs_dir>` 写入指定目录，以及内嵌 uv 的跨架构体积与是否需要联网自举
- [ ] 2.2 `[spike]` 对照标准库 pip 的可用性与速度，作出 uv vs pip 的最终选型（决策门槛：uv `--target` 可用且 +20MB 可接受 → uv；否则 pip）
- [ ] 2.3 `[spike]` 建立 10+ 券商 SDK 在 macOS arm64 / x86_64 / Windows 的预编译 wheel 可用性矩阵
- [ ] 2.4 按选型将包管理器纳入 bundle（`resources.rs` 解析、`tauri.conf.json` 声明 resource）或确认标准库 pip 可用

## 3. 可选依赖清单（registry）

- [ ] 3.1 设计 `agent/src/optional_deps/registry.yaml` schema：券商/能力 → PyPI 包名 + 描述 + 平台 wheel 可用性标记 + 推荐镜像
- [ ] 3.2 录入初始清单（至少：python-okx、futu-api、ib_async、longbridge、tigeropen、alpaca-py、dhanhq、shoonya、NorenRestApiPy、vnpy_ctp）
- [ ] 3.3 实现 registry 加载模块（读取 + 校验包名白名单）

## 4. 后端安装/卸载/列表 API

- [ ] 4.1 新增 `agent/src/optional_deps/` 模块：安装、卸载、列表、状态查询
- [ ] 4.2 实现 `GET /optional-deps/list`：返回 registry 内容并扫描 `libs/` 的 `.dist-info` 标注已装状态
- [ ] 4.3 实现 `POST /optional-deps/install`：registry 白名单校验 → spawn 包管理器子进程写入 `libs/`
- [ ] 4.4 实现平台 wheel 预检：目标包在当前平台无预编译 wheel 时返回明确提示，不触发源码构建
- [ ] 4.5 实现 `POST /optional-deps/uninstall`
- [ ] 4.6 实现安装进度反馈：SSE 推送子进程 stdout / 阶段状态（复用 `sse-starlette`）
- [ ] 4.7 实现镜像源配置读写端点（`GET/PUT /optional-deps/mirror`），持久化到用户配置
- [ ] 4.8 将 `/optional-deps` 路由组挂载到 `agent/api_server.py`

## 5. 国内镜像注入

- [ ] 5.1 `sidecar.rs` spawn 时按用户配置注入 `PIP_INDEX_URL` / `UV_INDEX_URL`（及 `*_EXTRA_INDEX_URL`），默认清华源
- [ ] 5.2 镜像配置持久化与读取（写入 `~/.vibe-trading/.env` 或独立配置文件）

## 6. 前端设置页 UI

- [ ] 6.1 新增「可选依赖 / 券商支持」管理组件，按券商分组展示 registry
- [ ] 6.2 一键「安装支持」/「卸载」按钮，显示每个包的已装/未装状态
- [ ] 6.3 接入安装进度 SSE，实时展示安装阶段
- [ ] 6.4 镜像源切换 UI（清华 / 阿里 / 官方 / 自定义 / 关闭）
- [ ] 6.5 接入 `src/lib/api.ts` 与 `src/stores/agent.ts`，并在 `components/layout/Layout.tsx` 或设置页挂载入口

## 7. 打包脚本调整

- [ ] 7.1 `scripts/desktop/assemble.sh` 确认保留 `.dist-info`（包管理器需要其管理已装包）
- [ ] 7.2 `scripts/desktop/install-deps.sh` 适配包管理器选型（若用 uv 则确认内嵌；若 pip 则确认标准库可用）
- [ ] 7.3 将 registry.yaml 与（如选 uv）uv 二进制纳入打包资源

## 8. 验证与测试

- [ ] 8.1 后端 API 单元测试：白名单拒绝、list 已装标注、平台预检
- [ ] 8.2 集成测试：安装 `futu-api` → agent `import futu` → 成功调用
- [ ] 8.3 升级保留测试：版本升级后 `libs/` 内容不被清空，依赖仍可 import
- [ ] 8.4 镜像耗时对比：同一包在清华源 vs 官方 PyPI 的下载耗时记录
- [ ] 8.5 打包后真机验证：macOS arm64 与 Windows 各完成一次「选券商 → 安装 → 调用」全链路
```

## openspec/changes/desktop-runtime-deps-on-demand/specs/python-runtime-optional-deps/spec.md

- Source: openspec/changes/desktop-runtime-deps-on-demand/specs/python-runtime-optional-deps/spec.md
- Lines: 1-70
- SHA256: a73900aef37f7705bbad211ae8ac7def7d9ccd7e4a7cd7b3b536c0dec6ad1c7f

```md
## ADDED Requirements

### Requirement: 可写的可选依赖目录与 sidecar 模块搜索集成
系统 SHALL 在用户数据目录下维护一个可写的可选依赖目录（`~/.vibe-trading/runtime/libs/`），sidecar 启动时 SHALL 将该目录加入 Python 模块搜索路径且位于 bundle 内 `site-packages` **之后**，使运行时装入的第三方包可被 agent 正常 `import`，同时保证核心打包依赖始终优先。

#### Scenario: 运行时安装的包可被 agent import
- **WHEN** 后端通过安装 API 将 `futu-api` 写入可写依赖目录
- **THEN** sidecar 在不重启、不改动 bundle 的前提下能 `import futu`，并成功调用富途 API

#### Scenario: 核心依赖优先级不被覆盖
- **WHEN** 可写依赖目录中存在与核心打包依赖同名的包（如旧版 `pandas`）
- **THEN** agent 导入该名称时仍加载 bundle `site-packages` 中的核心版本，可写目录不覆盖核心依赖

### Requirement: 可选依赖安装/卸载/列表 API（手动触发）
系统 SHALL 提供 REST API（`/optional-deps` 路由组）支持列出可装/已装依赖、安装、卸载；安装与卸载 SHALL 仅由显式 API 调用触发，agent 运行时 SHALL NOT 具备自主 `pip install` 能力。

#### Scenario: 列出可装与已装依赖
- **WHEN** 调用 `GET /optional-deps/list`
- **THEN** 返回 registry 中全部可装项，并依据可写目录的 `.dist-info` 标注每项当前是否已安装

#### Scenario: 安装券商 SDK
- **WHEN** 调用 `POST /optional-deps/install` 指定包名 `futu-api`
- **THEN** 后端通过包管理器将 `futu-api` 及其依赖写入可写依赖目录，完成后该包可被 `import`

#### Scenario: 卸载已装依赖
- **WHEN** 调用 `POST /optional-deps/uninstall` 指定已安装的包
- **THEN** 该包从可写依赖目录移除，后续不再可 `import`

### Requirement: 安装进度反馈与失败重试
安装过程 SHALL 向前端实时反馈进度（stdout / 阶段状态）；安装失败 SHALL 给出明确原因并支持重新触发。

#### Scenario: 安装进度实时可见
- **WHEN** 触发一次安装
- **THEN** 前端通过 SSE（或等价轮询机制）收到安装过程的进度更新，直至完成或失败

#### Scenario: 断网或失败可重试
- **WHEN** 安装因网络中断或其他错误终止
- **THEN** 前端显示明确的失败状态与原因，用户可重新触发安装

### Requirement: 国内 PyPI 镜像默认启用且可切换
系统 SHALL 默认使用国内 PyPI 镜像（如清华源）执行安装，并 SHALL 允许用户在设置页切换镜像源（清华 / 阿里 / 官方 PyPI / 自定义）或关闭镜像回退官方源。

#### Scenario: 国内镜像默认生效
- **WHEN** 用户在默认配置下安装一个可选依赖
- **THEN** 安装请求指向国内镜像源，国内网络环境下下载速度显著优于官方 PyPI（应可记录耗时对比）

#### Scenario: 切换镜像源
- **WHEN** 用户在设置页切换镜像源并重新安装
- **THEN** 后续安装使用新指定的镜像源

### Requirement: 可选依赖清单（registry 白名单）
系统 SHALL 维护一份可选依赖清单（券商/能力 → PyPI 包名 + 描述 + 平台 wheel 可用性 + 推荐镜像），作为 UI 展示与安装 API 的单一数据源；安装 API SHALL 仅接受清单内声明的包名。

#### Scenario: 仅可安装清单内依赖
- **WHEN** 安装 API 收到不在 registry 内的包名请求
- **THEN** 拒绝安装并返回明确错误，不执行任意包安装

### Requirement: 已装依赖在版本升级后保留
应用版本升级时 SHALL 保留用户已安装的可选依赖目录内容，不随 bundle 模板覆盖或清空。

#### Scenario: 升级后已装依赖仍在
- **WHEN** 应用从旧版本升级到新版本
- **THEN** 用户此前安装的可选依赖依然存在于可写目录且可被 `import`

### Requirement: 平台 wheel 可用性预检
安装前 SHALL 检测目标包在当前平台是否存在预编译 wheel；缺失时 SHALL 给出明确提示而非触发本地编译。

#### Scenario: 目标平台无预编译 wheel
- **WHEN** 待安装的包在当前平台（如 macOS arm64）无预编译 wheel
- **THEN** 安装 API 返回明确提示信息，不尝试需要本地编译器的源码构建
```

