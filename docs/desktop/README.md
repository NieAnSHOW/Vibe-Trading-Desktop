# Vibe Trading Desktop

Vibe Trading 桌面客户端，基于 Tauri 2.x 封装，双击即用，无需安装 Python。

## 系统要求

- **macOS**: 12.0+ (Apple Silicon 原生)
- **Windows**: Windows 10+ (x64)
- **磁盘空间**: ~2GB（安装后，含重型依赖）

## 安装

### macOS
1. 下载 `Vibe Trading_*.dmg`
2. 双击挂载 DMG，拖拽 `Vibe Trading.app` 到 `/Applications`
3. **清除"已损坏"隔离标记**（当前未签名版本的必做步骤）：

   应用目前未做 Apple 代码签名与公证，经浏览器下载后双击会报"已损坏，无法打开"。打开"终端"（Spotlight 搜索 `Terminal` 或 `终端`），粘贴下面命令并回车：

   ```bash
   xattr -cr "/Applications/Vibe Trading.app"
   ```

   > 此命令仅清除这一个应用的"从网络下载"隔离标记，**不会**修改任何系统设置、也**不影响**其他应用，可放心执行。
4. **首次启动**：右键点击应用 → "打开" → 确认弹窗点"打开"
5. 后续启动直接双击即可

> 提示：若双击 DMG 本身就提示损坏，先对 dmg 执行 `xattr -cr ~/Downloads/Vibe\ Trading-*.dmg` 再挂载。

### Windows
1. 下载 `Vibe Trading_*_x64-setup.exe`
2. 双击安装
3. 首次启动可能触发 SmartScreen 警告 → 点击"更多信息" → "仍然运行"

## 首次运行

首次启动时，桌面控制台显示"未安装"状态：

1. 点击"安装 / 修复依赖"按钮，触发 `vibe-trading bootstrap`
2. 安装约几百 MB，包含 pandas/scipy/scikit-learn 等数据科学重型包
3. 安装进度实时显示（按行输出当前步骤），弱网可重试，重试会复用已下载部分
4. 可通过下拉菜单切换安装镜像（清华/阿里/官方/自定义）
5. 安装完成后自动冒烟验证，通过后状态变为"就绪"
6. 此后"启动服务"按钮可用，点击启动 WebUI 服务

### CLI 等价

桌面版的 bootstrap 和 serve 均可通过 CLI 直接操作：

```bash
vibe-trading bootstrap              # 安装依赖(人类可读输出)
vibe-trading bootstrap --sse        # SSE 输出(供控制台调用)
vibe-trading serve --port 8899 --open  # 启动并打开浏览器
```

## 桌面控制台

桌面窗口现在是环境/服务控制台，不再是业务 UI 宿主：

1. **安装依赖**: 点击"安装 / 修复依赖"按钮，触发 `vibe-trading bootstrap --sse`，进度实时显示。安装完成后自动冒烟验证，通过后状态变为"就绪"。
2. **启动服务**: 环境就绪后"启动服务"可用，点击用 venv 解释器启动 serve。
3. **打开 WebUI**: 服务运行后，"在浏览器打开 WebUI"按钮用系统默认浏览器打开 `http://127.0.0.1:<port>/`。
4. **查看日志**: "打开日志目录"在文件管理器打开 `~/.vibe-trading/logs/`。

## 三层依赖模型

桌面应用采用三层依赖架构，平衡包大小与开箱即用体验：

- **Tier 0** (bundle 内): 最小核心，见 `scripts/desktop/requirements-tier0.txt`。仅含 FastAPI/uvicorn/langchain 等 serve 入口链路顶层依赖，不含 pandas/scipy/sklearn/duckdb/matplotlib 等重型包。装在内嵌 Python 运行时中，随 .dmg 分发，足以拉起桌面控制台。
- **Tier 1** (首次 bootstrap): 首启时由 `vibe-trading bootstrap` 安装整个 `requirements.txt` 到 `~/.vibe-trading/venv`。包含 pandas/scipy/scikit-learn/duckdb 等重型包，供 serve 使用。安装进度实时显示，失败可重试复用已装部分。
- **Tier 2** (可选依赖): 券商 SDK 等，在 WebUI 设置页按需安装，复用 `/optional-deps` 机制。

## 升级保留策略

升级仅重建 `runtime/` 目录下的代码。以下用户资产始终保留：

- `.env` 配置文件
- `live/` 实盘授权与审计账本（安全关键）
- `sessions/` 会话记录
- `channels/` 渠道配置
- `venv/` 虚拟环境（按 hash 差异增量更新）
- `runs/`、`workspace/`、`uploads/` 等用户数据

