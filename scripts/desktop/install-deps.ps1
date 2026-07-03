# scripts/desktop/install-deps.ps1 <runtime_dir>
# 只把 Tier 0 最小核心(requirements-tier0.txt)装进内嵌运行时的 site-packages。
# 重型依赖(pandas/scipy/...)不再进 bundle,改由首次运行 vibe-trading bootstrap
# 装到 ~/.vibe-trading/venv(设计三层依赖 / python-runtime-bundling delta)。
$ErrorActionPreference = "Stop"
$Runtime = $args[0]; if (-not $Runtime) { throw "usage: install-deps.ps1 <runtime_dir>" }
$Py = "$Runtime\python.exe"
$ReqSrc = "scripts\desktop\requirements-tier0.txt"

uv --version 2>$null; if ($LASTEXITCODE -ne 0) { throw "uv not found; install via 'pip install uv' or astral installer" }

Write-Host "Installing Tier 0 core deps into embedded runtime (heavy deps deferred to venv bootstrap)"
uv pip install --python $Py -r $ReqSrc

Write-Host "Done. Installed packages:"
& $Py -m pip list 2>$null | Select-Object -First 40

Write-Host "Running Tier 0 smoke checks (serve entry-chain importable, no heavy pkgs)"
$env:PYTHONPATH = "agent"
& $Py scripts\desktop\smoke_tier0.py
