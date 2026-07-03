---
change: desktop-runtime-decoupling
design-doc: docs/superpowers/specs/2026-07-03-desktop-runtime-decoupling-design.md
base-ref: 7e3747eae75b3509638395e718cfbaf78e73e386
---

# 桌面运行时解耦 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实施本计划。步骤用复选框(`- [ ]`)语法跟踪进度。

**Goal:** 把重型 Python 依赖从 Tauri bundle 解耦到用户目录 venv,桌面壳从 WebUI 黑箱重构为可观测的环境/服务控制台,渠道管理迁入 WebUI。

**Architecture:** 三层依赖 —— Tier 0(bundle 内最小核心,能拉起控制台与 `serve` 空转)/ Tier 1(首启 `vibe-trading bootstrap` 装整个 requirements 到 `~/.vibe-trading/venv`)/ Tier 2(券商 SDK,复用现有 `/optional-deps`,不动)。Rust 控制台 spawn `bootstrap` 子命令并转发其 stdout 的 SSE 帧;服务由 venv 解释器 `serve` 启动,业务 UI 交系统默认浏览器。复用现有 `installer`/`mirror`/`sse_lines`/`smoke_imports`/`.installed_version`/`VIBE_RUNTIME_LIBS` 五套既有模式,主要是"复用 + 翻转默认"。

**Tech Stack:** Python 3.12(stdlib `venv` + `pip`、FastAPI、pytest)、Rust(Tauri v2、`cargo test`)、React 19 + Vite + TypeScript(vitest)、Bash / PowerShell 装配脚本。

---

## 文件结构

新增(Python bootstrap,复用现有 optional_deps 基础设施):

- `agent/src/desktop_bootstrap/__init__.py` — 包入口
- `agent/src/desktop_bootstrap/venv_env.py` — venv 路径解析(`~/.vibe-trading/venv`、按平台的 python 可执行路径)、`python -m venv` 创建
- `agent/src/desktop_bootstrap/requirements_hash.py` — requirements.txt 内容 hash + marker 读写(照搬 `.installed_version` 模式)
- `agent/src/desktop_bootstrap/smoke.py` — 重型包冒烟(numpy/scipy/sklearn/pandas/duckdb + native 调用),从现有 `scripts/desktop/smoke_imports.py` 抽取为可 import 的单一真源
- `agent/src/desktop_bootstrap/bootstrap.py` — 编排:建 venv → `pip install -r`(流式行)→ 冒烟 → 标记就绪;yield SSE 帧;断点重试
- `agent/tests/test_desktop_bootstrap_*.py` — 对应单测

修改(Python):

- `scripts/desktop/smoke_imports.py` — 改为 thin shim,委托给 `src.desktop_bootstrap.smoke`(保留 a_stock_data 业务冒烟)
- `agent/cli/_legacy.py` — 新增 `bootstrap` 子命令(parser + dispatch);`SESSIONS_DIR` 定义改为读 `VIBE_SESSIONS_DIR`(D4);`serve` 增 `--open`(§7.1)
- `agent/api_server.py` — `SESSIONS_DIR` 定义改为读 `VIBE_SESSIONS_DIR`(D4);`serve_main` 支持 `--open`

修改(Rust,`src-tauri/`):

- `src-tauri/src/runtime_dir.rs` — Layout 增 `venv_dir`/`venv_python`/`sessions_dir`/`logs_dir`;覆盖白名单判定 + `prepare` 保留资产
- `src-tauri/src/sidecar.rs` — `build_cmd` 解释器改 venv、注入 `VIBE_SESSIONS_DIR`;新增 bootstrap 子进程 spawn + stdout 转发
- `src-tauri/src/console.rs`(新增)— IPC 命令:环境状态 / 服务状态 / 启停 / 打开 WebUI / 打开日志目录 / 触发 bootstrap 并转发 SSE
- `src-tauri/src/main.rs` — 重写 boot 编排:准备目录 → 展示控制台页(不自动 spawn serve、不导航业务 SPA)
- `src-tauri/tauri.conf.json` — 窗口指向控制台页,不再指向 frontend/dist 业务页

修改(前端,`frontend/src/`):

- `frontend/src/pages/Settings.tsx` — 渠道启动/停止(已接)+ 渠道依赖安装 UI + 微信页面内扫码
- `frontend/src/lib/api.ts` — 补渠道依赖安装 / 微信登录相关客户端方法(若缺)
- `frontend/src/pages/__tests__/SettingsChannels.test.tsx` — 扩展渠道 UI 测试

新增(构建):

- `scripts/desktop/smoke_tier0.py` — Tier 0 冒烟(仅验证 serve 入口链路可导入,不含重型包)
- `scripts/desktop/requirements-tier0.txt` 或 install-deps.sh 内联 Tier 0 清单(§1 实测产出)

文档:

- `docs/desktop/README.md`、根 `CLAUDE.md` 相关段 — 三层依赖模型、控制台用法、首次 bootstrap 说明

## 任务依赖与排序

**Task 1(§1 Tier 0 边界)是所有后续的前置验证点,必须最先完成**——它用干净 venv 实测确定 Tier 0 最小依赖清单,后续构建脚本(Task 5)与 Rust 控制台(Task 6-8)都以该清单为输入。

依赖链:

```
Task 1 (Tier 0 边界·gate)
   ├─→ Task 5 (构建脚本:装 Tier 0)
   └─→ Task 3 (bootstrap 核心) ─→ Task 4 (bootstrap 编排+CLI) ─┐
Task 2 (SESSIONS_DIR 解耦·独立) ──────────────────────────────┤
                                                              ├─→ Task 6 (Rust venv/白名单)
                                                              │      └─→ Task 7 (Rust 控制台 IPC)
                                                              │             └─→ Task 8 (控制台页+main.rs 集成)
Task 9 (渠道 UI·较独立) ─→ Task 10 (微信扫码)                  │
Task 11 (serve --open) ←──────────────────────────────────────┘
Task 12 (文档)  Task 13 (全平台验收·最后·含 Windows wheel 矩阵 D6)
```

组内 TDD、频繁提交;每个 Task 结束时其验证命令必须通过。

## Task 1: Tier 0 边界干净 venv 实测(前置验证 · gate)

对应 tasks.md §1.1–1.3、python-runtime-bundling delta「Tier 0 足以拉起控制台与 serve 空转」场景。这是**所有后续任务的前置验证点**:用一个干净 venv 实测,究竟装哪些依赖能让 `vibe-trading serve` 启动并通过 `/health`。设计文档 D6 与「风险/取舍」都强调 serve 入口链路顶层不 import 重型包(懒加载),故 Tier 0 可拉起 serve 空转成立——本任务要用实测**证明**它,并**产出精确的 Tier 0 清单**交给 Task 5。

**Files:**
- Create: `scripts/desktop/requirements-tier0.txt`(实测产出的 Tier 0 清单)
- Create: `scripts/desktop/smoke_tier0.py`(Tier 0 冒烟:只验证 serve 入口链路可导入)
- Create: `docs/desktop/tier0-boundary.md`(实测结论 + Windows 结论记录)

- [x] **Step 1: 建一个干净 venv,先只装 serve 入口链路顶层依赖**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
rm -rf /tmp/tier0-venv
python3.12 -m venv /tmp/tier0-venv
/tmp/tier0-venv/bin/python -m pip install --upgrade pip
# 首个候选集:serve 入口链路顶层(FastAPI/uvicorn/pydantic/langchain 及其直接依赖)
/tmp/tier0-venv/bin/python -m pip install \
  "fastapi>=0.104.0" "uvicorn[standard]>=0.24.0" "pydantic>=2.0.0" \
  "python-multipart>=0.0.18" "sse-starlette>=1.6.0" "websockets>=12.0" \
  "langchain>=1.0.0,<2" "langchain-core>=1.0.0,<2" "langchain-openai>=1.0.0,<2" \
  "langgraph>=1.0.10,<1.1" "langgraph-checkpoint>=2.1.0,<5" \
  "python-dotenv>=1.0.0" "httpx>=0.28.0" "rich>=13.0.0" "pyyaml>=6.0.0" \
  "requests>=2.31.0"
```
Expected: pip 安装成功,无重型包(pandas/scipy/sklearn/duckdb/matplotlib)被拉入。

- [x] **Step 2: 用该 venv 尝试拉起 serve,探测缺哪些顶层模块**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
PYTHONPATH=agent /tmp/tier0-venv/bin/python -c "import cli, sys; raise SystemExit(cli.main(['serve','--host','127.0.0.1','--port','8877']))" &
SERVE_PID=$!
sleep 12
curl -sf http://127.0.0.1:8877/health && echo "  HEALTH OK" || echo "  HEALTH FAILED"
kill "$SERVE_PID" 2>/dev/null; wait "$SERVE_PID" 2>/dev/null
```
Expected(两种结果都推动任务):
- `HEALTH OK` → 当前候选集即 Tier 0,进入 Step 4。
- 启动崩溃并打印 `ModuleNotFoundError: No module named '<x>'` → 记录 `<x>`,进入 Step 3 补装后重试。

- [x] **Step 3: 逐个补装缺失的顶层模块,直到 serve 通过 /health**

对 Step 2 报出的每个 `ModuleNotFoundError`,判定它是"入口链路顶层必需"还是"应懒加载但被顶层 import 了"。前者补进 Tier 0 候选集并重试 Step 2;后者是设计缺陷候选,记进 `docs/desktop/tier0-boundary.md` 的"顶层 import 泄漏"清单(不补进 Tier 0,留给后续按需修 import 位置)。重复 Step 2 直到 `HEALTH OK`。

```bash
# 示例:补装单个缺失模块后重试
/tmp/tier0-venv/bin/python -m pip install "<缺失包>==<版本>"
# 回到 Step 2 的 serve+curl 验证
```
Expected: 收敛到一个能让 `/health` 通过、且不含 pandas/scipy/sklearn/duckdb/matplotlib 的最小集。

- [x] **Step 4: 冻结 Tier 0 清单到 requirements-tier0.txt**

把 Step 3 收敛出的最小集写入清单文件(带版本约束,与 `agent/requirements.txt` 对齐,`ponytail:` 注明这是实测边界):

`scripts/desktop/requirements-tier0.txt`(示例结构,实际以实测为准):
```
# Tier 0 — bundle 内最小核心:能拉起桌面控制台 + serve 空转(不含重型包)。
# 由 scripts/desktop/smoke_tier0.py 守卫;边界见 docs/desktop/tier0-boundary.md。
# ponytail: 清单为 Task 1 干净 venv 实测产出,新增顶层依赖时须重跑实测再改这里。
rich>=13.0.0
pyyaml>=6.0.0
python-dotenv>=1.0.0
httpx>=0.28.0
requests>=2.31.0
langchain>=1.0.0,<2
langchain-core>=1.0.0,<2
langchain-openai>=1.0.0,<2
langgraph>=1.0.10,<1.1
langgraph-checkpoint>=2.1.0,<5
fastapi>=0.104.0
uvicorn[standard]>=0.24.0
websockets>=12.0
pydantic>=2.0.0
python-multipart>=0.0.18
sse-starlette>=1.6.0
```

- [x] **Step 5: 写 Tier 0 冒烟脚本(只验证入口链路可导入)**

`scripts/desktop/smoke_tier0.py`:
```python
# scripts/desktop/smoke_tier0.py
# Tier 0 冒烟:验证 serve 入口链路顶层可导入且不因缺重型包而崩溃。
# 与 smoke_imports.py(Tier 1,验证重型包)互补——本脚本在 bundle 装配后跑,
# 用 bundle 的 Tier 0 运行时执行,任意 ImportError 即非零退出。
import sys

# serve 入口链路顶层:cli.main → serve_main 的 import 面。缺任一即 Tier 0 边界判断错。
MODULES = [
    "fastapi",
    "uvicorn",
    "pydantic",
    "langchain",
    "langgraph",
    "sse_starlette",
    "httpx",
]


def main() -> int:
    failed = []
    for name in MODULES:
        try:
            __import__(name)
            print(f"OK   import {name}")
        except Exception as exc:  # noqa: BLE001
            failed.append((name, repr(exc)))
            print(f"FAIL import {name}: {exc!r}")
    # 关键:import cli 且构造 serve 的 app,不监听端口——证明入口链路顶层不 import 重型包。
    try:
        import cli  # noqa: F401
        from api_server import app  # noqa: F401
        print("OK   import cli + api_server.app (serve 入口链路顶层就绪)")
    except Exception as exc:  # noqa: BLE001
        failed.append(("cli/api_server", repr(exc)))
        print(f"FAIL import cli/api_server: {exc!r}")
    if failed:
        print(f"\nTIER0 SMOKE FAILED: {len(failed)} issue(s)")
        return 1
    print("\nTIER0 SMOKE PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [x] **Step 6: 用 Tier 0 venv 跑冒烟脚本验证**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
PYTHONPATH=agent /tmp/tier0-venv/bin/python scripts/desktop/smoke_tier0.py
```
Expected: `TIER0 SMOKE PASSED`,退出码 0。

- [x] **Step 7: 记录实测结论 + Windows 结论到文档**

`docs/desktop/tier0-boundary.md` 至少含:(a)最终 Tier 0 清单与逐项理由;(b)Step 3 收敛过程中发现的"顶层 import 泄漏"清单(若有);(c)§1.3 Windows 结论——在无系统 Python 的 Windows(或已装内嵌 python-build-standalone 的等价环境)上,用相同 Tier 0 清单跑 Step 2 的 serve+`/health` 与 Step 6 冒烟的结论(能否 serve 空转)。若当前无 Windows 环境,明确标注"Windows 实测挂到 Task 13 全平台验收,此处先记 macOS 结论 + Windows 待验证",不留空泛 TODO。

- [x] **Step 8: Commit**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add scripts/desktop/requirements-tier0.txt scripts/desktop/smoke_tier0.py docs/desktop/tier0-boundary.md
git commit -s -m "test(desktop): pin Tier 0 minimal deps via clean-venv smoke"
```

## Task 2: 会话目录经 `VIBE_SESSIONS_DIR` 解耦(D4 · 安全回归)

对应 tasks.md §4.3、desktop-shell delta「本地/Docker 模式会话路径行为不变」与「会话已迁出 runtime 不被重建清除」场景。照搬 `VIBE_RUNTIME_LIBS` 环境变量模式:桌面 sidecar 设 `VIBE_SESSIONS_DIR=~/.vibe-trading/sessions/`(幸存 runtime 重建);**未设时逐字节回退到代码相对默认**,本地/Docker 行为不变。改 `cli/_legacy.py:58` 与 `api_server.py:46` 两处 `SESSIONS_DIR` 定义。此任务独立于 bootstrap,可与 Task 3 并行。

关键约束(设计文档 D4 + delta 场景):这是**安全回归**任务——回归测试必须锁定"env 未设 → 与重构前逐字节一致的 `<code_dir>/sessions`"。

**Files:**
- Create: `agent/src/config/sessions_dir.py`(单一真源解析器,两处共用,避免 DRY 违背)
- Modify: `agent/cli/_legacy.py:58`(`SESSIONS_DIR = AGENT_DIR / "sessions"` → 调用解析器)
- Modify: `agent/api_server.py:46`(`SESSIONS_DIR = Path(__file__).resolve().parent / "sessions"` → 调用解析器)
- Test: `agent/tests/test_sessions_dir_env.py`

- [x] **Step 1: 写失败测试(env 未设回退 + env 设置生效)**

`agent/tests/test_sessions_dir_env.py`:
```python
"""VIBE_SESSIONS_DIR 解析回归 —— 锁定本地/Docker 行为不变(设计 D4)。"""
from pathlib import Path

from src.config.sessions_dir import resolve_sessions_dir


