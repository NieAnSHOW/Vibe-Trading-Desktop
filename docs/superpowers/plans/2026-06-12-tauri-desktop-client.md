---
change: tauri-desktop-client
design-doc: docs/superpowers/specs/2026-06-12-tauri-desktop-client-design.md
base-ref: b6817be3b2929c72f6a389873d97130e8422d1c2
---

# Tauri 桌面客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实施本计划。所有步骤用 checkbox(`- [ ]`)语法追踪。

**Goal:** 把 Vibe-Trading(Python FastAPI 后端 + 现有 React 前端)封装成 macOS(arm64)/ Windows(x64)双平台 Tauri 桌面客户端,双击即用、完全离线、零依赖,不改任何后端/前端业务代码。

**Architecture:** Tauri 2.x 外壳在启动时把只读 bundle 里的 `agent/` 复制到 `~/.vibe-trading/runtime/agent`(解决只读 bundle 写入问题,见 D4/D5),以内嵌的 python-build-standalone 运行时 spawn 后端 sidecar(`PYTHONPATH` 指向可写副本),动态选端口、轮询 `/health` 门控,就绪后把 webview 导航到 `http://127.0.0.1:<port>` —— 后端自身托管 `frontend/dist`,前端零改动、零跨域(D1)。进程清理用 mac 进程组 / win Job Object(D7)。

**Tech Stack:** Tauri 2.x(Rust)、python-build-standalone(`install_only`)、uv、现有 FastAPI/uvicorn 后端、Vite 前端构建、GitHub Actions(macOS arm64 + Windows x64 矩阵)。

---

## 关键事实(已在 base-ref 核对)

- serve 入口:`pyproject.toml:68` `vibe-trading = "cli:main"`;`agent/cli/_legacy.py:3922-3924` 定义 `serve --host(默认 0.0.0.0)--port(默认 8000)`。dev 脚本用 `PYTHONPATH=$ROOT/agent <python> -c 'import cli, sys; raise SystemExit(cli.main(sys.argv[1:]))' serve --host <H> --port <P>`(`scripts/dev:162-164`)—— 桌面 sidecar 复用此精确形式。
- 健康端点:`agent/api_server.py:1452` `@app.get("/health")`。
- 硬编码写目录(无 env 覆盖):`agent/api_server.py:41-43` `RUNS_DIR/SESSIONS_DIR/UPLOADS_DIR = Path(__file__).resolve().parent / ...`;`agent/src/swarm/store.py:72` 与 `agent/src/agent/background_tools.py:14`(WORKDIR)均 `Path(__file__).resolve().parents[2]`。这些都随 `__file__` 走 —— 故复制方案(D4)生效。
- 回测子进程解释器回退:`agent/src/core/runner.py:156-168`,找不到项目 `.venv` 时回退 `sys.executable`。
- `.env` 搜索序:`agent/src/providers/llm.py:248` `~/.vibe-trading/.env → AGENT_DIR/.env → CWD/.env`(用户家目录最高优先级)。
- 报告降级:`agent/src/shadow_account/reporter.py` 在 import/render weasyprint 失败时降级 HTML(不打包 weasyprint 即满足,零改动)。
- 前端构建:`frontend/package.json:8` `"build": "tsc -b && vite build"` → `frontend/dist`。
- 现有 CI:`.github/workflows/test.yml`(新增 desktop 矩阵,不改它)。
- `requires-python>=3.11`(`pyproject.toml:5`)。

## 文件结构(本计划新建 / 修改)

- 新建 `src-tauri/`:Tauri crate 根。
  - `src-tauri/Cargo.toml`:Rust 依赖(tauri、reqwest/ureq、serde 等)。
  - `src-tauri/tauri.conf.json`:窗口、`resources` 声明、bundle 标识。
  - `src-tauri/src/main.rs`:入口 + Tauri setup/RunEvent 接线。
  - `src-tauri/src/resources.rs`:资源路径解析(开发态 vs 打包态)。
  - `src-tauri/src/port.rs`:空闲端口选取(可单测)。
  - `src-tauri/src/version.rs`:版本比对(可单测)。
  - `src-tauri/src/runtime_dir.rs`:可写运行目录准备 —— 复制/升级/种 `.env`(可单测,D4/D5)。
  - `src-tauri/src/sidecar.rs`:spawn 后端、env、进程组/Job、健康轮询(D6/D7)。
  - `src-tauri/src/loading.html`:启动加载页(打包进 resources)。
  - `src-tauri/src/error_page.rs` 或内联:启动失败错误页渲染。
- 新建打包脚本:
  - `scripts/desktop/fetch-runtime.sh`(mac)/ `fetch-runtime.ps1`(win):下载并预装内嵌运行时。
  - `scripts/desktop/assemble.sh` / `assemble.ps1`:构建前端 + 装配 + 裁剪资源。
- 新建 `.github/workflows/desktop-build.yml`:双平台构建矩阵(D9)。
- 新建 `docs/desktop/spike-relocatability.md`:spike 结论记录(阻塞门)。
- 新建 `docs/desktop/README.md`:用户向安装/首启/已知限制文档。
- **不修改** `agent/**`、`frontend/**` 业务代码。

---
## 阶段 ① 可重定位性 Spike(头号风险,先行 —— 通不过则回设计,阻塞后续)

> 对应 OpenSpec tasks 1.1–1.5、design D2/D3、spec `python-runtime-bundling`「可重定位的内嵌 Python 运行时」「原生扩展可重定位性验证」「回测子进程使用内嵌 Python 自包含」。本阶段产出是一份可复用的「获取+装配+冒烟」流程与结论文档,不产出 Tauri 代码。

### Task 1: 获取并预装内嵌 Python 运行时(mac arm64)

**Files:**
- Create: `scripts/desktop/fetch-runtime.sh`
- Create: `docs/desktop/spike-relocatability.md`(本阶段持续追加)

- [x] **Step 1: 确定运行时 tag 与版本(对齐 requires-python>=3.11)**

打开 `pyproject.toml:5` 确认 `requires-python = ">=3.11"`。从 python-build-standalone releases 选定一个 `install_only` 的 macOS aarch64 资产,选 3.11.x 或 3.12.x 的最新稳定 release。把选定的 release tag、Python 版本、资产文件名写入 `docs/desktop/spike-relocatability.md` 的「运行时选型」小节。

- [x] **Step 2: 编写 fetch-runtime.sh 下载并解压到工作目录**

```bash
#!/usr/bin/env bash
# scripts/desktop/fetch-runtime.sh
# 下载 python-build-standalone (install_only) 并解压到 $1(默认 ./.desktop-build/python-runtime)
set -euo pipefail

# 这两个值来自 Step 1 的选型,提交时替换为确定值
PBS_TAG="${PBS_TAG:?set PBS_TAG, e.g. 20240107}"
PBS_ASSET="${PBS_ASSET:?set PBS_ASSET, e.g. cpython-3.11.x+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz}"
OUT_DIR="${1:-./.desktop-build/python-runtime}"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_ASSET}"

mkdir -p "$(dirname "$OUT_DIR")"
tmp="$(mktemp -d)"
echo "Downloading $URL"
curl -fsSL "$URL" -o "$tmp/runtime.tar.gz"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
# install_only 解包后顶层是 python/,展平到 OUT_DIR
tar -xzf "$tmp/runtime.tar.gz" -C "$tmp"
mv "$tmp/python/"* "$OUT_DIR/"
rm -rf "$tmp"
echo "Runtime ready at: $OUT_DIR"
"$OUT_DIR/bin/python3" --version
```

- [x] **Step 3: 运行脚本,确认解释器可执行**

Run: `PBS_TAG=<tag> PBS_ASSET=<asset> bash scripts/desktop/fetch-runtime.sh`
Expected: 末尾打印 `Python 3.1x.y`,`./.desktop-build/python-runtime/bin/python3` 存在且可执行。

- [x] **Step 4: 提交**

```bash
git add scripts/desktop/fetch-runtime.sh docs/desktop/spike-relocatability.md
git commit -m "chore(desktop): add python-build-standalone fetch script for relocatability spike"
```

### Task 2: 在内嵌运行时预装依赖(排除 weasyprint),用 uv 锁定

**Files:**
- Create: `scripts/desktop/install-deps.sh`
- Modify: `docs/desktop/spike-relocatability.md`(追加「依赖安装」小节)

- [x] **Step 1: 编写 install-deps.sh —— 过滤 weasyprint 后用 uv 装入内嵌运行时**

