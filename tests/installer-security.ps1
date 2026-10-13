param([string]$InstallerPath = (Join-Path $PSScriptRoot '../install.ps1'))
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $InstallerPath -PathType Leaf)) { throw 'Installer source is missing' }
$taskRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('rdsh-installer-security-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot | Out-Null
$priorBase = $env:RDSH_RELEASE_BASE
$env:RDSH_RELEASE_BASE = 'https://fixture.invalid/releases'
$global:RdshInstallerSecurityFixture = @{ extractions = 0; checksum = $null; rustupUrl = $null; rustupActualHash = $null }
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile)
  if ($Uri -match '/rustup/archive/.+/x86_64-pc-windows-msvc/rustup-init\.exe$') {
    $global:RdshInstallerSecurityFixture.rustupUrl = $Uri
    [System.IO.File]::WriteAllText($OutFile, 'DUMMY_ARCHIVE_BYTES')
  } elseif ($Uri.EndsWith('.sha256')) {
    if ($null -eq $global:RdshInstallerSecurityFixture.checksum) { throw 'fixture checksum unavailable' }
    [System.IO.File]::WriteAllText($OutFile, $global:RdshInstallerSecurityFixture.checksum)
  } else { [System.IO.File]::WriteAllText($OutFile, 'DUMMY_ARCHIVE_BYTES') }
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
try {
  $installer = $InstallerPath
  foreach ($checksumCase in @('missing', 'mismatch', 'malformed', 'valid')) {
    $global:RdshInstallerSecurityFixture.checksum = switch ($checksumCase) {
      'missing' { $null }
      'mismatch' { '0' * 64 }
      'malformed' { 'not-a-checksum' }
      'valid' {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes('DUMMY_ARCHIVE_BYTES'))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
      }
    }
    $before = $global:RdshInstallerSecurityFixture.extractions
    $caught = $null
    try { & $installer -FromRelease -Prefix (Join-Path $taskRoot 'bin') }
    catch { $caught = $_.Exception.Message }
    if ($checksumCase -eq 'valid') {
      if ($global:RdshInstallerSecurityFixture.extractions -ne ($before + 1) -or $caught -ne 'fixture reached extraction') { throw "valid checksum rejected: $caught" }
    } else {
      if ($global:RdshInstallerSecurityFixture.extractions -ne $before -or $caught -notmatch 'checksum') { throw "$checksumCase checksum did not block before extraction: $caught" }
    }
    Write-Output "PASS: $checksumCase checksum"
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
      $caught = $null
      try { & $installer }
      catch { $caught = $_.Exception.Message }
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
  Remove-Variable -Name RdshInstallerSecurityFixture -Scope Global
  $resolvedTaskRoot = [System.IO.Path]::GetFullPath($taskRoot)
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (!$resolvedTaskRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup escaped temporary directory' }
  Remove-Item -LiteralPath $resolvedTaskRoot -Recurse -Force
}
