param([string]$InstallerPath = (Join-Path $PSScriptRoot '../install.ps1'))
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $InstallerPath -PathType Leaf)) { throw 'Installer source is missing' }
$taskRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('rdsh-installer-security-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot | Out-Null
$priorBase = $env:RDSH_RELEASE_BASE
$env:RDSH_RELEASE_BASE = 'https://fixture.invalid/releases'
$global:RdshInstallerSecurityFixture = @{ extractions = 0; checksum = $null }
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile)
  if ($Uri.EndsWith('.sha256')) {
    if ($null -eq $global:RdshInstallerSecurityFixture.checksum) { throw 'fixture checksum unavailable' }
    [System.IO.File]::WriteAllText($OutFile, $global:RdshInstallerSecurityFixture.checksum)
  } else { [System.IO.File]::WriteAllText($OutFile, 'DUMMY_ARCHIVE_BYTES') }
}
function Expand-Archive {
  param($Path, $DestinationPath, [switch]$Force)
  $global:RdshInstallerSecurityFixture.extractions++
  throw 'fixture reached extraction'
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
} finally {
  $env:RDSH_RELEASE_BASE = $priorBase
  Remove-Variable -Name RdshInstallerSecurityFixture -Scope Global
  $resolvedTaskRoot = [System.IO.Path]::GetFullPath($taskRoot)
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (!$resolvedTaskRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup escaped temporary directory' }
  Remove-Item -LiteralPath $resolvedTaskRoot -Recurse -Force
}