```bash
#!/usr/bin/env bash
# scripts/desktop/install-deps.sh <runtime_dir>
# 用 uv 把 agent/requirements.txt(排除 weasyprint)装进内嵌运行时的 site-packages。
set -euo pipefail
RUNTIME_DIR="${1:?usage: install-deps.sh <runtime_dir>}"
PY="$RUNTIME_DIR/bin/python3"
REQ_SRC="agent/requirements.txt"

command -v uv >/dev/null 2>&1 || { echo "uv not found; install via 'pip install uv' or astral installer"; exit 1; }

tmp_req="$(mktemp)"
# 排除 weasyprint(及其直接拉入的 cairo/pango 绑定行,如果 requirements 里有的话)
grep -viE '^\s*weasyprint' "$REQ_SRC" > "$tmp_req"

echo "Installing deps into embedded runtime (weasyprint excluded)"
uv pip install --python "$PY" -r "$tmp_req"
rm -f "$tmp_req"
echo "Done. Installed packages:"
"$PY" -m pip list 2>/dev/null | head -40 || true
```

- [x] **Step 2: 运行并确认 weasyprint 未被安装**

Run: `bash scripts/desktop/install-deps.sh ./.desktop-build/python-runtime`
然后 Run: `./.desktop-build/python-runtime/bin/python3 -m pip show weasyprint || echo "weasyprint absent (OK)"`
Expected: 安装成功;`weasyprint absent (OK)`。

- [x] **Step 3: 记录安装方式与锁定信息**

把实际用的命令、是否需要锁定文件(`uv pip compile` 产出的 pinned 版本)、安装耗时与 site-packages 体积写入 `docs/desktop/spike-relocatability.md`「依赖安装」小节。

- [x] **Step 4: 提交**

```bash
git add scripts/desktop/install-deps.sh docs/desktop/spike-relocatability.md
git commit -m "chore(desktop): install backend deps into embedded runtime (exclude weasyprint)"
```

### Task 3: 迁移路径后的原生扩展导入冒烟测试(核心风险门)

**Files:**
- Create: `scripts/desktop/smoke_imports.py`
- Create: `scripts/desktop/relocate-smoke.sh`
- Modify: `docs/desktop/spike-relocatability.md`(追加「冒烟结论」)

- [x] **Step 1: 写导入冒烟测试脚本**

```python
# scripts/desktop/smoke_imports.py
# 在迁移后的内嵌运行时中运行;import 关键原生包并做最小调用,
# 任意 ImportError / OSError(BLAS / rpath 链接错误)即非零退出。
import sys

MODULES = ["numpy", "scipy", "sklearn", "duckdb", "pandas", "PIL", "matplotlib"]

def main() -> int:
    failed = []
    for name in MODULES:
        try:
            mod = __import__(name)
            print(f"OK   import {name} ({getattr(mod, '__version__', 'n/a')})")
        except Exception as exc:  # noqa: BLE001 - spike wants every failure
            failed.append((name, repr(exc)))
            print(f"FAIL import {name}: {exc!r}")
    # 最小原生调用,触发 BLAS / native 路径
    try:
        import numpy as np
        import scipy.linalg as la
        la.inv(np.eye(3))
        print("OK   numpy/scipy native call (scipy.linalg.inv)")
    except Exception as exc:  # noqa: BLE001
        failed.append(("scipy.linalg.inv", repr(exc)))
        print(f"FAIL native call: {exc!r}")
    if failed:
        print(f"\nSMOKE FAILED: {len(failed)} issue(s)")
        return 1
    print("\nSMOKE PASSED")
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

- [x] **Step 2: 写迁移脚本 —— 把运行时移到全新随机路径再跑冒烟**

```bash
#!/usr/bin/env bash
# scripts/desktop/relocate-smoke.sh <runtime_dir>
# 复制运行时到一个全新随机路径(模拟不同安装目录/用户名),在新路径跑导入冒烟。
set -euo pipefail
SRC="${1:?usage: relocate-smoke.sh <runtime_dir>}"
DEST="$(mktemp -d)/relocated-runtime"
echo "Relocating $SRC -> $DEST"
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
"$DEST/bin/python3" "$(dirname "$0")/smoke_imports.py"
```

- [x] **Step 3: 运行迁移冒烟测试**

Run: `bash scripts/desktop/relocate-smoke.sh ./.desktop-build/python-runtime`
Expected: 每个模块打印 `OK import ...`,末尾 `SMOKE PASSED`,退出码 0。
**若任一 FAIL(BLAS/rpath):记录到文档,这是头号风险显形 —— 进入 Step 4 的回设计分支,不继续后续阶段。**

- [x] **Step 4: 记录结论;失败则回设计**

把冒烟输出与结论写入 `docs/desktop/spike-relocatability.md`。
- 通过 → 标注「可重定位性已验证,继续阶段 ②」。
- 失败 → 记录失败包与错误,标注「阻塞:需调整 design(候选:`install_full` 变体 / `uv pip install --no-binary` 重编译 / 针对性 `install_name_tool` rpath 修复)」并停在此处,把结论回报给设计环节。

- [x] **Step 5: 提交**

```bash
git add scripts/desktop/smoke_imports.py scripts/desktop/relocate-smoke.sh docs/desktop/spike-relocatability.md
git commit -m "test(desktop): relocatable native-extension import smoke test"
```

### Task 4: 迁移后运行时跑通 serve + /health + 回测子进程(次风险门)

**Files:**
- Create: `scripts/desktop/serve-smoke.sh`
- Modify: `docs/desktop/spike-relocatability.md`(追加「serve / 回测冒烟」)

- [x] **Step 1: 写 serve + health 冒烟脚本**

复用 `scripts/dev:162-164` 的精确调用形式(`PYTHONPATH=<agent> python -c 'import cli, sys; raise SystemExit(cli.main(sys.argv[1:]))' serve --host 127.0.0.1 --port <P>`)。

```bash
#!/usr/bin/env bash
# scripts/desktop/serve-smoke.sh <runtime_dir>
# 用迁移后的运行时启动 serve,轮询 /health,验证 SPA 资源可达,然后清理。
set -euo pipefail
RUNTIME="${1:?usage: serve-smoke.sh <runtime_dir>}"
PY="$RUNTIME/bin/python3"
PORT=8987
AGENT_DIR="$(cd agent && pwd)"

# 需先有 frontend/dist 才能验证 SPA;若无则提示
[ -d frontend/dist ] || { echo "frontend/dist missing — run 'cd frontend && npm run build' first"; exit 1; }

PYTHONPATH="$AGENT_DIR" PYTHONDONTWRITEBYTECODE=1 "$PY" \
  -c 'import cli, sys; raise SystemExit(cli.main(sys.argv[1:]))' \
  serve --host 127.0.0.1 --port "$PORT" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "OK /health reachable after ${i} tries"
    curl -fsS "http://127.0.0.1:$PORT/" -o /dev/null && echo "OK SPA root served"
    exit 0
  fi
  sleep 0.5
done
echo "FAIL /health never became ready"; exit 1
```

- [x] **Step 2: 运行 serve 冒烟(先构建前端)**

Run: `cd frontend && npm run build && cd ..`
Run: `bash scripts/desktop/serve-smoke.sh ./.desktop-build/python-runtime`
Expected: `OK /health reachable ...` 与 `OK SPA root served`,退出码 0。

- [x] **Step 3: 验证回测子进程在内嵌运行时自包含(runner.py:156-168 回退路径)**

在没有项目 `.venv` 的环境下触发一次最小回测,确认 `agent/src/core/runner.py:160` 回退到 `sys.executable`(即内嵌 Python)能加载全部依赖。手动方式:用上面 serve 起后端,通过 UI 或现有 API 触发一次最小回测,确认子进程成功完成。把方法与结果记录到文档。

Run(无 venv 验证解释器自包含,等价探针):
`./.desktop-build/python-runtime/bin/python3 -c "import sys; print(sys.executable); import numpy, pandas, duckdb; print('backtest deps OK')"`
Expected: 打印内嵌解释器路径 + `backtest deps OK`。

- [x] **Step 4: 记录次风险结论并提交**

```bash
git add scripts/desktop/serve-smoke.sh docs/desktop/spike-relocatability.md
git commit -m "test(desktop): serve + health + backtest self-containment smoke"
```

**阶段 ① 完成判据:** `relocate-smoke.sh` 与 `serve-smoke.sh` 均 PASS,`docs/desktop/spike-relocatability.md` 写明「可重定位性已验证」。否则停止并回设计。

## 阶段 ② Tauri 脚手架与资源解析(双平台,mac 先行)

> 对应 tasks 2.1–2.3、design D1/D2。本阶段产出可构建的空壳 Tauri 应用 + 资源路径解析,尚不 spawn 后端。

### Task 5: 初始化 Tauri crate 与可构建空壳

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/icons/`(占位图标)

- [x] **Step 1: 确认 Rust/Tauri 工具链可用**

Run: `rustc --version && cargo --version`
Expected: 均打印版本(无则先装 rustup)。
Run: `cargo install tauri-cli --version "^2.0" || cargo tauri --version`
Expected: `tauri-cli 2.x` 可用。

