---
change: desktop-runtime-deps-on-demand
design-doc: docs/superpowers/specs/2026-06-13-runtime-deps-on-demand-design.md
base-ref: 5492225b05693be43e29e69667fa1227648fcbfc
---

# 桌面端运行时按需安装可选依赖 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面端用户在设置页一键安装券商 SDK（futu-api、ib_async、longbridge 等）到可写目录 `~/.vibe-trading/runtime/libs/`，sidecar 通过 `sys.path.append` 加载，核心打包依赖始终优先。

**Architecture:** Tauri 的 `runtime_dir::Layout` 新增 `runtime_libs` 字段（升级时与 `.env` 同级保留）；`sidecar.rs` spawn 时注入 `VIBE_RUNTIME_LIBS`；`cli` 入口读该变量并 `sys.path.append`（排在 site-packages 之后）。后端新增 `optional_deps` 模块（registry 白名单 + pip 安装器 + FastAPI 路由），通过 SSE 推送 pip 子进程进度。前端在 Settings 页新增「券商支持」管理组件。安装器选用内嵌 pip（python-build-standalone 自带 pip 26.1.2，零体积增量），默认清华镜像。

**Tech Stack:** Rust（Tauri 2，std::process / std::fs）、Python 3.12（FastAPI、PyYAML、sse-starlette、subprocess）、React 19 + TypeScript + Zustand、pip（内嵌运行时自带）。

**约束 / 不变量：**
- 本 change **不触碰** `agent/src/live/`（订单 / mandate / kill switch）。无 broker 写入路径被改动。
- 核心打包依赖优先级不可被覆盖：只能用 `sys.path.append`（绝不用 `PYTHONPATH` 前置）。
- 安装 API 仅接受 registry 白名单内包名；不强制 `--require-hashes`。
- Lint：Python Ruff（E/F/W，ignore E501，line-length 120，py311）；前端 TypeScript strict + `tsc -b`。
- 平台：macOS arm64/x86_64 + Windows。`vnpy_ctp` 仅 `win_amd64`。

---

## 文件结构总览

| 文件 | 类型 | 职责 |
|---|---|---|
| `src-tauri/src/runtime_dir.rs` | 修改 | `Layout` 新增 `runtime_libs` 字段；`prepare` 创建该目录；升级保留断言 |
| `src-tauri/src/sidecar.rs` | 修改 | `build_cmd` 注入 `VIBE_RUNTIME_LIBS`；新增重载支持镜像环境变量 |
| `src-tauri/src/main.rs` | 修改 | `boot` 传 `layout.runtime_libs` 给 sidecar spawn |
| `agent/cli/main.py` | 修改 | 模块顶部插入 `sys.path.append(VIBE_RUNTIME_LIBS)` |
| `agent/src/optional_deps/__init__.py` | 新建 | 包标记 |
| `agent/src/optional_deps/registry.yaml` | 新建 | 券商 → PyPI 包名 + 元数据 + 平台标记 + 推荐镜像 |
| `agent/src/optional_deps/registry_loader.py` | 新建 | 加载 + 校验 registry 白名单 |
| `agent/src/optional_deps/platform.py` | 新建 | 当前平台标签（macos arm64/x86_64、windows amd64）+ wheel 平台预检 |
| `agent/src/optional_deps/installer.py` | 新建 | pip 子进程（`--target`）+ 平台预检 + 已装状态扫描 |
| `agent/src/optional_deps/mirror.py` | 新建 | 镜像配置读写（持久化到用户配置文件） |
| `agent/src/optional_deps/api.py` | 新建 | FastAPI `APIRouter`：list/install/uninstall/status/mirror |
| `agent/src/optional_deps/sse_lines.py` | 新建 | SSE 帧格式化（resolving/downloading/installing/done/failed） |
| `agent/api_server.py` | 修改 | 挂载 `/optional-deps` 路由组 |
| `agent/src/optional_deps/tests/*.py` | 新建 | 单元测试（registry、platform、installer、mirror） |
| `frontend/src/lib/api.ts` | 修改 | 新增 `optionalDeps.*` 方法 + 类型 |
| `frontend/src/components/settings/OptionalDepsManager.tsx` | 新建 | 券商分组 UI + 安装/卸载 + SSE 进度 + 镜像切换 |
| `frontend/src/pages/Settings.tsx` | 修改 | 挂载 `OptionalDepsManager` |
| `frontend/vite.config.ts` | 修改 | `PROXY_PATHS` 加 `/optional-deps` |
| `scripts/desktop/assemble.sh` | 修改 | 确认保留 `.dist-info`（已存在注释，新增显式校验）；纳入 registry.yaml |

---

## Task 1：runtime_dir 扩展可写 libs 目录

**Files:**
- Modify: `src-tauri/src/runtime_dir.rs:5-27`（`Layout` 结构体与 `new`）
- Modify: `src-tauri/src/runtime_dir.rs:44-88`（`prepare` 函数）
- Test: `src-tauri/src/runtime_dir.rs:90-217`（既有测试模块）

^- [x] **Step 1：写失败测试 — Layout 包含 runtime_libs**

在 `src-tauri/src/runtime_dir.rs` 的 `tests` 模块末尾追加：

```rust
    #[test]
    fn layout_exposes_runtime_libs_path() {
        let home = std::path::Path::new("/fake/home/.vibe-trading");
        let layout = Layout::new(home);
        assert_eq!(
            layout.runtime_libs,
            home.join("runtime").join("libs")
        );
    }
```

^- [x] **Step 2：运行测试确认失败**

Run: `cd src-tauri && cargo test --lib runtime_dir::tests::layout_exposes_runtime_libs_path`
Expected: 编译错误 `no field runtime_libs on type Layout`。

^- [x] **Step 3：在 Layout 新增 runtime_libs 字段**

修改 `src-tauri/src/runtime_dir.rs:5-10` 的结构体：

```rust
pub struct Layout {
    pub root: PathBuf,           // ~/.vibe-trading
    pub runtime_agent: PathBuf,  // ~/.vibe-trading/runtime/agent
    pub runtime_libs: PathBuf,   // ~/.vibe-trading/runtime/libs (按需安装的可选依赖)
    pub marker: PathBuf,         // ~/.vibe-trading/runtime/.installed_version
    pub user_env: PathBuf,       // ~/.vibe-trading/.env
}
```

修改 `src-tauri/src/runtime_dir.rs:12-20` 的 `new`：

```rust
    pub fn new(home_vibe: &Path) -> Self {
        Self {
            root: home_vibe.to_path_buf(),
            runtime_agent: home_vibe.join("runtime").join("agent"),
            runtime_libs: home_vibe.join("runtime").join("libs"),
            marker: home_vibe.join("runtime").join(".installed_version"),
            user_env: home_vibe.join(".env"),
        }
    }
```

^- [x] **Step 4：运行测试确认通过**

Run: `cd src-tauri && cargo test --lib runtime_dir`
Expected: PASS（包含新增测试 + 既有 4 个测试）。

^- [x] **Step 5：提交**

```bash
git add src-tauri/src/runtime_dir.rs
git commit -s -m "feat(desktop): add runtime_libs path to runtime_dir Layout"
```

---

## Task 2：prepare 创建 libs 目录并保证升级保留

**Files:**
- Modify: `src-tauri/src/runtime_dir.rs:44-88`（`prepare` 函数）
- Test: `src-tauri/src/runtime_dir.rs:155-196`（`upgrade_refreshes_code_but_preserves_data_dirs`）

^- [x] **Step 1：写失败测试 — prepare 创建 libs 目录**

在 `tests` 模块追加：

```rust
    #[test]
    fn prepare_creates_runtime_libs_dir() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        assert!(layout.runtime_libs.exists(), "runtime_libs should be created");
        assert!(layout.runtime_libs.is_dir());
    }
```

^- [x] **Step 2：写失败测试 — 升级保留 libs 内容**

在 `tests` 模块追加（在既有 `upgrade_refreshes_code_but_preserves_data_dirs` 之后）：

```rust
    #[test]
    fn upgrade_preserves_runtime_libs_contents() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);
        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        // 模拟用户安装了一个包到 libs
        fs::create_dir_all(layout.runtime_libs.join("futu_api")).unwrap();
        fs::write(layout.runtime_libs.join("futu_api/__init__.py"), "# user installed").unwrap();

        // bundle 升级到 v2
        fs::write(bundle.join("agent/api_server.py"), "# v2").unwrap();
        fs::write(bundle.join("VERSION"), "2.0.0").unwrap();
        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        assert!(
            layout.runtime_libs.join("futu_api/__init__.py").exists(),
            "runtime_libs contents must survive an upgrade"
        );
        assert_eq!(
            fs::read_to_string(layout.runtime_libs.join("futu_api/__init__.py")).unwrap(),
            "# user installed"
        );
    }
```

^- [x] **Step 3：运行测试确认失败**

Run: `cd src-tauri && cargo test --lib runtime_dir::tests::prepare_creates_runtime_libs_dir runtime_dir::tests::upgrade_preserves_runtime_libs_contents`
Expected: FAIL（`runtime_libs` 目录未创建）。

^- [x] **Step 4：prepare 中创建 libs 目录**

在 `src-tauri/src/runtime_dir.rs` 的 `prepare` 函数，`fs::create_dir_all(&layout.root)` 之后（约第 60 行处）追加一行。将：

```rust
    fs::create_dir_all(&layout.root)
        .map_err(|e| format!("create root {:?}: {e}", layout.root))?;
```

改为：

```rust
    fs::create_dir_all(&layout.root)
        .map_err(|e| format!("create root {:?}: {e}", layout.root))?;
    // 可写可选依赖目录：始终确保存在；升级时不被清空（与 runtime_agent 的
    // copy_dir_recursive 无关——libs 永远是用户拥有的数据，不来自 bundle 模板）。
    fs::create_dir_all(&layout.runtime_libs)
        .map_err(|e| format!("create runtime_libs {:?}: {e}", layout.runtime_libs))?;
```

关键不变量：`copy_dir_recursive(bundle_agent, &layout.runtime_agent)` 只覆盖 `runtime/agent`，**从不触碰** `runtime/libs`。新增的 `create_dir_all` 是幂等的——目录已存在时是 no-op，因此升级路径不会清空 libs。

^- [x] **Step 5：运行测试确认通过**