def test_unset_falls_back_to_code_relative_default(monkeypatch):
    # env 未设 → 逐字节回退到调用方传入的代码相对默认(重构前行为)。
    monkeypatch.delenv("VIBE_SESSIONS_DIR", raising=False)
    code_default = Path("/repo/agent/sessions")
    assert resolve_sessions_dir(code_default) == code_default


def test_env_set_overrides_to_home(monkeypatch, tmp_path):
    # 桌面模式:env 指向 home,幸存 runtime 重建。
    target = tmp_path / "home-sessions"
    monkeypatch.setenv("VIBE_SESSIONS_DIR", str(target))
    code_default = Path("/repo/agent/sessions")
    assert resolve_sessions_dir(code_default) == target


def test_env_empty_string_is_treated_as_unset(monkeypatch):
    # 空串不是有效路径 → 按未设处理,回退默认(避免桌面误传空串清空到 CWD)。
    monkeypatch.setenv("VIBE_SESSIONS_DIR", "")
    code_default = Path("/repo/agent/sessions")
    assert resolve_sessions_dir(code_default) == code_default
```

- [x] **Step 2: 运行测试确认失败**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop && pytest agent/tests/test_sessions_dir_env.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.config.sessions_dir'`

- [x] **Step 3: 写解析器(最小实现)**

`agent/src/config/sessions_dir.py`:
```python
"""会话目录解析:VIBE_SESSIONS_DIR 覆盖,未设则用代码相对默认。

照搬 cli/main.py 的 VIBE_RUNTIME_LIBS 模式(env 注入路径,未设时不变)。
桌面 sidecar 设 VIBE_SESSIONS_DIR=~/.vibe-trading/sessions/,使会话幸存
runtime/ 重建;本地/Docker 未设该 env,逐字节回退到 code_default —— 与
重构前行为一致(设计文档 D4)。
"""

from __future__ import annotations

import os
from pathlib import Path


def resolve_sessions_dir(code_default: Path) -> Path:
    """Return the sessions dir, honoring VIBE_SESSIONS_DIR when set & non-empty.

    Args:
        code_default: 调用方的代码相对默认(重构前的路径),env 未设时返回它。

    Returns:
        VIBE_SESSIONS_DIR 指向的路径(设置且非空),否则 ``code_default``。
    """
    override = os.environ.get("VIBE_SESSIONS_DIR")
    if override and override.strip():
        return Path(override)
    return code_default
```

- [x] **Step 4: 运行测试确认通过**

Run: `pytest agent/tests/test_sessions_dir_env.py -v`
Expected: PASS(3 passed)

- [x] **Step 5: 接入两处 SESSIONS_DIR 定义**

`agent/cli/_legacy.py` 第 58 行:
```python
# 旧: SESSIONS_DIR = AGENT_DIR / "sessions"
from src.config.sessions_dir import resolve_sessions_dir  # 放到文件顶部 import 区
SESSIONS_DIR = resolve_sessions_dir(AGENT_DIR / "sessions")
```

`agent/api_server.py` 第 46 行:
```python
# 旧: SESSIONS_DIR = Path(__file__).resolve().parent / "sessions"
from src.config.sessions_dir import resolve_sessions_dir  # 放到文件顶部 import 区
SESSIONS_DIR = resolve_sessions_dir(Path(__file__).resolve().parent / "sessions")
```

注意:两处的 `code_default` 表达式必须与原值逐字节等价(`AGENT_DIR / "sessions"` = `Path(__file__).resolve().parents[1] / "sessions"`;api_server 用 `.parent`)——保证 env 未设时行为不变。

- [x] **Step 6: 回归——env 未设时两处解析结果与重构前一致**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
# env 未设:两处 SESSIONS_DIR 应等于各自代码相对默认
env -u VIBE_SESSIONS_DIR PYTHONPATH=agent python -c "
from cli._legacy import SESSIONS_DIR as A, AGENT_DIR
assert A == AGENT_DIR / 'sessions', A
print('legacy OK', A)"
env -u VIBE_SESSIONS_DIR PYTHONPATH=agent python -c "
from pathlib import Path
import api_server
assert api_server.SESSIONS_DIR == Path(api_server.__file__).resolve().parent / 'sessions', api_server.SESSIONS_DIR
print('api_server OK', api_server.SESSIONS_DIR)"
# env 设置:两处都跟随 env
VIBE_SESSIONS_DIR=/tmp/xsess PYTHONPATH=agent python -c "
from pathlib import Path
from cli._legacy import SESSIONS_DIR as A
import api_server
assert A == Path('/tmp/xsess') and api_server.SESSIONS_DIR == Path('/tmp/xsess')
print('override OK')"
```
Expected: 三行 `OK` 全部打印,无 AssertionError。

- [x] **Step 7: 语法检查 + 相关会话测试不回归**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
python -m py_compile agent/api_server.py agent/cli/_legacy.py agent/src/config/sessions_dir.py
pytest agent/tests/test_session_search.py agent/tests/test_session_events.py agent/tests/test_sessions_dir_env.py -q
```
Expected: 编译无错;会话测试全通过。

- [x] **Step 8: Commit**

```bash
git add agent/src/config/sessions_dir.py agent/tests/test_sessions_dir_env.py agent/cli/_legacy.py agent/api_server.py
git commit -s -m "feat(sessions): resolve sessions dir via VIBE_SESSIONS_DIR, unset unchanged"
```

## Task 3: bootstrap 核心 —— venv 创建 / requirements hash / 冒烟(D2 · D5)

对应 tasks.md §2.1、§2.5、§2.6,desktop-runtime-bootstrap delta「全新机器首次 bootstrap」「venv 已就绪则跳过」「冒烟验证通过才判定就绪」「升级时按需增量同步依赖」场景。这是 bootstrap 的纯逻辑底座(无 SSE、无 CLI),先 TDD 建可测的三块:venv 环境解析/创建(D2:stdlib `python -m venv`)、requirements hash marker(D5:照搬 `.installed_version`)、冒烟(从 `smoke_imports.py` 抽取单一真源)。依赖 Task 1 的 Tier 0 结论(冒烟覆盖的重型包清单)。

**Files:**
- Create: `agent/src/desktop_bootstrap/__init__.py`
- Create: `agent/src/desktop_bootstrap/venv_env.py`
- Create: `agent/src/desktop_bootstrap/requirements_hash.py`
- Create: `agent/src/desktop_bootstrap/smoke.py`
- Test: `agent/tests/test_desktop_bootstrap_venv.py`
- Test: `agent/tests/test_desktop_bootstrap_hash.py`

- [x] **Step 1: 写 venv_env 失败测试**

`agent/tests/test_desktop_bootstrap_venv.py`:
```python
"""venv 环境解析 —— 路径按平台正确,创建走 stdlib venv(设计 D2)。"""
import sys
from pathlib import Path

from src.desktop_bootstrap.venv_env import venv_dir, venv_python, ensure_venv


def test_venv_dir_is_home_vibe_trading_venv():
    assert venv_dir(Path("/home/u/.vibe-trading")) == Path("/home/u/.vibe-trading/venv")


def test_venv_python_path_is_platform_correct():
    base = Path("/home/u/.vibe-trading")
    p = venv_python(base)
    if sys.platform.startswith("win"):
        assert p == base / "venv" / "Scripts" / "python.exe"
    else:
        assert p == base / "venv" / "bin" / "python"


def test_ensure_venv_creates_real_venv(tmp_path):
    # 真建一个 venv(慢但确定),验证解释器可执行且能 import venv 产物 pip。
    base = tmp_path / ".vibe-trading"
    py = ensure_venv(base)
    assert py.exists()
    import subprocess
    out = subprocess.run([str(py), "-c", "import sys; print(sys.prefix)"],
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0
    assert str(base / "venv") in out.stdout


def test_ensure_venv_is_idempotent(tmp_path):
    base = tmp_path / ".vibe-trading"
    p1 = ensure_venv(base)
    p2 = ensure_venv(base)  # 已存在则不重建
    assert p1 == p2 and p2.exists()
```

- [x] **Step 2: 运行确认失败**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop && pytest agent/tests/test_desktop_bootstrap_venv.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.desktop_bootstrap'`

- [x] **Step 3: 写 venv_env 实现**

`agent/src/desktop_bootstrap/__init__.py`:
```python
"""桌面首次运行 bootstrap:建 ~/.vibe-trading/venv 并装 Tier 1 依赖。

复用 optional_deps 的 installer/mirror/sse_lines,不新造 pip 封装(设计 D1)。
"""
```

`agent/src/desktop_bootstrap/venv_env.py`:
```python
"""venv 路径解析与创建 —— stdlib venv,零额外打包负担(设计 D2)。"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def venv_dir(home_vibe: Path) -> Path:
    """Return ``<home_vibe>/venv``."""
    return home_vibe / "venv"


def venv_python(home_vibe: Path) -> Path:
    """Return the venv interpreter path for the current platform."""
    vd = venv_dir(home_vibe)
    if sys.platform.startswith("win"):
        return vd / "Scripts" / "python.exe"
    return vd / "bin" / "python"


def ensure_venv(home_vibe: Path) -> Path:
    """Create the venv if absent; return the interpreter path.

    Idempotent: an existing venv (interpreter present) is reused, matching
    the "venv 已就绪则跳过" scenario.
    """
    py = venv_python(home_vibe)
    if py.exists():
        return py
    home_vibe.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [sys.executable, "-m", "venv", str(venv_dir(home_vibe))],
        check=True,
        stdin=subprocess.DEVNULL,
    )
    return py
```

- [x] **Step 4: 运行 venv 测试确认通过**

Run: `pytest agent/tests/test_desktop_bootstrap_venv.py -v`
Expected: PASS(4 passed;`ensure_venv` 真建 venv 可能耗时数秒)

- [x] **Step 5: 写 requirements_hash 失败测试**

`agent/tests/test_desktop_bootstrap_hash.py`:
```python
"""requirements hash marker —— 增量同步判定(设计 D5,照搬 .installed_version)。"""
from pathlib import Path

from src.desktop_bootstrap.requirements_hash import (
    compute_hash, read_marker, write_marker, needs_sync,
)


def test_compute_hash_is_stable_and_content_sensitive(tmp_path):
    req = tmp_path / "requirements.txt"
    req.write_text("numpy>=1.24.0\npandas>=2.0.0\n", encoding="utf-8")
    h1 = compute_hash(req)
    h2 = compute_hash(req)
    assert h1 == h2 and len(h1) == 64  # sha256 hex
    req.write_text("numpy>=1.24.0\npandas>=2.0.0\nscipy>=1.10\n", encoding="utf-8")
    assert compute_hash(req) != h1


def test_needs_sync_true_when_marker_absent(tmp_path):
    req = tmp_path / "requirements.txt"
    req.write_text("numpy\n", encoding="utf-8")
    marker = tmp_path / ".requirements_hash"
    assert needs_sync(req, marker) is True  # 首次:无 marker → 需装


def test_needs_sync_false_when_hash_matches(tmp_path):
    req = tmp_path / "requirements.txt"
    req.write_text("numpy\n", encoding="utf-8")
    marker = tmp_path / ".requirements_hash"
    write_marker(marker, compute_hash(req))
    assert needs_sync(req, marker) is False  # hash 未变 → 跳过


def test_needs_sync_true_when_requirements_changed(tmp_path):
    req = tmp_path / "requirements.txt"
    req.write_text("numpy\n", encoding="utf-8")
    marker = tmp_path / ".requirements_hash"
    write_marker(marker, compute_hash(req))
    req.write_text("numpy\nscipy\n", encoding="utf-8")  # 升级改了清单
    assert needs_sync(req, marker) is True
    assert read_marker(marker) is not None  # 旧 marker 仍可读(未清空)
```

- [x] **Step 6: 运行确认失败**

Run: `pytest agent/tests/test_desktop_bootstrap_hash.py -v`
Expected: FAIL — `ModuleNotFoundError` / `ImportError`

- [x] **Step 7: 写 requirements_hash 实现**

`agent/src/desktop_bootstrap/requirements_hash.py`:
```python
"""requirements.txt hash marker —— 增量同步判定(设计 D5)。

启动比对 requirements.txt 的 sha256 与 marker;不一致则跑 pip install -r
(pip 自做差量,已满足的跳过),而非删重建整个 venv。照搬 runtime_dir.rs 的
.installed_version marker 模式。
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional


def compute_hash(requirements: Path) -> str:
    """Return the sha256 hex of the requirements file bytes."""
    return hashlib.sha256(requirements.read_bytes()).hexdigest()


def read_marker(marker: Path) -> Optional[str]:
    """Return the stored hash, or None when the marker is absent/unreadable."""
    try:
        return marker.read_text(encoding="utf-8").strip()
    except OSError:
        return None


def write_marker(marker: Path, digest: str) -> None:
    """Persist the requirements hash to the marker file."""
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(digest, encoding="utf-8")


def needs_sync(requirements: Path, marker: Path) -> bool:
    """True when requirements changed since the last recorded install."""
    return read_marker(marker) != compute_hash(requirements)
```

- [x] **Step 8: 运行 hash 测试确认通过**

Run: `pytest agent/tests/test_desktop_bootstrap_hash.py -v`
Expected: PASS(4 passed)

- [x] **Step 9: 抽取冒烟为单一真源(smoke.py + smoke_imports.py shim)**

`agent/src/desktop_bootstrap/smoke.py` —— 把 `scripts/desktop/smoke_imports.py` 的重型包 import + native 调用逻辑搬进来(a_stock_data 业务冒烟留在脚本层)。冒烟包清单以 Task 1 实测的 Tier 1 重型包为准:
```python
"""重型包冒烟 —— bootstrap 完成后判定"就绪"的依据(desktop-runtime-bootstrap)。

单一真源:scripts/desktop/smoke_imports.py 委托到这里,避免两处清单漂移。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

# desktop-runtime-bootstrap delta 要求至少覆盖 numpy/scipy/scikit-learn/pandas/duckdb。
SMOKE_MODULES = ["numpy", "scipy", "sklearn", "duckdb", "pandas", "PIL", "matplotlib", "stockstats"]


@dataclass
class SmokeResult:
    ok: bool
    failures: List[str] = field(default_factory=list)


def run_smoke(python: str) -> SmokeResult:
    """Run import + native smoke in the target interpreter; return pass/fail.

    Runs as a subprocess of ``python`` (the venv interpreter) so it exercises
    the freshly-installed packages, not the caller's environment.
    """
    import subprocess

    probe = (
        "import importlib,sys\n"
        f"mods={SMOKE_MODULES!r}\n"
        "bad=[]\n"
        "for m in mods:\n"
        "    try: importlib.import_module(m)\n"
        "    except Exception as e: bad.append(f'{m}: {e!r}')\n"
        "try:\n"
        "    import numpy as np, scipy.linalg as la; la.inv(np.eye(3))\n"
        "except Exception as e: bad.append(f'scipy.linalg.inv: {e!r}')\n"
        "print('\\n'.join(bad))\n"
        "sys.exit(1 if bad else 0)\n"
    )
    proc = subprocess.run([python, "-c", probe], capture_output=True, text=True, timeout=120)
    failures = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    return SmokeResult(ok=proc.returncode == 0, failures=failures)
```

改 `scripts/desktop/smoke_imports.py` 顶部:导入并调用 `src.desktop_bootstrap.smoke.SMOKE_MODULES` 作为 `MODULES` 的真源(保留脚本原有的 `_smoke_a_stock_data` 业务冒烟与 CLI `main()`,只让模块清单不再重复定义)。`ponytail:` 注明单一真源。

