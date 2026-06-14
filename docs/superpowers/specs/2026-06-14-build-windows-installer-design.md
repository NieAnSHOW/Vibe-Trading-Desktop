# Windows 安装包端到端构建脚本 — 设计文档

**日期**: 2026-06-14
**状态**: 已获批（brainstorming），待写实现计划
**作者**: brainstorming session

## 1. 背景与目标

Vibe Trading Desktop 是一个 Tauri 2 桌面应用（React/Vite 前端 + Python agent + 内嵌 Python runtime），Windows 平台的安装包产物为 MSI。当前构建流程是**分散的手动步骤**：

```
npm run build → fetch-runtime → install-deps → assemble → cargo tauri build
```

这五步分别由不同脚本/命令承担，开发者每次构建都要手工按序执行，且 `fetch-runtime.ps1` 还依赖手动设置 `PBS_TAG`/`PBS_ASSET` 环境变量。

**目标**：提供一个单一编排脚本 `scripts/desktop/build-windows.ps1`，一条命令端到端产出 Windows MSI 安装包并归档，便于每次构建。

## 2. 现状分析

### 2.1 已有的分散脚本（`scripts/desktop/`）

| 脚本 | 职责 |
|------|------|
| `fetch-runtime.ps1` | 下载 python-build-standalone（install_only）解压到 `.desktop-build/python-runtime`；需 `$env:PBS_TAG` / `$env:PBS_ASSET` |
| `install-deps.ps1` | 用 `uv` 把 `agent/requirements.txt`（排除 weasyprint）装进内嵌 runtime 的 site-packages |
| `assemble.ps1` | 前端 `npm ci && npm run build` + 裁剪 runtime + 复制 agent 模板 + 种子 `.env` + 写 VERSION marker，输出到 `.desktop-build/` |
| `assemble.sh` | macOS/Linux 对应物（CI 在 Windows runner 上用 bash 版） |

**缺失**：没有把以上步骤 + `cargo tauri build` 串成端到端流程的单一入口脚本。

### 2.2 权威构建序列参考

CI workflow `.github/workflows/desktop-build.yml`（Windows 分支）已经定义了完整的权威序列。新脚本本质上是这套 CI 流程的**本地化、PowerShell 原生版本**：

| 步骤 | CI 命令 | 关键参数 |
|------|---------|---------|
| 前端构建 | `npm ci && npm run build` | — |
| 拉取 Python runtime | PBS release 下载 | `PBS_TAG=20260610`，asset `cpython-3.12.13+20260610-x86_64-pc-windows-msvc-install_only.tar.gz` |
| 装 Python 依赖 | `uv pip install` | 排除 weasyprint |
| 组装资源 | `bash scripts/desktop/assemble.sh` | → 本地用 `assemble.ps1` |
| 装 Tauri CLI | `cargo install tauri-cli --version "^2"` | — |
| 打包 MSI | `cargo tauri build --bundles msi` | working-directory: src-tauri |
| 上传产物 | `src-tauri/target/release/bundle/msi/*.msi` | — |

### 2.3 关键技术事实

- **WiX 无需脚本管理**：验证文档（`docs/superpowers/verification/2026-06-13-windows-build-verification.md`）证实 Tauri 会自动下载打包工具链（NSIS 场景自动下载了 makensis）；MSI 场景同理自动下载 WiX。`.tools/wix311/` 是手动副本，被 `.gitignore` 忽略，不影响 Tauri 自动下载。
- **产物用 MSI**：与 CI（`--bundles msi`）和当前 `tauri.conf.json`（`bundle.targets: ["app","dmg","msi"]`）一致。旧验证文档提到的 NSIS 是历史产物，当前配置已切换为 MSI。
- **PBS 版本**：CI 已 pin `PBS_TAG=20260610`，本地脚本采用同值以保持与 CI 同源。
- **README 已有手动分散步骤**（`docs/desktop/README.md` 第 43-47 行），正是本脚本要替代/补充的对象。

## 3. 需求决策（已与用户确认）

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 构建范围 | 端到端一键产出 MSI | 一条命令从干净状态到产物，便于每次构建 |
| Python runtime 准备策略 | 每次强制重建 | 保证干净、可复现，避免环境漂移 |
| 产物处理 | 复制到统一目录 + 打印信息 | 便于定位，避免每次去 `target/release/bundle/msi/` 翻找 |
| 脚本组织 | 方案 A：新建编排脚本，复用现有子脚本 | 最大化复用、职责单一、改动面最小 |

## 4. 设计详情

### 4.1 定位

单一编排脚本，按序调用现有 `fetch-runtime.ps1` → `install-deps.ps1` → `assemble.ps1` → `cargo tauri build`，产出 MSI 并归档。不改变任何现有脚本的职责，现有脚本继续可单独使用。

### 4.2 步骤序列

```
[0] 前置检查    — node/npm、cargo、uv、cargo-tauri 是否在 PATH；缺失即报错并给安装提示
[1] 准备 runtime — $env:PBS_TAG/PBS_ASSET 设为 pin 值 → fetch-runtime.ps1 → install-deps.ps1
[2] 组装资源     — assemble.ps1（内含 npm ci + npm run build + 组装 .desktop-build/）
[3] Tauri 构建   — cargo tauri build --bundles msi（working-directory: src-tauri）
[4] 归档产物     — 复制 *.msi 到 release/，打印路径/大小/版本/commit
```

步骤 [1][2] 复用现有 `.ps1` 版本（不调用 `.sh` 版），PowerShell 原生调用更可靠，也避免对 Git Bash 的依赖。

