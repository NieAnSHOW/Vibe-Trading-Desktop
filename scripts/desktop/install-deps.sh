#!/usr/bin/env bash
# scripts/desktop/install-deps.sh [runtime_dir]
# 把 Tier 0 最小核心(requirements-tier0.txt)装进内嵌运行时的 site-packages。
# 重型依赖(pandas/scipy/...)不再进 bundle,改由首次运行 vibe-trading bootstrap
# 装到 ~/.vibe-trading/venv(设计三层依赖 / python-runtime-bundling delta)。
#
# 用法:
#   bash scripts/desktop/install-deps.sh                       # runtime_dir 默认 .desktop-build/python-runtime
#   bash scripts/desktop/install-deps.sh <runtime_dir>         # 指定其它 runtime 目录
set -euo pipefail
RUNTIME_DIR="${1:-./.desktop-build/python-runtime}"
PY="$RUNTIME_DIR/bin/python3"
# 基于脚本自身位置定位，避免依赖调用方 CWD（build-dmg.sh / CI 可能从任意目录调用）
REQ_SRC="$(cd "$(dirname "$0")" && pwd)/requirements-tier0.txt"

# runtime 未就绪时给清晰引导，而不是让下游 uv 报晦涩错误
[ -x "$PY" ] || { echo "runtime 未就绪: $PY 不存在；请先运行 bash scripts/desktop/fetch-runtime.sh" >&2; exit 1; }

command -v uv >/dev/null 2>&1 || { echo "uv not found; install via 'pip install uv' or astral installer"; exit 1; }

echo "Installing Tier 0 core deps into embedded runtime (heavy deps deferred to venv bootstrap)"
uv pip install --python "$PY" -r "$REQ_SRC"
echo "Done. Installed packages:"
"$PY" -m pip list 2>/dev/null | head -40 || true

echo "Running Tier 0 smoke checks (serve entry-chain importable, no heavy pkgs)"
PYTHONPATH=agent "$PY" scripts/desktop/smoke_tier0.py
