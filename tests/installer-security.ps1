param([string]$InstallerPath = (Join-Path $PSScriptRoot '../install.ps1'))
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $InstallerPath -PathType Leaf)) { throw 'Installer source is missing' }
$taskRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('rdsh-installer-security-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot | Out-Null
$priorBase = $env:RDSH_RELEASE_BASE
$priorDigests = $env:RDSH_RELEASE_DIGESTS
$priorNoChecksum = $env:RDSH_NO_CHECKSUM
$env:RDSH_RELEASE_BASE = 'https://fixture.invalid/releases'
$env:RDSH_RELEASE_DIGESTS = $null
$env:RDSH_NO_CHECKSUM = $null
# install.ps1 reads the Windows-only ledger; the four Unix archives stay in
# release-digests.tsv, which the published installers keep reading.
$registryUrl = 'https://raw.githubusercontent.com/jimoto-no-llm/rustdsh/main/release-digests-windows.tsv'
$asset = 'rdsh-windows-x64.zip'
$unixAsset = 'rdsh-macos-x64.tar.gz'

# A real single-member zip: the installer lists the archive before extracting
# it. The extraction stub below is what stops the fixture installing anything.
$fixtureExe = Join-Path $taskRoot 'rdsh.exe'
[System.IO.File]::WriteAllText($fixtureExe, 'DUMMY_ARCHIVE_BYTES')
$fixtureArchive = Join-Path $taskRoot 'pkg.zip'
Compress-Archive -Path $fixtureExe -DestinationPath $fixtureArchive -Force
$goodDigest = (Get-FileHash -LiteralPath $fixtureArchive -Algorithm SHA256).Hash.ToLowerInvariant()
$zeroDigest = '0' * 64

$global:RdshInstallerSecurityFixture = @{
  extractions = 0
  requests = @()
  archive = $fixtureArchive
  registry = $null
  rustupUrl = $null
  rustupActualHash = $null
}
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile)
  $global:RdshInstallerSecurityFixture.requests += $Uri
  if ($Uri -match '/rustup/archive/.+/x86_64-pc-windows-msvc/rustup-init\.exe$') {
    $global:RdshInstallerSecurityFixture.rustupUrl = $Uri
    [System.IO.File]::WriteAllText($OutFile, 'DUMMY_ARCHIVE_BYTES')
  } elseif ($Uri -ceq $registryUrl) {
    if ($null -eq $global:RdshInstallerSecurityFixture.registry) { throw 'fixture registry unavailable' }
    [System.IO.File]::WriteAllLines($OutFile, [string[]]$global:RdshInstallerSecurityFixture.registry)
  } elseif ($Uri.EndsWith('.sha256')) {
    throw "fixture refused a release sidecar request: $Uri"
  } else {
    Copy-Item -LiteralPath $global:RdshInstallerSecurityFixture.archive -Destination $OutFile -Force
  }
}
function Expand-Archive {
  param($Path, $DestinationPath, [switch]$Force)
  $global:RdshInstallerSecurityFixture.extractions++
  throw 'fixture reached extraction'
}
function Get-FileHash {
  param([string]$LiteralPath, [string]$Algorithm)
  if ($LiteralPath -like '*rustup-init.exe') {
    if ($Algorithm -ne 'SHA256') { throw "unexpected rustup hash algorithm: $Algorithm" }
    return [PSCustomObject]@{ Hash = $global:RdshInstallerSecurityFixture.rustupActualHash }
  }
  Microsoft.PowerShell.Utility\Get-FileHash @PSBoundParameters
}

# Registry fixtures mirror the real release-digests-windows.tsv shape: a latest
# row plus the Windows archive row install.ps1 knows about.
function New-Registry([string]$Latest, [string[]]$Rows) {
  return @('# fixture registry', "latest $Latest") + $Rows
}
function New-AssetRows([string]$Version, [string]$Digest) {
  return @("$Version $asset $Digest")
}
function Test-AssetRequested {
  return (@($global:RdshInstallerSecurityFixture.requests | Where-Object { $_ -match 'rdsh-windows-x64\.zip$' }).Count -ne 0)
}
function Invoke-Installer([hashtable]$Extra) {
  $params = @{ FromRelease = $true; Prefix = (Join-Path $taskRoot ('bin-' + [Guid]::NewGuid().ToString('N'))) }
  foreach ($key in $Extra.Keys) { $params[$key] = $Extra[$key] }
  $global:RdshInstallerSecurityFixture.requests = @()
  $caught = $null
  try { & $InstallerPath @params } catch { $caught = $_.Exception.Message }
  return $caught
}

