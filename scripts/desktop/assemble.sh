#!/usr/bin/env bash
# scripts/desktop/assemble.sh
# 组装桌面打包资源到 .desktop-build/(供 tauri resources 引用)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$ROOT/.desktop-build"
RUNTIME="$BUILD/python-runtime"

# 1) 前端构建(复用现有 npm run build,不改前端)
echo "=== Building frontend ==="
( cd "$ROOT/frontend" && npm ci && npm run build )

# 2) 运行时须已由 fetch-runtime.sh + install-deps.sh 准备好
echo "=== Checking runtime ==="
[ -x "$RUNTIME/bin/python3" ] || { echo "runtime missing; run fetch-runtime.sh + install-deps.sh first"; exit 1; }

# 3) 裁剪运行时 site-packages 体积(测试 / 缓存 / dist-info 元数据)
echo "=== Trimming runtime ==="
find "$RUNTIME" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$RUNTIME" -type d -name "tests" -prune -exec rm -rf {} + 2>/dev/null || true
find "$RUNTIME" -type d -name "test" -prune -exec rm -rf {} + 2>/dev/null || true
# 不删除 *.dist-info (pip/uv 需要它们来管理包)

# 4) 准备 agent 代码模板:复制后删除数据目录,保证 bundle 模板永不含用户数据
echo "=== Preparing agent template ==="
rm -rf "$BUILD/agent"
mkdir -p "$BUILD/agent"
cp -R "$ROOT/agent/." "$BUILD/agent/"
for d in runs sessions uploads .swarm; do rm -rf "$BUILD/agent/$d"; done
find "$BUILD/agent" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$BUILD/agent/tests"

# 5) .env 种子:若仓库 agent/.env 不存在,用 agent/.env.example 兜底(不含真密钥)
echo "=== Preparing .env seed ==="
if [ -f "$ROOT/agent/.env" ]; then cp "$ROOT/agent/.env" "$BUILD/agent/.env";
elif [ -f "$ROOT/agent/.env.example" ]; then cp "$ROOT/agent/.env.example" "$BUILD/agent/.env";
else : > "$BUILD/agent/.env"; fi

# 6) VERSION 标记(取 git short sha + 构建时间戳，确保每次构建都触发前端刷新)
echo "=== Creating VERSION marker ==="
VERSION_MARKER="$(cd "$ROOT" && git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
printf '%s\n' "$VERSION_MARKER" > "$BUILD/VERSION"

echo "=== Assembly complete ==="
echo "Contents of $BUILD:"
du -sh "$BUILD"/*