## 状态与配置

- **状态目录**: `~/.vibe-trading/`
  - `venv/` — Tier 1 虚拟环境（bootstrap 创建）
  - `runtime/` — 后端代码副本（升级时自动刷新）
  - `.env` — 用户配置（API 密钥等，首次启动自动创建）
- **后端端口**: 每次启动动态分配，仅绑定 `127.0.0.1`
- **进程清理**: 关闭窗口自动终止所有后端子进程

## 已知限制

- **未签名**: macOS 需先执行 `xattr -cr` 清除隔离标记（见上方安装步骤），Windows 触发 SmartScreen
- **体积**: DMG ~90MB（Tier 0 核心），首次 bootstrap 额外下载 ~几百 MB 重型依赖至 `~/.vibe-trading/venv/`
- **PDF 报告降级为 HTML**: bundle 不打包 weasyprint（~200MB 原生依赖），影子账户报告降级为 HTML 输出。
  bootstrap 安装 weasyprint 至 venv，但需要系统级 cairo/pango 库，macOS Homebrew 安装见 [weasyprint 文档](https://doc.courtbouillon.org/weasyprint/stable/first_steps.html#macos)。若 venv 中 weasyprint 运行时因缺系统库报错，影响范围仅限于 PDF 报告生成，不影响其他功能。
- **无自动更新**: 需手动下载新版本
- **仅限 127.0.0.1**: 后端仅监听本机回环地址
- **Apple Silicon only (macOS)**: x64 macOS 需交叉编译（CI 未覆盖）

## 开发

### 构建

**Windows 一键构建**（推荐）：

```powershell
.\scripts\desktop\build-windows.ps1
```

该脚本端到端完成：前置检查 → 拉取 Python runtime → 装依赖 → 组装资源 → `cargo tauri build --bundles nsis` → 归档安装包到 `release/`。前置依赖：`node`/`npm`、`cargo`、`cargo-tauri`（`cargo install tauri-cli --version "^2"`）、`uv`（`pip install uv`）。

**手动分步构建**（macOS / 调试用）：

1. 安装 Rust + Tauri CLI: `cargo install tauri-cli`
2. 准备运行时: `bash scripts/desktop/fetch-runtime.sh && bash scripts/desktop/install-deps.sh .desktop-build/python-runtime`
3. 装配资源: `bash scripts/desktop/assemble.sh`
4. 构建: `cd src-tauri && cargo tauri build`

### 技术栈
- Tauri 2.x (Rust)
- python-build-standalone (嵌入运行时)
- FastAPI/uvicorn (后端)
- React + Vite (前端)

## 安全

- 后端仅绑定 `127.0.0.1`，外部网络不可达
- 应用退出时终止所有子进程，无残留
- 用户配置（API 密钥）存储在 `~/.vibe-trading/.env`，不与应用打包

## 自选股盯盘（Watchlist）

**功能概述**：在 WebUI 侧边栏新增「自选股」入口（`/watchlist`），提供 A 股实时涨跌盯盘，将「看盘→分析」工作流闭合在 Vibe Trading 内部。

### 功能列表

- **自选股管理**：按 6 位股票代码添加/删除，本地持久化存储
- **实时行情**：每 3 秒自动刷新；页面切到后台时浏览器自动节流，切回立即刷一次
- **A 股涨跌配色**：上涨红（`text-red-500`）、下跌绿（`text-green-500`），符合 A 股惯例
- **多选 + 发给 Agent**：勾选一支或多支股票，点击「发给 Agent 分析」一键发起分析

### 数据存储位置

自选股列表存储在独立 SQLite 文件：

```
~/.vibe-trading/watchlist.db
```

与 Agent 会话记录（`sessions.db`）分离，便于独立备份或清除。

### 数据源与市场支持

- 当前**仅支持 A 股**（沪深市场，6 位数字代码，如 `000001`、`600519`）
- 行情来源：腾讯实时行情（`tencent_quote()`），无需 API key，免费
- 进程内 TTL 缓存（5 秒），数据源故障时返回最后已知行情（stale 降级，不抛 500）
- 港股、美股、期货、加密货币暂不支持

### 当前限制

- 股票名称需等待首次行情返回后才显示（添加时仅存代码）
- 非交易时段（工作日 15:00 后、节假日）腾讯接口仍响应但价格不变化
- PDF 报告与桌面版 weasyprint 限制同样适用，与此功能无关
