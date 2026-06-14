# Windows 安装包端到端构建脚本 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建 `scripts/desktop/build-windows.ps1`，一条命令端到端产出 Windows MSI 安装包并归档到 `release/`。

**Architecture:** 单一编排脚本，按序复用现有子脚本 `fetch-runtime.ps1` → `install-deps.ps1` → `assemble.ps1` → `cargo tauri build --bundles msi`，加前置检查与产物归档。本质是 CI workflow（`.github/workflows/desktop-build.yml` Windows 分支）的本地化、PowerShell 原生版本。

**Tech Stack:** PowerShell 5.1+（Windows 自带），复用现有 `scripts/desktop/*.ps1`，Tauri CLI 2.x。

**测试策略说明:** PowerShell 编排脚本无单元测试框架（与 spec §6 一致）。每个 task 用 PowerShell Parser 做语法检查作为轻量验证；最终用一次端到端实跑作为主验证（Task 6）。

**设计文档:** `docs/superpowers/specs/2026-06-14-build-windows-installer-design.md`

---

## 文件结构

| 文件 | 责任 | 操作 |
|------|------|------|
| `scripts/desktop/build-windows.ps1` | 端到端编排：前置检查 → runtime → assemble → tauri build → 归档 | 新增 |
| `.gitignore` | 忽略构建产物目录 | 改（加 `release/`） |
| `docs/desktop/README.md` | 用户/开发者文档 | 改（加一键构建说明） |

`build-windows.ps1` 内部结构（单一文件，按职责分函数）：
- 头部：`param` 配置、`$ErrorActionPreference`、路径解析、计时
- `Write-Step`：阶段标记输出
- `Test-Command`：工具存在性检查（被 step 0 复用）
- `Invoke-Step0Checks`：前置依赖检查
- `Invoke-Step1Runtime`：runtime 准备（fetch + install-deps）
- `Invoke-Step2Assemble`：资源组装
- `Invoke-Step3Tauri`：Tauri MSI 构建
- `Invoke-Step4Archive`：产物归档与信息打印
- 主流程：`try/catch/finally` 串联各 step

---

## Task 1: 创建脚本骨架与前置检查

**Files:**
- Create: `scripts/desktop/build-windows.ps1`

- [ ] **Step 1: 创建脚本，写入头部与配置**

创建 `scripts/desktop/build-windows.ps1`，写入以下内容（这是脚本的初始版本，只含头部、配置、`Write-Step` 函数和一个临时主流程用于验证）：

```powershell
# scripts/desktop/build-windows.ps1
# 端到端构建 Windows MSI 安装包。
# 编排: fetch-runtime → install-deps → assemble → cargo tauri build，产物归档到 release/。
#
# 用法:
#   .\scripts\desktop\build-windows.ps1                  # 端到端构建
#   .\scripts\desktop\build-windows.ps1 -SkipRuntime     # 跳过 runtime 重建（调试）
#   .\scripts\desktop\build-windows.ps1 -PbsTag <tag> -PbsAsset <name>  # 覆盖 PBS 版本
#
# 前置（须在 PATH）: node, npm, cargo, cargo-tauri, uv

param(
  [string]$PbsTag    = "20260610",
  [string]$PbsAsset  = "cpython-3.12.13+20260610-x86_64-pc-windows-msvc-install_only.tar.gz",
  [string]$OutputDir = ".\release",
  [switch]$SkipRuntime
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$DesktopScripts = "$Root\scripts\desktop"
$BuildStartTime = Get-Date

function Write-Step([int]$Index, [string]$Name) {
  Write-Host ""
  Write-Host "=== [$Index/4] $Name ===" -ForegroundColor Cyan
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# 主流程（后续 task 在此扩展）
Push-Location $Root
try {
  Write-Host "build-windows.ps1 — placeholder main flow (Task 1)" -ForegroundColor Yellow
  Write-Host "Root: $Root"
} finally {
  Pop-Location
}
```

- [ ] **Step 2: 添加前置检查函数 `Invoke-Step0Checks`**

在 `Test-Command` 函数定义之后、`# 主流程` 注释之前，插入：

