#!/usr/bin/env bash
# scripts/desktop/upload-release.sh
#
# 将本地构建产物上传到 GitHub Release（幂等：release 已存在则覆盖同名资产）。
#
# 用法：
#   bash scripts/desktop/upload-release.sh                    # 版本取 src-tauri/tauri.conf.json，自动发现产物
#   bash scripts/desktop/upload-release.sh v0.1.15            # 指定版本
#   bash scripts/desktop/upload-release.sh v0.1.15 文件1 [文件2…]  # 指定产物路径
#
# 产物自动发现（未显式传入时）：
#   src-tauri/target/release/bundle/dmg/*.dmg     （macOS，build-dmg.sh）
#   src-tauri/target/release/bundle/nsis/*.exe    （Windows，build-windows.ps1）
#   src-tauri/target/release/bundle/nsis/*.msi
#
# 行为：
#   - 仓库固定为 git remote origin，避免 gh 默认仓库指到上游 fork
#   - release 不存在时创建：标题 "Trading Worker vX.Y.Z"，notes 取 CHANGELOG.md 对应
#     小节，取不到则回退 --generate-notes；tag 必须已推送到远端（--verify-tag）
#   - 资产重名直接覆盖（--clobber），可安全重复执行
#
# Windows：在 Git Bash（git for Windows 自带）中运行；需已安装 gh 并 gh auth login。
#
# 退出码：0 成功 / 1 前置缺失 / 2 无产物 / 3 上传或创建失败

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

log()  { printf '▸ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
err()  { printf '✗ %s\n' "$*" >&2; }

# ── 版本 ─────────────────────────────────────────────────────
VER="${1:-}"
if [ -z "$VER" ]; then
    command -v node >/dev/null 2>&1 \
        || { err "未指定版本且无 node，无法从 tauri.conf.json 读取；用法: $0 vX.Y.Z"; exit 1; }
    VER="$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")"
fi
VER="${VER#v}"
TAG="v$VER"
log "版本: $TAG"

# ── 仓库：固定 origin，避免 gh 默认仓库漂移到上游 fork ────────
REPO="$(git -C "$ROOT" remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')"
case "$REPO" in
    */*) ;;
    *)  err "无法从 origin 解析 GitHub 仓库: $REPO"; exit 1 ;;
esac
log "仓库: $REPO"

# ── 前置检查 ─────────────────────────────────────────────────
command -v gh >/dev/null 2>&1 || { err "未安装 gh CLI（https://cli.github.com/）"; exit 1; }
gh auth status >/dev/null 2>&1 || { err "gh 未登录，先执行: gh auth login"; exit 1; }

# ── 产物收集 ─────────────────────────────────────────────────
FILES=()
if [ "$#" -ge 2 ]; then
    for f in "${@:2}"; do
        [ -f "$f" ] || { err "产物不存在: $f"; exit 2; }
        FILES+=("$f")
    done
else
    BUNDLE="$ROOT/src-tauri/target/release/bundle"
    for f in "$BUNDLE"/dmg/*.dmg "$BUNDLE"/nsis/*.exe "$BUNDLE"/nsis/*.msi; do
        [ -e "$f" ] && FILES+=("$f")
    done
fi
[ "${#FILES[@]}" -gt 0 ] || {
    err "未发现安装包产物；先运行 build-dmg.sh / build-windows.ps1，或显式传入路径"
    exit 2
}
for f in "${FILES[@]}"; do
    log "产物: $(basename "$f") ($(du -h "$f" | cut -f1))"
done

# ── 上传 / 创建 release ──────────────────────────────────────
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
    log "release 已存在，覆盖上传资产"
    gh release upload "$TAG" "${FILES[@]}" -R "$REPO" --clobber \
        || { err "上传失败"; exit 3; }
else
    NOTES="$(awk -v ver="$VER" '
        $0 ~ "^## \\[" ver "\\]" { capture = 1; next }
        capture && /^## \[/ { exit }
        capture { print }
    ' "$ROOT/CHANGELOG.md" 2>/dev/null || true)"
    log "release 不存在，创建（tag 需已推送远端）"
    if [ -n "$NOTES" ]; then
        gh release create "$TAG" "${FILES[@]}" -R "$REPO" \
            --verify-tag --title "Trading Worker $TAG" --notes "$NOTES" \
            || { err "创建失败"; exit 3; }
    else
        log "CHANGELOG 未找到 [$VER] 小节，使用 --generate-notes"
        gh release create "$TAG" "${FILES[@]}" -R "$REPO" \
            --verify-tag --title "Trading Worker $TAG" --generate-notes \
            || { err "创建失败"; exit 3; }
    fi
fi

ok "完成: https://github.com/$REPO/releases/tag/$TAG"