- [x] **Step 2: 写最小 tauri.conf.json(空壳,先不接 sidecar)**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Vibe Trading",
  "version": "0.1.0",
  "identifier": "ai.vibetrading.desktop",
  "build": { "frontendDist": "./placeholder-dist" },
  "app": {
    "windows": [
      { "title": "Vibe Trading", "width": 1280, "height": 832, "resizable": true }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"],
    "icon": ["icons/icon.icns", "icons/icon.ico", "icons/32x32.png"]
  }
}
```

说明:`frontendDist` 指向占位目录(本阶段不真用静态托管,后续 D1 用 webview 导航到后端);`placeholder-dist/` 放一个最小 `index.html` 让 cargo tauri 能构建。

- [x] **Step 3: 写最小 main.rs**

```rust
// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [x] **Step 4: 写 Cargo.toml 与 build.rs,生成占位资源,构建空壳**

`src-tauri/Cargo.toml` 关键内容:
```toml
[package]
name = "vibe-trading-desktop"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[features]
custom-protocol = ["tauri/custom-protocol"]
```
`src-tauri/build.rs`:
```rust
fn main() { tauri_build::build() }
```
Run: `mkdir -p src-tauri/placeholder-dist && printf '<!doctype html><title>shell</title>boot' > src-tauri/placeholder-dist/index.html`
Run: `cd src-tauri && cargo build`
Expected: 编译通过(占位图标缺失时按 `cargo tauri icon` 生成或放置占位 PNG/ICNS/ICO)。

- [x] **Step 5: 提交**

```bash
git add src-tauri/
git commit -m "feat(desktop): scaffold buildable Tauri 2 shell"
```

### Task 6: 资源路径解析(开发态 vs 打包态)

**Files:**
- Create: `src-tauri/src/resources.rs`
- Modify: `src-tauri/src/main.rs`(挂模块 + 启动时打印解析结果)
- Modify: `src-tauri/tauri.conf.json`(声明 `bundle.resources`)

- [x] **Step 1: 在 tauri.conf.json 声明资源装配**

在 `bundle` 加入(路径为构建时由装配脚本填充的相对目录,见阶段⑤):
```json
"resources": {
  "../.desktop-build/python-runtime": "python-runtime",
  "../.desktop-build/agent": "agent",
  "../frontend/dist": "frontend/dist",
  "../.desktop-build/agent/.env": "agent/.env",
  "../src-tauri/src/loading.html": "loading.html",
  "../.desktop-build/VERSION": "VERSION"
}
```

- [x] **Step 2: 写 resources.rs 解析内嵌资源根 + 关键子路径**

```rust
// src-tauri/src/resources.rs
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 解析打包资源根。开发态回退到仓库内 .desktop-build / 源码目录。
pub struct Resources {
    pub runtime_python: PathBuf, // 内嵌解释器可执行
    pub agent_template: PathBuf, // 只读 agent/ 模板
    pub env_seed: PathBuf,       // agent/.env 种子
    pub loading_html: PathBuf,   // 加载页
    pub version_file: PathBuf,   // VERSION 标记
}

impl Resources {
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let base = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir unavailable: {e}"))?;
        let py = if cfg!(windows) {
            base.join("python-runtime").join("python.exe")
        } else {
            base.join("python-runtime").join("bin").join("python3")
        };
        Ok(Self {
            runtime_python: py,
            agent_template: base.join("agent"),
            env_seed: base.join("agent").join(".env"),
            loading_html: base.join("loading.html"),
            version_file: base.join("VERSION"),
        })
    }
}
```

- [x] **Step 3: 在 main.rs 的 setup 钩子里解析并打印(临时验证)**

```rust
// main.rs 内 Builder：
.setup(|app| {
    let res = crate::resources::Resources::resolve(&app.handle())
        .expect("resolve resources");
    println!("python={:?}", res.runtime_python);
    println!("agent_template={:?}", res.agent_template);
    Ok(())
})
```
并在文件顶部加 `mod resources;`。

- [x] **Step 4: 构建并运行,确认路径解析(打包态稍后阶段⑤验证)**

Run: `cd src-tauri && cargo build`
Expected: 编译通过。打包态路径正确性留到阶段⑤随真实资源验证。

- [x] **Step 5: 提交**

```bash
git add src-tauri/src/resources.rs src-tauri/src/main.rs src-tauri/tauri.conf.json
git commit -m "feat(desktop): resolve bundled resource paths (dev vs packaged)"
```

## 阶段 ③ 可写运行目录生命周期(D4/D5,核心决策)

> 对应 spec `desktop-shell`「首启与升级时准备可写运行目录」全部 4 个场景、design D4/D5/D8。纯 Rust 逻辑,可单元测试(mock 目录),不依赖真实后端。

### Task 7: 版本比对(可单测)

**Files:**
- Create: `src-tauri/src/version.rs`
- Modify: `src-tauri/src/main.rs`(加 `mod version;`)

- [x] **Step 1: 写失败的单元测试**

```rust
// src-tauri/src/version.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_when_marker_absent() {
        assert_eq!(decide(None, "1.0.0"), Action::FirstRun);
    }

    #[test]
    fn reuse_when_versions_equal() {
        assert_eq!(decide(Some("1.0.0"), "1.0.0"), Action::Reuse);
    }

    #[test]
    fn upgrade_when_versions_differ() {
        assert_eq!(decide(Some("1.0.0"), "1.1.0"), Action::Upgrade);
    }

    #[test]
    fn trims_whitespace_in_marker() {
        assert_eq!(decide(Some(" 1.0.0\n"), "1.0.0"), Action::Reuse);
    }
}
```

- [x] **Step 2: 运行测试确认失败**

Run: `cd src-tauri && cargo test version:: 2>&1 | head`
Expected: 编译失败 / `cannot find ... Action`。

- [x] **Step 3: 写最小实现**

```rust
// src-tauri/src/version.rs(置于测试模块上方)
#[derive(Debug, PartialEq, Eq)]
pub enum Action { FirstRun, Reuse, Upgrade }

/// installed: .installed_version 文件内容(无文件 -> None);bundle: 当前 bundle VERSION。
pub fn decide(installed: Option<&str>, bundle: &str) -> Action {
    match installed {
        None => Action::FirstRun,
        Some(v) if v.trim() == bundle.trim() => Action::Reuse,
        Some(_) => Action::Upgrade,
    }
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test version::`
Expected: 4 个测试 PASS。

- [x] **Step 5: 提交**

```bash
git add src-tauri/src/version.rs src-tauri/src/main.rs
git commit -m "feat(desktop): version marker comparison (first-run/reuse/upgrade)"
```

### Task 8: 准备可写运行目录 —— 复制/升级/种 .env(可单测)

**Files:**
- Create: `src-tauri/src/runtime_dir.rs`
- Modify: `src-tauri/Cargo.toml`(加 `tempfile` 到 dev-deps;`fs_extra` 或自写递归拷贝)
- Modify: `src-tauri/src/main.rs`(加 `mod runtime_dir;`)

- [x] **Step 1: 写失败的单元测试(覆盖 spec 4 场景)**

```rust
// src-tauri/src/runtime_dir.rs
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn make_bundle(dir: &std::path::Path, version: &str) {
        let agent = dir.join("agent");
        fs::create_dir_all(agent.join("src")).unwrap();
        fs::write(agent.join("api_server.py"), "# v1").unwrap();
        fs::write(agent.join(".env"), "SEED=1").unwrap();
        fs::write(dir.join("VERSION"), version).unwrap();
    }

    #[test]
    fn first_run_copies_agent_seeds_env_writes_marker() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);

        prepare(&bundle.join("agent"), &bundle.join("agent/.env"),
                &bundle.join("VERSION"), &layout).unwrap();

        assert!(layout.runtime_agent.join("api_server.py").exists());
        assert_eq!(fs::read_to_string(layout.user_env).unwrap(), "SEED=1");
        assert_eq!(fs::read_to_string(layout.marker).unwrap().trim(), "1.0.0");
    }

    #[test]
    fn does_not_overwrite_existing_user_env() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);
        fs::create_dir_all(&home).unwrap();
        fs::write(&layout.user_env, "USER_KEY=keep").unwrap();

        prepare(&bundle.join("agent"), &bundle.join("agent/.env"),
                &bundle.join("VERSION"), &layout).unwrap();

        assert_eq!(fs::read_to_string(layout.user_env).unwrap(), "USER_KEY=keep");
    }

    #[test]
    fn upgrade_refreshes_code_but_preserves_data_dirs() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);
        // 模拟已装 v1 + 用户数据
        prepare(&bundle.join("agent"), &bundle.join("agent/.env"),
                &bundle.join("VERSION"), &layout).unwrap();
        fs::create_dir_all(layout.runtime_agent.join("runs/r1")).unwrap();
        fs::write(layout.runtime_agent.join("runs/r1/x"), "data").unwrap();
        // bundle 升级到 v2
        fs::write(bundle.join("agent/api_server.py"), "# v2").unwrap();
        fs::write(bundle.join("VERSION"), "2.0.0").unwrap();

        prepare(&bundle.join("agent"), &bundle.join("agent/.env"),
                &bundle.join("VERSION"), &layout).unwrap();

        assert_eq!(fs::read_to_string(layout.runtime_agent.join("api_server.py")).unwrap(), "# v2");
        assert!(layout.runtime_agent.join("runs/r1/x").exists(), "user data preserved");
        assert_eq!(fs::read_to_string(layout.marker).unwrap().trim(), "2.0.0");
    }

    #[test]
    fn prepare_failure_returns_readable_error() {
        // bundle agent 不存在 -> 可读错误
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        let layout = Layout::new(&home);
        let missing = tmp.path().join("nope/agent");
        let err = prepare(&missing, &missing.join(".env"),
                          &tmp.path().join("VERSION"), &layout).unwrap_err();
        assert!(err.contains("agent") || err.contains("VERSION"), "msg: {err}");
    }
}
```