```powershell
function Invoke-Step0Checks {
  Write-Step 0 "Pre-check"
  $missing = @()
  foreach ($name in @("node", "npm", "cargo", "uv")) {
    if (-not (Test-Command $name)) { $missing += $name }
  }
  # cargo-tauri 不是独立可执行，用 cargo 子命令验证
  cargo tauri --version *> $null
  if ($LASTEXITCODE -ne 0) { $missing += "cargo-tauri" }

  if ($missing.Count -gt 0) {
    Write-Host "Missing prerequisites:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" }
    Write-Host ""
    Write-Host "Install hints:"
    Write-Host '  cargo tauri : cargo install tauri-cli --version "^2"'
    Write-Host "  uv          : pip install uv  (or https://docs.astral.sh/uv/)"
    Write-Host "  node/npm    : https://nodejs.org/"
    Write-Host "  cargo/rustc : https://rustup.rs/"
    exit 1
  }
  Write-Host "All prerequisites present." -ForegroundColor Green
}
```

- [ ] **Step 3: 把主流程从 placeholder 替换为调用 `Invoke-Step0Checks`**

把 `try { ... }` 块内的 placeholder 内容替换为对前置检查的调用。即将：

```powershell
try {
  Write-Host "build-windows.ps1 — placeholder main flow (Task 1)" -ForegroundColor Yellow
  Write-Host "Root: $Root"
} finally {
```

替换为：

```powershell
try {
  Invoke-Step0Checks
} finally {
```

- [ ] **Step 4: 语法检查**

Run:
```bash
powershell -NoProfile -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('scripts/desktop/build-windows.ps1', [ref]$null, [ref]$e); \$e.Count"
```
Expected output: `0`（零个解析错误）。如果输出非 0，检查对应行的语法。

- [ ] **Step 5: 运行验证**

Run:
```bash
powershell -NoProfile -File scripts/desktop/build-windows.ps1
```
Expected: 打印 `=== [0/4] Pre-check ===` 和 `All prerequisites present.`（前提是本机已装齐 node/npm/cargo/uv/cargo-tauri）。脚本正常退出，退出码 0。

**可选反向验证**（确认检测有效）：临时把 PATH 里某个工具遮蔽，例如 `$env:PATH = "" ; powershell -NoProfile -File scripts/desktop/build-windows.ps1`，预期打印 `Missing prerequisites:` 列表并以退出码 1 退出。验证后**不要提交**任何环境改动。

- [ ] **Step 6: Commit**

```bash
git add scripts/desktop/build-windows.ps1
git commit -m "feat(desktop): add build-windows.ps1 skeleton with prerequisite checks"
```

---

## Task 2: 实现 runtime 准备（step 1）

**Files:**
- Modify: `scripts/desktop/build-windows.ps1`

- [ ] **Step 1: 添加 `Invoke-Step1Runtime` 函数**

在 `Invoke-Step0Checks` 函数定义之后、`# 主流程` 注释之前，插入：

```powershell
function Invoke-Step1Runtime {
  Write-Step 1 "Prepare runtime"
  $Runtime = "$Root\.desktop-build\python-runtime"
  if ($SkipRuntime) {
    Write-Host "Skipping runtime rebuild (-SkipRuntime)" -ForegroundColor Yellow
    if (-not (Test-Path "$Runtime\python.exe")) {
      throw "runtime missing at $Runtime but -SkipRuntime set; remove the flag or run fetch-runtime first"
    }
    return
  }
  $env:PBS_TAG = $PbsTag
  $env:PBS_ASSET = $PbsAsset
  & "$DesktopScripts\fetch-runtime.ps1"
  if ($LASTEXITCODE -ne 0) { throw "[FAILED] step 1: fetch-runtime exited $LASTEXITCODE" }
  & "$DesktopScripts\install-deps.ps1" "$Runtime"
  if ($LASTEXITCODE -ne 0) { throw "[FAILED] step 1: install-deps exited $LASTEXITCODE" }
  Write-Host "Runtime ready at: $Runtime" -ForegroundColor Green
}
```

注意：`fetch-runtime.ps1` 默认 `-OutDir` 是 `.\.desktop-build\python-runtime`（相对路径），主流程已 `Push-Location $Root`，所以相对路径基于 root 解析，与 `$Runtime` 一致。`install-deps.ps1` 内部用相对路径 `agent\requirements.txt`，同样基于 root。

- [ ] **Step 2: 主流程加入 `Invoke-Step1Runtime` 调用**

把主流程 try 块从：

```powershell
try {
  Invoke-Step0Checks
} finally {
```

改为：

```powershell
try {
  Invoke-Step0Checks
  Invoke-Step1Runtime
} finally {
```

- [ ] **Step 3: 语法检查**

