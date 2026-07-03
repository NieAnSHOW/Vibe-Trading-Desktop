## Context

当前桌面端(`src-tauri/`)以 Tauri webview 托管业务 WebUI,并在构建时(`scripts/desktop/install-deps.sh`)将整个 `agent/requirements.txt`(除 weasyprint)预装进内嵌 python-build-standalone 运行时。侦察确认:`serve` 入口链路(`api_server.py` → `ui_services` / `alpha_routes` / `channels`)顶层**不**直接 import 重型包(pandas/scipy/sklearn/matplotlib/duckdb/ccxt),重型包均为懒加载——这使"Tier 0 最小核心即可拉起控制台与 serve 空转"成立。现有 `~/.vibe-trading/runtime/libs` + `/optional-deps` REST + 清华镜像默认(`sidecar.rs` 已注入 `PIP_INDEX_URL`)已为按需安装铺好地基,但主体仍是全量预装。

约束:Windows 一等目标且无可靠系统 Python;`live/` 为 CLAUDE.md 标注的安全关键路径;用户目录命名保持 `~/.vibe-trading/` 不变;会话物理位于 `runtime/agent/sessions/`(`SESSIONS_DIR = AGENT_DIR/"sessions"`,AGENT_DIR 为代码目录)。

本 design 为 open 阶段高层设计,细节技术方案(具体 venv 编排、控制台渲染栈、增量同步算法)在 comet-design 阶段经 brainstorming 深化。

## Goals / Non-Goals

**Goals:**
- 重型依赖移出 bundle,bundle 仅保留 Tier 0;体积显著下降且不随项目膨胀。
- 桌面壳从 UI 宿主重构为可观测的环境/服务控制台;业务 UI 交给系统默认浏览器。
- 首次运行 bootstrap 整个 requirements 到 `~/.vibe-trading/venv`,进度可见 + 断点重试 + 冒烟验证。
- 渠道管理(启动 + 依赖安装 + 微信扫码)从 CLI 迁入 WebUI,普通用户零终端。
- CLI 保持一等公民,桌面行为对齐本地部署(venv + pip)。

**Non-Goals:**
- 不改 agent 推理核心、skills、backtest 引擎。
- 不改 `/optional-deps` 券商 SDK 机制(Tier 2 原样复用)。
- 不做代码签名证书申请本身(外部前置,文档已覆盖)。
- 不重写 CLI 命令结构(顶多加 `serve --open`)。
- 不做用户目录改名迁移。

## Decisions

- **仍打包 Python 运行时(Tier 0),而非系统 Python / 首次连解释器一起下**。理由:Windows 无可靠系统 Python 是一等目标;运行时几十 MB 固定不膨胀,兼容性最稳,契合"优先保证能跑"。备选(系统 Python / 首次下解释器)均增加首次失败面,否决。
- **切分线是 "bundle vs venv",不是 "核心 vs 可选"**。重型包虽懒加载但属产品核心价值(回测/图表),不能当 Tier 2 缓装;Tier 1 首次 bootstrap 即装齐并冒烟。备选(重包也按需缓装)会让"起得来"≠"能用",否决。
- **标准 `venv` + `pip`,对齐本地 dev**;是否复用 `uv`(现有构建脚本已用,速度快)留 comet-design 定。
- **Tauri 降级为控制台,不删除**:利用其既有能力(spawn 进程 `sidecar.rs`、资源解析 `resources.rs`、文件访问),职责改为环境/服务管理面板。
- **会话先迁出 `runtime/` 再重建**:否则推倒 `runtime/` 会连会话一起抹掉。迁移落点与 `SESSIONS_DIR` 解析改动在 comet-design 定。
- **覆盖边界白名单化**:仅重建 `runtime/`、`cache/`、`fonts/`、`logs/`、`history`、`app/`;其余(尤其 `.env`、`live/`)一律保留。
- **渠道进 WebUI 复用既有 REST**(`/channels/status`、`/channels/start`)+ `Settings.tsx` 现有渠道列表;微信二维码搬进页面显示。

## Risks / Trade-offs

- [首次 bootstrap 下几百 MB,弱网/断网/缺 wheel 失败] → 进度可见 + 断点续装重试 + 冒烟验证 + 可读失败原因 + 可切镜像源;就绪前禁用启动服务。
- [黑箱→玻璃箱但故障种类变多(每台机器网络/平台/杀软/locale 不同)] → 日志落盘 `~/.vibe-trading/logs/` + 控制台"打开日志目录";冒烟验证把"残缺环境"挡在就绪之外。
- [会话迁移改动 `SESSIONS_DIR` 语义,可能影响 CLI/本地部署路径] → 迁移策略在 comet-design 定,须兼容非桌面运行模式,加回归测试。
- [Tier 0 边界判断错误导致 serve 空转崩] → 需干净 venv 实测最小依赖集(comet-design/build 的第一个验证点)。
- [升级增量同步依赖遗漏/冲突] → 以 requirements 差异为准增量安装,失败回落到冒烟"依赖不全"提示。
- [安全关键 `live/` 审计账本被误删] → 覆盖白名单显式排除 + 针对性场景测试。

## Migration Plan

- 老用户升级到重构版:首启检测旧全量 `runtime/` → 迁出会话 → 推倒重建运行时/派生目录 → 触发 bootstrap 建 venv → 保留全部用户资产与会话。
- 回滚:重构版与旧版 bundle 结构不兼容(BREAKING);回滚为重装旧版本;用户资产与会话因保留而不受影响。
- 详细步骤与 CI 双平台产出在 comet-design/build 细化。

## Open Questions

1. Tier 0 最小核心依赖精确清单(需干净 venv 实测 serve 空转)。
2. bootstrap 用 `venv`+`pip` 还是复用 `uv`。
3. 控制台 UI 渲染:Tauri 内小 webview 页面 vs 原生 Rust UI。
4. 会话迁出 `runtime/` 的落点与 `SESSIONS_DIR` 解析改动如何兼容本地/Docker 模式。
5. 升级增量同步依赖的具体判定(requirements hash / pip 差异)。
6. Windows 下 venv + 原生 wheel 兼容性验证矩阵。