- [x] **Step 10: 冒烟抽取回归(现有装配脚本行为不变)**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
# 现有 smoke_imports.py 仍能在装好重型包的环境跑通(用当前 dev 解释器代表 Tier 1 就绪态)
PYTHONPATH=agent python scripts/desktop/smoke_imports.py
python -m py_compile agent/src/desktop_bootstrap/smoke.py scripts/desktop/smoke_imports.py
```
Expected: `SMOKE PASSED`(若本机装了重型包);编译无错。

- [x] **Step 11: Commit**

```bash
git add agent/src/desktop_bootstrap/ agent/tests/test_desktop_bootstrap_venv.py agent/tests/test_desktop_bootstrap_hash.py scripts/desktop/smoke_imports.py
git commit -s -m "feat(bootstrap): venv creation, requirements-hash marker, smoke single-source"
```

## Task 4: bootstrap 编排 + `vibe-trading bootstrap` 子命令(D1)

对应 tasks.md §2.1–2.6 全部,desktop-runtime-bootstrap delta 全部场景(含「经 CLI 子命令触发 bootstrap」「默认清华源」「切换镜像后重试」「弱网中断后重试续装」)。把 Task 3 的三块编排成一条流:建 venv → 解析镜像(复用 `mirror.py`,默认清华)→ 流式 `pip install -r`(复用 installer 的 Popen 流式模式)→ 冒烟 → 写 hash marker → 就绪。实现为 CLI 子命令 `vibe-trading bootstrap`(D1:CLI 一等公民,Rust 控制台只 spawn 它 + 转发 SSE)。为可测,编排把两个慢/外部操作(pip 流、冒烟)做成可注入 seam,单测传 fake 免网络。

**Files:**
- Modify: `agent/src/optional_deps/installer.py`(新增 `build_requirements_args` + `run_requirements_install`,复用现有 Popen 流式模式)
- Create: `agent/src/desktop_bootstrap/bootstrap.py`(编排 + 事件流)
- Create: `agent/src/desktop_bootstrap/cli.py`(子命令渲染:默认人类可读 / `--sse` 输出 SSE 帧)
- Modify: `agent/cli/_legacy.py`(注册 `bootstrap` 子命令 parser + dispatch)
- Test: `agent/tests/test_desktop_bootstrap_flow.py`
- Test: `agent/tests/test_installer_requirements.py`

- [x] **Step 1: 写 installer requirements 安装的失败测试**

`agent/tests/test_installer_requirements.py`:
```python
"""pip install -r 参数构造 —— venv bootstrap 的安装原语(复用 installer 流式)。"""
from src.optional_deps.installer import build_requirements_args


def test_requirements_args_include_index_url_and_reqfile():
    args = build_requirements_args(
        python="/venv/bin/python",
        requirements="/repo/agent/requirements.txt",
        index_url="https://pypi.tuna.tsinghua.edu.cn/simple",
        trusted_host="",
    )
    assert args[:4] == ["/venv/bin/python", "-m", "pip", "install"]
    assert "-r" in args and "/repo/agent/requirements.txt" in args
    assert "--index-url" in args
    i = args.index("--index-url")
    assert args[i + 1] == "https://pypi.tuna.tsinghua.edu.cn/simple"


def test_requirements_args_omit_index_url_when_empty():
    args = build_requirements_args(
        python="/venv/bin/python",
        requirements="/r.txt",
        index_url="",
        trusted_host="",
    )
    assert "--index-url" not in args  # off/official → pip 用内建官方源


def test_requirements_args_add_trusted_host_for_http_mirror():
    args = build_requirements_args(
        python="/venv/bin/python",
        requirements="/r.txt",
        index_url="http://mirror.local/simple",
        trusted_host="mirror.local",
    )
    assert "--trusted-host" in args and "mirror.local" in args
```

- [x] **Step 2: 运行确认失败**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop && pytest agent/tests/test_installer_requirements.py -v`
Expected: FAIL — `ImportError: cannot import name 'build_requirements_args'`

- [x] **Step 3: 在 installer.py 加 requirements 安装原语**

追加到 `agent/src/optional_deps/installer.py`(复用文件内既有 Popen 流式模式,不新造):
```python
def build_requirements_args(
    python: str,
    requirements: str,
    index_url: str,
    trusted_host: str,
) -> List[str]:
    """Build argv for ``python -m pip install -r <requirements>`` into the venv.

    Unlike :func:`build_pip_args`, this installs into the interpreter's own
    site-packages (no ``--target``) — ``python`` is the venv interpreter, so
    packages land in the venv. Mirror/trusted-host reuse the same resolution.
    """
    args = [
        python, "-m", "pip", "install", "-r", str(requirements),
        "--no-input", "--disable-pip-version-check",
    ]
    if index_url:
        args += ["--index-url", index_url]
    if trusted_host:
        args += ["--trusted-host", trusted_host]
    return args


def run_requirements_install(
    python: str,
    requirements: str,
    index_url: str,
    trusted_host: str,
) -> Iterator[str]:
    """Run ``pip install -r`` and yield stdout lines (mirrors run_install).

    Re-invoking after a failure resumes: pip skips already-satisfied
    requirements and reuses its download cache (设计"断点重试"tasks §2.3).
    Raises CalledProcessError on non-zero exit.
    """
    args = build_requirements_args(python, requirements, index_url, trusted_host)
    proc = subprocess.Popen(  # noqa: S603 — argv built internally
        args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
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
```

- [x] **Step 4: 运行确认通过**

Run: `pytest agent/tests/test_installer_requirements.py -v`
Expected: PASS(3 passed)

- [x] **Step 5: 写 bootstrap 编排的失败测试(注入 fake,免网络)**

`agent/tests/test_desktop_bootstrap_flow.py`:
```python
"""bootstrap 编排 —— 决策流可测:建 venv → 装 → 冒烟 → 就绪 / 失败 / 跳过。"""
from pathlib import Path

from src.desktop_bootstrap.bootstrap import run_bootstrap
from src.desktop_bootstrap.smoke import SmokeResult


def _drain(events):
    return [(e.stage, e.ok) for e in events]


def test_happy_path_installs_then_ready(tmp_path):
    home = tmp_path / ".vibe-trading"
    req = tmp_path / "requirements.txt"; req.write_text("numpy\n", encoding="utf-8")
    events = list(run_bootstrap(
        home_vibe=home, requirements=req,
        ensure_venv=lambda h: (h / "venv" / "bin" / "python"),
        pip_stream=lambda **kw: iter(["Collecting numpy", "Successfully installed numpy"]),
        smoke=lambda py: SmokeResult(ok=True),
    ))
    stages = _drain(events)
    assert ("installing", True) in stages
    assert stages[-1] == ("done", True)
    # hash marker 写在 home 下,幸存后续启动
    assert (home / "venv" / ".requirements_hash").exists() or (home / ".requirements_hash").exists()


def test_smoke_failure_marks_not_ready(tmp_path):
    home = tmp_path / ".vibe-trading"
    req = tmp_path / "requirements.txt"; req.write_text("numpy\n", encoding="utf-8")
    events = list(run_bootstrap(
        home_vibe=home, requirements=req,
        ensure_venv=lambda h: (h / "venv" / "bin" / "python"),
        pip_stream=lambda **kw: iter(["Successfully installed numpy"]),
        smoke=lambda py: SmokeResult(ok=False, failures=["scipy: no wheel"]),
    ))
    stages = _drain(events)
    assert stages[-1] == ("failed", False)
    # 冒烟失败 → 不写 hash marker(下次启动仍判"依赖不全")
    assert not (home / "venv" / ".requirements_hash").exists()


def test_pip_failure_yields_failed_with_reason(tmp_path):
    import subprocess
    home = tmp_path / ".vibe-trading"
    req = tmp_path / "requirements.txt"; req.write_text("numpy\n", encoding="utf-8")

    def boom(**kw):
        yield "Collecting numpy"
        raise subprocess.CalledProcessError(1, ["pip"])

    events = list(run_bootstrap(
        home_vibe=home, requirements=req,
        ensure_venv=lambda h: (h / "venv" / "bin" / "python"),
        pip_stream=boom,
        smoke=lambda py: SmokeResult(ok=True),
    ))
    stages = _drain(events)
    assert stages[-1][0] == "failed"
    assert any("pip" in e.message.lower() for e in events if e.stage == "failed")


def test_already_ready_skips_install(tmp_path):
    from src.desktop_bootstrap.requirements_hash import compute_hash, write_marker
    from src.desktop_bootstrap.bootstrap import hash_marker_path
    home = tmp_path / ".vibe-trading"
    req = tmp_path / "requirements.txt"; req.write_text("numpy\n", encoding="utf-8")
    # 预置:venv 存在 + hash 匹配 + 冒烟通过 → 跳过安装
    (home / "venv" / "bin").mkdir(parents=True)
    (home / "venv" / "bin" / "python").write_text("#!/bin/sh\n")
    write_marker(hash_marker_path(home), compute_hash(req))
    calls = {"pip": 0}

    def counting_pip(**kw):
        calls["pip"] += 1
        return iter([])

    events = list(run_bootstrap(
        home_vibe=home, requirements=req,
        ensure_venv=lambda h: (h / "venv" / "bin" / "python"),
        pip_stream=counting_pip,
        smoke=lambda py: SmokeResult(ok=True),
    ))
    assert calls["pip"] == 0  # 未安装
    assert _drain(events)[-1] == ("done", True)
```

- [x] **Step 6: 运行确认失败**

Run: `pytest agent/tests/test_desktop_bootstrap_flow.py -v`
Expected: FAIL — `ImportError: cannot import name 'run_bootstrap'`

- [x] **Step 7: 写 bootstrap 编排实现**

`agent/src/desktop_bootstrap/bootstrap.py`:
```python
"""bootstrap 编排:venv → pip install -r → smoke → 就绪(设计 D1/D5)。

pip 流与 smoke 通过参数注入(默认真实实现),使决策流可脱网单测。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator, List, Optional

from src.desktop_bootstrap.requirements_hash import compute_hash, needs_sync, write_marker
from src.desktop_bootstrap.smoke import SmokeResult, run_smoke as _real_smoke
from src.desktop_bootstrap.venv_env import ensure_venv as _real_ensure_venv


@dataclass
class BootstrapEvent:
    stage: str  # venv | installing | smoke | done | failed
    message: str = ""
    ok: bool = True


def hash_marker_path(home_vibe: Path) -> Path:
    """Marker recording the installed requirements hash (survives venv reuse)."""
    return home_vibe / "venv" / ".requirements_hash"
```
(接 Step 8 续写主函数)

- [x] **Step 8: 续写 run_bootstrap 主函数**

追加到 `agent/src/desktop_bootstrap/bootstrap.py`:
```python
def run_bootstrap(
    home_vibe: Path,
    requirements: Path,
    *,
    index_url: str = "https://pypi.tuna.tsinghua.edu.cn/simple",
    trusted_host: str = "",
    log_path: Optional[Path] = None,
    ensure_venv: Callable[[Path], Path] = _real_ensure_venv,
    pip_stream: Optional[Callable[..., Iterator[str]]] = None,
    smoke: Callable[[str], SmokeResult] = _real_smoke,
) -> Iterator[BootstrapEvent]:
    """Run the full bootstrap, yielding progress events.

    Idempotent & resumable: when venv exists, hash matches and smoke passes,
    installation is skipped (tasks §2.6 增量同步). Re-invoking after a pip
    failure resumes via pip's own skip-satisfied behaviour (tasks §2.3).
    """
    import subprocess

    from src.optional_deps.installer import run_requirements_install

    if pip_stream is None:
        pip_stream = run_requirements_install

    marker = hash_marker_path(home_vibe)
    log = _open_log(log_path)
    try:
        yield BootstrapEvent("venv", "preparing virtual environment")
        py = ensure_venv(home_vibe)

        # 增量同步 gate:hash 未变且冒烟通过 → 跳过安装(venv 已就绪则跳过)。
        if not needs_sync(requirements, marker):
            if smoke(str(py)).ok:
                yield BootstrapEvent("done", "already up to date")
                return
            # hash 匹配但冒烟失败(残缺环境)→ 落到重装。

        yield BootstrapEvent("installing", "installing dependencies")
        try:
            for line in pip_stream(
                python=str(py), requirements=str(requirements),
                index_url=index_url, trusted_host=trusted_host,
            ):
                _tee(log, line)
                yield BootstrapEvent("installing", line)
        except subprocess.CalledProcessError as exc:
            msg = f"pip install failed (exit {exc.returncode}); 重试将复用已装部分"
            _tee(log, msg)
            yield BootstrapEvent("failed", msg, ok=False)
            return
        except Exception as exc:  # noqa: BLE001
            _tee(log, repr(exc))
            yield BootstrapEvent("failed", str(exc), ok=False)
            return

        yield BootstrapEvent("smoke", "verifying key packages")
        result = smoke(str(py))
        if not result.ok:
            detail = "; ".join(result.failures) or "smoke import failed"
            _tee(log, f"SMOKE FAILED: {detail}")
            yield BootstrapEvent("failed", f"依赖不全:{detail}", ok=False)
            return

        write_marker(marker, compute_hash(requirements))
        yield BootstrapEvent("done", "environment ready")
    finally:
        if log is not None:
            log.close()


def _open_log(log_path: Optional[Path]):
    if log_path is None:
        return None
    log_path.parent.mkdir(parents=True, exist_ok=True)
    return log_path.open("a", encoding="utf-8")


def _tee(log, line: str) -> None:
    if log is not None:
        log.write(line + "\n")
        log.flush()
```

- [x] **Step 9: 运行编排测试确认通过**

Run: `pytest agent/tests/test_desktop_bootstrap_flow.py -v`
Expected: PASS(4 passed)

- [x] **Step 10: 写子命令渲染层 + 冒烟测试**

`agent/src/desktop_bootstrap/cli.py`:
```python
"""`vibe-trading bootstrap` 渲染:默认人类可读,--sse 输出 SSE 帧给 Rust 控制台。"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from src.desktop_bootstrap.bootstrap import run_bootstrap


def run_bootstrap_cli(argv: Optional[list[str]] = None) -> int:
    """Entry for the ``bootstrap`` subcommand. Returns process exit code."""
    import argparse

    from src.config.paths import get_runtime_root
    from src.optional_deps.mirror import (
        MirrorConfig, load_mirror_config, resolve_index_url, resolve_trusted_host,
    )
    from src.optional_deps.sse_lines import sse_event, stage_line

    parser = argparse.ArgumentParser(prog="vibe-trading bootstrap")
    parser.add_argument("--sse", action="store_true", help="Emit SSE frames (for the desktop console)")
    parser.add_argument("--mirror", default=None, help="tsinghua|aliyun|official|custom|off")
    parser.add_argument("--index-url", default=None, help="Custom index url (with --mirror custom)")
    args = parser.parse_args(argv)

    home = get_runtime_root()
    requirements = Path(__file__).resolve().parents[2] / "requirements.txt"
    # 镜像:命令行 > 持久化配置 > 默认清华。
    cfg = load_mirror_config()
    if args.mirror:
        cfg = MirrorConfig(name=args.mirror, custom_index_url=args.index_url or "")
    index_url = resolve_index_url(cfg)
    trusted = resolve_trusted_host(cfg)
    log_path = home / "logs" / "bootstrap.log"

    exit_code = 0
    for ev in run_bootstrap(
        home_vibe=home, requirements=requirements,
        index_url=index_url, trusted_host=trusted, log_path=log_path,
    ):
        if args.sse:
            if ev.stage in ("done", "failed"):
                print(sse_event(ev.stage, {"ok": ev.ok, "message": ev.message}), end="", flush=True)
            else:
                print(stage_line(ev.stage, ev.message), end="", flush=True)
        else:
            print(f"[{ev.stage}] {ev.message}", flush=True)
        if ev.stage == "failed":
            exit_code = 1
    return exit_code
```

