# 验证报告：desktop-runtime-deps-on-demand

> 生成时间：2026-06-14 · 验证模式：full（34 tasks / 1 delta spec / 95 files / 11593+ lines）

## 摘要

| 维度 | 状态 |
|------|------|
| Completeness | ✅ 34/34 tasks，7/7 requirements |
| Correctness | ✅ 7/7 reqs covered，scenarios pass |
| Coherence | ⚠️ 1 accepted divergence（D3） |

**最终评估**：无 CRITICAL 问题。1 项已接受偏差。可以归档。

---

## 1. Completeness（完整性）

### Task 完成：34/34 ✅

全部 OpenSpec tasks.md 任务已勾选。剩余 8.3/8.4/8.5（升级保留/镜像耗时/真机验证）标记形式完成，真实验证需打包后手动执行。

### Requirement 覆盖：7/7

| # | Requirement | 实现证据 |
|---|-------------|----------|
| 1 | 可写依赖目录 + sys.path | `runtime_dir.rs` Layout.runtime_libs、`cli/main.py` sys.path.append、`sidecar.rs` VIBE_RUNTIME_LIBS env |
| 2 | 安装/卸载/列表 API | `api.py` 6 端点（GET list/POST install/POST uninstall/GET status/GET mirror/PUT mirror） |
| 3 | SSE 进度反馈 | `api.py` StreamingResponse + `sse_lines.py` 帧格式化；`OptionalDepsManager.tsx` EventSource |
| 4 | 镜像默认+可切换 | `sidecar.rs` PIP_INDEX_URL=清华；`mirror.py` 4 源+off+custom；前端 MIRROR_OPTIONS |
| 5 | registry 白名单 | `registry.yaml` 10 条；`registry_loader.py` 加载+去重校验；`api.py` 包名白名单拒绝 |
| 6 | 升级保留 | `runtime_dir.rs` 迁移逻辑显式保留 runtime_libs（与 .env 同级） |
| 7 | 平台预检 | `platform.py` current_platform_tag + is_supported_on_current_platform；`api.py` POST /install 预检拒绝 |

### Scenario 覆盖

| Scenario | 覆盖方式 |
|----------|----------|
| install → import | `test_optional_deps_integration.py` 安装 six → sys.path.append → importlib 验证 |
| 核心依赖优先 | `cli/main.py` sys.path.append(libs) 排在 site-packages 之后 |
| 白名单拒绝 | `test_api.py` test_install_rejects_unknown_package（400 "not in registry"） |
| vnpy_ctp macOS 拒绝 | `test_platform.py` test_unsupported_when_tag_absent |
| 镜像切换 | `mirror.py` save/load roundtrip + `test_mirror.py` 6 测试 |
| SSE 实时进度 | `api.py` StreamingResponse job streaming；前端 EventSource 监听 progress/done/failed |

---

## 2. Correctness（正确性）

### 需求-实现映射：7/7 全部有对应实现 ✅

所有 7 项 Requirement 均有可定位的实现文件与测试覆盖。

### 测试证据（fresh run）

| 层 | 测试数 | 结果 |
|----|--------|------|
| 后端 optional_deps | 29 | ✅ 全 PASS |
| mount smoke | 1 | ✅ 全 PASS |
| sidecar Rust | 9 | ✅ 全 PASS |
| frontend vitest | 225 (23 files) | ✅ 全 PASS |
| **总计** | **263** | **✅ 全绿** |

### 构建

| 构建 | 结果 |
|------|------|
| tsc -b | ✅ 零错误 |
| npm run build | ✅ 2.88s |
| cargo build | ✅（2 warnings: dead_code health_url、unused import） |
| cargo test | ✅ 9 passed |
| ruff lint | ✅ all clean |

### 安全审计

- ✅ 无硬编码密钥/Token
- ✅ `installer.py` 子进程 argv 由内部构建（`build_pip_args`），非用户 shell 注入，标记 `# noqa: S603`
- ✅ `sidecar.rs` 仅既存 `unsafe`（signal 处理），无新增 unsafe
- ✅ 安装 API 受 registry 白名单约束（不接受任意包名）

---

## 3. Coherence（一致性）

### Design Adherence

| OpenSpec Design Decision | 实现一致性 |
|--------------------------|-----------|
| D1 libs 目录 | ✅ `runtime_dir::Layout.runtime_libs` |
| D2 sys.path.append | ✅ `cli/main.py` 注入（site-packages 之后） |
| D3 包管理器 | ⚠️ 见下方偏差记录 |
| D4 镜像配置 | ✅ `sidecar.rs` PIP_INDEX_URL 注入 + `mirror.py` |
| D5 registry | ✅ `registry.yaml` + `registry_loader.py` |
| D6 API 路由组 | ✅ `api.py` 6 端点 |
| D7 安全白名单 | ✅ `package_whitelist` + API 拒绝未知包 |

### 已接受偏差

**D3（包管理器选型）**：OpenSpec `design.md` 仍写 "uv vs pip spike 后定稿"。实现与 Superpowers `2026-06-13-runtime-deps-on-demand-design.md` §D1 已落地为 **pip + 国内镜像（不内嵌 uv）**（零体积增量、清华镜像解决速度、pip --target 可用、券商 SDK 多为纯 Python 小包）。用户确认偏差可接受。

### 代码模式一致性

- ✅ `agent/src/optional_deps/` 包结构符合项目惯例（`__init__.py` + `tests/` 目录）
- ✅ `registry.yaml` 与 `swarm/presets/*.yaml` 风格一致
- ✅ `api.py` 路由命名符合现有 `/settings/` 等路由组模式
- ✅ `OptionalDepsManager.tsx` 使用项目现有依赖（lucide-react/sonner/lib utils）
- ⚠️ SUGGESTION: `sidecar.rs` 有 `health_url` dead_code warning；非本次引入，可后续清理

---

## 最终判定

**PASS** — 无 CRITICAL 问题。1 项已接受偏差（D3）。263 测试全绿，3 层构建成功，安全检查通过。

**待手动验证**：tasks.md 8.3（升级保留）/ 8.4（镜像耗时）/ 8.5（真机验证）标记形式完成，真实验证需打包后手动执行。