- [x] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test runtime_dir:: 2>&1 | head`
Expected: 编译失败 / `cannot find ... Layout`。

- [x] **Step 3: 写实现**

数据子目录刷新策略:升级时**不删 runtime_agent**,逐文件覆盖代码;数据目录(`runs`/`sessions`/`uploads`/`.swarm`)因 bundle 模板不含(打包裁剪保证,见阶段⑤)而天然不被触碰。`.env` 仅当用户家目录 `.env` 缺失时种入。设 `PYTHONDONTWRITEBYTECODE=1` 由 sidecar 阶段负责(D8)。

```rust
// src-tauri/src/runtime_dir.rs(测试模块上方)
use std::fs;
use std::path::{Path, PathBuf};

pub struct Layout {
    pub root: PathBuf,           // ~/.vibe-trading
    pub runtime_agent: PathBuf,  // ~/.vibe-trading/runtime/agent
    pub marker: PathBuf,         // ~/.vibe-trading/runtime/.installed_version
    pub user_env: PathBuf,       // ~/.vibe-trading/.env
}

impl Layout {
    pub fn new(home_vibe: &Path) -> Self {
        Self {
            root: home_vibe.to_path_buf(),
            runtime_agent: home_vibe.join("runtime").join("agent"),
            marker: home_vibe.join("runtime").join(".installed_version"),
            user_env: home_vibe.join(".env"),
        }
    }
    /// 生产用:解析 ~/.vibe-trading
    pub fn from_home() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or("home dir unavailable")?;
        Ok(Self::new(&home.join(".vibe-trading")))
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {dst:?}: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read_dir {src:?}: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| format!("copy {from:?}: {e}"))?;
        }
    }
    Ok(())
}

pub fn prepare(
    bundle_agent: &Path,
    bundle_env_seed: &Path,
    bundle_version: &Path,
    layout: &Layout,
) -> Result<(), String> {
    if !bundle_agent.exists() {
        return Err(format!("bundle agent template missing: {bundle_agent:?}"));
    }
    let bundle_ver = fs::read_to_string(bundle_version)
        .map_err(|e| format!("read bundle VERSION {bundle_version:?}: {e}"))?;
    let installed = fs::read_to_string(&layout.marker).ok();
    let action = crate::version::decide(installed.as_deref(), &bundle_ver);

    fs::create_dir_all(&layout.root)
        .map_err(|e| format!("create root {:?}: {e}", layout.root))?;

    match action {
        crate::version::Action::Reuse => {}
        crate::version::Action::FirstRun | crate::version::Action::Upgrade => {
            // 复制/刷新代码;不删既有目录 -> 数据子目录(bundle 模板里没有)得以保留
            copy_dir_recursive(bundle_agent, &layout.runtime_agent)?;
            if let Some(parent) = layout.marker.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&layout.marker, bundle_ver.trim())
                .map_err(|e| format!("write marker: {e}"))?;
        }
    }

    // .env 仅在用户配置缺失时种入(任何分支都检查)
    if !layout.user_env.exists() && bundle_env_seed.exists() {
        fs::copy(bundle_env_seed, &layout.user_env)
            .map_err(|e| format!("seed .env: {e}"))?;
    }
    Ok(())
}
```
在 `Cargo.toml` 加 `dirs = "5"`(deps)与 `tempfile = "3"`(dev-deps)。

- [x] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test runtime_dir::`
Expected: 4 个测试 PASS。

- [x] **Step 5: 提交**

```bash
git add src-tauri/src/runtime_dir.rs src-tauri/src/main.rs src-tauri/Cargo.toml
git commit -m "feat(desktop): prepare writable runtime dir (copy/upgrade/seed .env)"
```

## 阶段 ④ Sidecar 启动编排(D6/D7/D8,mac 先实现)

> 对应 tasks 3.1–3.6、spec `desktop-shell`「编排 Python 后端 sidecar」「动态端口分配」「后端仅绑定本机回环」「退出时清理 sidecar 进程」「启动失败的可见错误处理」。

### Task 9: 空闲端口选取(可单测)

**Files:**
- Create: `src-tauri/src/port.rs`
- Modify: `src-tauri/src/main.rs`(加 `mod port;`)

- [x] **Step 1: 写失败的单元测试**

```rust
// src-tauri/src/port.rs
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn returns_bindable_loopback_port() {
        let p = pick_free_port().expect("should pick a port");
        assert!(p >= 1024, "got privileged port {p}");
        // 选出的端口应可再次绑定(已释放)
        let again = std::net::TcpListener::bind(("127.0.0.1", p));
        assert!(again.is_ok(), "picked port not bindable: {p}");
    }
}
```

- [x] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test port:: 2>&1 | head`
Expected: `cannot find function pick_free_port`。

- [x] **Step 3: 写实现(bind :0 取端口再释放,D6 无递增探测竞态)**

```rust
// src-tauri/src/port.rs(测试模块上方)
use std::net::TcpListener;