Run: `cd src-tauri && cargo test --lib runtime_dir`
Expected: PASS（全部 6 个测试）。

^- [x] **Step 6：提交**

```bash
git add src-tauri/src/runtime_dir.rs
git commit -s -m "feat(desktop): prepare creates runtime_libs and preserves it on upgrade"
```

---

## Task 3：sidecar.rs 注入 VIBE_RUNTIME_LIBS 环境变量

**Files:**
- Modify: `src-tauri/src/sidecar.rs:11-47`（`BOOT` 常量、`build_cmd`、`spawn`）
- Modify: `src-tauri/src/sidecar.rs:111-167`（测试模块）
- Modify: `src-tauri/src/main.rs:68`（`boot` 调用 `spawn`）

^- [x] **Step 1：写失败测试 — build_cmd 注入 VIBE_RUNTIME_LIBS**

在 `src-tauri/src/sidecar.rs` 的 `tests` 模块追加：

```rust
    #[test]
    fn build_cmd_injects_runtime_libs_env() {
        let python = Path::new("/fake/python3");
        let agent = Path::new("/fake/agent");
        let libs = Path::new("/fake/libs");
        let cmd = build_cmd(python, agent, 8899, libs);

        let mut found = false;
        for (key, val) in cmd.get_envs() {
            if key.to_str() == Some("VIBE_RUNTIME_LIBS")
                && val.and_then(|v| v.to_str()) == Some("/fake/libs")
            {
                found = true;
            }
        }
        assert!(found, "VIBE_RUNTIME_LIBS not set to libs path");
    }
```

^- [x] **Step 2：运行测试确认失败**

Run: `cd src-tauri && cargo test --lib sidecar::tests::build_cmd_injects_runtime_libs_env`
Expected: 编译错误 — `build_cmd` 签名不接受 `libs` 参数。

^- [x] **Step 3：修改 build_cmd 与 spawn 签名**

修改 `src-tauri/src/sidecar.rs:16-47`。将 `build_cmd` 签名与 `PYTHONPATH` 之后的环境变量段改为：

```rust
pub fn build_cmd(
    python: &Path,
    runtime_agent: &Path,
    port: u16,
    runtime_libs: &Path,
) -> std::process::Command {
    let mut cmd = Command::new(python);
    cmd.arg("-c")
        .arg(BOOT)
        .arg("serve")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(runtime_agent)
        .env("PYTHONPATH", runtime_agent)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("VIBE_RUNTIME_LIBS", runtime_libs)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd
}
```

修改 `src-tauri/src/sidecar.rs:49-52` 的 `spawn`：

```rust
pub fn spawn(
    python: &Path,
    runtime_agent: &Path,
    port: u16,
    runtime_libs: &Path,
) -> Result<Child, String> {
    let mut cmd = build_cmd(python, runtime_agent, port, runtime_libs);
    cmd.spawn().map_err(|e| format!("spawn sidecar failed: {e}"))
}
```

^- [x] **Step 4：更新既有 build_cmd 测试以匹配新签名**

修改 `src-tauri/src/sidecar.rs:116-140` 的 `spawn_command_has_expected_args` 与 `src-tauri/src/sidecar.rs:149-160` 的 `build_cmd_includes_serve_args`，给 `build_cmd` 调用补上第 4 个参数 `Path::new("/fake/libs")`。例如：

```rust
        let cmd = build_cmd(python, agent, 8899, Path::new("/fake/libs"));
```

^- [x] **Step 5：运行测试确认通过**

Run: `cd src-tauri && cargo test --lib sidecar`
Expected: PASS（全部 sidecar 测试）。

^- [x] **Step 6：更新 main.rs 调用点**

修改 `src-tauri/src/main.rs:68`：

```rust
    let mut child = sidecar::spawn(&res.runtime_python, &layout.runtime_agent, p, &layout.runtime_libs)?;
```

^- [x] **Step 7：编译并运行全部 Rust 测试**

Run: `cd src-tauri && cargo test`
Expected: 编译通过，全部测试 PASS。

^- [x] **Step 8：提交**

```bash
git add src-tauri/src/sidecar.rs src-tauri/src/main.rs
git commit -s -m "feat(desktop): inject VIBE_RUNTIME_LIBS into sidecar spawn env"
```

---

## Task 4：cli 入口 sys.path.append 注入

**Files:**
- Modify: `agent/cli/main.py:19-34`（模块顶部 import 区之后）
- Test: `agent/tests/test_cli_runtime_libs.py`（新建）

^- [x] **Step 1：写失败测试 — 注入函数将 libs 追加到 sys.path 末尾**

新建 `agent/tests/test_cli_runtime_libs.py`：

```python
"""Tests for cli runtime libs sys.path injection."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path


def _reload_cli_main():
    """Reload cli.main so the module-level injection runs in this test."""
    import cli.main  # noqa: F401

    return importlib.reload(cli.main)


def test_injection_appends_libs_after_site_packages(monkeypatch, tmp_path):
    """VIBE_RUNTIME_LIBS pointing at an existing dir appends it to sys.path."""
    libs_dir = tmp_path / "libs"
    libs_dir.mkdir()
    monkeypatch.setenv("VIBE_RUNTIME_LIBS", str(libs_dir))

    # 清理：确保测试前 sys.path 不含该目录
    before = [p for p in sys.path if str(libs_dir) not in p]
    monkeypatch.setattr(sys, "path", list(before))

    _reload_cli_main()

    assert str(libs_dir) in sys.path
    # append 语义：libs 必须排在所有原有路径之后
    assert sys.path[-1] == str(libs_dir)


def test_injection_skips_missing_dir(monkeypatch, tmp_path):
    """A non-existent VIBE_RUNTIME_LIBS is silently skipped (no crash)."""
    missing = tmp_path / "does_not_exist"
    monkeypatch.setenv("VIBE_RUNTIME_LIBS", str(missing))
    monkeypatch.setattr(sys, "path", [p for p in sys.path if str(missing) not in p])

    _reload_cli_main()

    assert str(missing) not in sys.path


def test_injection_skips_when_env_unset(monkeypatch):
    """Without VIBE_RUNTIME_LIBS the path is untouched."""
    monkeypatch.delenv("VIBE_RUNTIME_LIBS", raising=False)
    baseline = list(sys.path)

    _reload_cli_main()

    assert sys.path == baseline
```

^- [x] **Step 2：运行测试确认失败**

Run: `cd agent && python -m pytest tests/test_cli_runtime_libs.py -q`
Expected: FAIL（注入逻辑尚不存在，`test_injection_appends_libs_after_site_packages` 找不到 libs 在 sys.path 中）。注：`agent/tests/` 已在 pytest 收集路径内。

^- [x] **Step 3：在 cli/main.py 顶部插入注入逻辑**

在 `agent/cli/main.py` 的 `from __future__ import annotations`（第 20 行）之后、`import importlib`（第 22 行）之前，插入以下块。**必须**在 `from cli.intro import ...` 等业务 import 之前，否则业务模块的 import 会早于 libs 被加载：

```python
# ---------------------------------------------------------------------------
# Optional-deps runtime libs: append the writable libs dir to sys.path.
# This MUST run before any business import so packages installed into
# ~/.vibe-trading/runtime/libs/ (by the optional-deps installer) are
# importable. ``append`` (not insert) keeps bundle site-packages FIRST,
# so a same-named package in libs never shadows a core bundled dependency.
# ---------------------------------------------------------------------------
_libs_dir = os.environ.get("VIBE_RUNTIME_LIBS")
if _libs_dir and Path(_libs_dir).is_dir():
    sys.path.append(_libs_dir)
```

注意：`os`、`sys`、`Path` 在此点必须已可用。将现有的 `import os` / `import sys`（第 23-24 行）与 `from pathlib import Path`（第 28 行）**上移**到 `from __future__ import annotations` 之后，使顺序为：

```python
from __future__ import annotations

import os
import sys
from pathlib import Path

# <注入块（上面那段）>

import importlib
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from cli.intro import print_banner
from cli.onboard import run_onboarding
from cli.theme import Theme, get_console
```

^- [x] **Step 4：运行测试确认通过**

Run: `cd agent && python -m pytest tests/test_cli_runtime_libs.py -q`
Expected: PASS（3 个测试）。

^- [x] **Step 5：语法检查**

Run: `cd agent && python -m py_compile cli/main.py`
Expected: 无输出（成功）。

^- [x] **Step 6：提交**

```bash
git add agent/cli/main.py agent/tests/test_cli_runtime_libs.py
git commit -s -m "feat(cli): inject VIBE_RUNTIME_LIBS into sys.path at import time"
```

---

## Task 5：optional_deps 包骨架 + registry schema 与初始清单

**Files:**
- Create: `agent/src/optional_deps/__init__.py`
- Create: `agent/src/optional_deps/registry.yaml`
- Test: `agent/src/optional_deps/tests/__init__.py`
- Test: `agent/src/optional_deps/tests/test_registry_loader.py`

- [x] **Step 1：创建包标记**

新建 `agent/src/optional_deps/__init__.py`：

```python
"""On-demand optional dependency management for the desktop runtime.

Exposes the registry loader, platform pre-check, pip-based installer, and
the FastAPI router mounted at ``/optional-deps`` by ``agent/api_server.py``.
"""
```

新建 `agent/src/optional_deps/tests/__init__.py`：（空文件）

- [x] **Step 2：写失败测试 — loader 加载 registry 并返回包名白名单**

新建 `agent/src/optional_deps/tests/test_registry_loader.py`：

