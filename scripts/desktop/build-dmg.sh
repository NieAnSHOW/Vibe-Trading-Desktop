#!/usr/bin/env bash
# scripts/desktop/build-dmg.sh
#
# 完整构建 macOS .dmg 安装包的端到端脚本。
#
# 作用范围：
#   1. 校验前置工具链（cargo, npm, iconutil, sips）
#   2. 校验 .desktop-build/ 资源就绪（python-runtime / agent / .env / VERSION）
#   3. 重新构建前端 dist（npm run build）
#   4. 调用 `cargo tauri build` 编译 Rust release + 生成 .app / .dmg
#   5. 冒烟检查：.app 可执行位、icon.icns 大小、.dmg 产物存在
#   6. 输出产物路径与体积摘要
#
# 用法：
#   bash scripts/desktop/build-dmg.sh              # 标准构建
#   bash scripts/desktop/build-dmg.sh --skip-frontend   # 跳过前端构建（dist 已就绪时）
#   bash scripts/desktop/build-dmg.sh --no-smoke        # 跳过冒烟检查
#
# 前置条件：
#   - 已运行 scripts/desktop/fetch-runtime.sh + install-deps.sh（生成 .desktop-build/python-runtime）
#   - 已运行 scripts/desktop/assemble.sh（生成 .desktop-build/agent, .env, VERSION）
#   - 或直接运行本脚本会自动调用 assemble.sh 兜底
#
# 退出码：
#   0 成功 / 1 工具缺失 / 2 资源缺失 / 3 构建失败 / 4 冒烟失败 / 5 签名/公证失败

set -euo pipefail

# ── 路径与颜色 ───────────────────────────────────────────────
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_TAURI="$ROOT/src-tauri"
BUILD="$ROOT/.desktop-build"

# 颜色输出（非 TTY 时自动禁用）
if [ -t 1 ]; then
    C_RESET='\033[0m'; C_BOLD='\033[1m'; C_GREEN='\033[32m'
    C_YELLOW='\033[33m'; C_RED='\033[31m'; C_BLUE='\033[34m'
else
    C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BLUE=''
fi

log()  { printf "${C_BLUE}▸${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn() { printf "${C_YELLOW}!${C_RESET} %s\n" "$*" >&2; }
err()  { printf "${C_RED}✗${C_RESET} %s\n" "$*" >&2; }
section() { printf "\n${C_BOLD}${C_BLUE}━━━ %s ━━━${C_RESET}\n" "$*"; }

# ── 参数解析 ─────────────────────────────────────────────────
SKIP_FRONTEND=0
SKIP_SMOKE=0
for arg in "$@"; do
    case "$arg" in
        --skip-frontend) SKIP_FRONTEND=1 ;;
        --no-smoke)      SKIP_SMOKE=1 ;;
        --help|-h)
            sed -n '2,28p' "$0"
            exit 0 ;;
        *) err "未知参数: $arg"; exit 1 ;;
    esac
done

# ── 平台守卫 ─────────────────────────────────────────────────
section "平台检查"
if [ "$(uname)" != "Darwin" ]; then
    err "本脚本仅用于 macOS。Windows 请使用 cargo tauri build 或对应 .ps1 脚本。"
    exit 1
fi
ARCH="$(uname -m)"
ok "macOS $ARCH"

# ── 工具链校验 ───────────────────────────────────────────────
section "工具链校验"
missing=0
check_tool() {
    if command -v "$1" >/dev/null 2>&1; then
        ok "$1 → $(command -v "$1")"
    else
        err "$1 未安装"
        missing=1
    fi
}
check_tool cargo
check_tool npm
check_tool iconutil    # macOS 自带
check_tool sips        # macOS 自带

# tauri CLI（cargo 子命令）
if cargo tauri --version >/dev/null 2>&1; then
    ok "tauri-cli → $(cargo tauri --version 2>&1 | head -1)"
else
    err "tauri-cli 未安装（运行: cargo install tauri-cli --version '^2'）"
    missing=1
fi

[ "$missing" -ne 0 ] && { err "工具链不完整，请先安装缺失项"; exit 1; }

# ── 资源校验 ─────────────────────────────────────────────────
section ".desktop-build 资源检查"
PY_RUNTIME="$BUILD/python-runtime/bin/python3"

verify_resource() {
    if [ -e "$1" ]; then ok "$2"; else err "缺失: $2 ($1)"; return 1; fi
}

