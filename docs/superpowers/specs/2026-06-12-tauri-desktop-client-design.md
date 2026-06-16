---
comet_change: tauri-desktop-client
role: technical-design
canonical_spec: openspec
---

# Tauri 桌面客户端技术设计

> 把 Vibe-Trading 封装成 macOS(arm64)/ Windows(x64)双平台桌面客户端,双击即用、零依赖安装。本文档是 HOW;需求事实源(WHAT)在 OpenSpec delta spec。

## Context

Vibe-Trading 后端是 Python(FastAPI + uvicorn),生产模式下用 `SPAStaticFiles` 把 `frontend/dist` 挂载到 `/`(`agent/api_server.py:3100-3118`)—— **后端本身即 Web 服务器**。前端所有 API 请求走同源相对路径(`frontend/src/lib/api.ts:3` `BASE=""`)。用户全局状态在 `~/.vibe-trading/`,`.env` 搜索序为 `~/.vibe-trading/.env → agent/.env → $CWD/.env`(`agent/src/providers/llm.py:246`)。

当前只能 Docker 或本地手动起服务,门槛高。目标是 Tauri 封装,**不重写任何后端/前端业务逻辑**。

**已确认决策(brainstorming):**
- 平台:macOS arm64 + Windows x64,无 universal、无交叉编译。
- Python:完整内嵌 python-build-standalone(`install_only`)+ uv 预装依赖(排除 weasyprint),体积 ~800MB–1.5GB 可接受。
- PDF:降级 HTML,`reporter.py:304` 已 try/except 降级,打包不装 weasyprint 即可,零代码改动。
- 架构:webview 指向后端托管 UI(`http://127.0.0.1:<port>`),前端零改动、零跨域。
- 可写路径:首启/升级复制 `agent/` 到 `~/.vibe-trading/runtime/agent`,不改后端。

## Goals / Non-Goals

**Goals:**
- 双击即用、完全离线、零依赖的 macOS arm64 + Windows x64 桌面客户端。
- 后端与 Web UI 原样复用,封装层与业务层解耦。
- sidecar 生命周期可靠:可写目录准备、端口选择、健康门控、进程清理。
- 用户状态在家目录持久,升级不丢数据;用户可覆盖配置。

**Non-Goals:**
- 不重写后端/前端业务逻辑(靠复制而非 env 重定向规避路径硬编码)。
- 不做 auto-update、应用内配置 UI、内置本地 LLM。
- 不做代码签名/公证(列为已知限制)。
- 不保留 PDF 渲染(降级 HTML)。
- 不支持 macOS Intel / universal。

## Decisions

### D1: webview 指向后端托管的 UI(而非 Tauri 静态托管前端)
后端生产模式已托管 `frontend/dist` 且前端走同源相对路径。webview 直接指向 `http://127.0.0.1:<port>`,前端零改动、零跨域、无需注入 API base。
- **Alternative**:Tauri `frontendDist` 托管前端、API 指向 sidecar。否决:破坏 `BASE=""` 同源假设,需改前端 + 处理 CORS,违背"不改业务"。

### D2: Python 用 python-build-standalone 的 `install_only` 变体,Tauri `resources` 打包
完整内嵌可重定位运行时。`install_only` 是官方专为嵌入/可重定位出的构建,是解决头号风险的基础。打包整目录用 Tauri `resources`,Rust 用 `Command` spawn `<runtime>/bin/python`(win `python.exe`)。
- **Alt A**:PyInstaller/Nuitka 冻结。否决:scipy/duckdb 等重原生依赖隐藏导入与动态库易碎。
- **Alt B**:首启 uv 联网引导。否决:违背"开箱即用/完全离线"。

### D3: 依赖用 uv 预装,排除 weasyprint
`uv pip install -r requirements.txt`(去 weasyprint)装进内嵌运行时 site-packages。uv 快且可锁定版本保证双平台可重现。`reporter.py:304` 已 try/except 降级到 HTML,故零代码改动满足"降级 HTML",同时省去 vendoring cairo/pango。

