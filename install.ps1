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
#   .\install.ps1 -FromRelease -NoChecksum      # skip SHA-256 only after typing YES at a terminal
#   .\install.ps1 -Desktop         # also attach the rdsh plugins to DeepSeek Harness Desktop
# -FromRelease verifies the Windows archive against this repository's
# release-digests-windows.tsv, fetched from its fixed canonical URL; the release
# origin's .sha256 sidecar is never trusted. RDSH_RELEASE_BASE only moves the
# download, it never moves the registry. The four Unix archives stay in
# release-digests.tsv: the published installers reject that file once it names
# any other asset, so the Windows pin lives in its own ledger.
param(
  [switch]$AsDsh,
  [switch]$Restore,
  [string]$Prefix = '',
  [switch]$NoRustup,
  [switch]$Wsl,
  [switch]$FromRelease,
  [switch]$Desktop,
  [string]$Version = 'latest',
  [switch]$NoChecksum
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($Prefix)) { $Prefix = "$env:LOCALAPPDATA/rdsh/bin" }
$OriginFile = Join-Path $env:USERPROFILE '.config/rdsh/origin'
# Trusted digest registry for the release archives. Never make it follow
# RDSH_RELEASE_BASE or another environment value: the release origin must not
# choose the digests that verify its own archive.
$ReleaseDigestsUrl = 'https://raw.githubusercontent.com/jimoto-no-llm/rustdsh/main/release-digests-windows.tsv'
$ReleaseAsset = 'rdsh-windows-x64.zip'
$ReleaseMember = 'rdsh.exe'

function Ensure-Cargo {
  if (Get-Command cargo -ErrorAction SilentlyContinue) { return }
  if ($NoRustup) { throw 'cargo not found (drop -NoRustup to auto-install rustup)' }
  if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install -e --id Rustlang.Rustup --silent --accept-package-agreements --accept-source-agreements
    } else {
      $init = Join-Path $env:TEMP 'rustup-init.exe'
      # Keep this fixed archive version and digest paired; do not fetch the digest beside the binary.
      $rustupVersion = '1.29.1'
      $expectedHash = '6f4bef66261261fcb43131be8720bab817d403a09edec7455c371974b90bdb7e'
      $url = "https://static.rust-lang.org/rustup/archive/$rustupVersion/x86_64-pc-windows-msvc/rustup-init.exe"
      try {
        Invoke-WebRequest -Uri $url -OutFile $init
        $actualHash = (Get-FileHash -LiteralPath $init -Algorithm SHA256).Hash
        if ($actualHash -ne $expectedHash) { throw 'rustup-init SHA-256 mismatch; refusing to run' }
        & $init -y --profile minimal --default-toolchain stable
      } finally {
        Remove-Item -LiteralPath $init -Force -ErrorAction SilentlyContinue
      }
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

function Get-ReleaseDigestManifest([string]$Destination) {
  # Normally the fixed canonical registry. A file:// release base -- which only
  # the tests use -- may instead point RDSH_RELEASE_DIGESTS at a local copy so
  # the offline installer fixture never needs the network. A remote base never
  # consults it: the release origin must not choose the digests that verify its
  # own archive.
  $source = $env:RDSH_RELEASE_DIGESTS
  if (-not [string]::IsNullOrEmpty($source)) {
    if ($env:RDSH_RELEASE_BASE -cnotlike 'file://*') {
      Write-Host 'warning: ignoring RDSH_RELEASE_DIGESTS (needs a file:// RDSH_RELEASE_BASE)'
      $source = ''
    } elseif (-not [System.IO.Path]::IsPathRooted($source)) {
      Write-Host "warning: ignoring RDSH_RELEASE_DIGESTS=$source (needs an absolute path)"
      $source = ''
    }
  }
  if (-not [string]::IsNullOrEmpty($source)) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "no local digest registry at $source" }
    Write-Host "warning: using local digest registry $source (file:// release base)"
    Copy-Item -LiteralPath $source -Destination $Destination -Force
    return
  }
  Invoke-WebRequest -Uri $ReleaseDigestsUrl -OutFile $Destination
}