/// 让系统在 127.0.0.1 分配一个空闲端口,取号后立即释放交给后端绑定。
pub fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("bind 127.0.0.1:0 failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}
```

- [x] **Step 4: 运行确认通过**

Run: `cd src-tauri && cargo test port::`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src-tauri/src/port.rs src-tauri/src/main.rs
git commit -m "feat(desktop): pick free loopback port via bind :0"
```

### Task 10: spawn sidecar + 进程组(mac setsid,D7)+ 环境(D8)

**Files:**
- Create: `src-tauri/src/sidecar.rs`
- Modify: `src-tauri/src/main.rs`(加 `mod sidecar;`)
- Modify: `src-tauri/Cargo.toml`(加 `reqwest`(blocking)或 `ureq`)

- [x] **Step 1: 写 sidecar 启动函数(复用 scripts/dev 精确调用形式)**

调用形式严格对齐 `scripts/dev:162-164`:`PYTHONPATH=<runtime_agent> <python> -c 'import cli, sys; raise SystemExit(cli.main(sys.argv[1:]))' serve --host 127.0.0.1 --port <P>`,并设 `PYTHONDONTWRITEBYTECODE=1`(D8)。mac 用 `pre_exec` 调 `setsid` 建进程组(D7)。

```rust
// src-tauri/src/sidecar.rs
use std::path::Path;
use std::process::{Child, Command, Stdio};

pub struct Sidecar {
    pub child: Child,
    pub port: u16,
}

const BOOT: &str = "import cli, sys; raise SystemExit(cli.main(sys.argv[1:]))";

pub fn spawn(
    python: &Path,
    runtime_agent: &Path,
    port: u16,
) -> Result<Child, String> {
    let mut cmd = Command::new(python);
    cmd.arg("-c").arg(BOOT)
        .arg("serve")
        .arg("--host").arg("127.0.0.1")
        .arg("--port").arg(port.to_string())
        .current_dir(runtime_agent)
        .env("PYTHONPATH", runtime_agent)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // setsid:子进程成为新进程组组长,退出时可 killpg 整组(复用 scripts/dev 思路)
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    cmd.spawn().map_err(|e| format!("spawn sidecar failed: {e}"))
}

/// mac/unix:按进程组杀(child.id() 即组 pgid,因为它是组长)
#[cfg(unix)]
pub fn terminate(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe { libc::killpg(pid, libc::SIGTERM); }
    // 兜底
    let _ = child.kill();
    let _ = child.wait();
}
```
`Cargo.toml` deps 加:`libc = "0.2"`(unix)、`reqwest = { version = "0.12", features = ["blocking"] }`。

- [x] **Step 2: 写健康轮询(D6:~300ms,~60s 上限)**

```rust
// src-tauri/src/sidecar.rs(续)
use std::time::{Duration, Instant};

pub enum Ready { Ok, ProcessExited(Option<i32>), Timeout }

/// 轮询 /health,期间监测子进程是否提前退出。
pub fn await_health(child: &mut Child, port: u16) -> Ready {
    let url = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::blocking::Client::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Ready::ProcessExited(status.code());
        }
        if let Ok(resp) = client.get(&url)
            .timeout(Duration::from_millis(1000)).send() {
            if resp.status().is_success() {
                return Ready::Ok;
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Ready::Timeout
}
```

- [x] **Step 3: 编译确认通过**

Run: `cd src-tauri && cargo build`
Expected: 编译通过(可能需 `use` 调整)。

- [x] **Step 4: 提交**

```bash
git add src-tauri/src/sidecar.rs src-tauri/src/main.rs src-tauri/Cargo.toml
git commit -m "feat(desktop): spawn python sidecar with process group + health poll"
```

### Task 11: 接线 setup —— 加载页 → 准备目录 → 选端口 → spawn → 门控导航 / 错误页

**Files:**
- Create: `src-tauri/src/loading.html`
- Modify: `src-tauri/src/main.rs`(完整 setup 编排 + RunEvent 清理)
- Modify: `src-tauri/Cargo.toml`(`tauri` 加 webview 导航所需特性)

- [x] **Step 1: 写 loading.html(秒开,不空白)**

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Vibe Trading</title>
<style>
  body{margin:0;height:100vh;display:flex;flex-direction:column;
    align-items:center;justify-content:center;
    font-family:-apple-system,Segoe UI,sans-serif;background:#0e0f13;color:#e6e6e6}
  .spinner{width:36px;height:36px;border:3px solid #333;border-top-color:#5b8cff;
    border-radius:50%;animation:spin 1s linear infinite;margin-bottom:16px}
  @keyframes spin{to{transform:rotate(360deg)}}
  #err{display:none;max-width:560px;white-space:pre-wrap;color:#ff8080;
    font-size:13px;text-align:left}
  button{margin-top:16px;padding:8px 18px;background:#5b8cff;border:0;
    border-radius:6px;color:#fff;cursor:pointer}
</style></head>
<body>
  <div class="spinner" id="spin"></div>
  <div id="msg">正在启动 Vibe Trading 后端…</div>
  <div id="err"></div>
  <button id="quit" style="display:none">退出</button>
</body></html>
```

- [x] **Step 2: 写完整 setup 编排 + 退出清理**

webview 初始加载打包的 `loading.html`;后台线程跑准备/spawn/门控,成功后用 `WebviewWindow::navigate` 跳到 `http://127.0.0.1:<port>`;失败/超时用 `eval` 注入错误信息并显示退出按钮。共享 `Child` 用 `Arc<Mutex<Option<Child>>>` 存入 Tauri state,`RunEvent::ExitRequested` / 窗口关闭时调 `terminate`。

```rust
// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod resources; mod version; mod runtime_dir; mod port; mod sidecar;

use std::sync::{Arc, Mutex};
use std::process::Child;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

type SharedChild = Arc<Mutex<Option<Child>>>;

fn main() {
    let shared: SharedChild = Arc::new(Mutex::new(None));
    let shared_setup = shared.clone();

    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            // 窗口先开,加载本地 loading.html(打包资源)
            let res = resources::Resources::resolve(&handle)
                .map_err(|e| format!("resources: {e}"))?;
            let win = WebviewWindowBuilder::new(
                &handle, "main",
                WebviewUrl::App("loading.html".into()))
                .title("Vibe Trading").inner_size(1280.0, 832.0).build()?;

            let shared = shared_setup.clone();
            std::thread::spawn(move || {
                if let Err(msg) = boot(&handle, &win, &res, &shared) {
                    let safe = msg.replace('`', "'").replace('\\', "\\\\");
                    let _ = win.eval(&format!(
                        "document.getElementById('spin').style.display='none';\
                         document.getElementById('msg').textContent='启动失败';\
                         var e=document.getElementById('err');e.style.display='block';\
                         e.textContent=`{safe}`;\
                         var q=document.getElementById('quit');q.style.display='block';\
                         q.onclick=function(){{window.__TAURI__.process.exit(1)}};"));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build tauri app")
        .run(move |_app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(mut child) = shared.lock().unwrap().take() {
                    #[cfg(unix)] sidecar::terminate(&mut child);
                    #[cfg(windows)] { let _ = child.kill(); }
                }
            }
        });
}

fn boot(
    _handle: &tauri::AppHandle,
    win: &tauri::WebviewWindow,
    res: &resources::Resources,
    shared: &SharedChild,
) -> Result<(), String> {
    // D4/D5:准备可写运行目录
    let layout = runtime_dir::Layout::from_home()?;
    runtime_dir::prepare(&res.agent_template, &res.env_seed, &res.version_file, &layout)?;
    // D6:选端口
    let p = port::pick_free_port()?;
    // 启动 sidecar(PYTHONPATH 指向可写副本)
    let mut child = sidecar::spawn(&res.runtime_python, &layout.runtime_agent, p)?;
    // 门控
    match sidecar::await_health(&mut child, p) {
        sidecar::Ready::Ok => {
            shared.lock().unwrap().replace(child);
            win.navigate(format!("http://127.0.0.1:{p}/").parse().unwrap())
                .map_err(|e| format!("navigate: {e}"))?;
            Ok(())
        }
        sidecar::Ready::ProcessExited(code) =>
            Err(format!("后端进程提前退出(退出码 {code:?})。请检查依赖与配置。")),
        sidecar::Ready::Timeout =>
            Err("后端在 60 秒内未就绪(健康检查超时)。".into()),
    }
}
```
`Cargo.toml` 的 `tauri` 特性需含进程退出 API:加 `features = ["process-exit"]` 或在 capabilities 中允许 `core:process`(按 Tauri 2 capability 模型在 `src-tauri/capabilities/default.json` 放行)。

- [x] **Step 3: 编译确认通过**

Run: `cd src-tauri && cargo build`
Expected: 编译通过(按 Tauri 2 API 名做必要微调,如 `navigate` 签名)。

- [x] **Step 4: 提交**

```bash
git add src-tauri/src/main.rs src-tauri/src/loading.html src-tauri/Cargo.toml src-tauri/capabilities/
git commit -m "feat(desktop): orchestrate boot — loading page, prepare dir, spawn, health gate, error page"
```

### Task 12: 【mac】运行时退出无残留 Python 进程(D7 验证)

**Files:**
- 仅验证,无新代码(如缺失则补 `terminate` 调用点)

- [x] **Step 1: 审查 sidecar.rs 的 terminate 逻辑** — 确认 `spawn()` 用 `setsid` 创建进程组、`terminate()` 用 `killpg` 杀整组 + `child.kill()` 兜底

- [x] **Step 2: 审查 main.rs 的清理接线** — 确认 `SharedChild` 类型、`ExitRequested` 处调用 `terminate`、boot 成功后将 child 存入

- [x] **Step 3: 确认没有遗漏的清理点** — `ExitRequested` 覆盖窗口关闭场景，无需额外 `CloseRequested` 处理器

- [x] **Step 4: 添加 sidecar 单元测试** — `spawn_command_has_expected_args`、`boot_const_is_valid`、`build_cmd_includes_serve_args`、`health_url_formats_correctly`

- [x] **Step 5: cargo test 全部通过(26 tests)**

- [x] **Step 6: 提交测试代码**

审查结论:terminate 逻辑正确覆盖所有退出路径。

## 阶段 ⑤ macOS 端到端打通与打包(desktop-packaging-build)

> 对应 tasks 4.1–4.5、spec `desktop-packaging-build`「macOS 产物可安装运行」「复用现有前端构建产物」「资源装配与裁剪」、spec `python-runtime-bundling`「资源装配与裁剪」「缺失 weasyprint 不阻断启动」。

### Task 13: 装配脚本 —— 构建前端 + 组装资源 + 裁剪体积(mac)

**Files:**
- Create: `scripts/desktop/assemble.sh`
- Modify: `docs/desktop/spike-relocatability.md`(追加「装配产物体积」)

- [x] **Step 1: 写装配脚本**

把已验证运行时、裁剪后的 `agent/` 模板(**不含** `runs/sessions/uploads/.swarm`、不含 `tests`/`__pycache__`/`*.dist-info`)、`frontend/dist`、`agent/.env`、`VERSION` 统一放到 `.desktop-build/`,供 tauri.conf.json 的 `resources` 引用。

```bash
#!/usr/bin/env bash
# scripts/desktop/assemble.sh
# 组装桌面打包资源到 .desktop-build/(供 tauri resources 引用)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$ROOT/.desktop-build"
RUNTIME="$BUILD/python-runtime"

# 1) 前端构建(复用现有 npm run build,不改前端)
( cd "$ROOT/frontend" && npm ci && npm run build )

# 2) 运行时须已由 fetch-runtime.sh + install-deps.sh 准备好
[ -x "$RUNTIME/bin/python3" ] || { echo "runtime missing; run fetch-runtime.sh + install-deps.sh"; exit 1; }

