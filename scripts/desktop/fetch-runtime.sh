#!/usr/bin/env bash
# scripts/desktop/fetch-runtime.sh
# 下载 python-build-standalone (install_only) 并解压到指定目录。
#
# 用法:
#   bash scripts/desktop/fetch-runtime.sh [输出目录]
#
# 版本/asset 可用环境变量覆盖（均可选，不设则用默认值）:
#   PBS_TAG   python-build-standalone release tag（默认 20260610）
#   PBS_PY    对应的 CPython 版本号，与 PBS_TAG 配套（默认 3.12.13）
#   PBS_ASSET 完整 asset 文件名；设置后忽略下面的架构推断（用于自定义/其他平台）
#
# 不设 PBS_ASSET 时按 (uname -sm) 自动选择 install_only asset（默认 tag 下）:
#   macOS arm64  → cpython-3.12.13+20260610-aarch64-apple-darwin-install_only.tar.gz
#   macOS x86_64 → cpython-3.12.13+20260610-x86_64-apple-darwin-install_only.tar.gz
#   linux x86_64 → cpython-3.12.13+20260610-x86_64-unknown-linux-gnu-install_only.tar.gz
#   linux arm64  → cpython-3.12.13+20260610-aarch64-unknown-linux-gnu-install_only.tar.gz
set -euo pipefail

PBS_TAG="${PBS_TAG:-20260610}"
PBS_PY="${PBS_PY:-3.12.13}"
if [ -z "${PBS_ASSET:-}" ]; then
    case "$(uname -sm)" in
        "Darwin arm64")  PBS_ASSET="cpython-${PBS_PY}+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz" ;;
        "Darwin x86_64") PBS_ASSET="cpython-${PBS_PY}+${PBS_TAG}-x86_64-apple-darwin-install_only.tar.gz" ;;
        "Linux x86_64")  PBS_ASSET="cpython-${PBS_PY}+${PBS_TAG}-x86_64-unknown-linux-gnu-install_only.tar.gz" ;;
        "Linux aarch64") PBS_ASSET="cpython-${PBS_PY}+${PBS_TAG}-aarch64-unknown-linux-gnu-install_only.tar.gz" ;;
        *)
            printf '未支持的平台 "%s"；请显式设置 PBS_ASSET 环境变量。\n' "$(uname -sm)" >&2
            exit 1
            ;;
    esac
fi

OUT_DIR="${1:-./.desktop-build/python-runtime}"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_ASSET}"

mkdir -p "$(dirname "$OUT_DIR")"
tmp="$(mktemp -d)"
echo "Downloading $URL"
# 不用 -s（静默）：python-build-standalone runtime ~24MB，对 GitHub release assets
# 拉取较慢；静默会让用户以为脚本卡住。显示进度条 + 连接超时(防 IPv6 hang) + 自动重试。
curl -fL --progress-bar --connect-timeout 30 --retry 3 "$URL" -o "$tmp/runtime.tar.gz"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
# install_only 解包后顶层是 python/, 展平到 OUT_DIR
tar -xzf "$tmp/runtime.tar.gz" -C "$tmp"
mv "$tmp/python/"* "$OUT_DIR/"
rm -rf "$tmp"
echo "Runtime ready at: $OUT_DIR"
"$OUT_DIR/bin/python3" --version