function Read-ReleaseDigestManifest([string]$Path) {
  # Parse the trusted Windows registry the way install.sh's
  # validate_release_digest_manifest parses the Unix one: comments and blank
  # lines are ignored, exactly one 'latest' row names a stable release, every
  # other row pins a known asset of a well-formed version with a 64-hex digest,
  # a version/asset pair never repeats, and the latest release pins the Windows
  # archive itself. Only $ReleaseAsset is known here: the Unix archives live in
  # release-digests.tsv, which this file deliberately does not reuse.
  # Returns @{ Latest = 'vX.Y.Z'; Digests = @{ '<version> <asset>' = '<sha256>' } }
  # or $null when the registry must be refused.
  $versionPattern = '\Av[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?\z'
  $knownAssets = @($ReleaseAsset)
  $latest = ''
  $latestRows = 0
  $latestAssets = 0
  $digests = @{}
  $versions = @{}
  foreach ($line in @(Get-Content -LiteralPath $Path)) {
    if ($line -match '^[ \t]*#' -or $line.Trim().Length -eq 0) { continue }
    $fields = $line.Trim() -split '[ \t]+'
    if ($fields[0] -ceq 'latest') {
      $latestRows++
      if ($latestRows -ne 1 -or $fields.Count -ne 2 -or $fields[1] -cnotmatch $versionPattern -or $fields[1].Contains('-')) { return $null }
      $latest = $fields[1]
      continue
    }
    if ($fields.Count -ne 3 -or $fields[0] -cnotmatch $versionPattern -or $knownAssets -cnotcontains $fields[1] -or $fields[2] -cnotmatch '\A[0-9a-fA-F]{64}\z') { return $null }
    $key = "$($fields[0]) $($fields[1])"
    if ($digests.ContainsKey($key)) { return $null }
    $digests[$key] = $fields[2]
    $versions[$fields[0]] = $true
    if ($fields[0] -ceq $latest) { $latestAssets++ }
  }
  if ($latestRows -ne 1 -or -not $versions.ContainsKey($latest) -or $latestAssets -ne 1) { return $null }
  return @{ Latest = $latest; Digests = $digests }
}

function Assert-ReleaseSha256([string]$Path, [string]$Expected) {
  # install.sh's verify_sha256: only a 64-hex pin is acceptable, and the file's
  # digest is compared case-insensitively.
  if ($Expected -cnotmatch '\A[0-9a-fA-F]{64}\z') { throw 'invalid pinned SHA-256' }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  if ($actual -ieq $Expected) { Write-Host 'checksum ok'; return }
  throw "release checksum mismatch (expected $Expected, got $actual); refusing install"
}

function Assert-ReleaseArchiveMembers([string]$Archive) {
  # install.sh accepts only an archive whose single member is the rdsh binary,
  # and checks that before extraction so a traversal entry can never be written.
  try { Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue | Out-Null } catch { }
  $zip = $null
  try {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    $members = @($zip.Entries | ForEach-Object { $_.FullName })
  } catch {
    throw "release archive is not a readable zip; refusing install ($($_.Exception.Message))"
  } finally {
    if ($null -ne $zip) { $zip.Dispose() }
  }
  if ($members.Count -ne 1 -or $members[0] -cne $ReleaseMember) {
    throw "release archive must contain only $ReleaseMember; refusing install"
  }
}