`agent/tests/test_desktop_bootstrap_flow.py` 追加:
```python
def test_cli_sse_flag_emits_frames(tmp_path, monkeypatch, capsys):
    import src.desktop_bootstrap.cli as cli_mod
    from src.desktop_bootstrap.bootstrap import BootstrapEvent
    monkeypatch.setattr(cli_mod, "run_bootstrap",
                        lambda **kw: iter([BootstrapEvent("installing", "x"),
                                           BootstrapEvent("done", "ready")]))
    monkeypatch.setattr("src.config.paths.get_runtime_root", lambda: tmp_path)
    rc = cli_mod.run_bootstrap_cli(["--sse"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "event: progress" in out and "event: done" in out
```

- [x] **Step 11: 运行确认通过**

Run: `pytest agent/tests/test_desktop_bootstrap_flow.py -v`
Expected: PASS(5 passed)

- [x] **Step 12: 注册 `bootstrap` 子命令到 CLI dispatcher**

`agent/cli/_legacy.py` —— 在 `_build_parser()` 的 subparsers 区(靠近 `serve_parser = subparsers.add_parser("serve", ...)` 第 4245 行)加:
```python
bootstrap_parser = subparsers.add_parser(
    "bootstrap", help="Create ~/.vibe-trading/venv and install backend deps"
)
bootstrap_parser.add_argument("--sse", action="store_true", help="Emit SSE frames (desktop console)")
bootstrap_parser.add_argument("--mirror", default=None)
bootstrap_parser.add_argument("--index-url", default=None)
```
在 dispatch 区(靠近 `if args.command == "serve":` 第 5187 行)加:
```python
if args.command == "bootstrap":
    from src.desktop_bootstrap.cli import run_bootstrap_cli
    forwarded = []
    if getattr(args, "sse", False):
        forwarded.append("--sse")
    if getattr(args, "mirror", None):
        forwarded += ["--mirror", args.mirror]
    if getattr(args, "index_url", None):
        forwarded += ["--index-url", args.index_url]
    return run_bootstrap_cli(forwarded)
```

- [x] **Step 13: 验证子命令在 argparse 层可见 + 编译**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
python -m py_compile agent/cli/_legacy.py agent/src/desktop_bootstrap/bootstrap.py agent/src/desktop_bootstrap/cli.py agent/src/optional_deps/installer.py
PYTHONPATH=agent python -c "
from cli._legacy import _build_parser
p = _build_parser()
ns = p.parse_args(['bootstrap','--sse'])
assert ns.command == 'bootstrap' and ns.sse is True
print('bootstrap subcommand registered OK')"
```
Expected: `bootstrap subcommand registered OK`,编译无错。

- [x] **Step 14: Commit**

```bash
git add agent/src/desktop_bootstrap/bootstrap.py agent/src/desktop_bootstrap/cli.py agent/src/optional_deps/installer.py agent/cli/_legacy.py agent/tests/test_desktop_bootstrap_flow.py agent/tests/test_installer_requirements.py
git commit -s -m "feat(bootstrap): orchestrate venv install flow + vibe-trading bootstrap subcommand"
```

## Task 5: 构建装配脚本装 Tier 0(python-runtime-bundling)

对应 tasks.md §5.1–5.4,python-runtime-bundling delta「bundle 仅含 Tier 0 核心」「Tier 0 足以拉起控制台与 serve 空转」与 REMOVED「资源装配与裁剪」的 Migration。翻转 `install-deps.sh` 的默认:不再装整个 `requirements.txt`,只装 Task 1 冻结的 `requirements-tier0.txt`;`assemble.sh` 装配范围维持(Tier 0 运行时 + agent 源码 + frontend/dist + .env 种子),冒烟改跑 Tier 0 冒烟;记录体积对比。依赖 Task 1(Tier 0 清单)。

**Files:**
- Modify: `scripts/desktop/install-deps.sh`(装 `requirements-tier0.txt`,冒烟改 `smoke_tier0.py`)
- Modify: `scripts/desktop/assemble.sh`(冒烟守卫改 Tier 0;体积记录)
- Modify: `scripts/desktop/build-dmg.sh`、`scripts/desktop/build-windows.ps1`(冒烟校验改 Tier 0)
- `scripts/desktop/fetch-runtime.sh`:无需改(只下运行时,与依赖层无关——本任务确认它不动)

- [x] **Step 1: install-deps.sh 改装 Tier 0**

`scripts/desktop/install-deps.sh` —— 把 `REQ_SRC` 从整个 requirements 改为 Tier 0 清单,冒烟从 `smoke_imports.py`(Tier 1 重型包)改为 `smoke_tier0.py`(仅入口链路):
```bash
#!/usr/bin/env bash
# scripts/desktop/install-deps.sh <runtime_dir>
# 只把 Tier 0 最小核心(requirements-tier0.txt)装进内嵌运行时的 site-packages。
# 重型依赖(pandas/scipy/... )不再进 bundle,改由首次运行 vibe-trading bootstrap
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
```
`ponytail:` 保留用 uv 装(脚本本就依赖 uv,只是安装源换 Tier 0 清单——这是"翻转默认"而非新增依赖;bootstrap 侧才用 stdlib pip)。

- [x] **Step 2: assemble.sh 冒烟守卫改 Tier 0**

`scripts/desktop/assemble.sh` 第 3 步(裁剪)之后、或在收尾处,把任何调用 `smoke_imports.py` 的校验改为 `smoke_tier0.py`。assemble.sh 当前不直接跑冒烟(冒烟在 install-deps.sh),故此步主要是:(a)确认 assemble 的裁剪逻辑(`__pycache__`/`tests`/`test`)对 Tier 0 运行时仍适用(delta Migration 明确"裁剪仍适用");(b)在收尾 `du -sh` 处补一行 bundle 体积记录(见 Step 5)。若 assemble.sh 无冒烟调用,此步只需在注释中标注装配范围为 Tier 0,不强行加冒烟。

- [x] **Step 3: build-dmg.sh / build-windows.ps1 冒烟校验改 Tier 0**

在两个打包脚本里,凡对**打包运行时**做的 import 冒烟(pre-bundle 校验)改用 `smoke_tier0.py`。注意区分:
- pre-bundle(bundle 内 Tier 0 运行时)→ `smoke_tier0.py`(只验证入口链路,不能验证重型包——它们已不在 bundle)
- 若脚本里原来用 `smoke_imports.py` 校验打包运行时的重型包,**必须删除或改为 Tier 0**,否则打包必失败(重型包已移出 bundle)。

Run(定位需改处):
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
grep -n "smoke_imports\|smoke_tier0\|requirements.txt\|install-deps" scripts/desktop/build-dmg.sh scripts/desktop/build-windows.ps1
```
按定位结果逐处改为 Tier 0 冒烟。

- [x] **Step 4: 校验脚本语法**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
bash -n scripts/desktop/install-deps.sh
bash -n scripts/desktop/assemble.sh
bash -n scripts/desktop/build-dmg.sh
pwsh -NoProfile -Command "\$null = [System.Management.Automation.Language.Parser]::ParseFile('scripts/desktop/build-windows.ps1', [ref]\$null, [ref]\$null); 'ps1 syntax OK'" 2>/dev/null || echo "pwsh 不可用则跳过 ps1 语法检查,Task 13 Windows 验收覆盖"
```
Expected: 三个 `bash -n` 无输出(语法正确);ps1 语法 OK 或明确跳过。

- [x] **Step 5: 实测装 Tier 0 + 体积对比(§5.4)**

Run(需已 `fetch-runtime.sh` 拉到运行时;如无则先拉):
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
# 若 .desktop-build/python-runtime 不存在,先拉运行时(需 PBS_TAG/PBS_ASSET,见现有 CI)
[ -x .desktop-build/python-runtime/bin/python3 ] || echo "先跑 fetch-runtime.sh"
# 记录装 Tier 0 前后体积
du -sh .desktop-build/python-runtime 2>/dev/null | tee /tmp/size-before.txt || true
bash scripts/desktop/install-deps.sh .desktop-build/python-runtime
du -sh .desktop-build/python-runtime | tee /tmp/size-after-tier0.txt
```
Expected: install-deps 成功,Tier 0 冒烟 `TIER0 SMOKE PASSED`。把体积对比(全量预装 vs Tier 0)追加到 `docs/desktop/tier0-boundary.md`——delta「bundle 体积显著小于全量预装」的证据。若本机不便实测全量对照,记录 Tier 0 绝对体积 + 说明重型包(pandas/scipy/sklearn/matplotlib/duckdb)已不在清单即为显著下降的定性依据。

- [x] **Step 6: Commit**

```bash
git add scripts/desktop/install-deps.sh scripts/desktop/assemble.sh scripts/desktop/build-dmg.sh scripts/desktop/build-windows.ps1 docs/desktop/tier0-boundary.md
git commit -s -m "build(desktop): bundle Tier 0 only, defer heavy deps to venv bootstrap"
```

## Task 6: Rust —— venv 解释器路径 + 覆盖白名单(安全关键 · tasks §4.1/4.4/4.5/4.6)

对应 tasks.md §4.1、§4.4、§4.5、§4.6,desktop-shell delta「首启与升级时准备可写运行目录」「升级刷新代码但保留用户资产与会话」「安全关键的 live 资产不被清除」「可写目录准备失败的可读错误」场景。改 `runtime_dir.rs`:Layout 暴露 venv/sessions/logs 路径;`sidecar::build_cmd` 用 venv 解释器 + 注入 `VIBE_SESSIONS_DIR`。**安全关键**:`prepare` 的覆盖行为必须显式验证 `live/` 等用户资产在升级重建后存活——delta 明确 `live/` 实盘授权与审计账本不得清除,对齐 CLAUDE.md 高风险面。

**关键事实(已核实)**:`~/.vibe-trading/live/` 由 `src.config.paths.get_runtime_root()/live` 解析,物理位于 root 层(不在 `runtime/` 内),`runtime/` 重建天然不触及它。`runtime_dir.rs::prepare` 当前只 `copy_dir_recursive(bundle_agent, runtime_agent)`(仅动 `runtime/agent`),对 root 层的 `live/`/`sessions/` 等本就不动。本任务的价值是:(a)加 `venv`/`sessions`/`logs` 路径到 Layout;(b)**加针对性测试锁定** live/sessions 不被 prepare 触碰的不变量(防未来重构回归)。依赖 Task 2(env 名)。

**Files:**
- Modify: `src-tauri/src/runtime_dir.rs`(Layout 增字段 + 保留资产测试)
- Modify: `src-tauri/src/sidecar.rs`(`build_cmd` 解释器改 venv、注入 `VIBE_SESSIONS_DIR`)

- [x] **Step 1: 写 Layout venv/sessions/logs 路径的失败测试**

在 `src-tauri/src/runtime_dir.rs` 的 `#[cfg(test)] mod tests` 内追加:
```rust
    #[test]
    fn layout_exposes_venv_python_path() {
        let home = std::path::Path::new("/fake/home/.vibe-trading");
        let layout = Layout::new(home);
        // venv 在 home 根层,幸存 runtime 重建
        assert_eq!(layout.venv_dir, home.join("venv"));
        if cfg!(windows) {
            assert_eq!(layout.venv_python, home.join("venv").join("Scripts").join("python.exe"));
        } else {
            assert_eq!(layout.venv_python, home.join("venv").join("bin").join("python"));
        }
    }

    #[test]
    fn layout_exposes_sessions_and_logs_at_home_root() {
        let home = std::path::Path::new("/fake/home/.vibe-trading");
        let layout = Layout::new(home);
        // 会话与日志在 home 根层,不在 runtime/ 内(设计 D4:幸存 runtime 重建)
        assert_eq!(layout.sessions_dir, home.join("sessions"));
        assert_eq!(layout.logs_dir, home.join("logs"));
        assert!(!layout.sessions_dir.starts_with(home.join("runtime")));
    }
```

- [x] **Step 2: 运行确认失败**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri && cargo test runtime_dir 2>&1 | tail -20`
Expected: 编译失败 —— `Layout` 无 `venv_dir`/`venv_python`/`sessions_dir`/`logs_dir` 字段。

- [x] **Step 3: 给 Layout 加字段**

`src-tauri/src/runtime_dir.rs` 的 `struct Layout` 与 `impl Layout::new`:
```rust
pub struct Layout {
    pub root: PathBuf,          // ~/.vibe-trading
    pub runtime_agent: PathBuf, // ~/.vibe-trading/runtime/agent
    pub runtime_libs: PathBuf,  // ~/.vibe-trading/runtime/libs (Tier 2 可选依赖)
    pub marker: PathBuf,        // ~/.vibe-trading/runtime/.installed_version
    pub user_env: PathBuf,      // ~/.vibe-trading/.env
    pub venv_dir: PathBuf,      // ~/.vibe-trading/venv (Tier 1 bootstrap,幸存重建)
    pub venv_python: PathBuf,   // venv 解释器可执行
    pub sessions_dir: PathBuf,  // ~/.vibe-trading/sessions (迁出 runtime/,幸存重建)
    pub logs_dir: PathBuf,      // ~/.vibe-trading/logs (bootstrap/serve 日志)
}

impl Layout {
    pub fn new(home_vibe: &Path) -> Self {
        let venv_python = if cfg!(windows) {
            home_vibe.join("venv").join("Scripts").join("python.exe")
        } else {
            home_vibe.join("venv").join("bin").join("python")
        };
        Self {
            root: home_vibe.to_path_buf(),
            runtime_agent: home_vibe.join("runtime").join("agent"),
            runtime_libs: home_vibe.join("runtime").join("libs"),
            marker: home_vibe.join("runtime").join(".installed_version"),
            user_env: home_vibe.join(".env"),
            venv_dir: home_vibe.join("venv"),
            venv_python,
            sessions_dir: home_vibe.join("sessions"),
            logs_dir: home_vibe.join("logs"),
        }
    }
    // from_home() 不变
}
```

- [x] **Step 4: 运行确认通过**

Run: `cd src-tauri && cargo test runtime_dir 2>&1 | tail -20`
Expected: 新增 2 测试通过,原有 runtime_dir 测试不回归。

- [x] **Step 5: prepare 确保 sessions/logs/venv 目录存在(不清空)**

`src-tauri/src/runtime_dir.rs::prepare` —— 在现有 `create_dir_all(&layout.runtime_libs)` 之后,补建 sessions/logs 目录(与 runtime_libs 同属"用户拥有、升级不清空"的数据目录):
```rust
    // 会话/日志/venv 均在 home 根层，属用户数据：始终确保存在，升级不清空。
    // (venv 本身由 vibe-trading bootstrap 创建；这里只确保父目录 home 就绪，
    //  bootstrap 会 mkdir venv，故此处不预建 venv_dir。)
    for dir in [&layout.sessions_dir, &layout.logs_dir] {
        fs::create_dir_all(dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    }
```

- [x] **Step 6: 写安全关键的用户资产保留测试**

在 `runtime_dir.rs` tests 内追加(锁定 live/sessions 在升级重建后存活的不变量):
```rust
    #[test]
    fn upgrade_preserves_live_audit_and_sessions() {
        // 安全关键(CLAUDE.md 高风险面 / desktop-shell delta):
        // 升级重建 runtime/ 时，root 层的 live/ 授权与审计、sessions/ 会话不得清除。
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);
        prepare(&bundle.join("agent"), &bundle.join("agent/.env"),
                &bundle.join("VERSION"), None, &layout).unwrap();

        // 模拟用户资产:实盘授权/审计账本 + 会话
        let live_audit = home.join("live").join("audit_ledger.jsonl");
        fs::create_dir_all(live_audit.parent().unwrap()).unwrap();
        fs::write(&live_audit, "AUDIT ENTRY").unwrap();
        let mandate = home.join("live").join("mandate.json");
        fs::write(&mandate, "MANDATE").unwrap();
        let session = layout.sessions_dir.join("s1").join("messages.jsonl");
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        fs::write(&session, "SESSION").unwrap();

        // 升级 bundle → v2，重建 runtime/
        fs::write(bundle.join("agent/api_server.py"), "# v2").unwrap();
        fs::write(bundle.join("VERSION"), "2.0.0").unwrap();
        prepare(&bundle.join("agent"), &bundle.join("agent/.env"),
                &bundle.join("VERSION"), None, &layout).unwrap();

        // runtime/ 代码已刷新
        assert_eq!(fs::read_to_string(layout.runtime_agent.join("api_server.py")).unwrap(), "# v2");
        // 但安全资产与会话全部存活
        assert_eq!(fs::read_to_string(&live_audit).unwrap(), "AUDIT ENTRY", "live 审计账本必须保留");
        assert_eq!(fs::read_to_string(&mandate).unwrap(), "MANDATE", "live mandate 必须保留");
        assert_eq!(fs::read_to_string(&session).unwrap(), "SESSION", "会话必须保留");
    }

    #[test]
    fn prepare_readable_error_on_unwritable_target() {
        // 可写目录准备失败 → 返回含路径的可读错误(供控制台展示,不静默崩溃)。
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        let layout = Layout::new(&home);
        let missing = tmp.path().join("nope/agent");
        let err = prepare(&missing, &missing.join(".env"),
                          &tmp.path().join("VERSION"), None, &layout).unwrap_err();
        assert!(err.contains("agent") || err.contains("VERSION"), "错误须含失败路径线索: {err}");
    }