Run:
```bash
powershell -NoProfile -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('scripts/desktop/build-windows.ps1', [ref]$null, [ref]$e); \$e.Count"
```
Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add scripts/desktop/build-windows.ps1
git commit -m "feat(desktop): wire runtime prepare step into build-windows.ps1"
```

（此 task 的完整端到端验证留给 Task 6；此处只做语法验证，因为实跑会触发耗时的 runtime 下载。）

---

## Task 3: 实现资源组装与 Tauri 构建（step 2-3）

**Files:**
- Modify: `scripts/desktop/build-windows.ps1`

- [ ] **Step 1: 添加 `Invoke-Step2Assemble` 与 `Invoke-Step3Tauri` 函数**

在 `Invoke-Step1Runtime` 函数定义之后、`# 主流程` 注释之前，插入：

```powershell
function Invoke-Step2Assemble {
  Write-Step 2 "Assemble"
  & "$DesktopScripts\assemble.ps1"
  if ($LASTEXITCODE -ne 0) { throw "[FAILED] step 2: assemble exited $LASTEXITCODE" }
  Write-Host "Assembly complete (.desktop-build populated)" -ForegroundColor Green
}

function Invoke-Step3Tauri {
  Write-Step 3 "Tauri build"
  Push-Location "$Root\src-tauri"
  try {
    cargo tauri build --bundles msi
    if ($LASTEXITCODE -ne 0) { throw "[FAILED] step 3: cargo tauri build exited $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  Write-Host "MSI built at src-tauri/target/release/bundle/msi/" -ForegroundColor Green
}
```

`--bundles msi` 与 CI（`.github/workflows/desktop-build.yml:146`）和 `tauri.conf.json` 的 `bundle.targets` 一致。`assemble.ps1` 自行用 `$PSScriptRoot` 解析 root，对调用方工作目录不敏感；`Push-Location $Root` 仍保留，因其内部前端 `npm ci` 需在 root 下。

- [ ] **Step 2: 主流程加入两个新 step 调用**

把主流程 try 块从：

```powershell
try {
  Invoke-Step0Checks
  Invoke-Step1Runtime
} finally {
```

改为：

```powershell
try {
  Invoke-Step0Checks
  Invoke-Step1Runtime
  Invoke-Step2Assemble
  Invoke-Step3Tauri
} finally {
```

- [ ] **Step 3: 语法检查**

Run:
```bash
powershell -NoProfile -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('scripts/desktop/build-windows.ps1', [ref]$null, [ref]$e); \$e.Count"
```
Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add scripts/desktop/build-windows.ps1
git commit -m "feat(desktop): wire assemble and tauri build steps into build-windows.ps1"
```

---

## Task 4: 实现产物归档与错误收尾（step 4）

**Files:**
- Modify: `scripts/desktop/build-windows.ps1`

- [ ] **Step 1: 添加 `Invoke-Step4Archive` 函数**

在 `Invoke-Step3Tauri` 函数定义之后、`# 主流程` 注释之前，插入：

```powershell
function Invoke-Step4Archive {
  Write-Step 4 "Archive"
  $MsiGlob = "$Root\src-tauri\target\release\bundle\msi\*.msi"
  $msiFiles = @(Get-ChildItem $MsiGlob -ErrorAction SilentlyContinue)
  if ($msiFiles.Count -eq 0) { throw "no .msi found at $MsiGlob" }

  if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
  }
  $dest = (Resolve-Path $OutputDir).Path

  $sizeMB = 0
  foreach ($f in $msiFiles) {
    Copy-Item $f.FullName -Destination $dest -Force
    $copied = Join-Path $dest $f.Name
    $sizeMB = [math]::Round((Get-Item $copied).Length / 1MB, 1)
    Write-Host "Archived: $copied ($sizeMB MB)" -ForegroundColor Green
  }

  $elapsed = ((Get-Date) - $BuildStartTime).ToString('hh\:mm\:ss')
  $commit = (git -C $Root rev-parse --short HEAD 2>$null)
  $tauriVer = ((cargo tauri --version 2>$null) -split "`n" | Select-Object -First 1)
  Write-Host ""
  Write-Host "=== Build complete ===" -ForegroundColor Green
  Write-Host "  Output dir : $dest"
  Write-Host "  MSI size   : $sizeMB MB"
  Write-Host "  Git HEAD   : $commit"
  Write-Host "  Tauri      : $tauriVer"
  Write-Host "  Elapsed    : $elapsed"
}
```

- [ ] **Step 2: 主流程加入归档调用，并用 try/catch 包装统一错误处理**

把主流程从：

```powershell
# 主流程（后续 task 在此扩展）
Push-Location $Root
try {
  Invoke-Step0Checks
  Invoke-Step1Runtime
  Invoke-Step2Assemble
  Invoke-Step3Tauri
} finally {
  Pop-Location
}
```

替换为：

```powershell
# 主流程
Push-Location $Root
try {
  Invoke-Step0Checks
  Invoke-Step1Runtime
  Invoke-Step2Assemble
  Invoke-Step3Tauri
  Invoke-Step4Archive
} catch {
  Write-Host ""
  Write-Host "[FAILED] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  Pop-Location
}
```

`$ErrorActionPreference = "Stop"` + `throw` 会让任何 step 失败时跳到 catch，打印 `[FAILED] ...` 并以退出码 1 退出。

- [ ] **Step 3: 语法检查**

Run:
```bash
powershell -NoProfile -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('scripts/desktop/build-windows.ps1', [ref]$null, [ref]$e); \$e.Count"
```
Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add scripts/desktop/build-windows.ps1
git commit -m "feat(desktop): add MSI archive step and unified error handling

端到端编排完成：pre-check → runtime → assemble → tauri build → archive。
产物复制到 release/ 并打印路径/大小/commit/耗时。"
```