```python
"""Tests for optional_deps.registry_loader."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.optional_deps.registry_loader import (
    RegistryEntry,
    load_registry,
)


def _write_registry(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "registry.yaml"
    p.write_text(body, encoding="utf-8")
    return p


def test_load_registry_returns_entries(tmp_path):
    reg = _write_registry(
        tmp_path,
        """
version: 1
brokers:
  - id: futu
    label: "富途 Futu"
    package: futu-api
    description: "Futu OpenAPI SDK"
    platforms: [macos_arm64, macos_x86_64, windows_amd64]
    recommended_mirror: tsinghua
""",
    )
    entries = load_registry(reg)
    assert len(entries) == 1
    e = entries[0]
    assert isinstance(e, RegistryEntry)
    assert e.id == "futu"
    assert e.package == "futu-api"
    assert e.platforms == ["macos_arm64", "macos_x86_64", "windows_amd64"]


def test_load_registry_white_lists_package_names(tmp_path):
    reg = _write_registry(
        tmp_path,
        """
version: 1
brokers:
  - id: a
    label: A
    package: pkg-a
    platforms: [macos_arm64]
  - id: b
    label: B
    package: pkg-b
    platforms: [windows_amd64]
""",
    )
    entries = load_registry(reg)
    names = {e.package for e in entries}
    assert names == {"pkg-a", "pkg-b"}


def test_load_registry_rejects_duplicate_packages(tmp_path):
    reg = _write_registry(
        tmp_path,
        """
version: 1
brokers:
  - id: a
    label: A
    package: dup-pkg
    platforms: [macos_arm64]
  - id: b
    label: B
    package: dup-pkg
    platforms: [windows_amd64]
""",
    )
    with pytest.raises(ValueError, match="duplicate package"):
        load_registry(reg)


def test_load_registry_rejects_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_registry(tmp_path / "nope.yaml")
```

- [x] **Step 3：运行测试确认失败**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_registry_loader.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.optional_deps.registry_loader'`。

- [x] **Step 4：创建 registry.yaml 初始清单**

新建 `agent/src/optional_deps/registry.yaml`：

```yaml
# Optional broker/capability → PyPI package registry.
# Single source of truth for the settings UI + the install API whitelist.
# platforms values: macos_arm64 | macos_x86_64 | windows_amd64
# recommended_mirror keys: tsinghua | aliyun | official
version: 1
brokers:
  - id: okx
    label: "OKX (crypto)"
    package: python-okx
    description: "OKX REST/WebSocket SDK"
    platforms: [macos_arm64, macos_x86_64, windows_amd64]
    recommended_mirror: tsinghua
  - id: futu
    label: "富途 Futu"
    package: futu-api
    description: "Futu OpenAPI SDK (sdist, pure Python)"
    platforms: [macos_arm64, macos_x86_64, windows_amd64]
    recommended_mirror: tsinghua
  - id: ibkr
    label: "Interactive Brokers"
    package: ib_async
    description: "ib_async — async IBKR client"
    platforms: [macos_arm64, macos_x86_64, windows_amd64]
    recommended_mirror: tsinghua
  - id: longbridge
    label: "Longbridge 长桥"
    package: longbridge
    description: "Longbridge SDK (native wheel, all platforms)"
    platforms: [macos_arm64, macos_x86_64, windows_amd64]
    recommended_mirror: tsinghua
  - id: tiger
    label: "老虎证券 Tiger"
    package: tigeropen
    description: "Tiger OpenAPI SDK"
    platforms: [macos_arm64, macos_x86_64, windows_amd64]
    recommended_mirror: tsinghua
  - id: alpaca
    label: "Alpaca"
    package: alpaca-py
    description: "Alpaca trading SDK"
    platforms: [macos_arm64, macos_x86_64, windows_amd64]
    recommended_mirror: tsinghua
  - id: dhan
    label: "Dhan (India)"
    package: dhanhq
    description: "Dhan HTTP API client"
    platforms: [macos_arm64, macos_x86_64, windows_amd64]
    recommended_mirror: tsinghua
  - id: shoonya
    label: "Shoonya (Finvasia)"
    package: NorenRestApiPy
    description: "Shoonya/Noren REST API wrapper"
    platforms: [macos_arm64, macos_x86_64, windows_amd64]
    recommended_mirror: tsinghua
  - id: vnpy_ctp
    label: "vnpy CTP (期货)"
    package: vnpy_ctp
    description: "vnpy CTP gateway — Windows only (native CTP binding)"
    platforms: [windows_amd64]
    recommended_mirror: tsinghua
```

- [x] **Step 5：实现 registry_loader.py**

新建 `agent/src/optional_deps/registry_loader.py`：

```python
"""Load and validate the optional-deps registry.

The registry (``registry.yaml``) is the single source of truth for which
broker packages the install API will accept. The loader raises on
duplicates or malformed entries so a bad registry fails fast at startup.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import List

import yaml

# Default registry location: shipped alongside this module.
DEFAULT_REGISTRY_PATH = Path(__file__).resolve().parent / "registry.yaml"

_VALID_PLATFORMS = frozenset(
    {"macos_arm64", "macos_x86_64", "windows_amd64"}
)
_VALID_MIRRORS = frozenset({"tsinghua", "aliyun", "official", "custom", "off"})


@dataclass(frozen=True)
class RegistryEntry:
    """One broker/capability row in the registry."""

    id: str
    label: str
    package: str
    description: str
    platforms: List[str] = field(default_factory=list)
    recommended_mirror: str = "tsinghua"


def load_registry(path: Path = DEFAULT_REGISTRY_PATH) -> List[RegistryEntry]:
    """Load and validate the registry.

    Args:
        path: Path to ``registry.yaml``. Defaults to the bundled copy.

    Returns:
        List of validated :class:`RegistryEntry`.

    Raises:
        FileNotFoundError: When ``path`` does not exist.
        ValueError: On duplicate package names, unknown platforms/mirrors,
            or missing required fields.
    """
    if not path.exists():
        raise FileNotFoundError(f"registry not found: {path}")

    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    brokers = raw.get("brokers") or []

    entries: List[RegistryEntry] = []
    seen_packages: set[str] = set()
    for row in brokers:
        package = (row.get("package") or "").strip()
        entry_id = (row.get("id") or "").strip()
        if not package:
            raise ValueError(f"registry entry {entry_id!r} missing 'package'")
        if package in seen_packages:
            raise ValueError(f"duplicate package in registry: {package}")
        seen_packages.add(package)

        platforms = list(row.get("platforms") or [])
        bad_platforms = [p for p in platforms if p not in _VALID_PLATFORMS]
        if bad_platforms:
            raise ValueError(
                f"registry entry {entry_id!r} has unknown platforms: {bad_platforms}"
            )

        mirror = row.get("recommended_mirror") or "tsinghua"
        if mirror not in _VALID_MIRRORS:
            raise ValueError(
                f"registry entry {entry_id!r} has unknown mirror: {mirror}"
            )

        entries.append(
            RegistryEntry(
                id=entry_id,
                label=(row.get("label") or package),
                package=package,
                description=(row.get("description") or ""),
                platforms=platforms,
                recommended_mirror=mirror,
            )
        )
    return entries


def package_whitelist(entries: List[RegistryEntry]) -> set[str]:
    """Return the set of accepted package names."""
    return {e.package for e in entries}
```

- [x] **Step 6：运行测试确认通过**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_registry_loader.py -q`
Expected: PASS（4 个测试）。

- [x] **Step 7：提交**

```bash
git add agent/src/optional_deps/
git commit -s -m "feat(optional-deps): registry yaml + loader with whitelist validation"
```

---

## Task 6：platform 当前平台标签 + wheel 预检

**Files:**
- Create: `agent/src/optional_deps/platform.py`
- Test: `agent/src/optional_deps/tests/test_platform.py`

- [x] **Step 1：写失败测试 — 当前平台标签与预检**

新建 `agent/src/optional_deps/tests/test_platform.py`：

```python
"""Tests for optional_deps.platform pre-check."""

from __future__ import annotations

from src.optional_deps.platform import current_platform_tag, is_supported_on_current_platform


def test_current_platform_tag_returns_known_value():
    tag = current_platform_tag()
    assert tag in {"macos_arm64", "macos_x86_64", "windows_amd64"}


def test_supported_when_tag_in_list(monkeypatch):
    monkeypatch.setattr(
        "src.optional_deps.platform.current_platform_tag",
        lambda: "macos_arm64",
    )
    assert is_supported_on_current_platform(["macos_arm64", "windows_amd64"]) is True


def test_unsupported_when_tag_absent(monkeypatch):
    """vnpy_ctp on macOS arm64 must be rejected."""
    monkeypatch.setattr(
        "src.optional_deps.platform.current_platform_tag",
        lambda: "macos_arm64",
    )
    assert is_supported_on_current_platform(["windows_amd64"]) is False


def test_supported_when_no_platform_listed(monkeypatch):
    """An empty platform list is treated as 'available everywhere' (lenient)."""
    monkeypatch.setattr(
        "src.optional_deps.platform.current_platform_tag",
        lambda: "macos_arm64",
    )
    assert is_supported_on_current_platform([]) is True
```

- [x] **Step 2：运行测试确认失败**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_platform.py -q`
Expected: FAIL — `ModuleNotFoundError`。

- [x] **Step 3：实现 platform.py**

新建 `agent/src/optional_deps/platform.py`：

```python
"""Detect the current platform tag and pre-check wheel availability.

The install API rejects a package whose registry ``platforms`` list does
not include the current tag — this avoids triggering a source build
(which would fail without a local compiler) for packages like
``vnpy_ctp`` that only ship a ``win_amd64`` wheel.
"""

from __future__ import annotations

import platform as _platform
import sys
from typing import Iterable


def current_platform_tag() -> str:
    """Return the registry platform tag for the running interpreter.

    Maps the Python ``platform.machine()`` + ``sys.platform`` to one of
    the registry's known tags.
    """
    machine = _platform.machine().lower()
    if sys.platform.startswith("win"):
        # CPython wheels on 64-bit Windows are tagged ``win_amd64``.
        return "windows_amd64"
    if sys.platform == "darwin":
        if machine in {"arm64", "aarch64"}:
            return "macos_arm64"
        return "macos_x86_64"
    # Linux desktop is not a first-class target for this change, but we
    # tag it as the closest arch so a Linux dev box can still install the
    # pure-Python brokers for testing.
    if machine in {"arm64", "aarch64"}:
        return "macos_arm64"
    return "macos_x86_64"


def is_supported_on_current_platform(supported: Iterable[str]) -> bool:
    """Return True when the current tag is in ``supported``.

    An empty ``supported`` list means "no platform restriction declared"
    (treat as universally available) so a registry entry with a missing
    platforms field does not block every install.
    """
    tags = list(supported)
    if not tags:
        return True
    return current_platform_tag() in tags
```

