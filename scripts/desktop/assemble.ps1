# scripts/desktop/assemble.ps1
# 组装桌面打包资源到 .desktop-build\(供 tauri resources 引用)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$Build = "$Root\.desktop-build"
$Runtime = "$Build\python-runtime"

# 1) 前端构建(复用现有 npm run build)
Write-Host "=== Building frontend ==="
Push-Location "$Root\frontend"
npm ci
npm run build
Pop-Location

# 2) 运行时须已由 fetch-runtime.ps1 + install-deps.ps1 准备好
Write-Host "=== Checking runtime ==="
if (-not (Test-Path "$Runtime\python.exe")) { throw "runtime missing; run fetch-runtime.ps1 + install-deps.ps1 first" }

# 3) 裁剪运行时 site-packages 体积
Write-Host "=== Trimming runtime ==="
Get-ChildItem -Path $Runtime -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $Runtime -Recurse -Directory -Filter "tests" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $Runtime -Recurse -Directory -Filter "test" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# 4) 准备 agent 代码模板
Write-Host "=== Preparing agent template ==="
if (Test-Path "$Build\agent") { Remove-Item -Recurse -Force "$Build\agent" }
Copy-Item -Recurse "$Root\agent" "$Build\agent"
foreach ($d in @("runs","sessions","uploads",".swarm")) {
    Remove-Item -Recurse -Force "$Build\agent\$d" -ErrorAction SilentlyContinue
}
Get-ChildItem -Path "$Build\agent" -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$Build\agent\tests" -ErrorAction SilentlyContinue

# 5) .env 种子
Write-Host "=== Preparing .env seed ==="
if (Test-Path "$Root\agent\.env") { Copy-Item "$Root\agent\.env" "$Build\agent\.env" }
elseif (Test-Path "$Root\agent\.env.example") { Copy-Item "$Root\agent\.env.example" "$Build\agent\.env" }
else { New-Item -ItemType File -Path "$Build\agent\.env" | Out-Null }

# 6) VERSION 标记
Write-Host "=== Creating VERSION marker ==="
(git -C $Root rev-parse --short HEAD) | Set-Content "$Build\VERSION"

Write-Host "=== Assembly complete ==="
Write-Host "Contents of ${Build}:"
Get-ChildItem $Build | ForEach-Object { $size = (Get-ChildItem $_.FullName -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; "$($_.Name): $([math]::Round($size/1MB, 1))MB" }