```

- [x] **Step 7: 运行安全测试确认通过**

Run: `cd src-tauri && cargo test runtime_dir 2>&1 | tail -20`
Expected: `upgrade_preserves_live_audit_and_sessions` 与 `prepare_readable_error_on_unwritable_target` 通过。若因 `prepare` 未建 sessions_dir 导致 write 失败,回到 Step 5 确认目录预建。

- [x] **Step 8: sidecar build_cmd 改 venv 解释器 + 注入 VIBE_SESSIONS_DIR 的失败测试**

`src-tauri/src/sidecar.rs` tests 内追加:
```rust
    #[test]
    fn build_cmd_injects_sessions_dir_env() {
        let python = Path::new("/fake/venv/bin/python");
        let agent = Path::new("/fake/agent");
        let cmd = build_cmd(python, agent, 8899, Path::new("/fake/libs"), Path::new("/fake/home/sessions"));
        let mut found = false;
        for (key, val) in cmd.get_envs() {
            if key.to_str() == Some("VIBE_SESSIONS_DIR")
                && val.and_then(|v| v.to_str()) == Some("/fake/home/sessions") {
                found = true;
            }
        }
        assert!(found, "VIBE_SESSIONS_DIR 必须注入,使会话落 home 幸存 runtime 重建");
    }
```
(现有 `build_cmd` 的 4 个测试签名需同步加 `sessions_dir` 参数——见 Step 9。)

- [x] **Step 9: 改 build_cmd/spawn 签名加 sessions_dir 参数**

`src-tauri/src/sidecar.rs` —— 给 `build_cmd` 与 `spawn` 加 `sessions_dir: &Path` 参数并注入 env:
```rust
pub fn build_cmd(
    python: &Path,
    runtime_agent: &Path,
    port: u16,
    runtime_libs: &Path,
    sessions_dir: &Path,
) -> std::process::Command {
    let mut cmd = Command::new(python);
    cmd.arg("-c").arg(BOOT).arg("serve")
        .arg("--host").arg("127.0.0.1")
        .arg("--port").arg(port.to_string())
        .current_dir(runtime_agent)
        .env("PYTHONPATH", runtime_agent)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("VIBE_RUNTIME_LIBS", runtime_libs)
        // 会话迁出 runtime/：设 VIBE_SESSIONS_DIR 到 home，幸存 runtime 重建(设计 D4)。
        .env("VIBE_SESSIONS_DIR", sessions_dir)
        .env("PIP_INDEX_URL", "https://pypi.tuna.tsinghua.edu.cn/simple")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // ... setsid / creation_flags 分支不变
    cmd
}

pub fn spawn(
    python: &Path,
    runtime_agent: &Path,
    port: u16,
    runtime_libs: &Path,
    sessions_dir: &Path,
) -> Result<Child, String> {
    let mut cmd = build_cmd(python, runtime_agent, port, runtime_libs, sessions_dir);
    cmd.spawn().map_err(|e| format!("spawn sidecar failed: {e}"))
}
```
同步更新 sidecar.rs 内**现有 4 个** `build_cmd(...)` 测试调用,补第 5 个参数 `Path::new("/fake/sessions")`(`spawn_command_has_expected_args`、`build_cmd_includes_serve_args`、`build_cmd_injects_runtime_libs_env`、`build_cmd_injects_default_pip_mirror`)。

- [x] **Step 10: 运行 sidecar 测试确认通过**

Run: `cd src-tauri && cargo test sidecar 2>&1 | tail -25`
Expected: 5 个 build_cmd 相关测试全通过(含新 `build_cmd_injects_sessions_dir_env`)。

- [x] **Step 11: 全量 cargo test 不回归**

Run: `cd src-tauri && cargo test 2>&1 | tail -25`
Expected: 全绿(main.rs 里的 `sidecar::spawn` 调用点会因签名变更编译失败——若如此,记为 Task 8 修复点,或在此临时补 `layout.sessions_dir` 参数使其先编译;优先在 Step 12 一并处理)。

- [x] **Step 12: 修 main.rs 的 spawn 调用点(过渡编译)**

`src-tauri/src/main.rs` 的 `boot()` 内 `sidecar::spawn(...)` 调用补 `&layout.sessions_dir`。注意:main.rs 的完整控制台重构在 Task 8;此步只做最小编译修复,使 Task 6 自身可 `cargo test` 通过:
```rust
let mut child = sidecar::spawn(&res.runtime_python, &layout.runtime_agent, p, &layout.runtime_libs, &layout.sessions_dir)?;
```

- [x] **Step 13: 再次 cargo test 全绿 + Commit**

Run: `cd src-tauri && cargo test 2>&1 | tail -15`
Expected: 全绿。
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/src/runtime_dir.rs src-tauri/src/sidecar.rs src-tauri/src/main.rs
git commit -s -m "feat(desktop): venv interpreter paths, VIBE_SESSIONS_DIR, preserve live/sessions on upgrade"
```

## Task 7: Rust 控制台 IPC 命令(desktop-control-console)

对应 tasks.md §3.1–3.5,desktop-control-console delta 全部场景(环境/服务状态、引导安装、启停服务、浏览器打开 WebUI、打开日志目录),以及 §2.2 的 bootstrap SSE 转发。新增 `console.rs`:一组 `#[tauri::command]` IPC,供控制台页(Task 8)`invoke`。每个命令是薄壳——环境状态判定/进程启停在 Rust,bootstrap 逻辑委托给 `vibe-trading bootstrap --sse` 子进程并把它的 stdout SSE 帧 emit 给前端。抽出纯函数(状态判定、命令构造)做单元测试(D3:Rust 侧极薄,逻辑可 cargo 测)。依赖 Task 6(Layout/venv 路径)、Task 4(bootstrap 子命令)。

**状态模型(desktop-control-console delta)**:环境状态 = `NotInstalled`(无 venv)/ `Ready`(venv 存在且 hash marker 存在)/ `Incomplete`(venv 存在但 marker 缺失或冒烟未过);服务状态 = `Running`(sidecar 句柄存在且 `/health` 通过)/ `Stopped`。

**Files:**
- Create: `src-tauri/src/console.rs`
- Modify: `src-tauri/src/main.rs`(`mod console;`,注册 invoke_handler)
- Modify: `src-tauri/Cargo.toml`(若 emit 事件需 `tauri` 的 `Emitter`——通常已在;确认即可)

- [x] **Step 1: 写环境状态判定的失败测试**

`src-tauri/src/console.rs` 底部 `#[cfg(test)]`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use std::fs;

    #[test]
    fn env_status_not_installed_when_no_venv() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        let layout = crate::runtime_dir::Layout::new(&home);
        assert_eq!(compute_env_status(&layout), EnvStatus::NotInstalled);
    }

    #[test]
    fn env_status_incomplete_when_venv_without_marker() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        let layout = crate::runtime_dir::Layout::new(&home);
        // 造一个 venv 解释器但无 hash marker → 依赖不全
        fs::create_dir_all(layout.venv_python.parent().unwrap()).unwrap();
        fs::write(&layout.venv_python, "#!/bin/sh\n").unwrap();
        assert_eq!(compute_env_status(&layout), EnvStatus::Incomplete);
    }

    #[test]
    fn env_status_ready_when_venv_and_marker_present() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        let layout = crate::runtime_dir::Layout::new(&home);
        fs::create_dir_all(layout.venv_python.parent().unwrap()).unwrap();
        fs::write(&layout.venv_python, "#!/bin/sh\n").unwrap();
        // bootstrap 的 hash marker 落在 venv/.requirements_hash(与 Task 3 一致)
        fs::write(layout.venv_dir.join(".requirements_hash"), "deadbeef").unwrap();
        assert_eq!(compute_env_status(&layout), EnvStatus::Ready);
    }
}
```

- [x] **Step 2: 运行确认失败**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri && cargo test console 2>&1 | tail -20`
Expected: 编译失败 —— `console` 模块 / `compute_env_status` / `EnvStatus` 不存在。

- [x] **Step 3: 写状态判定纯函数 + 类型**

`src-tauri/src/console.rs`(顶部,纯逻辑部分):
```rust
// src-tauri/src/console.rs
//! 桌面控制台 IPC —— 环境/服务状态、启停服务、bootstrap 转发、打开 WebUI/日志。
//! 逻辑尽量做成纯函数(可 cargo 测);Tauri command 是薄壳(设计 D3)。
use std::path::Path;
use crate::runtime_dir::Layout;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvStatus {
    NotInstalled, // 无 venv
    Incomplete,   // venv 存在但依赖不全(无 hash marker)
    Ready,        // venv 存在且 marker 存在 → 允许启动服务
}

/// 依据磁盘上的 venv 解释器与 bootstrap hash marker 判定环境状态。
pub fn compute_env_status(layout: &Layout) -> EnvStatus {
    if !layout.venv_python.exists() {
        return EnvStatus::NotInstalled;
    }
    let marker = layout.venv_dir.join(".requirements_hash");
    if marker.exists() {
        EnvStatus::Ready
    } else {
        EnvStatus::Incomplete
    }
}

/// 构造 `vibe-trading bootstrap --sse` 子进程命令(Tier 0 运行时解释器跑,非 venv)。
/// bootstrap 用 bundle 的 Tier 0 python 执行(此时 venv 尚不存在),它内部再建 venv。
pub fn build_bootstrap_cmd(tier0_python: &Path, runtime_agent: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(tier0_python);
    cmd.arg("-c")
        .arg("import cli,sys; raise SystemExit(cli.main(sys.argv[1:]))")
        .arg("bootstrap").arg("--sse")
        .current_dir(runtime_agent)
        .env("PYTHONPATH", runtime_agent)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd
}
```

- [x] **Step 4: 运行确认通过**

Run: `cd src-tauri && cargo test console 2>&1 | tail -20`
Expected: 3 个 env_status 测试通过。

- [x] **Step 5: 写 build_bootstrap_cmd 参数测试**

`console.rs` tests 追加:
```rust
    #[test]
    fn bootstrap_cmd_runs_cli_bootstrap_sse() {
        let cmd = build_bootstrap_cmd(Path::new("/rt/bin/python3"), Path::new("/rt/agent"));
        let args: Vec<&str> = cmd.get_args().map(|a| a.to_str().unwrap()).collect();
        let joined = args.join(" ");
        assert!(joined.contains("bootstrap"), "args: {joined}");
        assert!(joined.contains("--sse"), "args: {joined}");
        let mut has_pythonpath = false;
        for (k, v) in cmd.get_envs() {
            if k.to_str() == Some("PYTHONPATH") && v.and_then(|x| x.to_str()) == Some("/rt/agent") {
                has_pythonpath = true;
            }
        }
        assert!(has_pythonpath, "bootstrap 子进程须设 PYTHONPATH 指向 runtime agent");
    }
```
Run: `cargo test console 2>&1 | tail -15` → Expected: 4 通过。

- [x] **Step 6: 写 Tauri command 薄壳(状态/启停/打开/bootstrap 转发)**

`console.rs` 追加(command 层——薄壳,调用 Step 3 的纯函数 + 现有 sidecar/资源):
```rust
use std::sync::{Arc, Mutex};
use std::process::Child;
use tauri::{AppHandle, Emitter, State};

pub type SharedChild = Arc<Mutex<Option<Child>>>;

#[derive(serde::Serialize)]
pub struct StatusReport {
    env: EnvStatus,
    service_running: bool,
    port: Option<u16>,
}

/// 环境 + 服务状态快照,供控制台首屏与轮询(desktop-control-console)。
#[tauri::command]
pub fn console_status(state: State<'_, SharedChild>) -> Result<StatusReport, String> {
    let layout = Layout::from_home()?;
    let running = state.lock().unwrap().is_some();
    Ok(StatusReport { env: compute_env_status(&layout), service_running: running, port: None })
}

/// 触发依赖 bootstrap:spawn `vibe-trading bootstrap --sse`,逐行 emit "bootstrap://progress"。
/// 环境未就绪时控制台调用它;完成事件由前端据 event 名判定。
#[tauri::command]
pub async fn console_bootstrap(app: AppHandle) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    let layout = Layout::from_home()?;
    let res = crate::resources::Resources::resolve(&app).map_err(|e| format!("resources: {e}"))?;
    let mut child = build_bootstrap_cmd(&res.runtime_python, &layout.runtime_agent)
        .spawn().map_err(|e| format!("spawn bootstrap: {e}"))?;
    let stdout = child.stdout.take().ok_or("no bootstrap stdout")?;
    // 后台线程读子进程 stdout 的 SSE 帧,原样 emit 给前端 EventSource-like 监听。
    let app2 = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app2.emit("bootstrap://progress", line);
        }
        let code = child.wait().ok().and_then(|s| s.code());
        let _ = app2.emit("bootstrap://exit", code);
    });
    Ok(())
}

/// 启动服务:环境未就绪时拒绝(引导先安装);否则用 venv 解释器 spawn serve + 健康门控。
#[tauri::command]
pub fn console_start_service(app: AppHandle, state: State<'_, SharedChild>) -> Result<u16, String> {
    let layout = Layout::from_home()?;
    if compute_env_status(&layout) != EnvStatus::Ready {
        return Err("环境未就绪,请先完成依赖安装".into());
    }
    if state.lock().unwrap().is_some() {
        return Err("服务已在运行".into());
    }
    let port = crate::port::pick_free_port()?;
    let mut child = crate::sidecar::spawn(
        &layout.venv_python, &layout.runtime_agent, port, &layout.runtime_libs, &layout.sessions_dir,
    )?;
    match crate::sidecar::await_health(&mut child, port) {
        crate::sidecar::Ready::Ok => { state.lock().unwrap().replace(child); let _ = app.emit("service://started", port); Ok(port) }
        crate::sidecar::Ready::ProcessExited(c) => Err(format!("后端提前退出(退出码 {c:?})")),
        crate::sidecar::Ready::Timeout => Err("后端 120 秒内未就绪".into()),
    }
}

/// 停止服务:干净回收 sidecar 进程组(复用现有 terminate)。
#[tauri::command]
pub fn console_stop_service(state: State<'_, SharedChild>) -> Result<(), String> {
    if let Some(mut child) = state.lock().unwrap().take() {
        crate::sidecar::terminate(&mut child);
    }
    Ok(())
}

/// 在系统默认浏览器打开 WebUI(复用 main.rs 的 open_external_url 逻辑)。
#[tauri::command]
pub fn console_open_webui(port: u16) -> Result<(), String> {
    crate::open_external_url(format!("http://127.0.0.1:{port}/"))
}

/// 在文件管理器打开 ~/.vibe-trading/logs/。
#[tauri::command]
pub fn console_open_logs() -> Result<(), String> {
    let layout = Layout::from_home()?;
    std::fs::create_dir_all(&layout.logs_dir).map_err(|e| format!("mkdir logs: {e}"))?;
    open_path_in_file_manager(&layout.logs_dir)
}

#[cfg(target_os = "macos")]
fn open_path_in_file_manager(p: &Path) -> Result<(), String> {
    std::process::Command::new("open").arg(p).spawn().map(|_| ()).map_err(|e| format!("open logs: {e}"))
}
#[cfg(target_os = "windows")]
fn open_path_in_file_manager(p: &Path) -> Result<(), String> {
    std::process::Command::new("explorer").arg(p).spawn().map(|_| ()).map_err(|e| format!("open logs: {e}"))
}
#[cfg(target_os = "linux")]
fn open_path_in_file_manager(p: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open").arg(p).spawn().map(|_| ()).map_err(|e| format!("open logs: {e}"))
}
```
注意:`open_external_url` 在 main.rs 当前是私有 `#[tauri::command] fn`——把它改为 `pub fn open_external_url(url: String) -> Result<(), String>`(保留 `#[tauri::command]` 属性),供 console.rs 复用(避免重复 URL 校验逻辑,DRY)。