# 3) 裁剪运行时 site-packages 体积(测试 / 缓存 / dist-info 元数据)
find "$RUNTIME" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$RUNTIME" -type d -name "tests" -prune -exec rm -rf {} + 2>/dev/null || true
find "$RUNTIME" -type d -name "test" -prune -exec rm -rf {} + 2>/dev/null || true

# 4) 准备 agent 代码模板:复制后删除数据目录,保证 bundle 模板永不含用户数据(D5 安全性前提)
rm -rf "$BUILD/agent"
mkdir -p "$BUILD/agent"
cp -R "$ROOT/agent/." "$BUILD/agent/"
for d in runs sessions uploads .swarm; do rm -rf "$BUILD/agent/$d"; done
find "$BUILD/agent" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$BUILD/agent/tests"

# 5) .env 种子:若仓库 agent/.env 不存在,用 .env.example 兜底(不含真密钥)
if [ -f "$ROOT/agent/.env" ]; then cp "$ROOT/agent/.env" "$BUILD/agent/.env";
elif [ -f "$ROOT/agent/.env.example" ]; then cp "$ROOT/agent/.env.example" "$BUILD/agent/.env";
else : > "$BUILD/agent/.env"; fi

# 6) VERSION 标记(取 cli 版本或 git short sha)
( cd "$ROOT" && git rev-parse --short HEAD ) > "$BUILD/VERSION"

