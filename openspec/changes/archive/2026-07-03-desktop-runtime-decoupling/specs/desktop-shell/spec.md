# desktop-shell delta

## MODIFIED Requirements

### Requirement: 应用启动时编排 Python 后端 sidecar
桌面应用 SHALL 在环境就绪(venv 已 bootstrap 且冒烟验证通过)后,使用 `~/.vibe-trading/venv` 的解释器拉起 Python 后端作为 sidecar 子进程,通过 `vibe-trading serve` 入口启动 FastAPI 服务。桌面应用 SHALL NOT 用内嵌 webview 承载业务 Web UI;业务 UI 改由系统默认浏览器访问 `http://127.0.0.1:<port>`(见 desktop-control-console)。启动服务前若环境未就绪,SHALL 引导用户先完成依赖 bootstrap。

#### Scenario: 环境就绪后由 venv 解释器启动服务
- **WHEN** 环境已就绪,用户经控制台启动服务
- **THEN** 应用使用 `~/.vibe-trading/venv` 解释器拉起 `serve`,轮询 `/health` 直至成功,状态更新为"运行中"

#### Scenario: 业务 UI 由默认浏览器承载
- **WHEN** 服务就绪、用户打开 WebUI
- **THEN** 系统默认浏览器加载 `http://127.0.0.1:<port>`,而非桌面 webview

#### Scenario: 环境未就绪时不启动服务
- **WHEN** venv 未 bootstrap 或冒烟未通过时尝试启动服务
- **THEN** 应用不启动 serve,转而引导用户先完成依赖安装

### Requirement: 首启与升级时准备可写运行目录
桌面应用 SHALL 在启动后端前把只读 bundle 中的后端代码复制到可写运行目录并以该副本启动后端。会话数据(会话 JSONL 与 `sessions.db`)当前物理位于 `runtime/agent/sessions/`,SHALL 迁出 `runtime/` 到不随运行时重建而清除的位置,使推倒重建 `runtime/` 不影响会话。升级/重构刷新时,SHALL 仅推倒重建运行时/派生目录(`runtime/`、`cache/`、`fonts/`、`logs/`、`history`、`app/`),并 SHALL 保留全部用户资产(`.env`、`live/` 实盘授权与审计账本、`channels/`+`pairing.json`、`memory/`、`shadow_accounts/`、券商配置 json、`runs/`、`workspace/`、`uploads/`)与会话数据。

#### Scenario: 首次启动准备可写目录
- **WHEN** 应用首次启动(可写运行目录尚不存在)
- **THEN** 应用将 bundle 后端代码复制到可写运行目录并记录版本标记;会话与用户资产目录创建在不随 `runtime/` 重建而清除的位置

#### Scenario: 升级刷新代码但保留用户资产与会话
- **WHEN** 应用版本较已安装版本更新(版本标记不一致)
- **THEN** 应用推倒重建运行时/派生目录,但 `.env`、`live/`、`channels/`、`memory/`、`shadow_accounts/`、券商配置、`runs/`、`workspace/`、`uploads/` 与会话数据均被保留

#### Scenario: 会话已迁出 runtime 不被重建清除
- **WHEN** `runtime/` 被推倒重建
- **THEN** 既有会话(JSONL 与 `sessions.db`)仍存在且可在 WebUI/CLI 中访问

#### Scenario: 本地/Docker 模式会话路径行为不变
- **WHEN** 以非桌面模式运行(本地部署 / Docker),未设置 `VIBE_SESSIONS_DIR` 环境变量
- **THEN** 会话路径回退到代码相对的默认位置(`<code_dir>/sessions`),与重构前逐字节一致,桌面模式的会话迁出改动 SHALL NOT 影响非桌面运行

#### Scenario: 安全关键的 live 资产不被清除
- **WHEN** 重构升级执行运行时目录重建
- **THEN** `~/.vibe-trading/live/`(实盘 mandate 授权与审计账本)不被覆盖或删除

#### Scenario: 可写目录准备失败的可读错误
- **WHEN** 准备可写运行目录失败(如磁盘空间不足或权限不足)
- **THEN** 控制台展示可读的错误信息(含失败路径与原因),而非静默崩溃或卡在加载态