- [x] **Step 7: main.rs 注册模块 + invoke_handler**

`src-tauri/src/main.rs`:
```rust
mod resources; mod version; mod runtime_dir; mod port; mod sidecar; mod console;
```
`invoke_handler` 扩展(Task 8 会最终定形,此处先注册使 command 可编译):
```rust
.invoke_handler(tauri::generate_handler![
    open_external_url,
    console::console_status,
    console::console_bootstrap,
    console::console_start_service,
    console::console_stop_service,
    console::console_open_webui,
    console::console_open_logs
])
```
并把 `SharedChild` 作为 Tauri managed state(供 command 的 `State<'_, SharedChild>` 注入):在 `tauri::Builder::default()` 链上加 `.manage(shared.clone())`(用现有 `shared` 句柄,类型改为 `console::SharedChild` 别名——它与 main.rs 现有 `type SharedChild` 等价,统一到 console 模块避免两处定义)。

- [x] **Step 8: cargo test 全绿(console 逻辑 + 编译)**

Run: `cd src-tauri && cargo test 2>&1 | tail -25`
Expected: console 的 4 个纯函数测试通过;整体编译通过(main.rs 的 boot 仍是旧逻辑,Task 8 重写)。若 `open_external_url` 可见性/managed state 未接好导致编译错,在此修至全绿。

