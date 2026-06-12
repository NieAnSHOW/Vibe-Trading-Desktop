#!/usr/bin/env bash
# scripts/desktop/serve-smoke.sh <runtime_dir>
# 用内嵌运行时启动 serve,轮询 /health,验证 SPA 资源可达,然后清理。
set -euo pipefail
RUNTIME="${1:?usage: serve-smoke.sh <runtime_dir>}"
PY="$RUNTIME/bin/python3"
PORT=8987
AGENT_DIR="$(cd "$(dirname "$0")/../../agent" && pwd)"

# 需先有 frontend/dist 才能验证 SPA;若无则提示
[ -d frontend/dist ] || { echo "frontend/dist missing — run 'cd frontend && npm run build' first"; exit 1; }

PYTHONPATH="$AGENT_DIR" PYTHONDONTWRITEBYTECODE=1 "$PY" \
  -c 'import cli, sys; raise SystemExit(cli.main(sys.argv[1:]))' \
  serve --host 127.0.0.1 --port "$PORT" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

START=$(date +%s)
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    ELAPSED=$(( $(date +%s) - START ))
    echo "OK /health reachable after ${i} tries (${ELAPSED}s)"
    curl -fsS "http://127.0.0.1:$PORT/" -o /dev/null && echo "OK SPA root served"
    exit 0
  fi
  sleep 0.5
done
echo "FAIL /health never became ready"; exit 1