---

## Task 5: 更新 .gitignore 与 README

**Files:**
- Modify: `.gitignore`
- Modify: `docs/desktop/README.md`

- [ ] **Step 1: `.gitignore` 加入 `release/`**

在 `.gitignore` 文件中，定位到 "Internal docs" 注释块附近（第 53-59 行）。在该块的 `!docs/desktop/` 之后新增一行 `release/`。

具体地，找到：

```
# Internal docs (plans, specs)
docs/
!wiki/docs/
!wiki/docs/**
!docs/desktop/
docs/screenshots/agent-run.png
```

在 `!docs/desktop/` 这一行之后插入一行：

```
release/
```

结果应为：

```
# Internal docs (plans, specs)
docs/
!wiki/docs/
!wiki/docs/**
!docs/desktop/
release/
docs/screenshots/agent-run.png
```

（`release/` 放在此处只是因为它紧邻其他构建产物忽略项的逻辑位置；放任一独立行均可生效。）

- [ ] **Step 2: `docs/desktop/README.md` 加一键构建说明**

打开 `docs/desktop/README.md`，定位到 `### 构建` 小节（约第 43-47 行）。当前内容是：

```markdown
### 构建
1. 安装 Rust + Tauri CLI: `cargo install tauri-cli`
2. 准备运行时: `bash scripts/desktop/fetch-runtime.sh && bash scripts/desktop/install-deps.sh .desktop-build/python-runtime`
3. 装配资源: `bash scripts/desktop/assemble.sh`
4. 构建: `cd src-tauri && cargo tauri build`
```

在 `### 构建` 标题之后、原步骤列表之前，插入"一键构建"段。把该小节改为：

```markdown
### 构建

**Windows 一键构建**（推荐）：

```powershell
.\scripts\desktop\build-windows.ps1
```

该脚本端到端完成：前置检查 → 拉取 Python runtime → 装依赖 → 组装资源 → `cargo tauri build --bundles msi` → 归档 MSI 到 `release/`。前置依赖：`node`/`npm`、`cargo`、`cargo-tauri`（`cargo install tauri-cli --version "^2"`）、`uv`（`pip install uv`）。

**手动分步构建**（macOS / 调试用）：

1. 安装 Rust + Tauri CLI: `cargo install tauri-cli`
2. 准备运行时: `bash scripts/desktop/fetch-runtime.sh && bash scripts/desktop/install-deps.sh .desktop-build/python-runtime`
3. 装配资源: `bash scripts/desktop/assemble.sh`
4. 构建: `cd src-tauri && cargo tauri build`
```

- [ ] **Step 3: 验证 `release/` 被忽略**

Run:
```bash
git check-ignore release/test-dummy.msi
```
Expected output: `release/test-dummy.msi`（表示该路径会被忽略）。再清理测试文件（如果创建过）：`rm -f release/test-dummy.msi 2>/dev/null; rmdir release 2>/dev/null; true`。

- [ ] **Step 4: Commit**

```bash
git add .gitignore docs/desktop/README.md
git commit -m "docs(desktop): document one-command Windows build; ignore release/"
```

---

## Task 6: 端到端验证

**Files:**
- Create: `docs/superpowers/verification/2026-06-14-build-windows-installer-verify.md`

> 本 task 执行真正的端到端构建，会下载 Python runtime（~50MB）+ 装 pip 依赖（~700MB 解压后）+ Rust release 编译（~1-2 分钟）+ MSI 打包。全程预期 5-15 分钟，取决于网络与机器。MSI 体积预期 ~150MB。

- [ ] **Step 1: 端到端运行脚本**