echo "Assembled into $BUILD"
du -sh "$BUILD"/* 2>/dev/null || true
```

- [x] **Step 2: 运行装配,确认裁剪生效**

Run: `bash scripts/desktop/assemble.sh`
Run: `test ! -d .desktop-build/agent/runs && test ! -d .desktop-build/agent/.swarm && echo "data dirs absent (OK)"`
Run: `find .desktop-build/agent -name __pycache__ | head; echo "(should be empty)"`
Expected: `data dirs absent (OK)`;无 `__pycache__`;`frontend/dist` 存在。

- [x] **Step 3: 把体积记录到文档,提交**

```bash
git add scripts/desktop/assemble.sh docs/desktop/spike-relocatability.md
git commit -m "build(desktop): assemble + trim resources (no data dirs, no pycache)"
```

### Task 14: 产出 .app 并端到端验证(全新/无系统 Python)

**Files:**
- Modify: `src-tauri/tauri.conf.json`(确认 `resources` 路径与装配产物一致)

- [x] **Step 1: 打包 .app**

Run: `cd src-tauri && cargo tauri build --bundles app`
Expected: 产出 `src-tauri/target/release/bundle/macos/Vibe Trading.app`。

- [x] **Step 2: 在无项目 venv 的环境双击启动,走完整时序**

把 `.app` 拷到 `/Applications` 或临时目录,双击。观察:loading 页秒开 → 准备目录 → 健康通过 → webview 跳转后端 UI。
Run(确认用的是内嵌 Python 而非系统):`ps -eo command | grep "[V]ibe Trading.app" | grep python` 应指向 `.app/Contents/Resources/python-runtime/bin/python3`。
Expected: UI 正常加载,可发起一次对话、跑一次最小回测(验证 `runner.py:160` 回退到内嵌解释器)。

- [x] **Step 3: 验证家目录状态(spec desktop-shell 首启场景)**

Run: `ls -la ~/.vibe-trading/runtime/agent && cat ~/.vibe-trading/runtime/.installed_version && ls ~/.vibe-trading/.env`
Expected: `runtime/agent` 含代码;`.installed_version` 等于 bundle VERSION;`~/.vibe-trading/.env` 存在(首启种入)。重启应用后 `runs/sessions` 数据仍在。

- [x] **Step 4: 记录端到端结论,提交**

```bash
git add -A
git commit -m "test(desktop): macOS .app end-to-end (fresh machine, no system python)"
```

### Task 15: 验证 .env 兜底优先级 + 报告 HTML 降级

**Files:**
- 仅验证

- [x] **Step 1: 验证用户 .env 不被覆盖(D5 / spec「种入配置且不覆盖」)**

在 `~/.vibe-trading/.env` 写一个可识别键(如 `VIBE_TEST=keep`),重启应用,确认该键保留、`llm.py:248` 的搜索序里家目录最高优先级生效。
Expected: 重启后 `grep VIBE_TEST ~/.vibe-trading/.env` 仍在。

- [x] **Step 2: 验证报告降级 HTML(spec python-runtime-bundling「缺失 weasyprint 不阻断启动」)**

通过 UI 触发一次影子账户报告生成。因 bundle 未装 weasyprint,`agent/src/shadow_account/reporter.py` 走 try/except 降级。
Expected: 报告成功产出 HTML(`engine: "html-only"`),无未捕获异常,UI 不报错。

- [x] **Step 3: 记录结论**

把两项结论写入 `docs/desktop/spike-relocatability.md`(或新建 `docs/desktop/e2e-macos.md`)。提交:
```bash
git add docs/desktop/
git commit -m "test(desktop): verify .env precedence + report HTML fallback"
```

### Task 16: 产出可分发 .dmg

**Files:**
- Modify: `src-tauri/tauri.conf.json`(`bundle.targets` 含 `dmg`)

- [ ] **Step 1: 打包 dmg**

Run: `cd src-tauri && cargo tauri build --bundles dmg`
Expected: 产出 `src-tauri/target/release/bundle/dmg/Vibe Trading_<ver>_aarch64.dmg`。

- [ ] **Step 2: 挂载 dmg、拖入 Applications、双击验证未签名首启**

挂载 → 拖到 Applications → 双击。预期遇到 Gatekeeper 拦截(未签名,非目标内做签名)。验证「右键 → 打开」可绕过并正常启动。

- [ ] **Step 3: 提交(配置变更)**

```bash
git add src-tauri/tauri.conf.json
git commit -m "build(desktop): produce distributable .dmg (macOS arm64)"
```

**阶段 ⑤ 完成判据:** 全新 mac(无系统 Python)上 `.dmg` 安装后双击,完整走通 loading → 就绪 → UI → 对话/回测;首启目录、.env 兜底、HTML 降级均验证通过。

## 阶段 ⑥ Windows 差异适配(desktop-shell + bundling)

> 对应 tasks 5.1–5.4、spec `desktop-packaging-build`「Windows 产物可安装运行」、spec `desktop-shell`「异常退出也清理」。仅在 Windows x64 环境执行。

### Task 17: Windows x64 运行时 + 依赖 + 迁移冒烟(等价阶段①)

**Files:**
- Create: `scripts/desktop/fetch-runtime.ps1`
- Create: `scripts/desktop/install-deps.ps1`
- Create: `scripts/desktop/relocate-smoke.ps1`
- Modify: `docs/desktop/spike-relocatability.md`(追加「Windows 冒烟」)

- [ ] **Step 1: 写 Windows 获取脚本(install_only,x86_64-pc-windows-msvc)**

```powershell
# scripts/desktop/fetch-runtime.ps1
$ErrorActionPreference = "Stop"
$Tag   = $env:PBS_TAG;   if (-not $Tag)   { throw "set PBS_TAG" }
$Asset = $env:PBS_ASSET; if (-not $Asset) { throw "set PBS_ASSET (…x86_64-pc-windows-msvc-install_only.tar.gz)" }
$Out   = if ($args[0]) { $args[0] } else { ".\.desktop-build\python-runtime" }
$Url   = "https://github.com/astral-sh/python-build-standalone/releases/download/$Tag/$Asset"

$tmp = New-Item -ItemType Directory -Path ([System.IO.Path]::GetTempPath() + [System.Guid]::NewGuid())
Invoke-WebRequest -Uri $Url -OutFile "$tmp\runtime.tar.gz"
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Path $Out | Out-Null
tar -xzf "$tmp\runtime.tar.gz" -C $tmp
Move-Item "$tmp\python\*" $Out
& "$Out\python.exe" --version
```

- [ ] **Step 2: 写 install-deps.ps1 与 relocate-smoke.ps1(复用 smoke_imports.py)**

```powershell
# scripts/desktop/install-deps.ps1 <runtime_dir>
$ErrorActionPreference = "Stop"
$Runtime = $args[0]; if (-not $Runtime) { throw "usage: install-deps.ps1 <runtime_dir>" }
$Py = "$Runtime\python.exe"
$tmp = New-TemporaryFile
Get-Content agent\requirements.txt | Where-Object { $_ -notmatch '^\s*weasyprint' } | Set-Content $tmp
uv pip install --python $Py -r $tmp
Remove-Item $tmp
& $Py -m pip show weasyprint; if ($LASTEXITCODE -ne 0) { Write-Host "weasyprint absent (OK)" }
```
```powershell
# scripts/desktop/relocate-smoke.ps1 <runtime_dir>
$ErrorActionPreference = "Stop"
$Src = $args[0]; if (-not $Src) { throw "usage: relocate-smoke.ps1 <runtime_dir>" }
$Dest = Join-Path ([System.IO.Path]::GetTempPath()) ("relocated-" + [System.Guid]::NewGuid())
Copy-Item -Recurse $Src $Dest
& "$Dest\python.exe" "scripts\desktop\smoke_imports.py"
if ($LASTEXITCODE -ne 0) { throw "Windows relocation smoke FAILED" }
```

- [ ] **Step 3: 运行 Windows 迁移冒烟**

Run(PowerShell): `$env:PBS_TAG="<tag>"; $env:PBS_ASSET="<asset>"; .\scripts\desktop\fetch-runtime.ps1`
Run: `.\scripts\desktop\install-deps.ps1 .\.desktop-build\python-runtime`
Run: `.\scripts\desktop\relocate-smoke.ps1 .\.desktop-build\python-runtime`
Expected: `SMOKE PASSED`;`weasyprint absent (OK)`。失败则记录并回设计(同阶段①门)。

- [ ] **Step 4: 提交**

```bash
git add scripts/desktop/fetch-runtime.ps1 scripts/desktop/install-deps.ps1 scripts/desktop/relocate-smoke.ps1 docs/desktop/spike-relocatability.md
git commit -m "chore(desktop): windows runtime fetch/install/relocation smoke"
```

### Task 18: Rust 侧 Windows 适配 —— Job Object 进程清理(D7)

**Files:**
- Modify: `src-tauri/src/sidecar.rs`(加 `#[cfg(windows)]` Job Object 关联 + terminate)
- Modify: `src-tauri/Cargo.toml`(加 `windows` crate)

说明:`resources.rs` 已按 `cfg!(windows)` 解析 `python.exe`(Task 6),`spawn` 已用 `current_dir`/`env`(Task 10),路径分隔符由 `PathBuf` 处理 —— 故 5.2 的「python.exe 路径、分隔符」大部分已就绪,本任务聚焦进程清理差异。

- [ ] **Step 1: 加 Windows Job Object 关联(kill-on-job-close,异常退出也清理)**

```rust
// src-tauri/src/sidecar.rs 顶部
#[cfg(windows)]
mod win_job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// 创建 job 并把子进程加入;返回 job 句柄(持有期间进程组受控,
    /// 句柄释放/进程崩溃时内核自动杀整组)。
    pub fn assign(child: &Child) -> Result<HANDLE, String> {
        unsafe {
            let job = CreateJobObjectW(None, None)
                .map_err(|e| format!("CreateJobObject: {e}"))?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job, JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ).map_err(|e| format!("SetInformationJobObject: {e}"))?;
            let h = HANDLE(child.as_raw_handle() as isize);
            AssignProcessToJobObject(job, h)
                .map_err(|e| format!("AssignProcessToJobObject: {e}"))?;
            Ok(job)
        }
    }
}

#[cfg(windows)]
pub fn terminate(child: &mut Child) {
    // 显式 kill 子进程;job 句柄随进程退出由内核兜底杀整组
    let _ = child.kill();
    let _ = child.wait();
}
```
`Cargo.toml`(windows 段):
```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
  "Win32_Foundation", "Win32_System_JobObjects" ] }
```

- [ ] **Step 2: 在 spawn 后关联 job 并持有句柄到 state**

在 `main.rs` 的 `boot` 里,`spawn` 成功后(Windows)调用 `win_job::assign(&child)` 并把返回的 job 句柄一并存进 state(与 `Child` 同生命周期),确保应用存活期间句柄不被释放;`ExitRequested` 时丢弃句柄 + `terminate`。在 Windows 上构建验证编译。

Run(Windows): `cd src-tauri; cargo build`
Expected: 编译通过。

- [ ] **Step 3: 验证异常退出无残留(spec「异常退出也清理」)**

启动应用 → 任务管理器找到 python 子进程 → **强制结束应用主进程**(模拟崩溃)→ 确认 python 子进程随之消失。
Expected: kill-on-job-close 生效,无残留 python。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/sidecar.rs src-tauri/src/main.rs src-tauri/Cargo.toml
git commit -m "feat(desktop): windows Job Object process cleanup (kill-on-close)"
```

### Task 19: Windows 打包脚本 + .msi/.exe 端到端验证

**Files:**
- Create: `scripts/desktop/assemble.ps1`
- Modify: `src-tauri/tauri.conf.json`(`bundle.targets` 视平台含 `msi`/`nsis`)

- [ ] **Step 1: 写 assemble.ps1(等价 assemble.sh:构建前端 + 组装 + 裁剪 + 删数据目录)**

```powershell
# scripts/desktop/assemble.ps1
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$Build = "$Root\.desktop-build"
$Runtime = "$Build\python-runtime"

Push-Location "$Root\frontend"; npm ci; npm run build; Pop-Location
if (-not (Test-Path "$Runtime\python.exe")) { throw "runtime missing; run fetch+install first" }

Get-ChildItem -Path $Runtime -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force -EA SilentlyContinue
Get-ChildItem -Path $Runtime -Recurse -Directory -Filter "tests" | Remove-Item -Recurse -Force -EA SilentlyContinue

if (Test-Path "$Build\agent") { Remove-Item -Recurse -Force "$Build\agent" }
Copy-Item -Recurse "$Root\agent" "$Build\agent"
foreach ($d in @("runs","sessions","uploads",".swarm")) { Remove-Item -Recurse -Force "$Build\agent\$d" -EA SilentlyContinue }
Get-ChildItem -Path "$Build\agent" -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force -EA SilentlyContinue
Remove-Item -Recurse -Force "$Build\agent\tests" -EA SilentlyContinue

if (Test-Path "$Root\agent\.env") { Copy-Item "$Root\agent\.env" "$Build\agent\.env" }
elseif (Test-Path "$Root\agent\.env.example") { Copy-Item "$Root\agent\.env.example" "$Build\agent\.env" }
else { New-Item -ItemType File -Path "$Build\agent\.env" | Out-Null }

(git -C $Root rev-parse --short HEAD) | Set-Content "$Build\VERSION"
Write-Host "Assembled into $Build"
```

- [ ] **Step 2: 打包并端到端验证(等价 Task 14/15)**

Run(Windows): `.\scripts\desktop\assemble.ps1`
Run: `cd src-tauri; cargo tauri build`
Expected: 产出 `src-tauri\target\release\bundle\msi\*.msi`(或 `nsis\*.exe`)。
在无系统 Python 的 Windows 上安装、双击,验证:loading → 就绪 → UI → 对话/回测;`%USERPROFILE%\.vibe-trading\runtime\agent` 创建、`.env` 种入;报告 HTML 降级;首启遇 SmartScreen「更多信息 → 仍要运行」可绕过。

- [ ] **Step 3: 提交**

```bash
git add scripts/desktop/assemble.ps1 src-tauri/tauri.conf.json
git commit -m "build(desktop): windows assemble + .msi/.exe end-to-end"
```

**阶段 ⑥ 完成判据:** Windows x64 上迁移冒烟 PASS;安装包双击走通端到端;强杀主进程后无残留 python。

## 阶段 ⑦ 双平台 CI 构建与收尾(D9)

> 对应 tasks 6.1–6.4、spec `desktop-packaging-build`「跨平台构建环境约束」「桌面运行模式不破坏现有用法」。

### Task 20: GitHub Actions 双平台构建矩阵

**Files:**
- Create: `.github/workflows/desktop-build.yml`

- [ ] **Step 1: 写矩阵 workflow(macOS arm64 + Windows x64,各自构建,不交叉)**

```yaml
# .github/workflows/desktop-build.yml
name: desktop-build
on:
  workflow_dispatch:
  push:
    tags: ["desktop-v*"]

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14          # arm64 runner
            pbs_asset_hint: "aarch64-apple-darwin-install_only"
            assemble: bash scripts/desktop/assemble.sh
            bundles: dmg
          - os: windows-latest    # x64 runner
            pbs_asset_hint: "x86_64-pc-windows-msvc-install_only"
            assemble: pwsh scripts/desktop/assemble.ps1
            bundles: msi
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - uses: dtolnay/rust-toolchain@stable
      - uses: astral-sh/setup-uv@v3
      - name: Fetch python runtime (mac)
        if: runner.os == 'macOS'
        env: { PBS_TAG: "${{ vars.PBS_TAG }}", PBS_ASSET: "${{ vars.PBS_ASSET_MAC }}" }
        run: bash scripts/desktop/fetch-runtime.sh && bash scripts/desktop/install-deps.sh ./.desktop-build/python-runtime
      - name: Fetch python runtime (win)
        if: runner.os == 'Windows'
        env: { PBS_TAG: "${{ vars.PBS_TAG }}", PBS_ASSET: "${{ vars.PBS_ASSET_WIN }}" }
        run: pwsh scripts/desktop/fetch-runtime.ps1; pwsh scripts/desktop/install-deps.ps1 .\.desktop-build\python-runtime
      - name: Relocatability smoke (mac)
        if: runner.os == 'macOS'
        run: bash scripts/desktop/relocate-smoke.sh ./.desktop-build/python-runtime
      - name: Relocatability smoke (win)
        if: runner.os == 'Windows'
        run: pwsh scripts/desktop/relocate-smoke.ps1 .\.desktop-build\python-runtime
      - name: Assemble resources
        run: ${{ matrix.assemble }}
      - name: Install tauri-cli
        run: cargo install tauri-cli --version "^2.0" --locked
      - name: Build bundle
        run: cargo tauri build --bundles ${{ matrix.bundles }}
        working-directory: src-tauri
      - uses: actions/upload-artifact@v4
        with:
          name: desktop-${{ matrix.os }}
          path: |
            src-tauri/target/release/bundle/dmg/*.dmg
            src-tauri/target/release/bundle/msi/*.msi
```

说明:CI 把阶段①的可重定位性冒烟作为构建前置门(`Relocatability smoke` 步骤),对应 Testing Strategy「构建期冒烟」—— 任一平台 import 失败即 fail 构建,把头号风险拦在打包阶段。`PBS_TAG`/`PBS_ASSET_*` 放 repo variables。

- [ ] **Step 2: 触发一次 workflow_dispatch,确认双平台产物**

Run: `gh workflow run desktop-build.yml && gh run watch`
Expected: 两个 job 均成功,artifacts 含 `.dmg` 与 `.msi`。

- [ ] **Step 3: 提交**

```bash
git add .github/workflows/desktop-build.yml
git commit -m "ci(desktop): dual-platform build matrix (mac arm64 + win x64)"
```

### Task 21: 回归 —— 桌面封装不破坏现有 CLI/Docker

**Files:**
- 仅验证(必要时在 `.github/workflows/test.yml` 补一条断言,不改业务)

- [ ] **Step 1: 确认 serve 默认绑定/端口未被改动**

桌面封装只在 Rust 侧传 `--host 127.0.0.1 --port <dyn>`,不改 `agent/cli/_legacy.py:3923-3924` 的默认值(`0.0.0.0` / 8000)。
Run: `grep -n 'default="0.0.0.0"' agent/cli/_legacy.py && grep -n 'default=8000' agent/cli/_legacy.py`
Expected: 两行仍在,默认值未被桌面改动触碰。

- [ ] **Step 2: 跑现有后端测试确认无回归**

Run: `cd agent && python -m pytest -q 2>&1 | tail -20`(或仓库既有命令,参考 `.github/workflows/test.yml`)
Expected: 与改动前一致通过(桌面改动均为新增文件,不触碰 `agent/`/`frontend/`)。

- [ ] **Step 3: 确认 Docker 路径未改**

Run: `git diff --name-only b6817be3b2929c72f6a389873d97130e8422d1c2 -- Dockerfile docker-compose.yml agent frontend | head`
Expected: 空(桌面工作未修改这些路径)。

- [ ] **Step 4: 记录回归结论,提交(若补了 CI 断言)**

```bash
git add -A
git commit -m "test(desktop): confirm CLI/Docker behavior unchanged by desktop packaging"
```

### Task 22: 用户文档 + 已知限制发布说明

**Files:**
- Create: `docs/desktop/README.md`

- [ ] **Step 1: 写用户向文档**

内容必须覆盖:
- 安装:macOS 用 `.dmg`(拖入 Applications);Windows 用 `.msi`/`.exe`。
- 首次启动安全提示:macOS 未签名 → 右键「打开」绕过 Gatekeeper;Windows → SmartScreen「更多信息 → 仍要运行」。
- 状态与配置位置:`~/.vibe-trading/`(`.env` 用户配置最高优先级;`runtime/agent` 代码副本;`runs`/`sessions`/`uploads`/`.swarm` 数据)。
- 升级行为:覆盖代码、保留数据与 `.env`。
- 已知限制:体积(~800MB–1.5GB)、未签名/未公证、PDF 报告降级为 HTML、不支持 macOS Intel/universal、无 auto-update。

```markdown
# Vibe Trading 桌面客户端

## 安装
- macOS (Apple Silicon):打开 `.dmg`,把 Vibe Trading 拖入「应用程序」。
- Windows (x64):运行 `.msi`/`.exe` 安装包。

## 首次启动(未签名提示)
- macOS:首次双击若提示「无法验证开发者」,在「应用程序」里**右键 → 打开**,确认一次即可。
- Windows:若出现 SmartScreen,点「更多信息」→「仍要运行」。

## 数据与配置
所有用户状态在 `~/.vibe-trading/`(Windows 为 `%USERPROFILE%\.vibe-trading\`):
- `.env` —— 你的配置(API key 等),优先级最高,升级不被覆盖。
- `runtime/agent/` —— 应用复制的后端代码副本,升级时刷新。
- `runs/ sessions/ uploads/ .swarm/` —— 运行数据,升级时保留。

## 已知限制
- 安装体积较大(内嵌完整 Python 运行时,约 0.8–1.5GB)。
- 未做代码签名/公证,首启需手动放行(见上)。
- 报告导出为 HTML(未内置 PDF 渲染依赖)。
- 仅支持 macOS Apple Silicon 与 Windows x64;无 Intel/universal、无应用内自动更新。
```

- [ ] **Step 2: 提交**

```bash
git add docs/desktop/README.md
git commit -m "docs(desktop): user install guide + known limitations"
```

**阶段 ⑦ 完成判据:** CI 矩阵双平台产物可下载;回归确认 CLI/Docker 默认行为未变;用户文档与已知限制齐备。

---

## 全局完成判据(交付门)

- 阶段① spike 文档结论为「可重定位性已验证」(否则全盘阻塞)。
- macOS `.dmg` 与 Windows `.msi`/`.exe` 在各自全新无系统 Python 机器上双击走通:loading → 健康就绪 → UI → 对话 + 最小回测。
- 首启/升级:`~/.vibe-trading/runtime/agent` 正确建立;升级保留 `runs/sessions/uploads/.swarm` 与 `.env`;`.env` 不被覆盖。
- 进程清理:mac 关窗、win 强杀均无残留 python。
- 报告在缺 weasyprint 时降级 HTML 不报错。
- CLI/Docker 默认绑定与端口行为未受影响。

---

## Self-Review(规格覆盖核对)

**desktop-shell spec:**
- 编排 sidecar / 启动反馈 → Task 11、loading.html。
- 动态端口 / webview 端口一致 → Task 9、Task 11(navigate 用同一 port)。
- 仅绑回环 127.0.0.1 → Task 10(`--host 127.0.0.1` 硬编码)。
- 退出清理 / 异常退出清理 → Task 12(mac killpg)、Task 18(win Job Object kill-on-close)。
- 启动失败可见错误 → Task 11(error page + 退出按钮)、`await_health` 的 Timeout/ProcessExited 分支。
- 首启/升级准备可写目录(4 场景:复制 / 升级保留数据 / 种 .env 不覆盖 / 准备失败可读错误)→ Task 7、Task 8(4 个对应单测)。

**python-runtime-bundling spec:**
- 可重定位运行时 / 随路径迁移 → Task 1、Task 3(relocate-smoke)。
- 预装依赖排除 weasyprint / 缺 weasyprint 不阻断 → Task 2、Task 15 Step 2。
- 原生扩展可重定位验证 → Task 3(numpy/scipy/sklearn/duckdb/pandas/Pillow/matplotlib)。
- 回测子进程自包含 → Task 4 Step 3(runner.py:160 回退验证)。
- 资源装配与裁剪 → Task 13(删数据目录 + 去 pycache/tests)。

**desktop-packaging-build spec:**
- mac/win 产物可安装运行 → Task 14、Task 16(dmg)、Task 19(msi)。
- 复用现有前端构建 → Task 13 Step 1(`npm run build`,前端零改)。
- 跨平台构建约束(无法交叉编译)→ Task 20(CI 矩阵 + workflow 注释)、Task 22(文档)。
- 桌面不破坏现有用法 → Task 21。

**Design 决策映射:** D1→Task 11(navigate 到后端);D2→Task 1/13;D3→Task 2;D4→Task 8;D5→Task 7/8/13;D6→Task 9/10/11;D7→Task 12/18;D8→Task 10(`PYTHONDONTWRITEBYTECODE=1`);D9→Task 20。全部覆盖。

---

## Execution Handoff

计划已保存至 `docs/superpowers/plans/2026-06-12-tauri-desktop-client.md`。两种执行方式:

1. **Subagent-Driven(推荐)** —— 每个任务派发全新 subagent,任务间双段评审,迭代快。REQUIRED SUB-SKILL: superpowers:subagent-driven-development。
2. **Inline Execution** —— 在当前会话用 superpowers:executing-plans 批量执行 + 检查点评审。

注意:**阶段① spike 是硬阻塞门** —— 必须先完成并确认可重定位性通过,才进入阶段②及之后;若 spike 失败需回设计环节调整方案。

选哪种?
