#!/usr/bin/env bash
# scripts/desktop/install-deps.sh <runtime_dir>
# 只把 Tier 0 最小核心(requirements-tier0.txt)装进内嵌运行时的 site-packages。
# 重型依赖(pandas/scipy/...)不再进 bundle,改由首次运行 vibe-trading bootstrap
# 装到 ~/.vibe-trading/venv(设计三层依赖 / python-runtime-bundling delta)。
set -euo pipefail
RUNTIME_DIR="${1:?usage: install-deps.sh <runtime_dir>}"
PY="$RUNTIME_DIR/bin/python3"
REQ_SRC="scripts/desktop/requirements-tier0.txt"

command -v uv >/dev/null 2>&1 || { echo "uv not found; install via 'pip install uv' or astral installer"; exit 1; }

echo "Installing Tier 0 core deps into embedded runtime (heavy deps deferred to venv bootstrap)"
uv pip install --python "$PY" -r "$REQ_SRC"
echo "Done. Installed packages:"
"$PY" -m pip list 2>/dev/null | head -40 || true

echo "Running Tier 0 smoke checks (serve entry-chain importable, no heavy pkgs)"
PYTHONPATH=agent "$PY" scripts/desktop/smoke_tier0.py