resources_ok=1
verify_resource "$PY_RUNTIME"        "python-runtime"    || resources_ok=0
verify_resource "$BUILD/agent"       "agent 代码模板"    || resources_ok=0
verify_resource "$BUILD/agent/.env"  "agent .env 种子"   || resources_ok=0
verify_resource "$BUILD/VERSION"     "VERSION 标记"      || resources_ok=0

if [ "$resources_ok" -ne 1 ]; then
    warn ".desktop-build 资源不全，尝试调用 assemble.sh 兜底组装…"
    if [ -x "$ROOT/scripts/desktop/assemble.sh" ]; then
        # assemble.sh 内部会校验 runtime，runtime 缺失时它自己会报错退出
        if ! bash "$ROOT/scripts/desktop/assemble.sh"; then
            err "assemble.sh 失败。请先运行："
            err "  bash scripts/desktop/fetch-runtime.sh"
            err "  bash scripts/desktop/install-deps.sh .desktop-build/python-runtime"
            err "  bash scripts/desktop/assemble.sh"
            exit 2
        fi
        ok "assemble.sh 完成，重新校验资源"
        resources_ok=1
        verify_resource "$PY_RUNTIME"        "python-runtime"    || resources_ok=0
        verify_resource "$BUILD/agent"       "agent 代码模板"    || resources_ok=0
        verify_resource "$BUILD/agent/.env"  "agent .env 种子"   || resources_ok=0
        verify_resource "$BUILD/VERSION"     "VERSION 标记"      || resources_ok=0
        [ "$resources_ok" -ne 1 ] && { err "assemble 后仍缺资源"; exit 2; }
    else
        err "找不到 scripts/desktop/assemble.sh，无法兜底"
        exit 2
    fi
fi

section "刷新桌面资源模板"
log "bash scripts/desktop/assemble.sh"
if ! bash "$ROOT/scripts/desktop/assemble.sh"; then
    err "assemble.sh 失败。请先确认 python-runtime 已准备好。"
    exit 2
fi
ok "agent / frontend / VERSION 资源模板已刷新"

PY_VER="$("$PY_RUNTIME" --version 2>&1)"
ok "运行时: $PY_VER"

section "嵌入式 Python 冒烟检查 (Tier 0)"
log "PYTHONPATH=agent $PY_RUNTIME scripts/desktop/smoke_tier0.py"
( cd "$ROOT" && PYTHONPATH=agent "$PY_RUNTIME" scripts/desktop/smoke_tier0.py ) || {
    err "嵌入式 Python Tier 0 冒烟检查失败，请重新运行 install-deps.sh"
    exit 2
}
ok "嵌入式 Python Tier 0 冒烟检查通过"

# ── 强制刷新 VERSION 标记 ─────────────────────────────────────
# 每次构建必须生成唯一 VERSION，否则 runtime_dir::prepare() 会因版本
# 匹配而跳过 frontend/dist 刷新（Action::Reuse），导致新版客户端显示旧 UI。
section "刷新 VERSION 标记"
if [ -n "${DESKTOP_RELEASE_VERSION:-}" ]; then
    VERSION_NEW="$DESKTOP_RELEASE_VERSION"
else
    VERSION_NEW="$(cd "$ROOT" && git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
fi
echo "$VERSION_NEW" > "$BUILD/VERSION"
ok "VERSION → $VERSION_NEW"

# ── 前端构建 ─────────────────────────────────────────────────
if [ "$SKIP_FRONTEND" -eq 1 ]; then
    section "前端构建（已跳过）"
    warn "--skip-frontend：使用现有 frontend/dist"
    [ -f "$ROOT/frontend/dist/index.html" ] || { err "frontend/dist 不存在，无法跳过"; exit 2; }
else
    section "前端构建 (npm run build)"
    log "cd frontend && npm run build"
    ( cd "$ROOT/frontend" && npm run build ) || { err "前端构建失败"; exit 3; }
    ok "frontend/dist 构建完成"
fi

# ── Tauri 编译 + 打包 ────────────────────────────────────────
section "Tauri build (cargo tauri build)"
log "开始编译 Rust release 并打包 .app / .dmg（首次约 1-3 分钟）"
BUILD_START=$(date +%s)

( cd "$SRC_TAURI" && cargo tauri build ) || { err "cargo tauri build 失败"; exit 3; }

BUILD_END=$(date +%s)
ok "构建完成，耗时 $((BUILD_END - BUILD_START))s"

# ── 定位产物 ─────────────────────────────────────────────────
BUNDLE_DIR="$SRC_TAURI/target/release/bundle"
APP_PATH="$BUNDLE_DIR/macos/Vibe Trading.app"
DMG_DIR="$BUNDLE_DIR/dmg"
DMG_PATH="$(ls -1 "$DMG_DIR"/*.dmg 2>/dev/null | head -1 || true)"

