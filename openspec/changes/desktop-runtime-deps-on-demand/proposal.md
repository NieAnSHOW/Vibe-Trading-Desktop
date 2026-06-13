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