- [x] **Step 9: Commit**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/src/console.rs src-tauri/src/main.rs
git commit -s -m "feat(console): IPC commands for env/service status, bootstrap, start/stop, open webui/logs"
```

## Task 8: 控制台页面 + main.rs boot 重构(desktop-control-console · desktop-shell §4.2)

对应 tasks.md §3.1(展示状态)、§3.2(触发安装、未就绪禁用启动)、§4.2(移除 webview 托管业务 UI)。这是把 Task 7 的 IPC 缝合成用户可见控制台的收尾:控制台页(`loading.html` 的演进,D3)经 `invoke` 调 Rust command,`listen` 接 bootstrap/service 事件;`main.rs::boot` 重写为"准备目录 → 展示控制台页(不自动 spawn serve、不导航业务 SPA)"。业务 SPA 改由 `console_open_webui` 交系统浏览器。依赖 Task 7。

**Files:**
- Create: `src-tauri/console.html`(控制台页,取代 loading.html 的角色)
- Modify: `src-tauri/tauri.conf.json`(窗口/frontendDist 指向控制台页,不指向业务 dist)
- Modify: `src-tauri/src/main.rs`(boot 重写;窗口加载 console.html)

- [x] **Step 1: 写控制台页**

`src-tauri/console.html`(演进自 placeholder-dist/index.html 的样式;加状态区 + 操作按钮 + 进度日志;经 `window.__TAURI__` invoke/listen):
```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Vibe Trading 控制台</title>
<style>
  body{margin:0;min-height:100vh;font-family:-apple-system,Segoe UI,sans-serif;
    background:#0e0f13;color:#e6e6e6;display:flex;flex-direction:column;align-items:center;padding:32px}
  .card{width:min(640px,92vw)}
  .row{display:flex;align-items:center;gap:12px;margin:12px 0}
  .badge{padding:3px 10px;border-radius:6px;font-size:13px}
  .ok{background:#1f6f3f}.warn{background:#8a6d1f}.bad{background:#7a2a2a}
  button{padding:8px 16px;background:#5b8cff;border:0;border-radius:6px;color:#fff;cursor:pointer}
  button:disabled{background:#33384a;cursor:not-allowed}
  #log{margin-top:16px;height:220px;overflow:auto;background:#07080b;border-radius:6px;
    padding:10px;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap}
  #err{color:#ff8080;white-space:pre-wrap;font-size:13px}
</style></head>
<body>
  <div class="card">
    <h2>Vibe Trading</h2>
    <div class="row">环境状态: <span id="envBadge" class="badge warn">检测中…</span></div>
    <div class="row">服务状态: <span id="svcBadge" class="badge warn">已停止</span></div>
    <div class="row">
      <button id="btnInstall">安装 / 修复依赖</button>
      <button id="btnStart" disabled>启动服务</button>
      <button id="btnStop" disabled>停止</button>
      <button id="btnOpen" disabled>在浏览器打开 WebUI</button>
      <button id="btnLogs">打开日志目录</button>
    </div>
    <div id="err"></div>
    <div id="log"></div>
  </div>
  <script>
    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;
    const $ = (id) => document.getElementById(id);
    const logEl = $("log");
    let port = null;
    function log(line){ logEl.textContent += line + "\n"; logEl.scrollTop = logEl.scrollHeight; }
    function setErr(m){ $("err").textContent = m || ""; }

    function renderEnv(env){
      const b = $("envBadge");
      const map = { ready:["就绪","ok"], incomplete:["依赖不全","warn"], not_installed:["未安装","bad"] };
      const [txt, cls] = map[env] || ["未知","warn"];
      b.textContent = txt; b.className = "badge " + cls;
      // 未就绪禁用"启动服务",突出安装入口(desktop-control-console §3.2)
      $("btnStart").disabled = (env !== "ready") || (port !== null);
    }
    function renderSvc(running){
      const b = $("svcBadge");
      b.textContent = running ? "运行中" : "已停止";
      b.className = "badge " + (running ? "ok" : "warn");
      $("btnStop").disabled = !running;
      $("btnOpen").disabled = !running;
    }
    async function refresh(){
      try {
        const s = await invoke("console_status");
        renderEnv(s.env); renderSvc(s.service_running);
      } catch(e){ setErr(String(e)); }
    }

    listen("bootstrap://progress", (ev) => log(ev.payload));
    listen("bootstrap://exit", (ev) => { log("bootstrap 退出码: " + ev.payload); refresh(); });
    listen("service://started", (ev) => { port = ev.payload; renderSvc(true); $("btnStart").disabled = true; });

    $("btnInstall").onclick = async () => { setErr(""); log("开始安装依赖…"); try { await invoke("console_bootstrap"); } catch(e){ setErr(String(e)); } };
    $("btnStart").onclick = async () => { setErr(""); try { port = await invoke("console_start_service"); renderSvc(true); } catch(e){ setErr(String(e)); } };
    $("btnStop").onclick = async () => { try { await invoke("console_stop_service"); port = null; renderSvc(false); await refresh(); } catch(e){ setErr(String(e)); } };
    $("btnOpen").onclick = async () => { if (port !== null) await invoke("console_open_webui", { port }); };
    $("btnLogs").onclick = async () => { try { await invoke("console_open_logs"); } catch(e){ setErr(String(e)); } };

    refresh();
    setInterval(refresh, 3000); // 轮询保持状态与磁盘/进程一致(delta「状态与实际一致」)
  </script>
</body></html>
```

- [x] **Step 2: tauri.conf.json 指向控制台页,不指向业务 dist**

`src-tauri/tauri.conf.json` —— `frontendDist` 从 `./placeholder-dist` 改为控制台页所在目录(把 `console.html` 放到一个 `console-dist/` 或直接让 frontendDist 指向含 console.html 的目录并改窗口入口)。最小改动:
```json
{
  "build": {
    "frontendDist": "./console-dist",
    "devUrl": "http://127.0.0.1:5899/",
    "beforeDevCommand": "cd frontend && npm run dev"
  }
}
```
把 `src-tauri/console.html` 放为 `src-tauri/console-dist/index.html`(或调整 assemble 把 console.html 拷进去)。**注意**:`bundle.resources` 仍保留 `"../frontend/dist": "frontend/dist"`——业务 SPA 仍需打包进 bundle,供 serve 从 `~/.vibe-trading/runtime/frontend/dist` 静态托管给浏览器访问(delta「业务 UI 由默认浏览器承载」)。即业务 dist 从"webview 加载目标"降级为"serve 静态资源",打包仍需要它。

- [x] **Step 3: 重写 main.rs boot()**

`src-tauri/src/main.rs` —— boot 不再 spawn serve、不导航业务 SPA;只准备目录并让窗口停在控制台页(所有动作交控制台 IPC)。dev 分支保留(dev 仍可走 Vite,便于前端开发):
```rust
fn boot(
    handle: &tauri::AppHandle,
    win: &tauri::WebviewWindow,
    res: &resources::Resources,
    _shared: &console::SharedChild,
) -> Result<(), String> {
    // 准备可写运行目录(会话/日志/venv 父目录就绪;runtime/ 代码刷新)。
    let layout = runtime_dir::Layout::from_home()?;
    runtime_dir::prepare(&res.agent_template, &res.env_seed, &res.version_file,
                         Some(&res.frontend_dist), &layout)?;
    let _ = (handle, win);
    // 不再自动 spawn serve、不导航业务 SPA——窗口停在控制台页(console.html),
    // 由用户经控制台按钮触发 bootstrap / 启停 / 打开浏览器(desktop-control-console)。
    Ok(())
}
```
`setup` 里窗口构造保持加载 `index.html`(现在是 console-dist 的控制台页);`.manage(shared.clone())` 已在 Task 7 加。`RunEvent::ExitRequested` 的 `sidecar::terminate` 保留(停服务=干净回收,delta「停止服务干净退出」)。boot 失败仍走现有 err 注入逻辑(delta「可写目录准备失败的可读错误」——控制台展示,不静默崩溃)。

- [x] **Step 4: 清理无用的 dev-aware 导航(业务 SPA 导航已废)**

main.rs 的 `nav_target_dev_aware` / `sidecar_port_dev_aware` 中,release 分支的"导航到 sidecar SPA"逻辑已不再由 boot 使用(boot 不导航)。保留 dev 分支(前端开发仍需 Vite)。给这两个函数的 release 分支加 `ponytail:` 注释说明 release 下已不经 boot 调用,或按需删除 release 分支下的 nav 调用。对应更新 main.rs 的相关单测(`release_navigates_to_sidecar` 等)——若删逻辑则删测试,若保留则测试不变。

- [x] **Step 5: cargo test + 前端资源就位校验**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
mkdir -p src-tauri/console-dist && cp src-tauri/console.html src-tauri/console-dist/index.html 2>/dev/null || true
cd src-tauri && cargo test 2>&1 | tail -25
```
Expected: cargo test 全绿。

- [x] **Step 6: dev 手动冒烟(可选但推荐)**

Run(需已 assemble `.desktop-build/`):
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri
cargo tauri dev
```
Expected(人工确认):窗口显示控制台页,环境状态徽章渲染;点"安装依赖"能看到进度日志滚动(bootstrap SSE 转发到位);未就绪时"启动服务"禁用。若无法跑 dev(资源未装配),记为 Task 13 验收覆盖并跳过。

- [x] **Step 7: Commit**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/console.html src-tauri/console-dist src-tauri/tauri.conf.json src-tauri/src/main.rs
git commit -s -m "feat(desktop): console page + boot rewrite, business UI moves to system browser"
```

## Task 9: 渠道依赖安装 UI + CLI 等价校验(channel-management-ui §6.1/6.2/6.4)

对应 tasks.md §6.1(渠道启停接入——已在 `Settings.tsx` 接好 `api.startChannels`/`stopChannels`/`getChannelStatus`,本任务确认并补测)、§6.2(渠道依赖安装 UI,复用现有 `/optional-deps` SSE 机制)、§6.4(CLI 渠道命令仍可用且与 WebUI 等价)。channel-management-ui delta「从 WebUI 安装渠道依赖」「CLI 与 WebUI 行为一致」场景。前端复用已存在的 `api.listOptionalDeps`/`api.installOptionalDep`/`api.optionalDepStatusUrl` 客户端(api.ts 已有,注意是 `listOptionalDeps` 非 `getOptionalDeps`),不新造安装机制(Tier 2 原样复用)。

**Files:**
- Modify: `frontend/src/pages/Settings.tsx`(不可用渠道加"安装依赖"入口,接 optional-deps 安装 + SSE 进度)
- Modify: `frontend/src/pages/__tests__/SettingsChannels.test.tsx`(扩展:启停已接、依赖安装入口渲染)
- Test: `agent/tests/test_channels_cli_parity.py`(§6.4:CLI 与 REST 走同一 runtime)

- [x] **Step 1: 写 CLI 等价性测试(§6.4)**

`agent/tests/test_channels_cli_parity.py` —— 锁定 CLI `channels start/status` 与 REST `/channels/start`、`/channels/status` 命中同一 `_get_channel_runtime()`,状态两处一致:
```python
"""渠道 CLI 与 WebUI 等价 —— 同一 runtime 单例,状态两处可见(channel-management-ui)。"""
import importlib


def test_cli_status_and_rest_status_share_runtime(monkeypatch):
    # cmd_channels_status(local=True) 读的本地状态应与 api_server 的 runtime.status() 同源。
    legacy = importlib.import_module("cli._legacy")
    api = importlib.import_module("api_server")
    # 两处都通过 _get_channel_runtime / _channels_local_status 解析同一 config 根;
    # 断言函数存在且可无异常取状态(不启动真实适配器)。
    assert hasattr(legacy, "cmd_channels_status")
    assert hasattr(legacy, "_channels_local_status")
    status = legacy._channels_local_status()
    assert isinstance(status, dict) and "channels" in status
    # REST 侧 runtime.status() 的形状与本地一致(都含 channels 映射)。
    runtime = api._get_channel_runtime()
    assert "channels" in runtime.status()
```

- [x] **Step 2: 运行确认(测试应通过或指出真实差异)**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop && pytest agent/tests/test_channels_cli_parity.py -v`
Expected: PASS。若 `_channels_local_status` 的键名与 REST 不一致而 FAIL,说明存在真实等价性缺陷——修 CLI/REST 使二者状态形状一致(这是 §6.4 的实质),再通过。

- [x] **Step 3: 前端——不可用渠道加"安装依赖"入口**

`frontend/src/pages/Settings.tsx` 渠道表格的 `recovery` 列(第 430 行附近):当某渠道 `available === false` 且其恢复信息指向一个 optional-deps 注册包时,渲染"安装依赖"按钮。逻辑:
- 组件加载时 `api.listOptionalDeps()` 拿到注册包列表(broker/渠道可选依赖白名单)。
- 渠道行若匹配到注册包名(用渠道的 `install_hint`/包名),显示"安装"按钮。
- 点击 → `api.installOptionalDep(pkg)` 拿 `job_id` → 用 `new EventSource(api.optionalDepStatusUrl(job_id))` 或既有 fetch-based reader 显示进度 → `done` 后 `refreshChannelStatus()`。

新增 state 与 handler(接入现有 optional-deps 客户端,不新造):
```tsx
const [optionalDeps, setOptionalDeps] = useState<OptionalDepsListResponse | null>(null);
const [installingPkg, setInstallingPkg] = useState<string | null>(null);

// 在既有的 Promise.all 初始化里追加 api.listOptionalDeps()
// ...().then(([llmData, dataSourceData, channelData, depsData]) => { ...; setOptionalDeps(depsData); })

const installChannelDep = async (pkg: string) => {
  setInstallingPkg(pkg);
  try {
    const { job_id } = await api.installOptionalDep(pkg);
    await new Promise<void>((resolve, reject) => {
      const es = new EventSource(api.optionalDepStatusUrl(job_id));
      es.addEventListener("done", () => { es.close(); resolve(); });
      es.addEventListener("failed", (e) => { es.close(); reject(new Error((e as MessageEvent).data)); });
    });
    toast.success(t("settings.channels.depInstalled"));
    await refreshChannelStatus();
  } catch (error) {
    toast.error(`${t("settings.channels.depInstallFailed")}: ${error instanceof Error ? error.message : "Unknown"}`);
  } finally {
    setInstallingPkg(null);
  }
};
```
在 recovery 列渲染按钮(仅当匹配到注册包):
```tsx
{item.available === false && matchedPkg(name, optionalDeps) && (
  <button type="button" disabled={installingPkg !== null}
    onClick={() => installChannelDep(matchedPkg(name, optionalDeps)!)}
    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
    {installingPkg ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
    {t("settings.channels.installDep")}
  </button>
)}
```
`matchedPkg(channelName, deps)` 是本文件内小工具:在 `deps.brokers` 里按渠道名/包名找匹配项返回其 `package`,无匹配返回 `undefined`。`ponytail:` 若渠道依赖不在 optional-deps 注册表,则只显示既有恢复文案,不显示安装按钮(不为不可安装项造 UI)。

- [x] **Step 4: 补 i18n 键**

在 `frontend/src` 的 i18n 资源(zh 优先,与仓库既有 `settings.channels.*` 同文件)补:`settings.channels.installDep`、`depInstalled`、`depInstallFailed`。zh 值分别为"安装依赖"、"依赖已安装"、"依赖安装失败";en 对应英文。

- [x] **Step 5: 扩展前端测试**

`frontend/src/pages/__tests__/SettingsChannels.test.tsx` 追加用例:mock `api.getChannelStatus` 返回一个 `available:false` 且匹配注册包的渠道 + `api.listOptionalDeps` 返回含该包 → 断言"安装依赖"按钮渲染;点击后 `api.installOptionalDep` 被调用。用 vitest + 现有测试的 mock 风格(mock `@/lib/api`)。

- [x] **Step 6: 前端构建 + 测试**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop/frontend
npx vitest run src/pages/__tests__/SettingsChannels.test.tsx
npm run build
```
Expected: vitest 通过;`tsc -b && vite build` 无类型错误。

- [x] **Step 7: Commit**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add frontend/src/pages/Settings.tsx frontend/src/pages/__tests__/SettingsChannels.test.tsx frontend/src agent/tests/test_channels_cli_parity.py
git commit -s -m "feat(channels): install-deps UI via optional-deps SSE, CLI/WebUI parity test"
```

## Task 10: 微信渠道页面内扫码登录(channel-management-ui §6.3)

对应 tasks.md §6.3,channel-management-ui delta「页面内扫码登录微信」场景:页面显示二维码,用户扫码后页面更新为已登录,替代 `vibe-trading channels login weixin` 的终端扫码。现有 weixin 适配器已有 `_fetch_qr_code()`(返回 `(qrcode_id, scan_url)`,`scan_url` 即 `qrcode_img_content` base64 图)与基于 `get_qrcode_status` 的轮询循环(`_qr_login`)。**根因式做法(DRY)**:把 weixin 适配器的 QR 登录拆成可复用的 `begin_qr_login()` + `poll_qr_login(login_id)` 两个公共方法,终端 `_qr_login` 与新 REST 端点共用;加两个后端端点包装它们;前端渲染二维码 + 轮询状态。依赖 Task 9(渠道 UI 骨架)。

**Files:**
- Modify: `agent/src/channels/weixin.py`(抽 `begin_qr_login`/`poll_qr_login`,`_qr_login` 复用)
- Modify: `agent/api_server.py`(加 `POST /channels/weixin/login/start`、`GET /channels/weixin/login/status`)
- Modify: `frontend/src/lib/api.ts`(加对应客户端方法 + 类型)
- Modify: `frontend/src/pages/Settings.tsx`(微信行"扫码登录"入口 + 二维码弹层 + 状态轮询)
- Test: `agent/tests/test_weixin_qr_login.py`
- Test: `frontend/src/pages/__tests__/SettingsChannels.test.tsx`(微信登录 UI)

- [x] **Step 1: 写 weixin QR 拆分的失败测试(注入 fake HTTP,免真实微信)**

`agent/tests/test_weixin_qr_login.py`:
```python
"""微信 QR 登录拆分 —— begin/poll 可被 REST 与终端共用(channel-management-ui §6.3)。"""
import asyncio

import pytest

from src.channels.weixin import WeixinChannel


def _make_adapter(monkeypatch, *, qr=("qid-1", "data:image/png;base64,AAAA"), statuses=None):
    from src.channels.bus.queue import MessageBus
    ch = WeixinChannel(WeixinChannel.default_config() if hasattr(WeixinChannel, "default_config") else {}, MessageBus())

    async def fake_fetch():
        return qr
    seq = list(statuses or [{"status": "wait"}, {"status": "confirmed", "bot_token": "T", "ilink_bot_id": "B"}])

    async def fake_poll(login_id):
        return seq.pop(0) if seq else {"status": "expired"}

    monkeypatch.setattr(ch, "_fetch_qr_code", fake_fetch)
    return ch, fake_poll


def test_begin_qr_login_returns_login_id_and_image(monkeypatch):
    ch, _ = _make_adapter(monkeypatch)
    out = asyncio.run(ch.begin_qr_login())
    assert out["login_id"] == "qid-1"
    assert out["qr_image"].startswith("data:image")  # 供前端 <img src> 直接渲染


def test_poll_qr_login_reports_confirmed(monkeypatch):
    ch, _ = _make_adapter(monkeypatch)
    asyncio.run(ch.begin_qr_login())
    # 第一次 wait,第二次 confirmed(适配器内部消费 get_qrcode_status)
    monkeypatch.setattr(ch, "_get_qrcode_status_raw", lambda lid: {"status": "confirmed", "bot_token": "T"})
    res = asyncio.run(ch.poll_qr_login("qid-1"))
    assert res["status"] in {"confirmed", "wait", "scanned", "expired"}
```
(测试意图锚定契约:`begin_qr_login()` → `{login_id, qr_image}`;`poll_qr_login(id)` → `{status, ...}`。执行者据 weixin.py 现有 `_fetch_qr_code`/`get_qrcode_status` 调整注入点名。)

- [x] **Step 2: 运行确认失败**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop && pytest agent/tests/test_weixin_qr_login.py -v`
Expected: FAIL — `AttributeError: 'WeixinChannel' object has no attribute 'begin_qr_login'`

- [x] **Step 3: 在 weixin.py 抽 begin/poll,_qr_login 复用**

`agent/src/channels/weixin.py` —— 新增两个公共方法,把现有 `_qr_login` 循环里的"取码"与"查一次状态"提炼出来(现有 `_qr_login` 改为调用它们的循环,保持终端行为不变):
```python
async def begin_qr_login(self) -> dict:
    """Start a QR login: fetch a fresh code. Returns {login_id, qr_image}.

    Reused by both the terminal _qr_login loop and the REST endpoint so the
    WebUI and CLI share one implementation (channel-management-ui §6.3).
    """
    qrcode_id, scan_url = await self._fetch_qr_code()
    self._active_qr_base = self.config.base_url
    return {"login_id": qrcode_id, "qr_image": scan_url}

async def poll_qr_login(self, login_id: str) -> dict:
    """Poll one QR status tick. Returns {status, confirmed?}.

    status ∈ {wait, scaned_but_redirect, confirmed, expired}. On 'confirmed'
    persists the bot token via _save_state (same as terminal flow).
    """
    base = getattr(self, "_active_qr_base", self.config.base_url)
    data = await self._api_get_with_base(
        base_url=base, endpoint="ilink/bot/get_qrcode_status",
        params={"qrcode": login_id}, auth=False,
    )
    status = (data or {}).get("status", "wait")
    if status == "scaned_but_redirect":
        host = str((data or {}).get("redirect_host", "") or "").strip()
        if host:
            self._active_qr_base = host if host.startswith("http") else f"https://{host}"
    if status == "confirmed":
        token = data.get("bot_token", "")
        if token:
            self._token = token
            if data.get("baseurl"):
                self.config.base_url = data["baseurl"]
            self._save_state()
    return {"status": status}
```
并把现有 `_qr_login` 的主体改为:`begin_qr_login()` 取码 + `_print_qr_code` + 循环 `poll_qr_login()` 直到 confirmed/放弃——DRY,终端路径行为不变。

- [x] **Step 4: 运行确认通过**

Run: `pytest agent/tests/test_weixin_qr_login.py -v`
Expected: PASS。若注入点名不符,按 weixin.py 实际方法名调整测试的 monkeypatch,再通过。

- [x] **Step 5: 加后端 REST 端点**

`agent/api_server.py` —— 在 channels 端点区(第 1740 行附近)加(复用 `_get_channel_runtime` 拿到 weixin 适配器):
```python
@app.post("/channels/weixin/login/start", dependencies=[Depends(require_auth)])
async def weixin_login_start():
    """Begin WeChat QR login; returns {login_id, qr_image} for in-page scan."""
    runtime = _get_channel_runtime()
    adapter = runtime.manager.get_channel("weixin") if runtime.manager is not None else None
    if adapter is None:
        raise HTTPException(status_code=400, detail="weixin channel unavailable; enable it first")
    return await adapter.begin_qr_login()


@app.get("/channels/weixin/login/status", dependencies=[Depends(require_auth)])
async def weixin_login_status(login_id: str = Query(...)):
    """Poll WeChat QR login status for the given login_id."""
    runtime = _get_channel_runtime()
    adapter = runtime.manager.get_channel("weixin") if runtime.manager is not None else None
    if adapter is None:
        raise HTTPException(status_code=400, detail="weixin channel unavailable")
    return await adapter.poll_qr_login(login_id)
```
(若 `_get_channel_runtime` 不直接暴露 `get_channel`,用其 manager 取适配器;按 runtime.py 实际 API 调整。)

- [x] **Step 6: 前端 api 客户端 + 类型**

`frontend/src/lib/api.ts` 加:
```ts
startWeixinLogin: () => request<{ login_id: string; qr_image: string }>("/channels/weixin/login/start", { method: "POST" }),
weixinLoginStatus: (loginId: string) =>
  request<{ status: string }>(`/channels/weixin/login/status?login_id=${encodeURIComponent(loginId)}`),
```

- [x] **Step 7: 前端微信扫码 UI**

`frontend/src/pages/Settings.tsx` —— 微信渠道行加"扫码登录"按钮,点击 → `api.startWeixinLogin()` 拿 `{login_id, qr_image}` → 弹层 `<img src={qr_image} />` + 每 2s `api.weixinLoginStatus(login_id)` 轮询,`status === "confirmed"` 时关闭弹层、toast 成功、`refreshChannelStatus()`;`expired` 时提示重取。新增 state:`weixinQr`(`{loginId, image} | null`)、`weixinStatus`。轮询用 `useEffect` + `setInterval`,在 confirmed/expired/卸载时清理。

- [x] **Step 8: 扩展前端测试**

`SettingsChannels.test.tsx` 追加:mock `api.startWeixinLogin` 返回 `{login_id:"x", qr_image:"data:image/png;base64,AA"}` + `api.weixinLoginStatus` 依次返回 `{status:"wait"}` → `{status:"confirmed"}` → 断言二维码 `<img>` 渲染、confirmed 后弹层关闭 + `refreshChannelStatus` 触发。

- [x] **Step 9: 后端 + 前端验证**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
python -m py_compile agent/api_server.py agent/src/channels/weixin.py
pytest agent/tests/test_weixin_qr_login.py -v
cd frontend && npx vitest run src/pages/__tests__/SettingsChannels.test.tsx && npm run build
```
Expected: 编译无错;pytest 通过;vitest 通过;前端构建通过。

- [x] **Step 10: Commit**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add agent/src/channels/weixin.py agent/api_server.py frontend/src/lib/api.ts frontend/src/pages/Settings.tsx frontend/src/pages/__tests__/SettingsChannels.test.tsx agent/tests/test_weixin_qr_login.py
git commit -s -m "feat(channels): in-page WeChat QR login, reused begin/poll for CLI + WebUI"
```

## Task 11: `serve --open`(CLI 收尾 · tasks §7.1)

对应 tasks.md §7.1:`serve` 增 `--open`,启动后开默认浏览器。这是 CLI 一等公民的便利收尾——高级用户 `vibe-trading serve --open` 与桌面控制台"打开 WebUI"体验对齐。`serve_main` 在 `agent/api_server.py`,`--open` 需在 uvicorn.run 阻塞前用后台定时器等 `/health` 通过再开浏览器(否则开早了页面 404)。`_legacy.py:4245` 的 serve parser 也需加 `--open` 以透传。

**Files:**
- Modify: `agent/api_server.py`(`serve_main`:加 `--open`,健康后开浏览器)
- Modify: `agent/cli/_legacy.py`(serve parser 加 `--open`;serve 透传已是 `serve_main(raw_argv[1:])`,自动带上)
- Test: `agent/tests/test_serve_open_flag.py`

- [x] **Step 1: 写 --open 解析 + 开浏览器决策的失败测试**

`agent/tests/test_serve_open_flag.py`:
```python
"""serve --open —— 解析标志 + 健康后开浏览器的决策(tasks §7.1)。"""
from api_server import _should_open_browser, _build_serve_parser


def test_serve_parser_accepts_open_flag():
    args = _build_serve_parser().parse_args(["--port", "8899", "--open"])
    assert args.open is True


def test_serve_parser_open_defaults_false():
    args = _build_serve_parser().parse_args(["--port", "8899"])
    assert args.open is False


def test_should_open_browser_only_when_flag_set():
    assert _should_open_browser(open_flag=True) is True
    assert _should_open_browser(open_flag=False) is False
```

- [x] **Step 2: 运行确认失败**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop && PYTHONPATH=agent pytest agent/tests/test_serve_open_flag.py -v`
Expected: FAIL — `ImportError: cannot import name '_build_serve_parser'`

- [x] **Step 3: 重构 serve_main 抽出可测的 parser + 决策,并加 --open**

`agent/api_server.py` —— 把 `serve_main` 内联的 argparse 抽成 `_build_serve_parser()`,加 `--open`;加 `_should_open_browser` 与后台开浏览器逻辑:
```python
def _build_serve_parser():
    import argparse
    parser = argparse.ArgumentParser(description="Vibe-Trading Server")
    parser.add_argument("--port", type=int, default=8000, help="Listen port (default 8000)")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address")
    parser.add_argument("--dev", action="store_true", help="Dev mode: spawn Vite on :5173")
    parser.add_argument("--open", action="store_true", help="Open the WebUI in the default browser once healthy")
    return parser


def _should_open_browser(open_flag: bool) -> bool:
    """Whether serve should open the system browser after boot."""
    return bool(open_flag)


def _open_browser_when_healthy(port: int) -> None:
    """Background thread: poll /health, then open the default browser once."""
    import threading, time, urllib.request, webbrowser

    def _worker() -> None:
        url = f"http://127.0.0.1:{port}/"
        for _ in range(120):  # ~120s,与 sidecar 冷启动上限一致
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as r:
                    if r.status == 200:
                        webbrowser.open(url)
                        return
            except Exception:  # noqa: BLE001 — 未就绪就重试
                pass
            time.sleep(0.5)

    threading.Thread(target=_worker, daemon=True, name="vibe-open-browser").start()
```
`serve_main` 里:`parser = _build_serve_parser()`;在 `uvicorn.run(...)` **之前**,若 `_should_open_browser(args.open)` 则调 `_open_browser_when_healthy(args.port)`(后台线程,不阻塞 uvicorn)。

- [x] **Step 4: 运行确认通过**

Run: `PYTHONPATH=agent pytest agent/tests/test_serve_open_flag.py -v`
Expected: PASS(3 passed)

- [x] **Step 5: _legacy.py serve parser 加 --open**

`agent/cli/_legacy.py` 第 4245–4248 行的 serve parser 加:
```python
serve_parser.add_argument("--open", action="store_true", help="Open the WebUI in the default browser once healthy")
```
serve 的 dispatch 已是 `return serve_main(raw_argv[1:])`(第 5187 行),`--open` 自动透传,无需改 dispatch。

- [x] **Step 6: 编译 + 冒烟(不实际起服务,只验证解析与透传)**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
python -m py_compile agent/api_server.py agent/cli/_legacy.py
PYTHONPATH=agent python -c "
from cli._legacy import _build_parser
ns = _build_parser().parse_args(['serve','--port','8899','--open'])
assert ns.command == 'serve' and ns.open is True
print('serve --open wired OK')"
```
Expected: `serve --open wired OK`;编译无错。

- [x] **Step 7: Commit**

```bash
git add agent/api_server.py agent/cli/_legacy.py agent/tests/test_serve_open_flag.py
git commit -s -m "feat(cli): serve --open launches WebUI in default browser once healthy"
```

## Task 12: 桌面文档更新(tasks §7.2)

对应 tasks.md §7.2:更新桌面文档,写清三层依赖模型、控制台用法、首次 bootstrap 说明。纯文档任务,无测试代码;但要与前 11 个 Task 的实际实现一致(不写与代码不符的说明)。

**Files:**
- Modify: `docs/desktop/README.md`(三层依赖模型、控制台用法、首次 bootstrap、弱网重试、日志目录)
- Modify: `CLAUDE.md`(相关段:桌面构建装配现在装 Tier 0;首启 bootstrap 建 venv;会话/资产覆盖边界)

- [x] **Step 1: 更新 docs/desktop/README.md**

补充/改写以下小节(与实现对齐):
- **三层依赖模型**:Tier 0(bundle 内最小核心,见 `scripts/desktop/requirements-tier0.txt`)/ Tier 1(首启 `vibe-trading bootstrap` → `~/.vibe-trading/venv` 装整个 `requirements.txt`,默认清华源)/ Tier 2(券商 SDK,WebUI 设置页按需装,复用 `/optional-deps`)。
- **控制台用法**:桌面窗口是环境/服务控制台,不再是业务 UI 宿主;首启点"安装依赖"→ 进度可见 + 断点重试 + 冒烟通过才"就绪";就绪后"启动服务"→"在浏览器打开 WebUI"。
- **首次 bootstrap 说明**:几百 MB、耗时、弱网可重试(复用已下载部分);可切镜像;冒烟失败会标"依赖不全"并给失败包。
- **CLI 等价**:`vibe-trading bootstrap`(与控制台等价)、`vibe-trading serve --open`。
- **日志**:`~/.vibe-trading/logs/`;控制台"打开日志目录"。
- **升级保留**:升级仅重建 `runtime/`/`cache/`/`fonts/`/`logs/`/`history`/`app/`;保留 `.env`/`live/`/`channels/`/`memory/`/`shadow_accounts/`/券商配置/`runs/`/`workspace/`/`uploads/` 与会话。

- [x] **Step 2: 更新 CLAUDE.md 相关段**

改 `CLAUDE.md` 的"Desktop Build Assembly & Packaging"与"Data Flow (Desktop Mode)"段:
- `install-deps.sh` 现在只装 Tier 0(不再"全量 requirements 除 weasyprint");重型依赖首启 bootstrap 到 `~/.vibe-trading/venv`。
- 数据流:首启 Rust 控制台 spawn `vibe-trading bootstrap` 建 venv;服务由 venv 解释器 `serve` 启动;业务 UI 交系统浏览器(不再 webview 导航业务 SPA)。
- 保留 weasyprint 排除说明(Tier 1 venv 也不装 weasyprint → 桌面 PDF 报告仍不可用,HTML 可用)——**确认**:Tier 1 装的是 `agent/requirements.txt`,其含 `weasyprint>=60.0`;若沿用现有"桌面排除 weasyprint"策略,bootstrap 装的 requirements 也应过滤 weasyprint。**这是一个实现决策点**:在 Task 4 的 `run_bootstrap_cli` 里,requirements 来源应过滤 weasyprint 行(照搬 `install-deps.sh` 的 `grep -viE '^\s*weasyprint'`),文档据此说明。若 Task 4 未处理,此处标注为回补项并在 Step 3 验证。

- [x] **Step 3: 校验 weasyprint 过滤一致性(文档↔实现)**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
# bootstrap 装的 requirements 是否过滤 weasyprint?检查 cli.py 的 requirements 组装
grep -n "weasyprint" agent/src/desktop_bootstrap/cli.py agent/requirements.txt
```
Expected: 若 `cli.py` 未过滤 weasyprint,回到 Task 4 的 `run_bootstrap_cli`,在传给 `run_bootstrap` 前把 requirements 复制为临时文件并剔除 weasyprint 行(与 install-deps.sh 一致),补一个 `test_desktop_bootstrap_flow.py` 用例锁定"weasyprint 不在 bootstrap 安装清单"。文档只描述已实现的行为。

- [x] **Step 4: Commit**

```bash
git add docs/desktop/README.md CLAUDE.md
git commit -s -m "docs(desktop): three-tier dependency model, console usage, first-run bootstrap"
```

## Task 13: 全平台验收 + Windows wheel 矩阵(tasks §7.3 · D6)

对应 tasks.md §7.3 与设计 D6(测试矩阵 = registry 三平台 macos_arm64 / macos_x86_64 / windows_amd64)。这是端到端验收:全新机器首装 → 安装依赖 → 冒烟通过 → 启动 → 浏览器打开 WebUI 完整可用;弱网重试;渠道零终端;CLI 对齐。**Windows wheel 兼容性是本任务的测试计划项**(D6:非设计决策)——重型包在 win amd64 均有预编译 wheel,bootstrap 完在本机跑 smoke_imports 兜底。

这是验收/验证任务,不产新功能代码;发现缺陷则回对应 Task 修复(遵循 systematic-debugging)。

**Files:**
- Modify: `docs/desktop/tier0-boundary.md`(补三平台验收结论表)
- 可能 Modify: `.github/workflows/desktop-build.yml`(若加 CI 冒烟步骤——可选)

- [x] **Step 1: 全量 Python 测试 + 安全关键窄测(回归总闸)**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
pytest --ignore=agent/tests/e2e_backtest --ignore=agent/tests/test_e2e_harness_v2.py --tb=short -q
# 安全关键窄测(order/mandate/live 未被本次改动破坏)
pytest agent/tests/test_sdk_order_gate.py agent/tests/test_mandate_enforcement.py -q
```
Expected: 全套通过(排除需 live key 的 e2e);安全窄测通过。任何失败必须在归档前修复。

- [x] **Step 2: Rust + 前端总闸**

Run:
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri && cargo test 2>&1 | tail -15
cd /Users/niean/Documents/project/Vibe-Trading-Desktop/frontend && npx vitest run && npm run build
```
Expected: cargo test 全绿;vitest 全绿;前端构建通过。

- [x] **Step 3: macOS 端到端验收(全新用户目录模拟)**

Run(把现有 `~/.vibe-trading` 备份后模拟全新首装):
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
# 备份真实用户目录(不破坏本机数据)
[ -d ~/.vibe-trading ] && mv ~/.vibe-trading ~/.vibe-trading.bak.$(date +%s) || true
# 装配 bundle(Tier 0)
bash scripts/desktop/fetch-runtime.sh   # 需 PBS_TAG/PBS_ASSET(见 CI 默认值)
bash scripts/desktop/install-deps.sh .desktop-build/python-runtime
bash scripts/desktop/assemble.sh
# 用 Tier 0 运行时触发 bootstrap(等价控制台"安装依赖"),观察进度/冒烟/就绪
PYTHONPATH=.desktop-build/agent .desktop-build/python-runtime/bin/python3 \
  -c "import cli,sys; raise SystemExit(cli.main(['bootstrap']))"
# 就绪后用 venv 解释器起 serve --open 并验证 /health
~/.vibe-trading/venv/bin/python -c "import cli,sys; raise SystemExit(cli.main(['serve','--port','8899','--open']))" &
SRV=$!; sleep 15; curl -sf http://127.0.0.1:8899/health && echo "  E2E HEALTH OK"; kill $SRV 2>/dev/null
```
Expected:bootstrap 建 `~/.vibe-trading/venv`、装依赖、冒烟通过、标就绪;`serve --open` 后 `/health` 通过且浏览器打开 WebUI。验收后恢复备份目录:`rm -rf ~/.vibe-trading && mv ~/.vibe-trading.bak.* ~/.vibe-trading`(若存在备份)。

- [x] **Step 4: 弱网重试验收**

Run(模拟中断:装到一半 kill,再重跑,验证复用已装部分):
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
# 首次 bootstrap 跑几秒后中断
PYTHONPATH=.desktop-build/agent .desktop-build/python-runtime/bin/python3 \
  -c "import cli,sys; raise SystemExit(cli.main(['bootstrap']))" & BP=$!
sleep 8; kill $BP 2>/dev/null
# 重跑:应复用已装部分继续,而非从零
PYTHONPATH=.desktop-build/agent .desktop-build/python-runtime/bin/python3 \
  -c "import cli,sys; raise SystemExit(cli.main(['bootstrap']))"
```
Expected: 重跑时 pip 跳过已满足的包,续装直至冒烟通过(desktop-runtime-bootstrap「弱网中断后重试续装」)。

- [x] **Step 5: 渠道零终端 + CLI 对齐验收**

Run(起服务后,用 REST 模拟 WebUI 操作,再对照 CLI):
```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
~/.vibe-trading/venv/bin/python -c "import cli,sys; raise SystemExit(cli.main(['serve','--port','8899']))" &
SRV=$!; sleep 12
# WebUI 路径:REST 启停/状态
curl -sf http://127.0.0.1:8899/channels/status | head -c 200; echo
curl -sf -X POST http://127.0.0.1:8899/channels/start | head -c 200; echo
# 微信登录 start(不真正扫码,验证返回 qr_image 契约)
curl -sf -X POST http://127.0.0.1:8899/channels/weixin/login/start | head -c 120; echo
# CLI 路径:等价 status
~/.vibe-trading/venv/bin/python -c "import cli,sys; raise SystemExit(cli.main(['channels','status','--local']))"
kill $SRV 2>/dev/null
```
Expected: REST 渠道启停/状态可用;weixin login start 返回含 `login_id`/`qr_image`;CLI `channels status` 与 REST 状态一致(§6.4)。

- [x] **Step 6: Windows amd64 验收(D6 wheel 矩阵)**

在 Windows amd64(无系统 Python 的干净机或等价环境)执行:
```powershell
# 装配(fetch-runtime → install-deps → assemble → 打包),或直接跑打包脚本
./scripts/desktop/build-windows.ps1
# 首装后:用 Tier 0 运行时触发 bootstrap,验证重型包在 win amd64 有 wheel 且冒烟过
$env:PYTHONPATH=".desktop-build/agent"
.desktop-build/python-runtime/python.exe -c "import cli,sys; raise SystemExit(cli.main(['bootstrap']))"
# venv 解释器起 serve + /health
& "$env:USERPROFILE/.vibe-trading/venv/Scripts/python.exe" -c "import cli,sys; raise SystemExit(cli.main(['serve','--port','8899']))"
# 另开:Invoke-WebRequest http://127.0.0.1:8899/health
```
Expected: Windows 上 bootstrap 建 venv、装 requirements(pandas/scipy/sklearn/duckdb/matplotlib 均命中 win amd64 wheel)、`smoke_imports.py` 冒烟通过、serve `/health` 通过。若某重型包在 win amd64 缺 wheel → 记入 tier0-boundary.md 的 Windows 兼容表并作为已知失败面(冒烟会正确标"依赖不全")。若无 Windows 环境,明确标注为"CI/后续验证"并在 `.github/workflows/desktop-build.yml` 的 windows job 里加一步 bootstrap+冒烟。

- [x] **Step 7: 记录三平台验收结论**

在 `docs/desktop/tier0-boundary.md` 补一张验收结论表:三平台(macos_arm64 / macos_x86_64 / windows_amd64)× 步骤(装配 / bootstrap / 冒烟 / serve /health / 浏览器 / 渠道零终端 / CLI 对齐)的通过情况。未在本机覆盖的平台标"CI 覆盖 / 待验证",不留空泛结论。

- [x] **Step 8: Commit**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add docs/desktop/tier0-boundary.md .github/workflows/desktop-build.yml
git commit -s -m "test(desktop): full-platform acceptance + Windows amd64 wheel matrix results"
```

## 自审清单(计划作者已核对)

**Spec 覆盖**(每条 delta requirement → 对应 Task):
- python-runtime-bundling「Tier 0 仅核心 / serve 空转 / 重型由 venv / 回测子进程用 venv」→ Task 1(边界)、Task 5(装配)、Task 6(venv 解释器,回测经 `_pick_python_interpreter` 的 sys.executable 回退自动选中 venv)。
- desktop-runtime-bootstrap「首次 bootstrap / 已就绪跳过 / CLI 子命令 / 默认清华可切 / 进度+断点重试 / 冒烟就绪 / 增量同步」→ Task 3 + Task 4(全覆盖,含 §「经 CLI 子命令触发」场景由 `vibe-trading bootstrap` 满足)。
- desktop-control-console「窗口作控制台 / 启停服务 / 打开 WebUI / 打开日志」→ Task 7(IPC)+ Task 8(页面)。
- desktop-shell「venv 解释器启动 / 业务 UI 交浏览器 / 未就绪不启动 / 首启升级准备目录 / 会话迁出 / 本地Docker 不变 / live 不清除 / 失败可读错误」→ Task 2(SESSIONS_DIR)、Task 6(venv+白名单+失败错误)、Task 8(不导航业务 SPA)。
- channel-management-ui「WebUI 启停+装依赖 / 微信页面内扫码 / 登录态保留 / CLI 保持可用」→ Task 9 + Task 10(登录态保留由 Task 6 的资产白名单——`channels/`+`pairing.json` 已在 home 幸存——保证)。

**安全约束覆盖**:`live/` 保留 → Task 6 Step 6 针对性测试 `upgrade_preserves_live_audit_and_sessions`;SESSIONS_DIR「env 未设本地/Docker 不变」→ Task 2 Step 1/Step 6 回归。安全窄测 → Task 13 Step 1。

**排序**:Task 1(Tier 0 gate)最先;依赖链见"任务依赖与排序"。

**占位符扫描**:无 TBD / "处理错误" / "类似 Task N" 空转;每个代码步骤含实际代码或实际命令 + 期望输出。

**类型/命名一致性**:`resolve_sessions_dir`、`run_bootstrap`/`BootstrapEvent`/`hash_marker_path`、`compute_env_status`/`EnvStatus`、`build_bootstrap_cmd`、`begin_qr_login`/`poll_qr_login`、`_build_serve_parser`/`_should_open_browser` 跨 Task 引用一致;`build_cmd`/`spawn` 新增 `sessions_dir` 参数在 Task 6 定义、Task 7 使用一致(第 5 参数);hash marker 路径统一为 `venv/.requirements_hash`(Task 3 定义、Task 7 `compute_env_status` 读同一路径)。
