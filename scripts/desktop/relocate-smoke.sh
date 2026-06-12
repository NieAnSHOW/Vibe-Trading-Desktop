#!/usr/bin/env bash
# scripts/desktop/relocate-smoke.sh <runtime_dir>
# 复制运行时到一个全新随机路径(模拟不同安装目录/用户名), 在新路径跑导入冒烟。
set -euo pipefail
SRC="${1:?usage: relocate-smoke.sh <runtime_dir>}"
DEST="$(mktemp -d)/relocated-runtime"
echo "Relocating $SRC -> $DEST"
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
"$DEST/bin/python3" "$(dirname "$0")/smoke_imports.py"
