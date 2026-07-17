# Windows Desktop Script Path Audit

审查日期：2026-07-17

## 范围

本记录审查 Windows 桌面打包相关脚本在从仓库外部目录调用时的路径解析，重点是默认运行时目录、`PYTHONPATH` 和 smoke 脚本路径。

## 已确认问题

### 1. `install-deps.ps1` 仍依赖调用目录

`install-deps.ps1` 已使用 `$PSScriptRoot` 定位 `requirements-tier0.txt` 和 `smoke_tier0.py`，但以下两项仍相对当前工作目录：

- 默认 `$Runtime = ".desktop-build\\python-runtime"`
- `$env:PYTHONPATH = "agent"`

从仓库外执行 `& C:\\repo\\scripts\\desktop\\install-deps.ps1` 时，runtime 会解析到调用目录，而 smoke 会在调用目录的 `agent` 下查找 `cli` 和 `api_server`，最终可能报 `ModuleNotFoundError: No module named 'cli'`。

修复时应从 `$PSScriptRoot\\..\\..` 派生仓库根目录，将默认 runtime 设为 `$Root\\.desktop-build\\python-runtime`，并将 `PYTHONPATH` 设为 `$Root\\agent`。

### 2. `fetch-runtime.ps1` 的默认输出目录依赖调用目录

`fetch-runtime.ps1` 的 `OutDir` 默认值为 `.\\.desktop-build\\python-runtime`。从仓库外部调用时，下载的 runtime 会落在错误位置；后续根目录锚定的 `assemble.ps1` 和 `build-windows.ps1` 会找不到它，或重复下载。

修复时应将默认 `OutDir` 由 `$PSScriptRoot` 派生，或在参数为空后将其解析到仓库根目录。

### 3. `relocate-smoke.ps1` 未设置 agent 导入路径

`relocate-smoke.ps1` 直接运行 `smoke_imports.py`，但该脚本需要导入 `src.desktop_bootstrap.smoke`。由于 `src` 位于 `agent/src`，独立调用时没有 `PYTHONPATH` 会报 `ModuleNotFoundError: src`。

修复时应显式将仓库的 `agent` 目录加入 `PYTHONPATH`，或者让 relocation smoke 使用随 runtime 一起复制的 agent 目录。`relocate-smoke.sh` 存在同一问题，应一起修复。

## 当前未触发的原因

`build-windows.ps1` 在主流程开始时执行 `Push-Location $Root`，所以内部调用暂时满足相对路径假设。GitHub Actions 也从 checkout workspace 根目录执行。两者都不是可依赖的脚本契约：手工执行、未来调整 workflow 的默认工作目录或脚本被复用时都会重新触发问题。

## 测试缺口

现有 `scripts/desktop/__tests__/build-windows.test.mjs` 只对 PowerShell 文本做正则断言，未覆盖：

- 从仓库外部 CWD 执行 `install-deps.ps1`，包括省略 runtime 参数的情况。
- 从仓库外部 CWD 执行 `fetch-runtime.ps1` 的默认输出位置。
- relocation smoke 的 `PYTHONPATH` 设置及实际模块导入。

新增或修改 Windows 脚本时，应优先增加可在 Windows CI 上执行的 PowerShell 集成测试，并以从仓库外调用脚本作为回归场景。

## 审查边界

本次未在 Windows 主机上执行 PowerShell；本机缺少 `pwsh`。已运行的静态检查为：

```text
node --test scripts/desktop/__tests__/build-windows.test.mjs
```

该命令的 3 项现有测试均通过，但不能证明上述外部 CWD 场景正确。