- [x] **Step 4：运行测试确认通过**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_platform.py -q`
Expected: PASS（4 个测试）。

- [x] **Step 5：提交**

```bash
git add agent/src/optional_deps/platform.py agent/src/optional_deps/tests/test_platform.py
git commit -s -m "feat(optional-deps): platform tag detection + wheel pre-check"
```

---

## Task 7：mirror 镜像配置读写

**Files:**
- Create: `agent/src/optional_deps/mirror.py`
- Test: `agent/src/optional_deps/tests/test_mirror.py`

- [x] **Step 1：写失败测试 — 镜像读写与默认值**

新建 `agent/src/optional_deps/tests/test_mirror.py`：

```python
"""Tests for optional_deps.mirror config persistence."""

from __future__ import annotations

import json
from pathlib import Path

from src.optional_deps.mirror import (
    DEFAULT_MIRROR,
    MIRROR_URLS,
    MirrorConfig,
    load_mirror_config,
    resolve_index_url,
    save_mirror_config,
)


def test_default_mirror_is_tsinghua(tmp_path):
    cfg = load_mirror_config(tmp_path / "mirror.json")
    assert cfg.name == DEFAULT_MIRROR == "tsinghua"
    assert cfg.custom_index_url == ""


def test_save_then_load_roundtrip(tmp_path):
    path = tmp_path / "mirror.json"
    save_mirror_config(
        MirrorConfig(name="aliyun", custom_index_url=""), path
    )
    cfg = load_mirror_config(path)
    assert cfg.name == "aliyun"


def test_custom_mirror_persists_url(tmp_path):
    path = tmp_path / "mirror.json"
    save_mirror_config(
        MirrorConfig(name="custom", custom_index_url="https://my.mirror/simple"),
        path,
    )
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw["custom_index_url"] == "https://my.mirror/simple"
    cfg = load_mirror_config(path)
    assert cfg.custom_index_url == "https://my.mirror/simple"


def test_resolve_index_url_tsinghua():
    cfg = MirrorConfig(name="tsinghua", custom_index_url="")
    assert resolve_index_url(cfg) == MIRROR_URLS["tsinghua"]


def test_resolve_index_url_off_returns_empty():
    """Mirror 'off' → empty string → pip uses official PyPI default."""
    cfg = MirrorConfig(name="off", custom_index_url="")
    assert resolve_index_url(cfg) == ""


def test_resolve_index_url_custom_uses_custom_url():
    cfg = MirrorConfig(name="custom", custom_index_url="https://x/simple")
    assert resolve_index_url(cfg) == "https://x/simple"
```

- [x] **Step 2：运行测试确认失败**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_mirror.py -q`
Expected: FAIL — `ModuleNotFoundError`。

- [x] **Step 3：实现 mirror.py**

新建 `agent/src/optional_deps/mirror.py`：

```python
"""Mirror config persistence for the optional-deps installer.

The chosen PyPI mirror is stored as JSON under
``~/.vibe-trading/runtime/optional_deps_mirror.json`` so it survives
restarts and is independent of the bundle template (which only manages
``runtime/agent``).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

MIRROR_URLS = {
    "tsinghua": "https://pypi.tuna.tsinghua.edu.cn/simple",
    "aliyun": "https://mirrors.aliyun.com/pypi/simple",
    "official": "https://pypi.org/simple",
}

DEFAULT_MIRROR = "tsinghua"

_VALID_NAMES = {"tsinghua", "aliyun", "official", "custom", "off"}


def default_config_path() -> Path:
    """Return the on-disk config path under the writable runtime root."""
    return Path.home() / ".vibe-trading" / "runtime" / "optional_deps_mirror.json"


@dataclass
class MirrorConfig:
    """Persisted mirror selection.

    Attributes:
        name: One of tsinghua / aliyun / official / custom / off.
            ``off`` means "no index-url override" (pip uses official PyPI).
        custom_index_url: Only used when ``name == "custom"``.
    """

    name: str = DEFAULT_MIRROR
    custom_index_url: str = ""


def load_mirror_config(path: Optional[Path] = None) -> MirrorConfig:
    """Load the mirror config, falling back to the default when absent."""
    path = path or default_config_path()
    if not path.exists():
        return MirrorConfig()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return MirrorConfig()
    name = str(raw.get("name") or DEFAULT_MIRROR)
    if name not in _VALID_NAMES:
        name = DEFAULT_MIRROR
    return MirrorConfig(
        name=name,
        custom_index_url=str(raw.get("custom_index_url") or ""),
    )


def save_mirror_config(config: MirrorConfig, path: Optional[Path] = None) -> None:
    """Persist the mirror config to disk."""
    path = path or default_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(asdict(config), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def resolve_index_url(config: MirrorConfig) -> str:
    """Return the ``--index-url`` value for pip, or ``""`` for official PyPI.

    ``""`` instructs the installer to omit ``--index-url`` entirely so pip
    falls back to its built-in official index.
    """
    if config.name == "off":
        return ""
    if config.name == "custom":
        return config.custom_index_url.strip()
    return MIRROR_URLS.get(config.name, MIRROR_URLS[DEFAULT_MIRROR])


def resolve_trusted_host(config: MirrorConfig) -> str:
    """Return the ``--trusted-host`` value for non-HTTPS mirrors, else ``""``.

    All bundled mirrors use HTTPS, so this is normally empty. Exposed so a
    user-configured ``http://`` custom mirror can still install.
    """
    url = resolve_index_url(config)
    if url.startswith("https://"):
        return ""
    # Strip scheme + path to get the bare host.
    bare = url.split("://", 1)[-1].split("/", 1)[0]
    return bare
```

- [x] **Step 4：运行测试确认通过**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_mirror.py -q`
Expected: PASS（6 个测试）。

- [x] **Step 5：提交**

```bash
git add agent/src/optional_deps/mirror.py agent/src/optional_deps/tests/test_mirror.py
git commit -s -m "feat(optional-deps): mirror config persistence with tsinghua default"
```

---

## Task 8：installer pip 子进程 + 已装状态扫描

**Files:**
- Create: `agent/src/optional_deps/installer.py`
- Test: `agent/src/optional_deps/tests/test_installer.py`

- [x] **Step 1：写失败测试 — 已装状态扫描与命令构造**

新建 `agent/src/optional_deps/tests/test_installer.py`：

```python
"""Tests for optional_deps.installer (pure logic; no real pip run)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from src.optional_deps.installer import (
    InstalledPackage,
    build_pip_args,
    scan_installed,
)


def _make_dist_info(libs: Path, name: str) -> None:
    d = libs / f"{name}.dist-info"
    d.mkdir(parents=True)
    (d / "METADATA").write_text(f"Name: {name}\Version: 1.0\n", encoding="utf-8")


def test_scan_installed_returns_dist_info_names(tmp_path):
    libs = tmp_path / "libs"
    libs.mkdir()
    _make_dist_info(libs, "futu_api")
    _make_dist_info(libs, "ib_async")

    installed = scan_installed(libs)
    names = {p.name for p in installed}
    assert names == {"futu_api", "ib_async"}


def test_scan_installed_normalizes_dashes(tmp_path):
    """PyPI ``futu-api`` installs as ``futu_api`` (normalized import name)."""
    libs = tmp_path / "libs"
    libs.mkdir()
    _make_dist_info(libs, "futu_api")

    installed = scan_installed(libs)
    # registry package name is ``futu-api``; scan should report the dist-info name
    assert any(p.name == "futu_api" for p in installed)


def test_scan_installed_empty_when_dir_missing(tmp_path):
    installed = scan_installed(tmp_path / "nope")
    assert installed == []


def test_build_pip_args_uses_target_and_index(tmp_path):
    libs = tmp_path / "libs"
    args = build_pip_args(
        python=sys.executable,
        libs_dir=libs,
        package="futu-api",
        index_url="https://pypi.tuna.tsinghua.edu.cn/simple",
        trusted_host="",
    )
    joined = " ".join(args)
    assert "--target" in joined
    assert str(libs) in joined
    assert "futu-api" in joined
    assert "--index-url" in joined
    assert "pypi.tuna.tsinghua.edu.cn" in joined


def test_build_pip_args_omits_index_url_when_empty(tmp_path):
    libs = tmp_path / "libs"
    args = build_pip_args(
        python=sys.executable,
        libs_dir=libs,
        package="futu-api",
        index_url="",
        trusted_host="",
    )
    assert "--index-url" not in args
    assert "futu-api" in args


def test_build_pip_args_includes_trusted_host_when_set(tmp_path):
    libs = tmp_path / "libs"
    args = build_pip_args(
        python=sys.executable,
        libs_dir=libs,
        package="futu-api",
        index_url="http://insecure.mirror/simple",
        trusted_host="insecure.mirror",
    )
    assert "--trusted-host" in args
    assert "insecure.mirror" in args
```

- [x] **Step 2：运行测试确认失败**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_installer.py -q`
Expected: FAIL — `ModuleNotFoundError`。

- [x] **Step 3：实现 installer.py**

新建 `agent/src/optional_deps/installer.py`：

```python
"""pip-based installer for optional deps into the writable libs dir.

The installer runs the embedded runtime's own pip as a subprocess:

    python3 -m pip install --target <libs_dir> [--index-url ...] <package>

``--target`` writes into ``~/.vibe-trading/runtime/libs/`` without touching
the read-only bundle site-packages. stdout is streamed line-by-line for
SSE progress. No ``--require-hashes`` (YAGNI; the registry whitelist +
HTTPS mirror are the safety boundary).
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, List, Optional


@dataclass(frozen=True)
class InstalledPackage:
    """One package detected under the libs dir via its ``.dist-info``."""

    name: str
    version: str


def scan_installed(libs_dir: Path) -> List[InstalledPackage]:
    """Scan ``libs_dir`` for ``*.dist-info`` and return installed packages.

    Returns an empty list when the directory does not exist yet.
    """
    if not libs_dir.exists():
        return []
    results: List[InstalledPackage] = []
    for entry in sorted(libs_dir.iterdir()):
        if not entry.is_dir() or not entry.name.endswith(".dist-info"):
            continue
        name = entry.name[: -len(".dist-info")]
        # dist-info dirs are ``<name>-<version>``; split off the version.
        version = ""
        if "-" in name:
            name, version = name.rsplit("-", 1)
        results.append(InstalledPackage(name=name, version=version))
    return results