### 4.3 配置（脚本 `param` 默认值，可被参数覆盖）

```powershell
param(
  [string]$PbsTag    = "20260610",
  [string]$PbsAsset  = "cpython-3.12.13+20260610-x86_64-pc-windows-msvc-install_only.tar.gz",
  [string]$OutputDir = ".\release",
  [switch]$SkipRuntime  # 调试用；默认每次重建（与用户决策一致）
)
```

- `PbsTag` / `PbsAsset` 与 CI 一致（`20260610`），保证本地构建与 CI 同源。
- `OutputDir` 默认 `release/`。
- `SkipRuntime` 提供给调试场景（跳过耗时的 runtime 重建）；默认不带此开关，即每次重建，符合用户决策。

### 4.4 前置检查（step 0）

逐个检测以下工具是否在 PATH：
- `node`、`npm`（前端构建）
- `cargo`（Rust 编译）
- `uv`（Python 依赖安装）
- `cargo tauri`（通过 `cargo tauri --version` 验证 tauri-cli 已安装）

任一缺失 → 打印明确的缺失项 + 对应安装命令（如 `cargo install tauri-cli --version "^2"`）后非零退出。

**WiX 不检查**：Tauri 在 MSI 打包阶段会自动下载 WiX 到本地缓存（参见 §2.3）。

### 4.5 产物归档（step 4）

- **源**：`src-tauri\target\release\bundle\msi\*.msi`
- **目标**：`release\`（保留 Tauri 默认文件名，如 `Vibe Trading_0.1.0_x64_en-US.msi`）
- **打印信息**：
  - 最终 MSI 路径
  - 文件大小（MB）
  - Tauri CLI 版本
  - git HEAD（commit hash）
  - 构建总耗时

### 4.6 错误处理

- `$ErrorActionPreference = "Stop"` 确保未捕获错误中断脚本。
- 每个子脚本 / 外部命令后显式检查 `$LASTEXITCODE -ne 0` → 打印 `[FAILED] step N: <name>` 并非零退出。
- 阶段标记规则：step [0] 前置检查打印 `=== [0/4] Pre-check ===`，主步骤 [1]-[4] 分别打印 `=== [1/4] Prepare runtime ===` / `[2/4] Assemble` / `[3/4] Tauri build` / `[4/4] Archive`，便于从控制台输出定位失败点。
- 不落盘日志文件（控制台输出足够；如需归档可手动重定向 `> build.log`）。

## 5. 文件改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `scripts/desktop/build-windows.ps1` | **新增** | 主编排脚本 |
| `.gitignore` | **改** | 新增 `release/` 一行 |
| `docs/desktop/README.md` | **改** | "开发/构建"小节加一段"一键构建：`.\scripts\desktop\build-windows.ps1`"，保留原手动步骤作为备选 |

## 6. 不做的事（YAGNI）

- ❌ **代码签名**：无证书；沿用 SmartScreen 警告现状（验证文档已记录此限制）。
- ❌ **跨平台 `.sh` 版**：用户明确 Windows；macOS 已有 `build-dmg.sh` 体系。
- ❌ **版本号自动注入**：沿用 `tauri.conf.json` 的 `0.1.0`。
- ❌ **`-Clean` / `-DryRun` 等高级参数**：保持简单；`-SkipRuntime` 是唯一调试开关。
- ❌ **日志文件落盘**：控制台输出 + 手动重定向足够。
- ❌ **测试框架**：PowerShell 脚本，验证靠端到端实跑（见 §7）。

## 7. 验证方式

脚本本身无单元测试。验证方法：

1. 在当前 Windows 机器执行 `.\scripts\desktop\build-windows.ps1`
2. 确认：
   - 全程无报错退出
   - `release\*.msi` 产出且文件大小合理（预期 ~150MB，含 Python runtime + 依赖）
   - 控制台打印的路径/大小/版本/commit 信息正确
3. 双击 `release\*.msi` 确认可正常安装并启动应用
4. 验证结果记录到 `docs/superpowers/verification/2026-06-14-build-windows-installer-verify.md`

## 8. 技术决策记录

| 决策 | 选择 | 替代方案与拒绝理由 |
|------|------|-------------------|
| 编排 vs 内联 | 复用现有子脚本（方案 A） | 方案 C（内联全部逻辑）造成与现有脚本重复维护 |
| 扩展 vs 新增 | 新增 `build-windows.ps1` | 方案 B（扩展 assemble.ps1）破坏 assemble 现有职责，且打破与 assemble.sh 的对称 |
| 配置管理 | param 默认值 | 外部配置文件对本规模过度设计（YAGNI） |
| WiX 来源 | 依赖 Tauri 自动下载 | 手动管理 `.tools/wix311` 是冗余的（已证实 Tauri 自动下载行为） |
| 产物格式 | MSI | NSIS 是历史产物；当前 tauri.conf.json 与 CI 均为 msi |
| 平台 | 仅 Windows PS1 | 用户明确 Windows；避免无谓的跨平台维护 |

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| `cargo tauri` 未安装导致 step 3 失败 | step 0 前置检查捕获，并给出安装命令 |
| PBS 远程 release 不可达（网络问题） | fetch-runtime.ps1 已有 curl fallback；脚本不额外处理，失败由错误处理上报 |
| runtime 重建耗时较长（每次都跑） | 用户已确认接受此代价换取可复现性；提供 `-SkipRuntime` 调试开关 |
| Tauri 自动下载 WiX 失败 | 与 CI 一致的行为，CI 已验证可行；失败时错误处理上报 |
