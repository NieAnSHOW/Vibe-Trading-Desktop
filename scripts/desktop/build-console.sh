#!/usr/bin/env bash
# 构建 src-tauri/console-app/ 的 Vue 工程到 ../console-dist/。
# Tauri frontendDist 指向 console-dist,所以桌面打包前必须先跑这个。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT/src-tauri/console-app"

if [ ! -d "$APP_DIR" ]; then
  echo "[build-console] console-app 不存在,跳过" >&2
  exit 0
fi

echo "[build-console] 安装依赖并构建 console-app..."
cd "$APP_DIR"
npm ci
npm run build

echo "[build-console] 校验 console 版本锚点..."
cd "$ROOT"
node scripts/desktop/console-version.mjs --check

echo "[build-console] 完成"
