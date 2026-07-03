# Tier 0 边界实测结论

> **实测日期**: 2026-07-03
> **实测环境**: macOS arm64 (Apple Silicon), Python 3.11 (pyenv)
> **测试方法**: 干净 venv + 逐层安装 → serve 启动 `/health` 通过 → 冻结 → 冒烟

## 最终 Tier 0 清单

16 个顶层包（不含传递依赖），约 60 个已安装包，无重型包（pandas/scipy/scikit-learn/duckdb/matplotlib 均不在内）：

```
rich, pyyaml, python-dotenv, httpx, requests,
langchain, langchain-core, langchain-openai,
langgraph, langgraph-checkpoint,
fastapi, uvicorn[standard], websockets, pydantic,
python-multipart, sse-starlette
```

## 顶层 import 泄漏（已修复）

修复前 `_build_parser()` → `src.factors.cli_handlers` → `numpy`，建 CLI parser 不应拉 numpy。

**修复**: `cli/_legacy.py` 的 `main()` 增加 `serve`/`bootstrap` 快速路径——无需构建完整 parser（含 alpha zoo 等重型子命令），直接派发到 `serve_main()` / `run_bootstrap_cli()`。

使 serve 入口链路无需 numpy/scipy。

## 逐层收敛过程

| 轮次 | 操作 | 结果 |
|------|------|------|
| 1 | venv only + candidate (fastapi/uvicorn/langchain/...) | ModuleNotFoundError: numpy（顶层 import 泄漏）|
| 2 | 修复 serve fast-path 后重试 | HEALTH OK ✅ |

## Windows 结论

**待验证** — 当前无 Windows 环境。Windows 实测挂到 Task 13 全平台验收。预期：内嵌 python-build-standalone 3.12 运行时安装同一 Tier 0 清单后，`smoke_tier0.py` 能通过、`serve` 能 `/health`。

## 体积对比

| 指标 | 全量预装（旧） | Tier 0（新） |
|------|---------------|-------------|
| 已装包数 | ~200+（含 pandas/scipy/sklearn/duckdb/matplotlib/numpy 等） | ~60 |
| pip freeze 行数 | ~200+ | 55 |
| 重型包 | pandas, scipy, scikit-learn, duckdb, matplotlib, numpy 均内嵌 | 0 重型包 ✅ |

定性结论：Tier 0 不含任何重型包，bundle 体积显著小于全量预装（重型包由首次 bootstrap 安装到 `~/.vibe-trading/venv`）。
