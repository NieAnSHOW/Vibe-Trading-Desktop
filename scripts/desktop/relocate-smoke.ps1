# scripts/desktop/relocate-smoke.ps1 <runtime_dir>
# 复制运行时到一个全新随机路径(模拟不同安装目录),在新路径跑导入冒烟。
$ErrorActionPreference = "Stop"
$Src = $args[0]; if (-not $Src) { throw "usage: relocate-smoke.ps1 <runtime_dir>" }
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$AgentPath = Join-Path $Root "agent"
$Dest = Join-Path ([System.IO.Path]::GetTempPath()) ("relocated-" + [System.Guid]::NewGuid())
Write-Host "Relocating $Src -> $Dest"
Copy-Item -Recurse $Src $Dest
$SmokeScript = Join-Path $PSScriptRoot "smoke_imports.py"
$env:PYTHONPATH = if ($env:PYTHONPATH) {
    "$AgentPath$([System.IO.Path]::PathSeparator)$env:PYTHONPATH"
} else {
    $AgentPath
}
& "$Dest\python.exe" $SmokeScript
if ($LASTEXITCODE -ne 0) { throw "Windows relocation smoke FAILED" }
Write-Host "Relocation smoke PASSED"
