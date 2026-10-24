#!/usr/bin/env pwsh
# Exercises the plugins-archive helpers in install.ps1 without running the
# installer: the functions are pulled out of the parsed AST and driven with a
# local file:// fixture.
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '../install.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if ($errors) { throw "install.ps1 does not parse: $($errors[0].Message)" }
foreach ($fn in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  . ([scriptblock]::Create($fn.Extent.Text))
}
$PluginAsset = 'rdsh-plugins.tar.gz'
$PluginDigestsUrl = 'https://fixture.invalid/release-plugins-digests.tsv'

$root = Join-Path ([System.IO.Path]::GetTempPath()) ('rdsh-plugins-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $root | Out-Null
$env:RDSH_RELEASE_BASE = 'file://' + $root
try {
  $tree = Join-Path $root 'tree/plugins'
  New-Item -ItemType Directory -Force -Path (Join-Path $tree 'rdsh-settings') | Out-Null
  Set-Content -LiteralPath (Join-Path $tree 'install.sh') -Value '# fixture installer'
  Set-Content -LiteralPath (Join-Path $tree 'rdsh-settings/package.json') -Value '{}'
  $download = Join-Path $root 'download/v9.9.9'
  New-Item -ItemType Directory -Force -Path $download | Out-Null
  & tar -czf (Join-Path $download 'rdsh-plugins.tar.gz') -C (Join-Path $root 'tree') plugins
  if ($LASTEXITCODE -ne 0) { throw 'fixture tar failed' }
  $digest = (Get-FileHash -LiteralPath (Join-Path $download 'rdsh-plugins.tar.gz') -Algorithm SHA256).Hash.ToLowerInvariant()
  $ledger = Join-Path $root 'release-plugins-digests.tsv'
  Set-Content -LiteralPath $ledger -Value @(
    '# Trusted SHA-256 registry for the bundled plugins archive (install.sh).',
    'latest v9.9.9',
    "v9.9.9 rdsh-plugins.tar.gz $digest")
  $env:RDSH_PLUGIN_DIGESTS = $ledger

  # 1) parsing
  $manifest = Read-PluginDigestManifest $ledger
  if ($null -eq $manifest) { throw 'a valid plugins ledger was refused' }
  if ($manifest.Latest -cne 'v9.9.9') { throw "latest parsed as $($manifest.Latest)" }
  if ($manifest.Digests["v9.9.9 rdsh-plugins.tar.gz"] -cne $digest) { throw 'the digest row was not parsed' }
  Write-Output 'PASS: a valid plugins ledger parses'

  # 2) header-only ledger means 'nothing published yet'
  $empty = Join-Path $root 'empty.tsv'
  Set-Content -LiteralPath $empty -Value @('# header only')
  $emptyManifest = Read-PluginDigestManifest $empty
  if ($null -eq $emptyManifest -or $emptyManifest.Digests.Count -ne 0) { throw 'a header-only ledger was not read as empty' }
  Write-Output 'PASS: a header-only ledger means nothing to install'

  # 3) malformed rows are refused
  foreach ($case in @(
      @('latest v9.9.9', 'v9.9.9 rdsh-linux-x64.tar.gz ' + $digest),
      @('latest v9.9.9'),
      @('v9.9.9 rdsh-plugins.tar.gz ' + $digest),
      @('latest v9.9.9', 'v9.9.9 rdsh-plugins.tar.gz ' + ('a' * 63)),
      @('latest v9.9.9', "v9.9.9 rdsh-plugins.tar.gz $digest", "v9.9.9 rdsh-plugins.tar.gz $digest"))) {
    $bad = Join-Path $root 'bad.tsv'
    Set-Content -LiteralPath $bad -Value $case
    if ($null -ne (Read-PluginDigestManifest $bad)) { throw "a malformed ledger was accepted: $($case -join ' | ')" }
  }
  Write-Output 'PASS: malformed plugins ledgers are refused'

  # 4) the archive is fetched, verified and unpacked next to the binary
  $share = Join-Path $root 'share/rdsh'
  $plugins = Install-ReleasePlugins ('file://' + $root) 'latest' $share
  if ($null -eq $plugins) { throw 'the pinned archive was not installed' }
  if (-not (Test-Path -LiteralPath (Join-Path $plugins 'install.sh') -PathType Leaf)) { throw 'install.sh was not unpacked' }
  if (-not (Test-Path -LiteralPath (Join-Path $plugins 'rdsh-settings/package.json') -PathType Leaf)) { throw 'the plugin tree was not unpacked' }
  Write-Output 'PASS: the pinned plugins archive is verified and unpacked'

  # 5) a tampered archive is refused before extraction
  Add-Content -LiteralPath (Join-Path $download 'rdsh-plugins.tar.gz') -Value 'tampered'
  $share2 = Join-Path $root 'share2/rdsh'
  $caught = $null
  try { Install-ReleasePlugins ('file://' + $root) 'latest' $share2 } catch { $caught = $_.Exception.Message }
  if ($caught -notmatch 'checksum mismatch') { throw "a tampered archive was not refused: $caught" }
  if (Test-Path -LiteralPath (Join-Path $share2 'plugins')) { throw 'a tampered archive was extracted' }
  Write-Output 'PASS: a tampered plugins archive is refused before extraction'
} finally {
  $env:RDSH_RELEASE_BASE = $null
  $env:RDSH_PLUGIN_DIGESTS = $null
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'all plugins-archive checks passed'