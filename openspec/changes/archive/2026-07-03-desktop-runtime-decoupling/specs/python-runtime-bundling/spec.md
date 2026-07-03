# python-runtime-bundling delta

## MODIFIED Requirements

### Requirement: 预装全部后端依赖(排除 weasyprint)
打包流程 SHALL 仅将能拉起桌面控制台与 `serve` 空转所需的 **Tier 0 最小核心依赖**预装进内嵌运行时(至少 fastapi / uvicorn / pydantic / langchain 等 serve 入口链路顶层依赖),SHALL NOT 再将整个 `agent/requirements.txt` 预装进 bundle。重型后端依赖(pandas / numpy / scipy / scikit-learn / matplotlib / duckdb / ccxt / akshare / tushare 等)SHALL 由首次运行时 bootstrap 安装进用户目录 venv(见 desktop-runtime-bootstrap),不随 bundle 分发。weasyprint 及其系统原生库仍 SHALL 排除。

#### Scenario: bundle 仅含 Tier 0 核心
- **WHEN** 完成打包
- **THEN** 内嵌运行时仅含 Tier 0 最小核心依赖,不含 pandas/scipy/scikit-learn/matplotlib/duckdb 等重型包,bundle 体积显著小于全量预装

#### Scenario: Tier 0 足以拉起控制台与 serve 空转
- **WHEN** 桌面应用在依赖尚未 bootstrap 时启动
- **THEN** 控制台可正常显示,且 `serve` 入口链路(api_server/ui_services/alpha_routes/channels 顶层)可导入并启动,不因缺少重型包而在启动阶段崩溃

#### Scenario: 重型依赖由 venv 提供
- **WHEN** 用户完成首次 bootstrap 后使用回测/行情/图表等功能
- **THEN** 所需重型包从 `~/.vibe-trading/venv` 导入并正常工作,而非从 bundle

### Requirement: 回测子进程使用内嵌 Python 自包含
回测执行会以子进程方式选取解释器(`agent/src/core/runner.py` 在找不到项目 `.venv` 时回退到 `sys.executable`)。桌面运行模式下,后端 SHALL 以 `~/.vibe-trading/venv` 的解释器运行,使回测子进程经 `sys.executable` 回退时选中的即为该 venv 解释器,从而自包含加载全部所需依赖。

#### Scenario: 回测子进程在 venv 中跑通
- **WHEN** 在桌面运行模式(sidecar 由 venv 解释器启动)触发一次回测
- **THEN** 回测子进程使用 venv 解释器成功加载 pandas/numpy/scipy 等依赖并完成执行,不因缺失依赖或解释器不可用而失败

## REMOVED Requirements

### Requirement: 资源装配与裁剪
**Reason**: 该 requirement 以"内嵌运行时预装全部依赖"为前提描述资源装配;依赖三层化后,bundle 不再装配全量 site-packages,装配范围与裁剪策略由本 delta 的 Tier 0 requirement 与 desktop-runtime-bootstrap 共同重新定义,原表述已不成立。
**Migration**: 资源装配改为:bundle 装配 Tier 0 运行时 + agent 源码 + frontend/dist + .env 种子;重型依赖不再进 bundle,改由首次运行 bootstrap 到 `~/.vibe-trading/venv`。裁剪(测试/`__pycache__`/`*.dist-info`)仍适用于 Tier 0 运行时。
