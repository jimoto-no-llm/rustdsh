# Windows end-to-end runtime bootstrap, without a release or model inference.
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('rdsh-bootstrap-' + [guid]::NewGuid().ToString('N'))
$saved = @{}
foreach ($name in @('HOME', 'USERPROFILE', 'RDSH_SKIP_RUNTIME', 'DSH_ORIG_BIN', 'RDSH_ORIG_BIN', 'Path')) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
  $env:HOME = Join-Path $fixture ('home with space ' + [char]0x65E5 + [char]0x672C)
  $env:USERPROFILE = $env:HOME
  $env:RDSH_SKIP_RUNTIME = '0'
  Remove-Item Env:DSH_ORIG_BIN, Env:RDSH_ORIG_BIN -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $env:HOME | Out-Null
  $prefix = Join-Path $env:HOME 'bin'
  # Execute in this scope: -RuntimeOnly intentionally calls exit, so use a child.
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '../install.ps1') -RuntimeOnly -Prefix $prefix
  if ($LASTEXITCODE -ne 0) { throw 'Runtime bootstrap failed' }
  $private = Join-Path $env:HOME '.local/share/rdsh/runtime'
  $pnpm = & (Join-Path $private 'bin/pnpm.cmd') --version
  if ($LASTEXITCODE -ne 0 -or $pnpm -notmatch '^10\.34\.9$') { throw 'Private pnpm did not run' }
  $dsh = & (Join-Path $private 'bin/dsh.cmd') --version
  if ($LASTEXITCODE -ne 0 -or $dsh -notmatch '^0\.2\.2-alpha\.3$') { throw 'Private DSH did not run' }
  $origin = ([IO.File]::ReadAllText((Join-Path $env:HOME '.config/rdsh/origin'))).Trim()
  if ($origin -ne (Join-Path $private 'node_modules/@deepseek-ai/dsh/lib/bin.js')) { throw 'Original JS entry not recorded' }
  Write-Host 'PASS: private Windows runtime bootstraps and runs without preinstalled pnpm/DSH'
} finally {
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
