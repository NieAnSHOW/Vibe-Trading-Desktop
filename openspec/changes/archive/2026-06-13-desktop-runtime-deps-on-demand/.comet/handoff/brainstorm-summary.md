# Brainstorm Summary

- Change: desktop-runtime-deps-on-demand
- Date: 2026-06-13
- Status: ✅ 用户已确认设计方案（2026-06-13）

## 确认的技术方案

- **安装器：pip（已内嵌 python-build-standalone 自带 pip 26.1.2，零体积增量）+ 国内镜像**。修正 open 阶段「倾向 uv」的判断——调研显示 pip 对纯 Python 小包足够，且零打包成本。
- **可写目录**：`~/.vibe-trading/runtime/libs/`，纳入 `runtime_dir::Layout`，升级时保留。
- **sys.path 注入**：`cli` 入口最顶部读 `VIBE_RUNTIME_LIBS` 环境变量并 `sys.path.append`；sidecar.rs 传该变量。append 保证核心依赖（bundle site-packages）优先，防 libs 覆盖。
- **进度反馈**：SSE（复用 sse-starlette）。
- **镜像**：默认清华，`PIP_INDEX_URL` 注入；设置页可切换（清华/阿里/官方/自定义/关闭）；registry 白名单限包名，**不强制 `--require-hashes`**（YAGNI）。
- **registry**：券商→包名+元数据+平台支持；标注 **vnpy_ctp 仅 Windows**，macOS 拒绝安装。

## 关键调研事实

- uv 0.9.26 支持 `--target`，但内嵌运行时已有 pip（零增量）。
- 8/9 券商 SDK 纯 Python（any/sdist），longbridge 有全平台 native wheel，**vnpy_ctp 仅 win_amd64**。
- `PYTHONPATH` 优先于 site-packages（覆盖风险）；`sys.path.append` 排在其后（安全）。

## 关键取舍与风险

- pip 慢于 uv → 国内镜像 + 纯 Python 小包场景可接受；未来 longbridge 类大包成痛点再引入 uv。
- sys.path.append 需改 cli 入口（小改动）。
- vnpy_ctp 仅 Windows → registry 标注 + 平台预检拒绝。

## 测试策略
- 单元：白名单拒绝、list 已装标注、vnpy_ctp 平台预检。
- 集成：装 futu-api → import futu → 调用。
- 升级保留：libs 不被清空。
- 镜像耗时对比。

## Spec Patch
无。现有 delta spec 的「核心依赖优先级不被覆盖」「平台 wheel 可用性预检」requirement 已覆盖 sys.path 顺序与 vnpy_ctp 平台拒绝场景，无需补充。
