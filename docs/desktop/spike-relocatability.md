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

## 装配产物体积

> 记录 `scripts/desktop/assemble.sh` 执行后的打包资源体积。日期：2026-06-12，Git commit: `2e09892`。

| 产物 | 大小 | 说明 |
|---|---|---|
| python-runtime | 728M | python-build-standalone 3.12.13 + 178 个依赖，已裁剪 `__pycache__` / tests |
| agent 模板 | 7.5M | 代码模板，已删除 runs/sessions/uploads/.swarm/tests + `__pycache__` |
| frontend/dist | 1.6M | Vite 构建产物，含 SPA + echarts + react |
| VERSION | 6B | Git short SHA: `2e09892` |
| **合计** | **~737M** | 桌面应用完整资源包 |

## Task 15: .env 兜底优先级 + 报告 HTML 降级验证

> 日期：2026-06-12，审查 + 验证任务，无需代码修改。

### Step 1: .env 不被覆盖逻辑审查

**文件**: `src-tauri/src/runtime_dir.rs` `prepare()` 第 82-86 行

```rust
// .env 仅在用户配置缺失时种入
if !layout.user_env.exists() && bundle_env_seed.exists() {
    fs::copy(bundle_env_seed, &layout.user_env)
        .map_err(|e| format!("seed .env: {e}"))?;
}
```

- `!layout.user_env.exists()` 确保用户已有 `~/.vibe-trading/.env` 时跳过
- `&& bundle_env_seed.exists()` 确保 bundle 中有种子 .env 才复制
- 单元测试 `does_not_overwrite_existing_user_env` 明确验证：用户手工写入 `USER_KEY=keep` 后再次运行 prepare，内容保持 `USER_KEY=keep` 不变
- 另外 unit_test `first_run_copies_agent_seeds_env_writes_marker` 验证首次运行正常种入

**结论: PASS -- .env 仅在首次运行且用户无 .env 时种入，绝不会覆盖已有配置。**

### Step 1b: .env 搜索优先级审查

**文件**: `agent/src/providers/llm.py` 第 246-258 行

```python
_ENV_CANDIDATES = [
    Path.home() / ".vibe-trading" / ".env",   # 优先级最高
    AGENT_DIR / ".env",                        # 第二优先级（bundle 内置种子）
    Path.cwd() / ".env",                       # 第三优先级（开发用）
]
```

- `_ensure_dotenv()` 第 323-344 行：遍历候选项，取第一个存在的，加载后 `break`
- `load_dotenv(dotenv_path=path, override=False)` 或手工 `os.environ.setdefault(key, value)` 均按 setdefault 语义，**已存在的环境变量不被覆盖**
- 搜索顺序：`~/.vibe-trading/.env` > `<AGENT_DIR>/.env` > `<CWD>/.env`，家目录最高优先级

**结论: PASS -- .env 加载按「用户家目录 > agent 内置种子 > 工作目录」的顺序，且已设置的环境变量不被覆盖。**

### Step 2: 报告 HTML 降级逻辑审查

**文件**: `agent/src/shadow_account/reporter.py` 第 299-320 行

```python
def _try_render_pdf(html, output_dir, shadow_id):
    try:
        from weasyprint import HTML
    except Exception as exc:
        logger.warning("weasyprint unavailable (%s); HTML-only output.", exc)
        return None, "html-only"

    pdf_path = output_dir / f"{shadow_id}.pdf"
    try:
        HTML(string=html, base_url=str(_TEMPLATES_DIR)).write_pdf(str(pdf_path))
    except Exception as exc:
        logger.warning("weasyprint render failed (%s); HTML-only output.", exc)
        ...  # 清理残废 pdf
        return None, "html-only"
    return pdf_path, "weasyprint"
```

降级路径：
1. **导入失败** (try/except at line 304): 返回 `(None, "html-only")`
2. **渲染失败** (try/except at line 311): 删除残废 PDF，返回 `(None, "html-only")`
3. HTML 总是在 PDF 之前生成（第 85-93 行），无论 weasyprint 成功与否 HTML 都产出

**结论: PASS -- weasyprint 导入或渲染失败均降级为 HTML-only，不报错，不阻断报告产出。**

### Step 3: Bundle 确认 weasyprint 未安装

```bash
./.desktop-build/python-runtime/bin/python3 -m pip show weasyprint
# 输出: WARNING: Package(s) not found: weasyprint
#        weasyprint absent (OK)
```

Bundle 中已确认不包含 weasyprint。这与 `install-deps.sh` 中 `grep -viE '^\s*weasyprint'` 的过滤逻辑一致（见上方依赖安装小节的记录）。

### Step 4: 总结论

**结果: PASS -- .env 优先级正确，报告降级正确，weasyprint 确认缺失，无需任何代码修改。**

| 验证项 | 结果 |
|---|---|
| .env 种子不覆盖已有用户配置 | PASS |
| .env 搜索优先级（家目录 > bundle > CWD） | PASS |
| weasyprint 导入失败降级 → HTML-only | PASS |
| weasyprint 渲染失败降级 → HTML-only | PASS |
| Bundle 中 weasyprint 确认缺失 | PASS |
| 报告 HTML 始终产出 | PASS |
| 无需代码修改 | PASS |
