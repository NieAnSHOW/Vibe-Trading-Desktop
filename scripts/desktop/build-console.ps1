# scripts/desktop/build-console.ps1
# Build src-tauri/console-app into src-tauri/console-dist for Tauri packaging.

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$AppDir = Join-Path $Root "src-tauri\console-app"

if (-not (Test-Path $AppDir -PathType Container)) {
  Write-Warning "[build-console] console-app does not exist; skipping"
  exit 0
}

Write-Host "[build-console] Installing dependencies and building console-app..."
Push-Location $AppDir
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci exited $LASTEXITCODE" }

  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build exited $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Host "[build-console] Checking console version anchor..."
node "$PSScriptRoot\console-version.mjs" --root $Root --check
if ($LASTEXITCODE -ne 0) { throw "console-version check exited $LASTEXITCODE" }

Write-Host "[build-console] Done"