try {
  # The Windows release path verifies the archive against its own trusted
  # ledger, fetched from the canonical URL. The four Unix archives stay in
  # release-digests.tsv so the published installers keep reading a Unix-only
  # file; this ledger names nothing but the Windows archive. The release
  # origin's .sha256 sidecar must never authorize a payload, and every refusal
  # happens before the archive is extracted.
  $rows = New-AssetRows -Version 'v9.9.9' -Digest $goodDigest
  $global:RdshInstallerSecurityFixture.registry = New-Registry -Latest 'v9.9.9' -Rows $rows
  $before = $global:RdshInstallerSecurityFixture.extractions
  $caught = Invoke-Installer -Extra @{}
  if ($global:RdshInstallerSecurityFixture.extractions -ne ($before + 1) -or $caught -ne 'fixture reached extraction') { throw "valid registry pin rejected: $caught" }
  $requests = $global:RdshInstallerSecurityFixture.requests
  if ($requests.Count -ne 2 -or $requests[0] -cne $registryUrl) { throw "the canonical registry was not the first request: $($requests -join ', ')" }
  if ($requests[1] -cne 'https://fixture.invalid/releases/download/v9.9.9/rdsh-windows-x64.zip') { throw "latest did not resolve through the registry: $($requests -join ', ')" }
  if (@($requests | Where-Object { $_ -like '*.sha256' }).Count -ne 0) { throw 'a release sidecar was requested' }
  Write-Output 'PASS: the Windows registry pin resolves latest and reaches extraction'

  # A registry row that pins different bytes cannot authorize the archive.
  $rows = New-AssetRows -Version 'v9.9.9' -Digest $zeroDigest
  $global:RdshInstallerSecurityFixture.registry = New-Registry -Latest 'v9.9.9' -Rows $rows
  $before = $global:RdshInstallerSecurityFixture.extractions
  $caught = Invoke-Installer -Extra @{}
  if ($global:RdshInstallerSecurityFixture.extractions -ne $before -or $caught -notmatch 'checksum mismatch') { throw "a registry checksum mismatch did not block before extraction: $caught" }
  Write-Output 'PASS: a registry checksum mismatch blocks before extraction'

  # A ledger whose latest row does not pin the Windows archive is refused as a
  # whole, before any download.
  $global:RdshInstallerSecurityFixture.registry = New-Registry -Latest 'v9.9.9' -Rows @()
  $before = $global:RdshInstallerSecurityFixture.extractions
  $caught = Invoke-Installer -Extra @{}
  if ($global:RdshInstallerSecurityFixture.extractions -ne $before -or $caught -notmatch 'digest registry is invalid') { throw "a ledger without a Windows pin was not refused: $caught" }
  if (Test-AssetRequested) { throw 'a ledger without a Windows pin still downloaded the archive' }
  Write-Output 'PASS: a ledger without a Windows pin is refused before download'

  # The Windows ledger is Windows-only: a Unix row belongs to
  # release-digests.tsv and makes this whole file invalid, so a stray copy of
  # the old shared shape fails closed instead of widening the asset set.
  $rows = New-AssetRows -Version 'v9.9.9' -Digest $goodDigest
  $global:RdshInstallerSecurityFixture.registry = New-Registry -Latest 'v9.9.9' -Rows ($rows + "v9.9.9 $unixAsset $goodDigest")
  $before = $global:RdshInstallerSecurityFixture.extractions
  $caught = Invoke-Installer -Extra @{}
  if ($global:RdshInstallerSecurityFixture.extractions -ne $before -or $caught -notmatch 'digest registry is invalid') { throw "a Unix row in the Windows ledger was not refused: $caught" }
  if (Test-AssetRequested) { throw 'a ledger with a Unix row still downloaded the archive' }
  Write-Output 'PASS: a Unix row in the Windows ledger is refused'

  # An explicit -Version the ledger does not pin is refused before the
  # download; the latest row only covers the release it names.
  $rows = New-AssetRows -Version 'v9.9.9' -Digest $goodDigest
  $global:RdshInstallerSecurityFixture.registry = New-Registry -Latest 'v9.9.9' -Rows $rows
  $before = $global:RdshInstallerSecurityFixture.extractions
  $caught = Invoke-Installer -Extra @{ Version = 'v9.9.8' }
  if ($global:RdshInstallerSecurityFixture.extractions -ne $before -or $caught -notmatch 'no pinned checksum for release v9\.9\.8 asset') { throw "an unpinned Windows archive was not refused: $caught" }
  if (Test-AssetRequested) { throw 'an unpinned release asset was downloaded' }
  Write-Output 'PASS: an unpinned Windows archive is refused before download'

  # A malformed registry is refused as a whole, before any download.
  $rows = New-AssetRows -Version 'v9.9.9' -Digest ('a' * 63)
  $global:RdshInstallerSecurityFixture.registry = New-Registry -Latest 'v9.9.9' -Rows $rows
  $before = $global:RdshInstallerSecurityFixture.extractions
  $caught = Invoke-Installer -Extra @{}
  if ($global:RdshInstallerSecurityFixture.extractions -ne $before -or $caught -notmatch 'digest registry is invalid') { throw "a malformed registry was not refused: $caught" }
  if (Test-AssetRequested) { throw 'a malformed registry still downloaded an asset' }
  Write-Output 'PASS: a malformed registry is refused before download'

  # A repeated version/asset pair is malformed too.
  $rows = (New-AssetRows -Version 'v9.9.9' -Digest $goodDigest) + (New-AssetRows -Version 'v9.9.9' -Digest $goodDigest)
  $global:RdshInstallerSecurityFixture.registry = New-Registry -Latest 'v9.9.9' -Rows $rows
  $before = $global:RdshInstallerSecurityFixture.extractions
  $caught = Invoke-Installer -Extra @{}
  if ($global:RdshInstallerSecurityFixture.extractions -ne $before -or $caught -notmatch 'digest registry is invalid') { throw "a duplicate registry row was not refused: $caught" }
  Write-Output 'PASS: a duplicate registry row is refused'

  # A remote release base can never name the registry: a hostile local copy is
  # ignored and the canonical URL is what gets fetched.
  $hostileRegistry = Join-Path $taskRoot 'hostile-digests.tsv'
  $hostileRows = New-AssetRows -Version 'v9.9.9' -Digest $zeroDigest
  Set-Content -LiteralPath $hostileRegistry -Value (New-Registry -Latest 'v9.9.9' -Rows $hostileRows)
  $env:RDSH_RELEASE_DIGESTS = $hostileRegistry
  $rows = New-AssetRows -Version 'v9.9.9' -Digest $goodDigest
  $global:RdshInstallerSecurityFixture.registry = New-Registry -Latest 'v9.9.9' -Rows $rows
  $before = $global:RdshInstallerSecurityFixture.extractions
  $caught = Invoke-Installer -Extra @{}
  if (-not ($global:RdshInstallerSecurityFixture.requests -ccontains $registryUrl)) { throw 'a remote base did not fall back to the canonical registry' }
  if ($global:RdshInstallerSecurityFixture.extractions -ne ($before + 1)) { throw "the hostile local registry was not ignored: $caught" }
  Write-Output 'PASS: a remote release base cannot supply its own registry'

  # Control: the same override is honoured for a file:// base, so the gate
  # above fails for the gate and not because the hook never works.
  $env:RDSH_RELEASE_BASE = 'file://' + $taskRoot
  $localRows = New-AssetRows -Version 'v9.9.9' -Digest $goodDigest
  Set-Content -LiteralPath $hostileRegistry -Value (New-Registry -Latest 'v9.9.9' -Rows $localRows)
  $global:RdshInstallerSecurityFixture.registry = $null
  $before = $global:RdshInstallerSecurityFixture.extractions
  $caught = Invoke-Installer -Extra @{}
  if ($global:RdshInstallerSecurityFixture.requests -ccontains $registryUrl) { throw 'a file:// base still fetched the canonical registry' }
  if ($global:RdshInstallerSecurityFixture.extractions -ne ($before + 1)) { throw "the local registry was not honoured: $caught" }
  $env:RDSH_RELEASE_BASE = 'https://fixture.invalid/releases'
  $env:RDSH_RELEASE_DIGESTS = $null
  Write-Output 'PASS: a file:// base honours the local registry (control)'

  # The version is interpolated into the download URL, so it has to be one
  # value: an anchored match applied line by line would accept the first line
  # of a two-line value and let the rest reach the URL.
  $rows = New-AssetRows -Version 'v9.9.9' -Digest $goodDigest
  $global:RdshInstallerSecurityFixture.registry = New-Registry -Latest 'v9.9.9' -Rows $rows
  $brokenVersion = 'v9.9.9' + [Environment]::NewLine + '../../etc'
  $caught = Invoke-Installer -Extra @{ Version = $brokenVersion }
  if ($caught -notmatch 'invalid release version') { throw "a multi-line release version was accepted: $caught" }
  if (@($global:RdshInstallerSecurityFixture.requests | Where-Object { $_ -match '\.\.' }).Count -ne 0) { throw 'a multi-line version reached a download URL' }
  Write-Output 'PASS: a multi-line release version is refused before the URL'

  # The checksum bypass is explicit and interactive: without a terminal it
  # refuses instead of silently trusting the download.
  if ([Console]::IsInputRedirected) {
    $caught = Invoke-Installer -Extra @{ NoChecksum = $true; Version = 'v9.9.9' }
    if ($caught -notmatch 'requires a terminal for confirmation') { throw "a non-interactive checksum bypass was not refused: $caught" }
    if (Test-AssetRequested) { throw 'a refused checksum bypass still downloaded the archive' }
    Write-Output 'PASS: NoChecksum refuses without a terminal'
  } else {
    Write-Output 'SKIP: the NoChecksum terminal gate needs redirected stdin'
  }

  $priorTemp = $env:TEMP
  $env:TEMP = $taskRoot
  function Get-Command {
    param([string]$Name, [string]$ErrorAction)
    if ($Name -in @('cargo', 'rustup', 'winget')) { return $null }
    Microsoft.PowerShell.Core\Get-Command @PSBoundParameters
  }
  try {
    $pinnedRustupVersion = '1.29.1'
    $pinnedRustupHash = '6f4bef66261261fcb43131be8720bab817d403a09edec7455c371974b90bdb7e'
    foreach ($checksumCase in @('mismatch', 'valid')) {
      $global:RdshInstallerSecurityFixture.rustupActualHash = switch ($checksumCase) {
        'mismatch' { '0' * 64 }
        'valid' { $pinnedRustupHash }
      }
      $global:RdshInstallerSecurityFixture.rustupUrl = $null
      $global:RdshInstallerSecurityFixture.requests = @()
      $caught = $null
      try { & $InstallerPath } catch { $caught = $_.Exception.Message }
      $expectedRustupUrl = "https://static.rust-lang.org/rustup/archive/$pinnedRustupVersion/x86_64-pc-windows-msvc/rustup-init.exe"
      if ($global:RdshInstallerSecurityFixture.rustupUrl -ne $expectedRustupUrl) {
        throw "$checksumCase rustup-init used an unexpected URL: $($global:RdshInstallerSecurityFixture.rustupUrl)"
      }
      if ($checksumCase -eq 'valid') {
        if ([string]::IsNullOrWhiteSpace($caught)) { throw 'valid pinned rustup-init fixture did not stop at the installer boundary' }
        if ($caught -match 'SHA-256 mismatch') { throw "pinned rustup-init SHA-256 was rejected: $caught" }
      } else {
        if ($caught -notmatch 'SHA-256 mismatch') { throw "$checksumCase rustup-init hash did not block execution: $caught" }
      }
      foreach ($file in @('rustup-init.exe')) {
        if (Test-Path -LiteralPath (Join-Path $taskRoot $file)) {
          throw "$checksumCase rustup-init fixture was not removed"
        }
      }
      Write-Output "PASS: rustup-init $checksumCase pinned SHA-256"
    }
  } finally {
    $env:TEMP = $priorTemp
    Remove-Item Function:Get-Command -ErrorAction SilentlyContinue
    Remove-Item Function:Get-FileHash -ErrorAction SilentlyContinue
  }
} finally {
  $env:RDSH_RELEASE_BASE = $priorBase
  $env:RDSH_RELEASE_DIGESTS = $priorDigests
  $env:RDSH_NO_CHECKSUM = $priorNoChecksum
  Remove-Variable -Name RdshInstallerSecurityFixture -Scope Global
  $resolvedTaskRoot = [System.IO.Path]::GetFullPath($taskRoot)
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (!$resolvedTaskRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup escaped temporary directory' }
  Remove-Item -LiteralPath $resolvedTaskRoot -Recurse -Force
}
