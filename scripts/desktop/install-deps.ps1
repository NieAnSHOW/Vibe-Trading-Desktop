# scripts/desktop/install-deps.ps1 [runtime_dir]
# 只把 Tier 0 最小核心(requirements-tier0.txt)装进内嵌运行时的 site-packages。
# 重型依赖(pandas/scipy/...)不再进 bundle,改由首次运行 vibe-trading bootstrap
# 装到 ~/.vibe-trading/venv(设计三层依赖 / python-runtime-bundling delta)。
#
# 用法:
#   .\scripts\desktop\install-deps.ps1                        # runtime_dir 默认仓库根目录下的 .desktop-build\python-runtime
#   .\scripts\desktop\install-deps.ps1 <runtime_dir>          # 指定其它 runtime 目录
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$Runtime = $args[0]
if (-not $Runtime) { $Runtime = Join-Path $Root ".desktop-build\python-runtime" }
$Py = "$Runtime\python.exe"
# 基于脚本自身位置定位，避免依赖调用方 CWD（build-windows.ps1 / CI / 手动调用可能从任意目录）
$ReqSrc = "$PSScriptRoot\requirements-tier0.txt"

# runtime 未就绪时给清晰引导，而不是让下游 uv 报晦涩错误
if (-not (Test-Path $Py)) { throw "runtime 未就绪: $Py 不存在；请先运行 .\scripts\desktop\fetch-runtime.ps1" }

uv --version 2>$null; if ($LASTEXITCODE -ne 0) { throw "uv not found; install via 'pip install uv' or astral installer" }

Write-Host "Installing Tier 0 core deps into embedded runtime (heavy deps deferred to venv bootstrap)"
uv pip install --python $Py -r $ReqSrc

Write-Host "Done. Installed packages:"
& $Py -m pip list 2>$null | Select-Object -First 40

Write-Host "Running Tier 0 smoke checks (serve entry-chain importable, no heavy pkgs)"
$AgentPath = Join-Path $Root "agent"
$env:PYTHONPATH = if ($env:PYTHONPATH) {
    "$AgentPath$([System.IO.Path]::PathSeparator)$env:PYTHONPATH"
} else {
    $AgentPath
}
& $Py "$PSScriptRoot\smoke_tier0.py"
