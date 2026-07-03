# Tasks — desktop-runtime-decoupling

## 1. Tier 0 边界确定(前置验证)

- [x] 1.1 用干净 venv 实测:仅装哪些依赖能让 `vibe-trading serve` 拉起并通过 `/health`、控制台可显示(serve 空转不崩)
- [x] 1.2 据实测结果定义 Tier 0 最小核心依赖清单(bundle 内),与 Tier 1(venv)依赖清单划清边界
- [x] 1.3 记录 Windows 下 Tier 0 冒烟结论(无系统 Python,内嵌运行时能跑 serve 空转)

## 2. 依赖 bootstrap(desktop-runtime-bootstrap)

- [x] 2.1 实现 `~/.vibe-trading/venv` 标准 venv 创建 + `requirements.txt` 安装,默认清华源
- [x] 2.2 安装进度实时反馈(复用 optional-deps 的 SSE/进度模式)+ 关键日志落盘
- [x] 2.3 断点重试:失败给可读原因,重试复用已完成部分而非从零
- [x] 2.4 镜像源可切换(清华/阿里/官方/自定义 index-url)
- [x] 2.5 smoke import 冒烟验证(numpy/scipy/scikit-learn/pandas/duckdb 等),通过才标"就绪"
- [x] 2.6 升级时按 requirements 差异增量同步依赖(不删重建整个 venv)

## 3. 桌面控制台(desktop-control-console)

- [x] 3.1 控制台窗口:展示环境状态(未安装/就绪/依赖不全)与服务状态(运行中/已停止)
- [x] 3.2 触发依赖安装入口(接 §2 bootstrap),环境未就绪时禁用"启动服务"
- [x] 3.3 启停服务(用 venv 解释器 spawn serve;停止干净回收进程)
- [x] 3.4 "在默认浏览器打开 WebUI"(系统浏览器打开 `127.0.0.1:<port>`)
- [x] 3.5 "打开日志目录"(`~/.vibe-trading/logs/`)

## 4. sidecar 与 shell 重构(desktop-shell / python-runtime-bundling)

- [x] 4.1 `sidecar.rs`:解释器路径改用 `~/.vibe-trading/venv`,环境未就绪不启动 serve
- [x] 4.2 移除 webview 托管业务 UI:`tauri.conf.json` 窗口不再指向 frontend/dist 业务页(改控制台)
- [x] 4.3 会话迁出 `runtime/`:调整 `SESSIONS_DIR` 解析,兼容本地/Docker 运行模式(加回归测试)
- [x] 4.4 覆盖边界白名单化:仅重建 `runtime/`/`cache/`/`fonts/`/`logs/`/`history`/`app/`,保留全部用户资产
- [x] 4.5 安全关键:针对性测试 `live/` 授权与审计账本在升级重建后不被清除
- [x] 4.6 首启/升级可写目录准备失败给可读错误(控制台展示,不静默崩溃)

## 5. 构建装配脚本(python-runtime-bundling)

- [x] 5.1 `install-deps.sh`:不再全量装进 bundle,仅装 Tier 0 核心
- [x] 5.2 `assemble.sh` / `fetch-runtime.sh`:装配范围调整为 Tier 0 运行时 + agent 源码 + frontend/dist + .env 种子
- [x] 5.3 `build-dmg.sh` / `build-windows.ps1`:适配新 bundle 内容,冒烟校验产物
- [x] 5.4 验证重构后 bundle 体积显著小于全量预装(记录对比)

## 6. 渠道管理进 WebUI(channel-management-ui)

- [x] 6.1 `Settings.tsx`:渠道启动/停止接入 `/channels/start`、`/channels/status`
- [x] 6.2 渠道依赖安装 UI(接可选依赖安装机制)+ 进度展示
- [x] 6.3 微信渠道页面内扫码登录(二维码 + 登录状态),替代终端扫码
- [x] 6.4 验证 CLI 渠道命令仍可用且与 WebUI 等价

## 7. CLI 与收尾

- [x] 7.1 `serve` 增加 `--open`(启动后开默认浏览器)
- [x] 7.2 更新桌面文档(`docs/desktop/`、CLAUDE.md 相关段):三层依赖模型、控制台用法、首次 bootstrap 说明
- [ ] 7.3 全平台验收:全新 Windows 机首装→安装依赖→冒烟通过→启动→浏览器打开 WebUI 完整可用;弱网重试;渠道零终端;CLI 对齐
