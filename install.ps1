#!/usr/bin/env pwsh
# rdsh installer for native Windows, with optional WSL side-install.
# Release checklist (Issue #7, docs only):
# 1) bump version in Cargo.toml, 2) cargo build/test/regress green,
# 3) commit + push, 4) cargo publish (needs crates.io token + verified email),
# 5) refresh live install via install.ps1 -AsDsh (or install.sh --as-dsh in WSL)
# and verify `dsh --version` delegation, 6) confirm sync-dsh.sh picks up
# the new version on its next run.
#   .\install.ps1                  # build + install rdsh
#   .\install.ps1 -AsDsh           # also shadow dsh (backs up to dsh-orig)
#   .\install.ps1 -Restore         # restore the backed-up original dsh
#   .\install.ps1 -Prefix DIR      # custom install dir
#   .\install.ps1 -Wsl             # also install inside WSL via install.sh
#   .\install.ps1 -FromRelease      # prebuilt binary from GitHub Releases (no Rust needed)
#   .\install.ps1 -FromRelease -Version v0.1.2  # pinned release
param(
  [switch]$AsDsh,
  [switch]$Restore,
  [string]$Prefix = '',
  [switch]$NoRustup,
  [switch]$Wsl,
  [switch]$FromRelease,
  [string]$Version = 'latest'
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($Prefix)) { $Prefix = "$env:LOCALAPPDATA/rdsh/bin" }
$OriginFile = Join-Path $env:USERPROFILE '.config/rdsh/origin'

function Ensure-Cargo {
  if (Get-Command cargo -ErrorAction SilentlyContinue) { return }
  if ($NoRustup) { throw 'cargo not found (drop -NoRustup to auto-install rustup)' }
  if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install -e --id Rustlang.Rustup --silent --accept-package-agreements --accept-source-agreements
    } else {
      $init = Join-Path $env:TEMP 'rustup-init.exe'
      Invoke-WebRequest -Uri 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile $init
      & $init -y --profile minimal --default-toolchain stable
    }
  }
  $env:PATH = "$env:USERPROFILE/.cargo/bin;$env:PATH"
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'cargo still missing after rustup (restart the shell and retry)' }
}

function Add-ToUserPath([string]$Dir) {
  $cur = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($cur -notlike "*$Dir*") {
    [Environment]::SetEnvironmentVariable('Path', "$cur;$Dir", 'User')
    $env:PATH = "$env:PATH;$Dir"
    Write-Host "added to user PATH: $Dir (new shells pick it up)"
  }
}

if ($Restore) {
  $backup = Join-Path $Prefix 'dsh-orig.exe'
  if (-not (Test-Path $backup)) { throw "no backup at $backup" }
  $cur = Join-Path $Prefix 'dsh.exe'
  if ((Test-Path $cur) -and (& $cur doctor 2>$null | Select-String 'rdsh' -Quiet)) {
    Move-Item $backup $cur -Force
    Write-Host 'restored original dsh'
  } else { throw "$cur does not look like rdsh; refusing" }
  exit 0
}

if ($FromRelease) {
  $base = $env:RDSH_RELEASE_BASE
  if ([string]::IsNullOrEmpty($base)) { $base = 'https://github.com/sahenjp/rustdsh/releases' }
  if ($Version -eq 'latest') { $url = "$base/latest/download/rdsh-windows-x64.zip" }
  else { $url = "$base/download/$Version/rdsh-windows-x64.zip" }
  $tmpd = Join-Path ([System.IO.Path]::GetTempPath()) ("rdsh-rel-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmpd | Out-Null
  try {
    Write-Host "fetching $url"
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmpd 'pkg.zip')
    Invoke-WebRequest -Uri "$url.sha256" -OutFile (Join-Path $tmpd 'pkg.zip.sha256')
    $checksumText = (Get-Content -LiteralPath (Join-Path $tmpd 'pkg.zip.sha256') -Raw).Trim()
    $expectedHash = ($checksumText -split '\s+')[0]
    if ($expectedHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'invalid release checksum; refusing install' }
    $actualHash = (Get-FileHash -LiteralPath (Join-Path $tmpd 'pkg.zip') -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) { throw 'release checksum mismatch; refusing install' }
    Expand-Archive -Path (Join-Path $tmpd 'pkg.zip') -DestinationPath $tmpd -Force
    $builtExe = Join-Path $tmpd 'rdsh.exe'
    if (-not (Test-Path $builtExe)) { throw 'release archive has no rdsh.exe' }
    & $builtExe --version | Out-Null
    New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
    Copy-Item $builtExe (Join-Path $Prefix 'rdsh.exe') -Force
  } finally { Remove-Item $tmpd -Recurse -Force -ErrorAction SilentlyContinue }
} else {
  Ensure-Cargo
  & cargo build --release --manifest-path (Join-Path $Repo 'Cargo.toml')
  New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
  Copy-Item (Join-Path $Repo 'target/release/rdsh.exe') (Join-Path $Prefix 'rdsh.exe') -Force
}
Write-Host "installed $(Join-Path $Prefix 'rdsh.exe')"
Add-ToUserPath $Prefix

if ($AsDsh) {
  $dsh = Join-Path $Prefix 'dsh.exe'
  $backup = Join-Path $Prefix 'dsh-orig.exe'
  $found = Get-Command dsh -ErrorAction SilentlyContinue
  if (Test-Path $backup) { throw "backup exists: $backup (use -Restore first)" }
  if ($found -and ($found.Source -ne $dsh)) {
    Copy-Item $found.Source $backup -Force
    New-Item -ItemType Directory -Force -Path (Split-Path $OriginFile) | Out-Null
    Set-Content $OriginFile $backup
    Write-Host "backed up original dsh -> $backup"
  } elseif (-not $found) {
    Write-Host 'no existing dsh on PATH; rdsh will be found as dsh via Prefix'
  }
  Copy-Item (Join-Path $Prefix 'rdsh.exe') $dsh -Force
  Write-Host "installed rdsh as $dsh (revert: .\install.ps1 -Restore)"
}

if ($Wsl) {
  if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) { throw 'wsl not found' }
  $nix = ((& wsl wslpath -a "$Repo") | Out-String).Trim()
  $wargs = @()
  if ($AsDsh) { $wargs += '--as-dsh' }
  if ($NoRustup) { $wargs += '--no-rustup' }
  & wsl bash "$nix/install.sh" @wargs
}

Write-Host '--- rdsh doctor ---'
& (Join-Path $Prefix 'rdsh.exe') doctor | Select-Object -First 12
Write-Host "next: run 'rdsh setup' to connect a model (GPT subscription via OAuth needs no API key)"