if [ -z "$DMG_PATH" ] || [ ! -f "$DMG_PATH" ]; then
    err "未找到 .dmg 产物（预期位置: $DMG_DIR/）"
    exit 3
fi
ok ".app → $APP_PATH"
ok ".dmg → $DMG_PATH"

# ── 冒烟检查 ─────────────────────────────────────────────────
if [ "$SKIP_SMOKE" -eq 0 ]; then
    section "冒烟检查"

    # 1) .app 主可执行位
    APP_BIN="$APP_PATH/Contents/MacOS/vibe-trading-desktop"
    if [ -x "$APP_BIN" ]; then
        ok "主可执行文件存在且有执行位"
    else
        err "主可执行文件缺失或不可执行: $APP_BIN"
        exit 4
    fi

    # 2) 内嵌图标体积（占位符 icns 约 117 字节；规范版本应为 MB 级）
    APP_ICNS="$APP_PATH/Contents/Resources/icon.icns"
    if [ -f "$APP_ICNS" ]; then
        ICNS_SIZE=$(stat -f%z "$APP_ICNS" 2>/dev/null || stat -c%s "$APP_ICNS" 2>/dev/null)
        if [ "$ICNS_SIZE" -gt 100000 ]; then
            ok "icon.icns ($ICNS_SIZE bytes) — 符合规范"
        else
            warn "icon.icns 仅 $ICNS_SIZE bytes — 疑似占位符，请检查图标生成"
        fi
    else
        err "icon.icns 缺失"
        exit 4
    fi

    # 3) Info.plist 图标引用
    if grep -q "CFBundleIconFile" "$APP_PATH/Contents/Info.plist" 2>/dev/null; then
        ok "Info.plist 已声明 CFBundleIconFile"
    else
        warn "Info.plist 未找到 CFBundleIconFile"
    fi

    # 4) 打包资源齐全（python-runtime / agent / frontend dist）
    RES="$APP_PATH/Contents/Resources"
    for r in python-runtime agent frontend/dist; do
        if [ -e "$RES/$r" ]; then ok "resource ✓ $r"; else err "resource ✗ $r 缺失"; exit 4; fi
    done

    ok "冒烟检查全部通过"
fi

# ── 签名 + 公证（可选）──────────────────────────────────────
# 检测到 APPLE_SIGNING_IDENTITY 即走完整 Developer ID 签名 + notarization；
# 否则产物保持 ad-hoc 签名 —— 经浏览器下载分发到其他 Mac 会报"已损坏"。
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
    section "签名 + 公证 (Developer ID)"
    log "bash scripts/desktop/sign-and-notarize.sh"
    if ! bash "$ROOT/scripts/desktop/sign-and-notarize.sh"; then
        err "签名/公证失败"
        exit 5
    fi
    ok "签名 + 公证完成"
else
    warn "未设置 APPLE_SIGNING_IDENTITY — 产物未签名/未公证（MVP 默认模式）。"
    log "分发提示：用户从浏览器下载 DMG 后双击会报『已损坏』，请在 Release 说明里提供："
    printf '    xattr -cr "/Applications/Vibe Trading.app"\n'
    log "完整安装说明见 docs/desktop/README.md；购入 Apple 开发者账号后配置证书即可一键启用签名公证。"
fi

# ── 摘要 ─────────────────────────────────────────────────────
section "构建摘要"

DMG_SIZE_HUMAN=$(du -h "$DMG_PATH" | cut -f1)
DMG_SIZE_BYTES=$(stat -f%z "$DMG_PATH" 2>/dev/null || stat -c%s "$DMG_PATH" 2>/dev/null)
VERSION="$(cat "$BUILD/VERSION" 2>/dev/null || echo unknown)"
GIT_SHA="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo n/a)"

printf "${C_BOLD}产物:${C_RESET}\n"
printf "  .dmg    : %s\n" "$DMG_PATH"
printf "  .app    : %s\n" "$APP_PATH"
printf "  大小    : %s (%s bytes)\n" "$DMG_SIZE_HUMAN" "$DMG_SIZE_BYTES"
printf "  版本标记: %s\n" "$VERSION"
printf "  Git SHA : %s\n" "$GIT_SHA"
printf "\n${C_GREEN}${C_BOLD}✓ 构建成功${C_RESET}\n"
printf "打开安装:\n  open \"%s\"\n" "$DMG_PATH"