def build_pip_args(
    python: str,
    libs_dir: str,
    package: str,
    index_url: str,
    trusted_host: str,
) -> List[str]:
    """Build the argv for ``python -m pip install --target``.

    Args:
        python: Path to the embedded interpreter executable.
        libs_dir: Writable target directory.
        package: PyPI package name (already whitelist-validated).
        index_url: ``--index-url`` value, or ``""`` to omit (official PyPI).
        trusted_host: ``--trusted-host`` value, or ``""`` to omit.

    Returns:
        Argv list suitable for :func:`subprocess.Popen`.
    """
    args = [
        python,
        "-m",
        "pip",
        "install",
        "--target",
        str(libs_dir),
        "--no-input",
        "--disable-pip-version-check",
    ]
    if index_url:
        args += ["--index-url", index_url]
    if trusted_host:
        args += ["--trusted-host", trusted_host]
    args.append(package)
    return args


def run_install(
    python: str,
    libs_dir: str,
    package: str,
    index_url: str,
    trusted_host: str,
) -> Iterator[str]:
    """Run pip and yield each stdout/stderr line for SSE streaming.

    Yields lines (stripped of trailing newline) as they arrive. Raises
    :class:`subprocess.CalledProcessError` on non-zero exit, after
    flushing all remaining output.
    """
    args = build_pip_args(
        python=python,
        libs_dir=libs_dir,
        package=package,
        index_url=index_url,
        trusted_host=trusted_host,
    )
    proc = subprocess.Popen(  # noqa: S603 — argv is built internally, not from user shell input
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            yield line.rstrip("\n")
    finally:
        proc.stdout.close()
        rc = proc.wait()
        if rc != 0:
            raise subprocess.CalledProcessError(rc, args)


def build_uninstall_args(
    python: str,
    libs_dir: str,
    package: str,
) -> List[str]:
    """Build argv for ``pip uninstall`` scoped to the target dir.

    pip's uninstall targets the ``--target`` dir's records, removing only
    the files it installed there (not bundle site-packages).
    """
    return [
        python,
        "-m",
        "pip",
        "uninstall",
        "-y",
        "--target",
        str(libs_dir),
        package,
    ]


def run_uninstall(
    python: str,
    libs_dir: str,
    package: str,
) -> Iterator[str]:
    """Run pip uninstall and yield stdout lines."""
    args = build_uninstall_args(python, libs_dir, package)
    proc = subprocess.Popen(  # noqa: S603
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            yield line.rstrip("\n")
    finally:
        proc.stdout.close()
        rc = proc.wait()
        if rc != 0:
            raise subprocess.CalledProcessError(rc, args)


def default_python_executable() -> str:
    """Return the interpreter to use for pip. Defaults to ``sys.executable``."""
    return sys.executable
```

- [x] **Step 4：运行测试确认通过**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_installer.py -q`
Expected: PASS（6 个测试）。

- [x] **Step 5：提交**

```bash
git add agent/src/optional_deps/installer.py agent/src/optional_deps/tests/test_installer.py
git commit -s -m "feat(optional-deps): pip installer with --target and dist-info scan"
```

---

## Task 9：sse_lines 帧格式化

**Files:**
- Create: `agent/src/optional_deps/sse_lines.py`
- Test: `agent/src/optional_deps/tests/test_sse_lines.py`

- [ ] **Step 1：写失败测试 — SSE 帧格式**

新建 `agent/src/optional_deps/tests/test_sse_lines.py`：

```python
"""Tests for optional_deps.sse_lines frame formatting."""

from __future__ import annotations

import json

from src.optional_deps.sse_lines import sse_event, stage_line


def test_stage_line_emits_json_with_stage():
    frame = stage_line("downloading", message="Fetching futu-api")
    assert frame.startswith("event: progress")
    assert frame.endswith("\n\n")
    data_line = [l for l in frame.splitlines() if l.startswith("data: ")][0]
    payload = json.loads(data_line[len("data: "):])
    assert payload["stage"] == "downloading"
    assert payload["message"] == "Fetching futu-api"


def test_sse_event_formats_done():
    frame = sse_event("done", {"package": "futu-api"})
    assert "event: done" in frame
    assert frame.endswith("\n\n")
    assert "futu-api" in frame


def test_sse_event_escapes_newlines_in_data():
    """SSE spec: a literal newline in data must be prefixed with another."""
    frame = sse_event("progress", {"message": "line1\nline2"})
    # Each newline in the JSON value must be escaped for SSE transport.
    assert "event: progress" in frame
```

- [ ] **Step 2：运行测试确认失败**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_sse_lines.py -q`
Expected: FAIL — `ModuleNotFoundError`。

- [ ] **Step 3：实现 sse_lines.py**

新建 `agent/src/optional_deps/sse_lines.py`：

```python
"""SSE frame formatting for the optional-deps install stream.

Frames use the standard ``event: <name>\\ndata: <json>\\n\\n`` shape so
the browser ``EventSource`` (or our fetch-based reader) dispatches them
to typed listeners. ``data`` is always a single-line JSON blob so we
never emit a raw newline inside the data field.
"""

from __future__ import annotations

import json
from typing import Any, Dict


def sse_event(event: str, data: Dict[str, Any]) -> str:
    """Format one SSE frame.

    Args:
        event: The SSE event name (``progress`` / ``done`` / ``failed``).
        data: JSON-serializable payload.

    Returns:
        A frame string ending in ``\\n\\n``.
    """
    # ensure_ascii=False keeps Chinese mirror/source names readable in the
    # browser console; json.dumps escapes any embedded newlines to ``\\n``
    # so the SSE data line stays single-line.
    body = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {body}\n\n"


def stage_line(stage: str, message: str = "") -> str:
    """Convenience wrapper for a ``progress`` frame carrying a stage + line."""
    return sse_event("progress", {"stage": stage, "message": message})
```

- [ ] **Step 4：运行测试确认通过**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_sse_lines.py -q`
Expected: PASS（3 个测试）。

- [ ] **Step 5：提交**

```bash
git add agent/src/optional_deps/sse_lines.py agent/src/optional_deps/tests/test_sse_lines.py
git commit -s -m "feat(optional-deps): SSE progress frame formatting"
```

---

## Task 10：API 路由（list/install/uninstall/status/mirror）

**Files:**
- Create: `agent/src/optional_deps/api.py`
- Test: `agent/src/optional_deps/tests/test_api.py`

- [ ] **Step 1：写失败测试 — list、白名单拒绝、平台预检、mirror 读写**

新建 `agent/src/optional_deps/tests/test_api.py`：

```python
"""Tests for the optional_deps FastAPI router."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.optional_deps import api as optional_api


@pytest.fixture()
def isolated_env(tmp_path, monkeypatch):
    """Point all paths at tmp_path so tests never touch the real home."""
    libs = tmp_path / "libs"
    libs.mkdir()
    mirror_path = tmp_path / "mirror.json"
    monkeypatch.setattr(
        "src.optional_deps.api._libs_dir",
        lambda: libs,
    )
    monkeypatch.setattr(
        "src.optional_deps.mirror.default_config_path",
        lambda: mirror_path,
    )
    monkeypatch.setattr(
        "src.optional_deps.api._registry_entries",
        lambda: optional_api._load_entries(),
    )
    return libs


@pytest.fixture()
def client(isolated_env):
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(optional_api.router)
    return TestClient(app)


def test_list_returns_registry_with_not_installed(client):
    resp = client.get("/optional-deps/list")
    assert resp.status_code == 200
    body = resp.json()
    pkgs = {b["package"]: b for b in body["brokers"]}
    assert "futu-api" in pkgs
    assert pkgs["futu-api"]["installed"] is False


def test_list_marks_installed_when_dist_info_present(client, isolated_env):
    d = isolated_env / "futu_api.dist-info"
    d.mkdir()
    (d / "METADATA").write_text("Name: futu_api\n", encoding="utf-8")

    resp = client.get("/optional-deps/list")
    pkgs = {b["package"]: b for b in resp.json()["brokers"]}
    assert pkgs["futu-api"]["installed"] is True


def test_install_rejects_unknown_package(client):
    resp = client.post(
        "/optional-deps/install", json={"package": "evil-pkg"}
    )
    assert resp.status_code == 400
    assert "not in registry" in resp.json()["detail"].lower()


def test_mirror_get_returns_default(client):
    resp = client.get("/optional-deps/mirror")
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "tsinghua"


def test_mirror_put_persists_selection(client):
    resp = client.put(
        "/optional-deps/mirror",
        json={"name": "aliyun", "custom_index_url": ""},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "aliyun"

    # Second GET reflects the persisted value.
    assert client.get("/optional-deps/mirror").json()["name"] == "aliyun"
```

- [ ] **Step 2：运行测试确认失败**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_api.py -q`
Expected: FAIL — `ModuleNotFoundError`。

- [ ] **Step 3：实现 api.py**

新建 `agent/src/optional_deps/api.py`：

```python
"""FastAPI router for on-demand optional dependency management.

Mounted by ``agent/api_server.py`` at ``/optional-deps``. All routes are
gated by the same loopback-or-auth dependency as the other settings
endpoints (the caller wires that in at mount time).

Routes:
    GET  /optional-deps/list              — registry + installed status
    POST /optional-deps/install           — whitelist + platform check, returns job id
    POST /optional-deps/uninstall
    GET  /optional-deps/status/{job_id}   — SSE stream of pip stdout
    GET  /optional-deps/mirror
    PUT  /optional-deps/mirror
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.optional_deps.installer import (
    InstalledPackage,
    default_python_executable,
    run_install,
    run_uninstall,
    scan_installed,
)
from src.optional_deps.mirror import (
    MirrorConfig,
    load_mirror_config,
    resolve_index_url,
    resolve_trusted_host,
    save_mirror_config,
)
from src.optional_deps.platform import is_supported_on_current_platform
from src.optional_deps.registry_loader import (
    DEFAULT_REGISTRY_PATH,
    RegistryEntry,
    load_registry,
)
from src.optional_deps.sse_lines import sse_event, stage_line

router = APIRouter(prefix="/optional-deps", tags=["optional-deps"])

# ---------------------------------------------------------------------------
# Path accessors — overridable in tests via monkeypatch.
# ---------------------------------------------------------------------------


def _libs_dir() -> Path:
    """Return the writable libs directory."""
    return Path.home() / ".vibe-trading" / "runtime" / "libs"


def _load_entries(path: Path = DEFAULT_REGISTRY_PATH) -> List[RegistryEntry]:
    """Load the registry entries (cached per-process)."""
    return load_registry(path)


def _registry_entries() -> List[RegistryEntry]:
    return _load_entries()


# ---------------------------------------------------------------------------
# In-memory job store for SSE status streams.
# ---------------------------------------------------------------------------


class _Job:
    """A pip install/uninstall job with a line buffer for SSE replay."""

    def __init__(self, package: str, kind: str) -> None:
        self.job_id = uuid.uuid4().hex
        self.package = package
        self.kind = kind  # "install" | "uninstall"
        self.lines: List[str] = []
        self.done = False
        self.failed = False
        self.error: str = ""
        self.queue: asyncio.Queue = asyncio.Queue()


_jobs: Dict[str, _Job] = {}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class BrokerStatus(BaseModel):
    id: str
    label: str
    package: str
    description: str
    platforms: List[str]
    recommended_mirror: str
    installed: bool
    installed_version: str = ""


class ListResponse(BaseModel):
    brokers: List[BrokerStatus]


class InstallRequest(BaseModel):
    package: str = Field(..., min_length=1, max_length=128)


class InstallResponse(BaseModel):
    job_id: str
    status: str


class UninstallResponse(BaseModel):
    status: str


class MirrorResponse(BaseModel):
    name: str
    custom_index_url: str
    available: Dict[str, str] = Field(
        default_factory=lambda: {
            "tsinghua": "https://pypi.tuna.tsinghua.edu.cn/simple",
            "aliyun": "https://mirrors.aliyun.com/pypi/simple",
            "official": "https://pypi.org/simple",
        }
    )


class UpdateMirrorRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=32)
    custom_index_url: str = Field("", max_length=512)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _entry_by_package(package: str) -> Optional[RegistryEntry]:
    for entry in _registry_entries():
        if entry.package == package:
            return entry
    return None


def _installed_map(libs: Path) -> Dict[str, InstalledPackage]:
    return {pkg.name.lower(): pkg for pkg in scan_installed(libs)}


def _normalize_name(name: str) -> str:
    """PyPI normalizes ``-``/``_``/``.`` to the same token."""
    return name.lower().replace("-", "_").replace(".", "_")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/list", response_model=ListResponse)
async def list_optional_deps() -> ListResponse:
    """Return registry entries annotated with installed status."""
    libs = _libs_dir()
    installed = _installed_map(libs)
    rows: List[BrokerStatus] = []
    for entry in _registry_entries():
        key = _normalize_name(entry.package)
        pkg = installed.get(key)
        rows.append(
            BrokerStatus(
                id=entry.id,
                label=entry.label,
                package=entry.package,
                description=entry.description,
                platforms=list(entry.platforms),
                recommended_mirror=entry.recommended_mirror,
                installed=bool(pkg),
                installed_version=pkg.version if pkg else "",
            )
        )
    return ListResponse(brokers=rows)


@router.post("/install", response_model=InstallResponse)
async def install_optional_dep(req: InstallRequest) -> InstallResponse:
    """Start a background pip install for a whitelisted package.

    Returns a ``job_id`` immediately; poll/subscribe via ``/status/{job_id}``.
    """
    entry = _entry_by_package(req.package)
    if entry is None:
        raise HTTPException(
            status_code=400,
            detail=f"package '{req.package}' is not in registry whitelist",
        )
    if not is_supported_on_current_platform(entry.platforms):
        raise HTTPException(
            status_code=400,
            detail=(
                f"package '{req.package}' has no prebuilt wheel for the "
                f"current platform; supported: {entry.platforms}"
            ),
        )

    job = _Job(package=req.package, kind="install")
    _jobs[job.job_id] = job
    asyncio.create_task(_run_install_job(job))
    return InstallResponse(job_id=job.job_id, status="started")


@router.post("/uninstall", response_model=UninstallResponse)
async def uninstall_optional_dep(req: InstallRequest) -> UninstallResponse:
    """Uninstall a whitelisted package from the libs dir."""
    entry = _entry_by_package(req.package)
    if entry is None:
        raise HTTPException(
            status_code=400,
            detail=f"package '{req.package}' is not in registry whitelist",
        )
    job = _Job(package=req.package, kind="uninstall")
    _jobs[job.job_id] = job
    asyncio.create_task(_run_uninstall_job(job))
    return UninstallResponse(status="started")


@router.get("/status/{job_id}")
async def install_status(job_id: str):
    """SSE stream of pip progress for a job."""
    from fastapi.responses import StreamingResponse

    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job_id: {job_id}")

    async def event_stream():
        # Replay buffered lines first (covers late subscribers).
        for line in job.lines:
            yield stage_line("downloading", line)
        # Then stream live until done/failed.
        while not job.done:
            try:
                line = await asyncio.wait_for(job.queue.get(), timeout=1.0)
                job.lines.append(line)
                yield stage_line("downloading", line)
            except asyncio.TimeoutError:
                if job.done:
                    break
                continue
        if job.failed:
            yield sse_event(
                "failed",
                {"package": job.package, "error": job.error},
            )
        else:
            yield sse_event("done", {"package": job.package})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/mirror", response_model=MirrorResponse)
async def get_mirror() -> MirrorResponse:
    cfg = load_mirror_config()
    return MirrorResponse(name=cfg.name, custom_index_url=cfg.custom_index_url)


@router.put("/mirror", response_model=MirrorResponse)
async def put_mirror(req: UpdateMirrorRequest) -> MirrorResponse:
    cfg = MirrorConfig(name=req.name, custom_index_url=req.custom_index_url)
    if cfg.name == "custom" and not cfg.custom_index_url.strip():
        raise HTTPException(
            status_code=400,
            detail="custom_index_url is required when name=custom",
        )
    save_mirror_config(cfg)
    return MirrorResponse(name=cfg.name, custom_index_url=cfg.custom_index_url)


# ---------------------------------------------------------------------------
# Background workers
# ---------------------------------------------------------------------------


async def _run_install_job(job: _Job) -> None:
    """Run pip in a thread, forwarding lines to the job's asyncio queue."""
    cfg = load_mirror_config()
    index_url = resolve_index_url(cfg)
    trusted_host = resolve_trusted_host(cfg)
    python = default_python_executable()
    libs = str(_libs_dir())

    loop = asyncio.get_event_loop()

    def _blocking() -> None:
        import subprocess  # local to keep module import side-effect free

        try:
            for line in run_install(
                python=python,
                libs_dir=libs,
                package=job.package,
                index_url=index_url,
                trusted_host=trusted_host,
            ):
                asyncio.run_coroutine_threadsafe(job.queue.put(line), loop)
        except subprocess.CalledProcessError as exc:
            job.failed = True
            job.error = f"pip exited with code {exc.returncode}"
        except Exception as exc:  # noqa: BLE001
            job.failed = True
            job.error = str(exc)

    await loop.run_in_executor(None, _blocking)
    job.done = True


async def _run_uninstall_job(job: _Job) -> None:
    loop = asyncio.get_event_loop()
    python = default_python_executable()
    libs = str(_libs_dir())

    def _blocking() -> None:
        import subprocess

        try:
            for line in run_uninstall(
                python=python,
                libs_dir=libs,
                package=job.package,
            ):
                asyncio.run_coroutine_threadsafe(job.queue.put(line), loop)
        except subprocess.CalledProcessError as exc:
            job.failed = True
            job.error = f"pip exited with code {exc.returncode}"
        except Exception as exc:  # noqa: BLE001
            job.failed = True
            job.error = str(exc)

    await loop.run_in_executor(None, _blocking)
    job.done = True
```

- [ ] **Step 4：运行测试确认通过**

Run: `cd agent && python -m pytest src/optional_deps/tests/test_api.py -q`
Expected: PASS（5 个测试）。注：`test_install_rejects_unknown_package` 与平台预检路径不触发真实 pip（`evil-pkg` 在白名单校验即被拒）。

- [ ] **Step 5：提交**

```bash
git add agent/src/optional_deps/api.py agent/src/optional_deps/tests/test_api.py
git commit -s -m "feat(optional-deps): FastAPI router with list/install/uninstall/status/mirror"
```

---

## Task 11：挂载路由到 api_server.py

**Files:**
- Modify: `agent/api_server.py`（在 swarm 路由块之后、文件末尾前）

- [ ] **Step 1：写失败测试 — /optional-deps/list 通过主 app 可达**

新建 `agent/tests/test_api_server_optional_deps.py`：

```python
"""Smoke test: the optional-deps router is mounted on the main app."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_optional_deps_list_mounted():
    # Import lazily so the app is constructed with the router wired in.
    import api_server

    client = TestClient(api_server.app)
    resp = client.get("/optional-deps/list")
    assert resp.status_code == 200
    body = resp.json()
    assert "brokers" in body
    assert isinstance(body["brokers"], list)
```

- [ ] **Step 2：运行测试确认失败**

Run: `cd agent && python -m pytest tests/test_api_server_optional_deps.py -q`
Expected: FAIL — 404（路由未挂载）。

- [ ] **Step 3：在 api_server.py 挂载路由**

在 `agent/api_server.py` 的 swarm retry 路由之后（约 Task 看到的 live-trading 注释块之前），插入：

```python
# ============================================================================
# Optional deps — on-demand broker SDK install (desktop runtime)
# ============================================================================
# Mounted with the same loopback-or-auth gate as the other settings endpoints
# so a non-local client must present API_AUTH_KEY to install packages.
from src.optional_deps.api import router as optional_deps_router

app.include_router(
    optional_deps_router,
    dependencies=[Depends(require_local_or_auth)],
)
```

- [ ] **Step 4：运行测试确认通过**

Run: `cd agent && python -m pytest tests/test_api_server_optional_deps.py -q`
Expected: PASS。

- [ ] **Step 5：语法检查**

Run: `cd agent && python -m py_compile api_server.py`
Expected: 无输出。

- [ ] **Step 6：提交**

```bash
git add agent/api_server.py agent/tests/test_api_server_optional_deps.py
git commit -s -m "feat(api): mount /optional-deps router on api_server app"
```

---

## Task 12：sidecar.rs 注入 pip 镜像环境变量

**Files:**
- Modify: `src-tauri/src/sidecar.rs`（`build_cmd` 追加镜像 env）
- Modify: `src-tauri/src/sidecar.rs`（测试）

- [ ] **Step 1：写失败测试 — build_cmd 默认注入清华 PIP_INDEX_URL**

在 `src-tauri/src/sidecar.rs` 的 `tests` 模块追加：

```rust
    #[test]
    fn build_cmd_injects_default_pip_mirror() {
        let python = Path::new("/fake/python3");
        let agent = Path::new("/fake/agent");
        let libs = Path::new("/fake/libs");
        let cmd = build_cmd(python, agent, 8899, libs);

        let mut index = None;
        let mut trusted = None;
        for (key, val) in cmd.get_envs() {
            if key.to_str() == Some("PIP_INDEX_URL") {
                index = val.and_then(|v| v.to_str()).map(String::from);
            }
            if key.to_str() == Some("PIP_TRUSTED_HOST") {
                trusted = val.and_then(|v| v.to_str()).map(String::from);
            }
        }
        assert_eq!(
            index.as_deref(),
            Some("https://pypi.tuna.tsinghua.edu.cn/simple"),
            "PIP_INDEX_URL must default to the Tsinghua mirror"
        );
        assert_eq!(trusted, None, "HTTPS mirror needs no trusted-host");
    }
```

- [ ] **Step 2：运行测试确认失败**

Run: `cd src-tauri && cargo test --lib sidecar::tests::build_cmd_injects_default_pip_mirror`
Expected: FAIL（`PIP_INDEX_URL` 未设置）。

- [ ] **Step 3：build_cmd 注入 PIP_INDEX_URL / PIP_TRUSTED_HOST**

在 `src-tauri/src/sidecar.rs` 的 `build_cmd` 中，`.env("VIBE_RUNTIME_LIBS", runtime_libs)` 之后追加：

```rust
        .env("VIBE_RUNTIME_LIBS", runtime_libs)
        // Default pip mirror: Tsinghua (HTTPS) so first-run installs are fast
        // on CN networks. The Python side (optional_deps.mirror) can override
        // per-install via --index-url; this is just the process default.
        .env(
            "PIP_INDEX_URL",
            "https://pypi.tuna.tsinghua.edu.cn/simple",
        )
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
```

不设置 `PIP_TRUSTED_HOST`（清华源是 HTTPS，无需 trusted-host；测试断言其为 `None`）。

- [ ] **Step 4：运行测试确认通过**

Run: `cd src-tauri && cargo test --lib sidecar`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src-tauri/src/sidecar.rs
git commit -s -m "feat(desktop): inject default PIP_INDEX_URL (tsinghua) into sidecar env"
```

---

## Task 13：前端 api.ts 类型与方法

**Files:**
- Modify: `frontend/src/lib/api.ts`（新增类型 + `optionalDeps.*` 方法）

- [ ] **Step 1：在 api.ts 新增类型定义**

在 `frontend/src/lib/api.ts` 的类型区（与其他 interface 同段，例如 `LiveStatus` 之后）追加：

```ts
export interface OptionalDepBroker {
  id: string;
  label: string;
  package: string;
  description: string;
  platforms: string[];
  recommended_mirror: string;
  installed: boolean;
  installed_version: string;
}

export interface OptionalDepsListResponse {
  brokers: OptionalDepBroker[];
}

export interface MirrorInfo {
  name: string;
  custom_index_url: string;
  available: Record<string, string>;
}

export interface UpdateMirrorRequest {
  name: string;
  custom_index_url?: string;
}
```

- [ ] **Step 2：在 api 对象新增方法**

在 `frontend/src/lib/api.ts` 的 `api` 对象中（`stopLiveRunner` 之后、闭合 `};` 之前）追加：

```ts
  // Optional deps — on-demand broker SDK install (desktop runtime).
  listOptionalDeps: () =>
    request<OptionalDepsListResponse>("/optional-deps/list"),
  installOptionalDep: (pkg: string) =>
    request<{ job_id: string; status: string }>(
      "/optional-deps/install",
      { method: "POST", body: JSON.stringify({ package: pkg }) },
    ),
  uninstallOptionalDep: (pkg: string) =>
    request<{ status: string }>(
      "/optional-deps/uninstall",
      { method: "POST", body: JSON.stringify({ package: pkg }) },
    ),
  optionalDepStatusUrl: (jobId: string) =>
    withAuthQuery(`${BASE}/optional-deps/status/${encodeURIComponent(jobId)}`),
  getOptionalDepsMirror: () =>
    request<MirrorInfo>("/optional-deps/mirror"),
  updateOptionalDepsMirror: (body: UpdateMirrorRequest) =>
    request<MirrorInfo>("/optional-deps/mirror", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
```

- [ ] **Step 3：类型检查**

Run: `cd frontend && npx tsc -b`
Expected: 无错误（类型在后续 Task 14 使用，此处仅声明）。

- [ ] **Step 4：提交**

```bash
git add frontend/src/lib/api.ts
git commit -s -m "feat(frontend): add optional-deps api methods and types"
```

---

## Task 14：vite proxy 加入 /optional-deps

**Files:**
- Modify: `frontend/vite.config.ts:6-15`（`PROXY_PATHS` 数组）

- [ ] **Step 1：修改 PROXY_PATHS**

在 `frontend/vite.config.ts` 的 `PROXY_PATHS` 数组中追加 `"/optional-deps"`：

```ts
const PROXY_PATHS = [
  "/sessions",
  "/swarm/presets",
  "/swarm/runs",
  "/settings/llm",
  "/settings/data-sources",
  "/mandate",
  "/live",
  "/upload",
  "/shadow-reports",
  "/optional-deps",
];
```

- [ ] **Step 2：提交**

```bash
git add frontend/vite.config.ts
git commit -s -m "feat(frontend): proxy /optional-deps to the backend"
```

---

## Task 15：OptionalDepsManager 组件

**Files:**
- Create: `frontend/src/components/settings/OptionalDepsManager.tsx`
- Modify: `frontend/src/pages/Settings.tsx`（挂载组件）

- [ ] **Step 1：创建组件文件**

新建目录与文件 `frontend/src/components/settings/OptionalDepsManager.tsx`：

```tsx
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, Loader2, Package, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import {
  api,
  isAuthRequiredError,
  type MirrorInfo,
  type OptionalDepBroker,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type JobState = Record<string, { stage: string; message: string; status: "running" | "done" | "failed" }>;

const MIRROR_OPTIONS: { value: MirrorInfo["name"]; label: string }[] = [
  { value: "tsinghua", label: "清华源 (默认)" },
  { value: "aliyun", label: "阿里云" },
  { value: "official", label: "官方 PyPI" },
  { value: "off", label: "关闭镜像 (回退官方)" },
  { value: "custom", label: "自定义" },
];

export function OptionalDepsManager() {
  const [brokers, setBrokers] = useState<OptionalDepBroker[]>([]);
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<JobState>({});
  const [mirror, setMirror] = useState<MirrorInfo | null>(null);
  const [mirrorSaving, setMirrorSaving] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  const jobStreams = useRef<Record<string, EventSource>>({});

  const load = () => {
    Promise.all([api.listOptionalDeps(), api.getOptionalDepsMirror()])
      .then(([list, mirrorInfo]) => {
        setBrokers(list.brokers ?? []);
        setMirror(mirrorInfo);
        setCustomUrl(mirrorInfo.custom_index_url ?? "");
      })
      .catch((err) => {
        if (!isAuthRequiredError(err)) {
          toast.error(`加载可选依赖失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    return () => {
      // 关闭所有未完成的 SSE
      Object.values(jobStreams.current).forEach((es) => es.close());
      jobStreams.current = {};
    };
  }, []);

  const subscribe = (jobId: string, pkg: string) => {
    const url = api.optionalDepStatusUrl(jobId);
    const es = new EventSource(url);
    jobStreams.current[pkg] = es;

    es.addEventListener("progress", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data);
        setJobs((prev) => ({
          ...prev,
          [pkg]: { stage: data.stage, message: data.message, status: "running" },
        }));
      } catch { /* ignore malformed */ }
    });
    es.addEventListener("done", () => {
      setJobs((prev) => ({
        ...prev,
        [pkg]: { stage: "done", message: "安装完成", status: "done" },
      }));
      es.close();
      delete jobStreams.current[pkg];
      load(); // 刷新已装状态
    });
    es.addEventListener("failed", (ev) => {
      let message = "安装失败";
      try {
        message = JSON.parse((ev as MessageEvent).data).error || message;
      } catch { /* keep default */ }
      setJobs((prev) => ({
        ...prev,
        [pkg]: { stage: "failed", message, status: "failed" },
      }));
      es.close();
      delete jobStreams.current[pkg];
      toast.error(`${pkg} 安装失败: ${message}`);
    });
    es.onerror = () => {
      es.close();
      delete jobStreams.current[pkg];
    };
  };

  const install = async (pkg: string) => {
    try {
      setJobs((prev) => ({
        ...prev,
        [pkg]: { stage: "starting", message: "启动安装…", status: "running" },
      }));
      const { job_id } = await api.installOptionalDep(pkg);
      subscribe(job_id, pkg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`无法启动安装: ${msg}`);
      setJobs((prev) => ({
        ...prev,
        [pkg]: { stage: "failed", message: msg, status: "failed" },
      }));
    }
  };

  const uninstall = async (pkg: string) => {
    try {
      await api.uninstallOptionalDep(pkg);
      toast.success(`已开始卸载 ${pkg}`);
      load();
    } catch (err) {
      toast.error(`卸载失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const saveMirror = async () => {
    if (!mirror) return;
    setMirrorSaving(true);
    try {
      const updated = await api.updateOptionalDepsMirror({
        name: mirror.name,
        custom_index_url: mirror.name === "custom" ? customUrl : "",
      });
      setMirror(updated);
      toast.success("镜像源已更新");
    } catch (err) {
      toast.error(`保存镜像失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setMirrorSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载可选依赖…
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {/* Mirror selector */}
      {mirror && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Package className="h-4 w-4" /> PyPI 镜像源
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={mirror.name}
              onChange={(e) => setMirror({ ...mirror, name: e.target.value as MirrorInfo["name"] })}
            >
              {MIRROR_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {mirror.name === "custom" && (
              <input
                className="flex-1 min-w-[240px] rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="https://your.mirror/simple"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
              />
            )}
            <button
              onClick={saveMirror}
              disabled={mirrorSaving}
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60"
            >
              {mirrorSaving ? "保存中…" : "保存镜像"}
            </button>
          </div>
        </div>
      )}

      {/* Broker list */}
      <div className="space-y-2">
        {brokers.map((b) => {
          const job = jobs[b.package];
          const running = job?.status === "running";
          return (
            <div key={b.package} className="rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{b.label}</span>
                    {b.installed ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-600">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        已安装{b.installed_version ? ` · ${b.installed_version}` : ""}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {b.package} — {b.description}
                  </p>
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                    平台: {b.platforms.join(" / ")}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {b.installed ? (
                    <button
                      onClick={() => uninstall(b.package)}
                      disabled={running}
                      className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> 卸载
                    </button>
                  ) : (
                    <button
                      onClick={() => install(b.package)}
                      disabled={running}
                      className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-60"
                    >
                      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      {running ? "安装中…" : "安装"}
                    </button>
                  )}
                </div>
              </div>
              {job && (
                <div
                  className={cn(
                    "mt-2 rounded-md px-2 py-1 text-[11px] font-mono",
                    job.status === "failed"
                      ? "bg-red-500/10 text-red-600"
                      : job.status === "done"
                        ? "bg-green-500/10 text-green-600"
                        : "bg-muted text-muted-foreground"
                  )}
                >
                  {job.status === "failed" && <XCircle className="inline h-3 w-3 mr-1" />}
                  {job.message}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 2：在 Settings.tsx 挂载组件**

在 `frontend/src/pages/Settings.tsx` 顶部 import 区追加：

```tsx
import { OptionalDepsManager } from "@/components/settings/OptionalDepsManager";
```

在 `Settings` 组件的 JSX 中（数据源设置区块之后、页面闭合标签之前）追加一个区块。定位到 `return ( <div ...> ... )` 内部，数据源卡片之后插入：

```tsx
        <div className="rounded-lg border bg-background p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            <h2 className="text-lg font-semibold">券商支持 (可选依赖)</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            按需安装券商 SDK。安装到本地可写目录，不影响核心依赖。
          </p>
          <OptionalDepsManager />
        </div>
```

注意：若 `Settings.tsx` 顶部未 import `Package`，从 `lucide-react` 的 import 列表中追加 `Package`（若已存在则跳过）。

- [ ] **Step 3：类型检查 + 构建**

Run: `cd frontend && npx tsc -b && npm run build`
Expected: 无类型错误，构建成功。

- [ ] **Step 4：提交**

```bash
git add frontend/src/components/settings/OptionalDepsManager.tsx frontend/src/pages/Settings.tsx
git commit -s -m "feat(frontend): OptionalDepsManager with install/uninstall/SSE/mirror UI"
```

---

## Task 16：打包脚本确认 .dist-info 保留 + 纳入 registry.yaml

**Files:**
- Modify: `scripts/desktop/assemble.sh`（显式保留 .dist-info；registry.yaml 已随 agent 模板复制）

- [ ] **Step 1：确认 registry.yaml 随 agent 模板进入 bundle**

`scripts/desktop/assemble.sh:28` 的 `cp -R "$ROOT/agent/." "$BUILD/agent/"` 已把 `agent/src/optional_deps/registry.yaml` 复制进 bundle。无需改动复制逻辑。

- [ ] **Step 2：显式保留 .dist-info（防止未来误删）**

`scripts/desktop/assemble.sh:22` 已有注释「不删除 *.dist-info」。将该注释强化为带 `grep` 断言的守卫。在 `assemble.sh` 的 `=== Trimming runtime ===` 块之后（约第 22 行注释之后）追加一段校验：

```bash
# 守卫：确认 trim 后仍保留 .dist-info（pip 需要 metadata 管理 --target 安装）
if ! find "$RUNTIME" -type d -name "*.dist-info" | grep -q .; then
  echo "WARNING: no *.dist-info found in runtime — pip --target install will still work"
  echo "         (it writes new dist-info into ~/.vibe-trading/runtime/libs), but"
  echo "         uninstall/upgrade of bundled core deps would lose metadata."
fi
```

- [ ] **Step 3：本地验证脚本语法**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop && bash -n scripts/desktop/assemble.sh`
Expected: 无输出（语法正确）。

- [ ] **Step 4：提交**

```bash
git add scripts/desktop/assemble.sh
git commit -s -m "build(desktop): guard .dist-info retention in assemble.sh"
```

---

## Task 17：集成测试 — 安装 → import 全链路

**Files:**
- Create: `agent/tests/test_optional_deps_integration.py`

> 这是有真实 pip 调用的慢测试，默认用 `@pytest.mark.optional_deps_integration` 标记，CI 主流程不跑（与 e2e_backtest 同策略）。`pyproject.toml` 已有 e2e ignore 模式；这里用 marker 而非默认收集。

- [ ] **Step 1：写集成测试**

新建 `agent/tests/test_optional_deps_integration.py`：

```python
"""Integration test: install a tiny pure-python package and import it.

Marked slow — run manually:

    pytest agent/tests/test_optional_deps_integration.py -m optional_deps_integration
"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.optional_deps_integration


def test_install_then_import(tmp_path, monkeypatch):
    """Install a tiny pure-python package (``six``) into a temp libs dir
    and verify it imports via the same sys.path.append path cli uses.
    """
    pytest.importorskip("fastapi")  # backend deps must be present
    libs = tmp_path / "libs"
    libs.mkdir()

    from src.optional_deps.installer import run_install

    # ``six`` is a tiny pure-Python package with wheels on every platform.
    lines = list(
        run_install(
            python=sys.executable,
            libs_dir=str(libs),
            package="six",
            index_url="",  # official PyPI; integration test assumes network
            trusted_host="",
        )
    )
    assert any("Successfully installed" in line for line in lines), lines

    # Simulate the cli injection: append libs and import.
    monkeypatch.setattr(sys, "path", list(sys.path) + [str(libs)])
    # Purge any pre-existing six so we prove the libs copy is the one loaded.
    sys.modules.pop("six", None)
    mod = importlib.import_module("six")
    assert mod is not None
    # The loaded file must live under our libs dir.
    assert str(libs) in getattr(mod, "__file__", "") or str(libs) in getattr(
        mod, "__path__", [""]  # type: ignore[arg-type]
    )[0]
```

- [ ] **Step 2：注册 marker（如 pyproject 已有 markers 配置则跳过）**

检查 `pyproject.toml` 的 `[tool.pytest.ini_options]` 是否有 `markers`。若无，在 `markers` 列表追加 `"optional_deps_integration: slow integration test that runs real pip"`。若已有 markers 列表，仅追加该项。

- [ ] **Step 3：确认 marker 未被默认收集误跑**

Run: `cd agent && python -m pytest tests/test_optional_deps_integration.py --collect-only -q -m optional_deps_integration`
Expected: 收集到 1 个测试（未加 `-m` 时默认不运行，因为 `pytestmark` 标记了它，但 collect-only 仍会列出）。

- [ ] **Step 4：（可选）手动跑一次集成测试验证链路**

Run: `cd agent && python -m pytest tests/test_optional_deps_integration.py -m optional_deps_integration -q`
Expected: PASS（需联网下载 six）。若离线环境，跳过此步并在 PR 说明。

- [ ] **Step 5：提交**

```bash
git add agent/tests/test_optional_deps_integration.py pyproject.toml
git commit -s -m "test(optional-deps): integration test install→import full chain"
```

---

## Task 18：全量验证

**Files:** 无（仅运行）

- [ ] **Step 1：后端全部单元测试**

Run: `cd agent && python -m pytest src/optional_deps/tests/ tests/test_cli_runtime_libs.py tests/test_api_server_optional_deps.py -q`
Expected: 全部 PASS。

- [ ] **Step 2：Ruff lint**

Run: `cd agent && ruff check src/optional_deps/ cli/main.py tests/test_cli_runtime_libs.py tests/test_api_server_optional_deps.py tests/test_optional_deps_integration.py`
Expected: 无错误（E501 已忽略，line-length 120）。

- [ ] **Step 3：Python 语法检查入口文件**

Run: `cd agent && python -m py_compile api_server.py cli/main.py`
Expected: 无输出。

- [ ] **Step 4：Rust 测试**

Run: `cd src-tauri && cargo test`
Expected: 全部 PASS（runtime_dir、sidecar 新测试 + 既有测试）。

- [ ] **Step 5：前端类型检查 + 构建 + 单测**

Run: `cd frontend && npx tsc -b && npm run build && npx vitest run`
Expected: 无类型错误，构建成功，vitest 全绿。

- [ ] **Step 6：提交（如有 lint 修复）**

```bash
git add -A
git commit -s -m "test(optional-deps): full suite green across backend, rust, frontend"
```

---

## Self-Review 记录

**Spec 覆盖检查（对照 `specs/python-runtime-optional-deps/spec.md` 的 7 个 Requirement）：**
- 可写目录与 sidecar 模块搜索集成 → Task 1-4（Layout、prepare、VIBE_RUNTIME_LIBS、sys.path.append）。
- 安装/卸载/列表 API（手动触发） → Task 8-11（installer、api router、挂载）。
- 安装进度反馈与失败重试 → Task 9（sse_lines）+ Task 10（status SSE）+ Task 15（前端 SSE 订阅 + 失败 toast）。
- 国内镜像默认启用且可切换 → Task 7（mirror 配置）+ Task 12（sidecar 默认 PIP_INDEX_URL）+ Task 15（镜像切换 UI）。
- registry 白名单 → Task 5（registry + loader，install API 白名单校验）。
- 已装依赖升级后保留 → Task 2（prepare 幂等 create_dir_all，不动 libs）。
- 平台 wheel 预检 → Task 6（platform）+ Task 10（install 路由调用预检）。

**Placeholder 扫描：** 无 TBD / TODO / 「添加适当错误处理」。每步含具体代码或命令。

**类型一致性：** `RegistryEntry`、`InstalledPackage`、`MirrorConfig`、`BrokerStatus`、`_Job` 在定义处与使用处签名一致；`build_pip_args` / `run_install` / `scan_installed` 在 Task 8 定义、Task 10 调用签名匹配；前端 `optionalDepStatusUrl` / `installOptionalDep` 与后端 `POST /install` 返回 `{job_id, status}` 一致。

**安全边界：** 全程未修改 `agent/src/live/`；install 路由白名单 + 平台预检 + loopback-or-auth 依赖；不强制 `--require-hashes`。