function Confirm-ChecksumBypass([string]$Version, [string]$Asset) {
  # The escape hatch stays explicit and interactive: -NoChecksum alone is not
  # enough, and the answer must be exactly YES at a terminal.
  if ([Console]::IsInputRedirected) { throw 'checksum bypass requires a terminal for confirmation; refusing' }
  try { $answer = Read-Host "NoChecksum skips SHA-256 verification for $Version/$Asset. Type YES to continue" }
  catch { throw 'could not read checksum-bypass confirmation; refusing' }
  if ($answer -cne 'YES') { throw 'checksum bypass not confirmed; refusing' }
  Write-Host 'checksum bypass confirmed interactively'
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
  if ([string]::IsNullOrEmpty($base)) { $base = 'https://github.com/jimoto-no-llm/rustdsh/releases' }
  else { Write-Host 'warning: custom release base in use (RDSH_RELEASE_BASE); the trusted digest registry remains canonical' }
  $tmpd = Join-Path ([System.IO.Path]::GetTempPath()) ("rdsh-rel-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmpd | Out-Null
  try {
    $manifest = $null
    # latest always resolves through the registry; a pinned -Version skips it
    # only under the explicit bypass, which still needs a typed YES below.
    if (-not $NoChecksum -or $Version -ceq 'latest') {
      $manifestPath = Join-Path $tmpd 'release-digests-windows.tsv'
      try { Get-ReleaseDigestManifest $manifestPath }
      catch { throw "could not fetch the trusted release digest registry; refusing release install ($($_.Exception.Message))" }
      $manifest = Read-ReleaseDigestManifest $manifestPath
      if ($null -eq $manifest) { throw 'trusted release digest registry is invalid; refusing release install' }
    }
    if ($Version -ceq 'latest') { $version = $manifest.Latest }
    else {
      $version = $Version
      if (-not $version.StartsWith('v')) { $version = "v$version" }
    }
    # The version is interpolated into the download URL, so reject anything
    # outside its alphabet first. \A..\z matches the whole value, not the first
    # line of a value such as a version plus a newline and more path.
    if (-not [regex]::IsMatch($version, '\A[0-9A-Za-z.-]+\z') -or
        -not [regex]::IsMatch($version, '\Av[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?\z')) {
      throw "invalid release version: $version"
    }
    $expectedHash = ''
    if ($null -ne $manifest) {
      $expectedHash = $manifest.Digests["$version $ReleaseAsset"]
      if ([string]::IsNullOrEmpty($expectedHash) -and -not $NoChecksum) {
        throw "no pinned checksum for release $version asset $ReleaseAsset; refusing release install"
      }
    }
    $url = "$base/download/$version/$ReleaseAsset"
    Write-Host "fetching $url"
    if ($NoChecksum) { Confirm-ChecksumBypass $version $ReleaseAsset }
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmpd 'pkg.zip')
    if (-not $NoChecksum) { Assert-ReleaseSha256 (Join-Path $tmpd 'pkg.zip') $expectedHash }
    Assert-ReleaseArchiveMembers (Join-Path $tmpd 'pkg.zip')
    Expand-Archive -Path (Join-Path $tmpd 'pkg.zip') -DestinationPath $tmpd -Force
    $builtExe = Join-Path $tmpd 'rdsh.exe'
    if (-not (Test-Path -LiteralPath $builtExe -PathType Leaf)) { throw 'release archive has no rdsh.exe' }
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

# DeepSeek Harness Desktop (Electron) keeps its own reserved profile; the npm
# dsh CLI cannot manage it, so plugin attachment goes through the Desktop
# command runtime. Detection is read-only and never fails the install.
$rdshExe = Join-Path $Prefix 'rdsh.exe'
$desktopStatus = & $rdshExe desktop status 2>$null
if ($desktopStatus -match 'desktop profile: .*(initialized)') {
  if ($Desktop) {
    Write-Host '--- DeepSeek Harness Desktop ---'
    & $rdshExe desktop install --plugins-dir (Join-Path $Repo 'plugins') --compute
    if ($LASTEXITCODE -eq 0) {
      Write-Host 'note: quit and reopen DeepSeek Harness to load the plugins'
    } else {
      Write-Host "note: Desktop plugin attach failed; run 'rdsh desktop status' for the next step"
    }
  } else {
    Write-Host "next: rdsh desktop install --plugins-dir . attaches the rdsh plugins to the Desktop app"
  }
}
