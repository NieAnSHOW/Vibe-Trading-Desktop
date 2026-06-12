# scripts/desktop/install-deps.ps1 <runtime_dir>
# 用 uv 把 agent/requirements.txt(排除 weasyprint)装进内嵌运行时的 site-packages。
$ErrorActionPreference = "Stop"
$Runtime = $args[0]; if (-not $Runtime) { throw "usage: install-deps.ps1 <runtime_dir>" }
$Py = "$Runtime\python.exe"
$ReqSrc = "agent\requirements.txt"

uv --version 2>$null; if ($LASTEXITCODE -ne 0) { throw "uv not found; install via 'pip install uv' or astral installer" }

$tmpReq = New-TemporaryFile
Get-Content $ReqSrc | Where-Object { $_ -notmatch '^\s*weasyprint' } | Set-Content $tmpReq

Write-Host "Installing deps into embedded runtime (weasyprint excluded)"
uv pip install --python $Py -r $tmpReq
Remove-Item $tmpReq

Write-Host "Done. Checking weasyprint absent:"
& $Py -m pip show weasyprint 2>&1; if ($LASTEXITCODE -ne 0) { Write-Host "weasyprint absent (OK)" }