Run:
```bash
powershell -NoProfile -File scripts/desktop/build-windows.ps1
```
Expected: 依次打印 `[0/4] Pre-check` → `[1/4] Prepare runtime` → `[2/4] Assemble` → `[3/4] Tauri build` → `[4/4] Archive`，最后打印 `=== Build complete ===` 及产物路径/大小/commit/耗时。退出码 0。

若任一 step 失败：脚本打印 `[FAILED] <message>` 并退出码 1。按消息定位（fetch 下载失败 / uv 缺失 / cargo tauri 报错等），修复后重跑。

- [ ] **Step 2: 验证产物存在与体积**

Run:
```bash
ls -la release/*.msi
```
Expected: 列出 1 个 `.msi` 文件，体积在 100-200MB 区间（内嵌 Python runtime + 依赖，参见验证文档 `2026-06-13-windows-build-verification.md` 的 ~153MB 基线）。

- [ ] **Step 3: 手动安装测试（需用户交互）**

提示用户：双击 `release\` 下的 `.msi`，按向导完成安装，启动 "Vibe Trading" 应用，确认窗口正常打开、后端（Python agent）正常拉起。

记录：安装是否成功 / 首次启动是否有 SmartScreen 警告（预期有，未签名）/ 应用是否正常运行。

- [ ] **Step 4: 写验证报告**

创建 `docs/superpowers/verification/2026-06-14-build-windows-installer-verify.md`，参考 `docs/superpowers/verification/2026-06-13-windows-build-verification.md` 的格式，记录：

```markdown
# Verification Report: build-windows-installer script

**Date:** 2026-06-14
**Platform:** Windows 11 Pro (x86_64)
**Script:** scripts/desktop/build-windows.ps1

## 端到端运行
| Step | 结果 | 备注 |
|------|------|------|
| [0/4] Pre-check | ✅/❌ | |
| [1/4] Prepare runtime | ✅/❌ | 耗时 / Python 版本 |
| [2/4] Assemble | ✅/❌ | |
| [3/4] Tauri build | ✅/❌ | 耗时 |
| [4/4] Archive | ✅/❌ | |

## 产物
- 路径: release\<name>.msi
- 体积: <size> MB
- Git HEAD: <commit>

## 安装测试
- 双击安装: ✅/❌
- SmartScreen 警告: 有/无（预期有）
- 应用启动: ✅/❌

## Verdict
PASS / FAIL — <一句话>
```

填入实际观测值。

- [ ] **Step 5: Commit 验证报告**

由于 `docs/` 被 `.gitignore` 忽略（但 `docs/superpowers/` 下既有验证报告是用 `-f` 跟踪的流程产物），用 `-f` 提交：

```bash
git add -f docs/superpowers/verification/2026-06-14-build-windows-installer-verify.md
git commit -m "docs(verify): report for build-windows-installer script"
```

---

## Self-Review（计划作者已完成）

**1. Spec 覆盖检查：**
- §4.1 定位（编排脚本复用子脚本）→ Task 1-4 ✓
- §4.2 步骤序列 [0]-[4] → Task 1（step 0）、Task 2（step 1）、Task 3（step 2-3）、Task 4（step 4）✓
- §4.3 配置 param（PbsTag/PbsAsset/OutputDir/SkipRuntime）→ Task 1 Step 1 ✓
- §4.4 前置检查（node/npm/cargo/uv/cargo-tauri，不查 WiX）→ Task 1 Step 2 ✓
- §4.5 产物归档（复制 + 打印路径/大小/commit/耗时）→ Task 4 Step 1 ✓
- §4.6 错误处理（Stop + $LASTEXITCODE 检查 + 阶段标记 + try/catch）→ Task 1（Write-Step）、Task 4 Step 2（try/catch）✓
- §5 文件改动清单（3 文件）→ Task 1-4（脚本）、Task 5（.gitignore + README）✓
- §6 YAGNI 边界（无签名/无跨平台/无版本注入）→ 计划未引入这些 ✓
- §7 验证方式 → Task 6 ✓

**2. 占位符扫描：** 无 TBD/TODO。所有代码块完整。Step 3"手动安装测试"标注为"需用户交互"是合理的（GUI 操作无法自动化），非占位符。

**3. 类型/命名一致性：** 函数名 `Invoke-Step0Checks`/`Invoke-Step1Runtime`/`Invoke-Step2Assemble`/`Invoke-Step3Tauri`/`Invoke-Step4Archive` 在各 task 间一致。`Write-Step`、`Test-Command` 定义（Task 1）与使用（Task 1-4）一致。param 名 `$PbsTag`/`$PbsAsset`/`$OutputDir`/`$SkipRuntime` 一致。

无遗漏，计划可执行。