### D4: 可写运行目录 —— 首启/升级复制 `agent/` 到家目录(核心决策)
**问题**:后端把数据写到相对代码目录的硬编码位置,无 env 覆盖:`agent/runs`(`api_server.py:41`、`loop.py:39`)、`agent/sessions`(:42)、`agent/uploads`(:43)、`agent/.swarm/runs`(`swarm/store.py:72`)。Python import 还往代码旁写 `__pycache__`。只读 bundle(签名 .app / Program Files)下这些写入必失败。

**方案**:Rust 在 spawn 前把只读 bundle 的 `agent/` 复制到 `~/.vibe-trading/runtime/agent`,以 `PYTHONPATH` 指向可写副本启动后端 → `__file__` 解析到可写处 → 所有写目录自然落在可写位置。
- **Alternative**:给四个目录加 env 覆盖、重定向到 `~/.vibe-trading/`。否决:需改后端多个文件(违背非目标);且 `swarm/store.py:67` 记录的 P03-A 表明 store 路径与 `path_utils` 白名单分别推导极易漂移,改路径解析风险高。
- 复制方案下 `background_tools.py:14` 的 `WORKDIR=parents[2]`、`core/runner.py:156` 的 `project_root` 都自动落在可写副本,无需特殊处理。

### D5: 版本标记驱动首启/升级,数据子目录保留
`~/.vibe-trading/runtime/.installed_version` 与 bundle 内 VERSION 比对:
- 首启(无标记):复制 `agent/`;若 `~/.vibe-trading/.env` 缺失则从 bundle `agent/.env` 种入;写标记。
- 升级(版本不等):刷新代码文件,**保留** `runs/sessions/uploads/.swarm` 与 `~/.vibe-trading/.env`;更新标记。
- 常规(版本一致):直接复用。

安全性:bundle 的 `agent/` 模板**永不含** `runs/sessions/uploads/.swarm`(打包裁剪),故刷新代码天然不碰数据;`.env` 仅首启种入一次,用户在 `~/.vibe-trading/.env` 的修改始终最高优先级(`llm.py:246`)。

### D6: 端口动态分配 + 健康检查门控加载
Rust `bind 127.0.0.1:0` 让系统分配空闲端口(无递增探测竞态),以 `--host 127.0.0.1 --port <N>` 启动后端;窗口先显示打包的 `loading.html`(秒开不空白),轮询 `/health`(`api_server.py:1452`,~300ms 间隔、~60s 上限)通过后导航 webview 到 `127.0.0.1:<N>`;子进程提前退出或超时显示可读错误页 + 退出途径。

