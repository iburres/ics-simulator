<#
.SYNOPSIS
  Repairs a missing or broken Electron binary install for OTForge on Windows.

.DESCRIPTION
  Electron 42+ no longer downloads its own binary automatically via npm's
  postinstall lifecycle -- it only exposes a manual "install-electron" /
  install.js command. OTForge's own predev hook already calls that
  automatically on every "npm run dev", but if the download itself is
  blocked (antivirus quarantine, a campus network blocking direct GitHub
  release downloads, a captive portal, etc.) the binary can still end up
  missing, causing electron-vite to fail with "Error: Electron uninstall".

  This script diagnoses and repairs that directly:
    1. Checks whether node_modules\electron\dist\electron.exe is already
       present and looks like a real build (not a 0-byte leftover).
    2. Looks for an already-cached zip in the same folder Electron's own
       installer uses (%LOCALAPPDATA%\electron\Cache) before touching the
       network at all.
    3. If nothing is cached, downloads the matching release zip straight
       from GitHub, with clear, non-silent error messages if that fails --
       unlike a plain "npm install", which can swallow this failure.
    4. Extracts it into node_modules\electron\dist and writes path.txt,
       exactly like Electron's own installer does.

.USAGE
  From the OTForge project root (the folder containing package.json):
    powershell -ExecutionPolicy Bypass -File scripts\fix-electron.ps1

  Add -Force to reinstall even if a binary already appears present.
#>

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Ok($msg) {
    Write-Host "    $msg" -ForegroundColor Green
}

function Write-Fail($msg) {
    Write-Host "    $msg" -ForegroundColor Red
}

# --- Locate the electron package inside node_modules ------------------------
Write-Step "Locating node_modules\electron"

$electronDir = Join-Path (Get-Location) "node_modules\electron"
$electronPkgJson = Join-Path $electronDir "package.json"

if (-not (Test-Path $electronPkgJson)) {
    Write-Fail "node_modules\electron\package.json not found."
    Write-Fail "Run 'npm install' from the OTForge project root first, then re-run this script."
    exit 1
}

$electronPkg = Get-Content $electronPkgJson -Raw | ConvertFrom-Json
$version = $electronPkg.version
Write-Ok "Required Electron version: $version"

# --- Check whether it is already properly installed --------------------------
$exePath = Join-Path $electronDir "dist\electron.exe"

if ((Test-Path $exePath) -and -not $Force) {
    $exeSize = (Get-Item $exePath).Length
    if ($exeSize -gt 1000000) {
        Write-Ok "electron.exe already present ($([math]::Round($exeSize / 1MB, 1)) MB). Nothing to do."
        Write-Ok "Use -Force to reinstall anyway."
        exit 0
    } else {
        Write-Fail "electron.exe exists but looks too small ($exeSize bytes) -- treating as broken and reinstalling."
    }
}

# --- Work out platform/arch and the expected Electron asset filename --------
$arch = if ([System.Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
} else {
    "ia32"
}

$zipName = "electron-v$version-win32-$arch.zip"
Write-Ok "Platform target: win32-$arch ($zipName)"

# --- Look for an already-cached zip before downloading anything -------------
# Same cache location Electron's own installer (@electron/get) uses, so a
# normal `npm install` that succeeded on another machine, or a previous run
# of this script, can satisfy this without any network call at all.
$cacheDir = Join-Path $env:LOCALAPPDATA "electron\Cache"
$cachedZip = Join-Path $cacheDir $zipName

$zipPath = $null

if (Test-Path $cachedZip) {
    Write-Step "Found a cached copy at $cachedZip"
    $zipPath = $cachedZip
} else {
    Write-Step "No cached copy found. Downloading from GitHub releases..."

    # Older PowerShell/.NET defaults sometimes negotiate TLS 1.0/1.1, which
    # GitHub rejects outright with a generic connection-closed error.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $downloadUrl = "https://github.com/electron/electron/releases/download/v$version/$zipName"
    $tempZip = Join-Path $env:TEMP $zipName

    Write-Ok "URL: $downloadUrl"

    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip -UseBasicParsing
    } catch {
        Write-Fail "Download failed: $($_.Exception.Message)"
        Write-Fail ""
        Write-Fail "This usually means one of:"
        Write-Fail "  - No internet access right now"
        Write-Fail "  - A campus/school network or firewall is blocking direct GitHub release downloads"
        Write-Fail "    (this is different from blocking npm itself, which uses a different host)"
        Write-Fail "  - A VPN is interfering -- try disconnecting it and re-running this script"
        exit 1
    }

    $downloadedSize = (Get-Item $tempZip).Length
    if ($downloadedSize -lt 1000000) {
        Write-Fail "Downloaded file is only $downloadedSize bytes -- too small to be a real Electron build."
        Write-Fail "This usually means a captive portal or proxy intercepted the download and returned an"
        Write-Fail "error or login page instead of the actual file. Try a different network and re-run."
        exit 1
    }

    Write-Ok "Downloaded $([math]::Round($downloadedSize / 1MB, 1)) MB"

    # Save into the standard cache location too, so a normal `npm install`
    # (or this script again) can reuse it without another download.
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    Copy-Item $tempZip $cachedZip -Force
    $zipPath = $tempZip
}

# --- Extract into node_modules\electron\dist --------------------------------
Write-Step "Extracting Electron binary into node_modules\electron\dist"

$distDir = Join-Path $electronDir "dist"
if (Test-Path $distDir) {
    Remove-Item -Recurse -Force $distDir
}
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

Expand-Archive -Path $zipPath -DestinationPath $distDir -Force

# Electron's own installer writes this file with the relative path to the
# executable; electron-vite's getElectronPath() reads it to find the binary.
Set-Content -Path (Join-Path $electronDir "path.txt") -Value "electron.exe" -NoNewline -Encoding ascii

# --- Verify -------------------------------------------------------------------
Write-Step "Verifying"

if (Test-Path $exePath) {
    $finalSize = (Get-Item $exePath).Length
    Write-Ok "electron.exe present ($([math]::Round($finalSize / 1MB, 1)) MB)"
    Write-Host ""
    Write-Host "Done. You can now run 'npm run dev' from the OTForge project root." -ForegroundColor Green
} else {
    Write-Fail "electron.exe still not found after extraction. Something is wrong with the downloaded or cached zip."
    exit 1
}
