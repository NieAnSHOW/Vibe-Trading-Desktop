# scripts/desktop/fetch-runtime.ps1
# Windows 版运行时获取脚本。
# 下载 python-build-standalone (install_only) 并解压到指定目录。
# 用法: $env:PBS_TAG="20260610"; $env:PBS_ASSET="cpython-3.12.13+20260610-x86_64-pc-windows-msvc-install_only.tar.gz"; .\scripts\desktop\fetch-runtime.ps1 [-OutDir <path>]
param(
    [string]$OutDir
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
if (-not $OutDir) {
    $OutDir = Join-Path $Root ".desktop-build\python-runtime"
}

$PBS_TAG = $env:PBS_TAG
if (-not $PBS_TAG) {
    Write-Error "Environment variable PBS_TAG is required."
    exit 1
}

$PBS_ASSET = $env:PBS_ASSET
if (-not $PBS_ASSET) {
    Write-Error "Environment variable PBS_ASSET is required."
    exit 1
}

$URL = "https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_ASSET}"

$parent = Split-Path -Parent $OutDir
if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
}

$tmp = New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory -Path $_ }
try {
    Write-Host "Downloading $URL"
    # PowerShell 7+ (Invoke-WebRequest -SkipHttpErrorCheck) or fallback
    try {
        Invoke-WebRequest -Uri $URL -OutFile "$tmp\runtime.tar.gz" -ErrorAction Stop
    } catch {
        # Fallback: use curl.exe if available (comes with Windows 10+)
        curl.exe -fsSL "$URL" -o "$tmp\runtime.tar.gz"
    }

    if (Test-Path $OutDir) {
        Remove-Item -Recurse -Force $OutDir
    }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

    # install_only 解包后顶层是 python/, 展平到 OutDir
    Write-Host "Extracting..."
    tar.exe -xzf "$tmp\runtime.tar.gz" -C "$tmp"
    Move-Item "$tmp\python\*" -Destination "$OutDir\" -Force

    Write-Host "Runtime ready at: $OutDir"
    & "$OutDir\python.exe" --version
} finally {
    if (Test-Path $tmp) {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}
