# 可重定位性 Spike 记录

> 目标: 验证 python-build-standalone `install_only` 产物在 macOS arm64 上可重定位使用,即解压后移动到任意路径仍能正常 import 原生扩展并启动后端。

## 运行时选型

| 项目 | 值 |
|---|---|
| Release Tag | `20260610` |
| Python 版本 | 3.12.13 |
| 资产文件名 | `cpython-3.12.13+20260610-aarch64-apple-darwin-install_only.tar.gz` |
| 目标平台 | macOS aarch64 (Apple Silicon) |
| 选型理由 | 3.12.x 满足 `requires-python >= 3.11`, 且比 3.11 有更好的性能与错误信息; 选用最新稳定 release tag `20260610` |

**获取命令:**
```bash
PBS_TAG=20260610 \
PBS_ASSET=cpython-3.12.13+20260610-aarch64-apple-darwin-install_only.tar.gz \
bash scripts/desktop/fetch-runtime.sh
```

## 依赖安装

**安装命令:**
```bash
bash scripts/desktop/install-deps.sh ./.desktop-build/python-runtime
```

**安装方式:** 使用 `uv pip install`(uv 0.9.26)直接从 `agent/requirements.txt` 安装，通过 `grep -viE '^\s*weasyprint'` 过滤掉 weasyprint 行。共解析 178 个包，实际安装 178 个包（含传递依赖）。

**安装耗时:** 约 8.6 秒（wall time），含下载 94 个预编译 wheel + 3 个源码构建（ta、asyncio-nats-client、jsonpath）。

**site-packages 体积:** 739 MB（含所有原生扩展如 numpy、scipy、duckdb、matplotlib 等）。

**验证:**
```bash
# 确认 weasyprint 未被安装
./.desktop-build/python-runtime/bin/python3 -m pip show weasyprint || echo "weasyprint absent (OK)"
# 输出: weasyprint absent (OK)
```

**过滤后的 requirements 内容:** 除 `weasyprint>=60.0` 被排除外，其余所有行（rich、pyyaml、langchain、pandas、numpy、scipy、duckdb、fastapi、uvicorn、fastmcp、ccxt 等）均正常安装。

## 冒烟结论

**结果: PASS -- 可重定位性已验证, 继续阶段 ②**

**测试方法:** 将完整运行时复制到随机临时路径 `/var/folders/.../tmp.XXXXXX/relocated-runtime`, 在新路径执行导入冒烟测试。

**测试覆盖:**

| 模块 | 版本 | 原始路径 | 迁移路径 |
|---|---|---|---|
| numpy | 2.4.6 | OK | OK |
| scipy | 1.17.1 | OK | OK |
| sklearn | 1.9.0 | OK | OK |
| duckdb | 1.5.3 | OK | OK |
| pandas | 3.0.3 | OK | OK |
| PIL | 12.2.0 | OK | OK |
| matplotlib | 3.11.0 | OK | OK |
| scipy.linalg.inv (BLAS 原生调用) | -- | OK | OK |

**关键发现:** python-build-standalone 的 `install_only` 产物在 macOS arm64 上完全可重定位。所有原生扩展(numpy/scipy BLAS、duckdb、sklearn Cython 模块等)在迁移到不同绝对路径后均正常工作, 无任何 rpath 链接错误或 OSError。

**脚本位置:**
- 冒烟测试: `scripts/desktop/smoke_imports.py`
- 迁移测试: `scripts/desktop/relocate-smoke.sh`

## serve / 回测冒烟

> 阶段 ① 次风险门：验证内嵌运行时能启动 serve、/health 可达、SPA 可加载、回测子进程自包含。

### serve 启动方式

```bash
PYTHONPATH="<agent_dir>" PYTHONDONTWRITEBYTECODE=1 <runtime>/bin/python3 \
  -c 'import cli, sys; raise SystemExit(cli.main(sys.argv[1:]))' \
  serve --host 127.0.0.1 --port 8987
```

复用 `scripts/dev:162-164` 的精确调用形式。

### /health 响应时间

- 首次 `/health` 可达耗时：约 **23 秒**（含 preflight check、LLM 超时等）
- 轮询间隔 0.5s，第 45 次尝试时成功
- 响应状态码：200 OK

### SPA 资源可达性

- `http://127.0.0.1:8987/`（SPA 根路由）：200 OK
- 前端构建产物位于 `frontend/dist`，由 FastAPI 静态托管

### 回测子进程自包含验证

```bash
./.desktop-build/python-runtime/bin/python3 -c "import sys; print(sys.executable); import numpy, pandas, duckdb; print('backtest deps OK')"
# 输出:
# /.../.desktop-build/python-runtime/bin/python3
# backtest deps OK
```

- 解释器路径指向内嵌运行时（非系统 Python）
- numpy / pandas / duckdb 均正常导入
- `runner.py:156-168` 在找不到项目 `.venv` 时回退到 `sys.executable`，此处 `sys.executable` 即内嵌运行时 —— 回测子进程自包含已验证

### 冒烟脚本

- `scripts/desktop/serve-smoke.sh`：自动化 serve 启动 → /health 轮询 → SPA 验证 → 清理

### 阶段 ① 总结论

**结果: PASS -- 阶段 ① 全部验证通过, 可重定位性 + serve + 回测均 OK**

| 验证项 | 结果 |
|---|---|
| 运行时可重定位性（8 个原生扩展） | PASS |
| serve 启动 + /health 可达 | PASS |
| SPA 静态资源托管 | PASS |
| 回测子进程自包含（runner.py 回退路径） | PASS |

**阶段 ① 阻塞门已通过, 可以进入阶段 ②（Tauri 脚手架）。**