### D7: sidecar 进程生命周期(平台差异)
- macOS:spawn 时 `setsid` 建进程组,退出 `killpg` 整组(复用 `scripts/dev` 同款思路)。
- Windows:子进程加入 Job Object(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`),应用崩溃时内核因 job 句柄释放自动杀整组,杜绝残留。
- Tauri 监听窗口关闭 / `RunEvent::ExitRequested` 统一触发清理。

### D8: 内嵌 Python 设 `PYTHONDONTWRITEBYTECODE=1`
内嵌运行时 stdlib 在只读 bundle 内,避免 import 时往只读处写 `.pyc`。可写副本的 `agent/` 不受此限(其 `__pycache__` 可正常写)。

### D9: 双平台构建走 CI 矩阵
项目已有 `.github/`。GitHub Actions macOS(arm64 runner)+ Windows(x64 runner)分别构建,文档明确"无法交叉编译"。本地 macOS 优先验证。

## Runtime Sequence(启动时序)

```
窗口创建 → 显示打包 loading.html(秒开)
  │
  ├─ 准备可写运行目录(D4/D5:首启复制 / 升级刷新 / 常规复用)
  ├─ 选空闲端口(bind 127.0.0.1:0 → 取端口 → 释放 → 传后端)
  ├─ spawn 内嵌 python -m <serve> --host 127.0.0.1 --port <N>
  │    env: PYTHONPATH=runtime/agent, PYTHONDONTWRITEBYTECODE=1
  │    进程组: mac setsid / win Job Object
  ├─ 轮询 GET /health(~300ms,上限 ~60s)
  │    ├─ 200      → 导航 webview → 127.0.0.1:<N>,现有 UI 接管
  │    ├─ 子进程退出 → 错误页(退出码 + stderr 尾部)
  │    └─ 超时      → 错误页 + 退出按钮
  └─ 运行中:sidecar 意外退出 → 错误页提示
退出:窗口关闭 / ExitRequested → killpg(mac) / 关闭 job 句柄(win)
```

## 资源布局

```
Bundle(只读)                         运行期(可写)
─────────────────────────            ─────────────────────────────
python-runtime/   内嵌运行时          ~/.vibe-trading/
agent/            代码模板(无数据目录)   ├── runtime/
agent/.env        配置种子              │    ├── agent/        ← 复制副本
frontend/dist/    现有 UI               │    │    └ runs/ sessions/ uploads/ .swarm/
loading.html      启动加载页            │    └── .installed_version
VERSION           版本标记              ├── .env              用户配置(可覆盖)
                                       ├── sessions.db memory/ cache/ ...
```

## Risks / Trade-offs

- [头号风险:python-build-standalone 装 scipy/sklearn/duckdb 等重原生包后,迁移路径能否 import(rpath/BLAS)] → `install_only` 变体 + PyPI 自包含 wheels;**构建期就跑迁移路径导入冒烟测试**,把问题拦在打包阶段。Spike(tasks 第 1 组)先验证,通不过回设计。
- [次风险:回测子进程能否用内嵌 Python 跑通(`core/runner.py` 回退 sys.executable)] → 端到端验证最小回测路径。
- [首启复制耗时/体积;升级合并逻辑] → 版本标记比对;只刷新代码,数据子目录天然不在 bundle 模板内。
- [Windows 进程残留] → Job Object kill-on-close,内核级保证。
- [不签名首启安全提示] → 文档说明 mac 右键打开 / win SmartScreen「仍要运行」;列已知限制。
- [无法交叉编译] → CI 矩阵双平台分别构建。
- [动态端口/健康检查竞态] → 就绪轮询 + 超时 + 可读错误兜底。

## Testing Strategy

| 层级 | 测什么 | 方法 | 归属 |
|------|--------|------|------|
| 构建期冒烟 | 可重定位性(头号风险) | 运行时移随机路径后 import numpy/scipy/scikit-learn/duckdb/pandas/Pillow/matplotlib,无链接错误 | CI |
| 构建期冒烟 | 回测子进程自包含 | 内嵌 Python 跑最小回测,验证 `core/runner.py` 回退 sys.executable | CI |
| Rust 单元 | 端口选取、版本比对、复制/合并 | `#[cfg(test)]` + mock 目录 | CI |
| 端到端 | 全新无 Python 机双击 → 加载 → 就绪 → UI → 对话/回测 | mac/win 干净环境 | 发布前手动门 |
| 端到端 | 进程清理(正常 + 强杀无残留) | 关后 ps / 任务管理器核对 | 发布前手动门 |
| 端到端 | 升级保留数据 | 装 v1 产数据 → 装 v2 → 比对 runs/sessions/.env | 发布前手动门 |
| 回归 | 现有 CLI/Docker 不受影响 | `vibe-trading serve` 默认 0.0.0.0/8899 不变 | CI/手动 |

## Migration Plan

封装层为新增,不改现有运行方式,无数据迁移。回滚 = 不分发桌面包,Docker/CLI 路径不受影响。交付顺序:macOS arm64 先端到端打通(含可重定位性 spike),再补 Windows 差异(Job Object 清理、运行时打包)。

## Open Questions

1. python-build-standalone 具体发行 tag / Python 版本(对齐 `requires-python>=3.11`)—— build 阶段定。
2. serve 入口的精确调用形式(`-m` 模块 vs `-c` 引导)与所需 env 全集 —— build 阶段随脚手架定。
3. loading.html 的具体形态(纯静态 vs 带进度)—— 实现细节,build 阶段定。

## Spec Patch(已回写 OpenSpec delta spec)

- `desktop-shell`:新增需求「首启/升级时准备可写运行目录」(复制 agent/、种入 .env、升级保留数据子目录、准备失败可读错误),含场景。
- `python-runtime-bundling`:补充「回测子进程使用内嵌 Python 自包含」验收场景。
