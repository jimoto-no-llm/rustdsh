#requires -Version 7.0
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Run this integration test on Windows.' }
$repo = Split-Path $PSScriptRoot
$supervisor = Join-Path $repo 'scripts/windows-web-supervisor.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('rdsh-supervisor-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
$fixture = Join-Path $testRoot 'child fixture.ps1'
$shell = (Get-Process -Id $PID).Path
$children = [Collections.Generic.List[Diagnostics.Process]]::new()
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Free-Port {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
function Start-Case([string]$Name, [string]$Codes, [int]$Budget = 3,
                    [int]$Hold = 0, [int]$OutputBytes = 0, [int]$Port = 0,
                    [int]$Window = 600, [int]$Delay = 0) {
  $directory = Join-Path $testRoot $Name
  New-Item -ItemType Directory -Path $directory | Out-Null
  if (-not $Port) { $Port = Free-Port }
  $attemptFile = Join-Path $directory 'attempts.txt'
  $config = @{
    executable = $shell
    arguments = @('-NoProfile', '-NonInteractive', '-File', $fixture,
      '-AttemptFile', $attemptFile, '-ExitCodes', $Codes,
      '-Marker', 'literal $() & space " quote', '-HoldMs', "$Hold", '-OutputBytes', "$OutputBytes")
    workingDirectory = $directory
  }
  $configPath = Join-Path $directory 'config.json'
  $config | ConvertTo-Json | Set-Content -LiteralPath $configPath
  $info = [Diagnostics.ProcessStartInfo]::new($shell)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  foreach ($argument in @('-NoProfile', '-NonInteractive', '-File', $supervisor,
    '-ConfigPath', $configPath, '-StateDirectory', $directory, '-Port', "$Port",
    '-MaxRestarts', "$Budget", '-DelaySeconds', "$Delay", '-WindowSeconds', "$Window")) {
    $info.ArgumentList.Add($argument)
  }
  $process = [Diagnostics.Process]::Start($info)
  $children.Add($process)
  return @{ process = $process; directory = $directory; attempts = $attemptFile; port = $Port }
}
function Finish-Case($Case, [int]$ExitCode, [int]$Attempts) {
  Assert ($Case.process.WaitForExit(30000)) 'Supervisor exceeded the 30-second test deadline.'
  Assert ($Case.process.ExitCode -eq $ExitCode) "Unexpected supervisor exit: $($Case.process.ExitCode)"
  $count = if (Test-Path -LiteralPath $Case.attempts) { [int](Get-Content $Case.attempts -Raw) } else { 0 }
  Assert ($count -eq $Attempts) "Expected $Attempts attempts, got $count"
  return @(Get-Content (Join-Path $Case.directory 'lifecycle.jsonl') | ConvertFrom-Json)
}
try {
  @'
param([string]$AttemptFile, [string]$ExitCodes, [string]$Marker, [int]$HoldMs, [int]$OutputBytes)
$ErrorActionPreference = 'Stop'
if ($Marker -cne 'literal $() & space " quote') { exit 91 }
$count = if (Test-Path -LiteralPath $AttemptFile) { [int](Get-Content $AttemptFile -Raw) } else { 0 }
$count++
Set-Content -LiteralPath $AttemptFile -Value $count
if ($OutputBytes) {
  $line = 'SECRET_TOKEN https://example.invalid/?token=never-persist ' + ('x' * 1024)
  for ($i = 0; $i -lt $OutputBytes / 1024; $i++) {
    [Console]::Out.WriteLine($line)
    [Console]::Error.WriteLine($line)
  }
}
if ($HoldMs) { Start-Sleep -Milliseconds $HoldMs }
$codes = $ExitCodes.Split(',')
exit ([int]$codes[[math]::Min($count - 1, $codes.Length - 1)])
'@ | Set-Content -LiteralPath $fixture

  $case = Start-Case 'recover' '-1073740791,19,0' -OutputBytes 131072
  $events = Finish-Case $case 0 3
  Assert (@($events | Where-Object event -eq 'restart_scheduled').Count -eq 2) 'Crash recovery did not retry twice.'
  Assert (@($events | Where-Object exitHex -eq '0xC0000409').Count -eq 1) 'Windows crash status was lost.'
  Assert ((Get-Content (Join-Path $case.directory 'lifecycle.jsonl') -Raw) -notmatch 'SECRET_TOKEN|example.invalid|never-persist|literal') 'Process output or argv leaked.'
  'PASS: native crash recovery, literal argv, concurrent output draining, metadata-only logs'

  $case = Start-Case 'budget' '17' -Budget 2
  $events = Finish-Case $case 17 3
  Assert (@($events | Where-Object event -eq 'restart_limit').Count -eq 1) 'Restart budget was not enforced.'
  'PASS: bounded crash loop and final exit status'

  $case = Start-Case 'clean' '0'
  $null = Finish-Case $case 0 1
  $case = Start-Case 'cancel' '-1073741510'
  $null = Finish-Case $case -1073741510 1
  'PASS: no restart after clean exit or Ctrl+C status'

  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    $case = Start-Case 'occupied' '0' -Port $listener.LocalEndpoint.Port
    $events = Finish-Case $case 0 0
    Assert ($events.event -contains 'existing_listener') 'Existing listener was not preserved.'
    Assert ($listener.Server.IsBound) 'Existing listener was closed.'
  } finally { $listener.Stop() }
  'PASS: preserve an existing listener'

  $first = Start-Case 'mutex-owner' '0' -Hold 2500
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path $first.attempts) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
  Assert (Test-Path $first.attempts) 'First supervisor did not launch its child.'
  $second = Start-Case 'mutex-second' '0' -Port $first.port
  Assert ($second.process.WaitForExit(10000)) 'Duplicate supervisor did not exit.'
  Assert ($second.process.ExitCode -eq 0 -and -not (Test-Path $second.attempts)) 'Duplicate supervisor launched another child.'
  $null = Finish-Case $first 0 1
  'PASS: per-user/session/port singleton'

  $case = Start-Case 'backoff' '8,8,0' -Delay 1
  $events = Finish-Case $case 0 3
  Assert ((@($events | Where-Object event -eq 'restart_scheduled').delaySeconds -join ',') -eq '1,2') 'Exponential backoff changed.'
  $case = Start-Case 'window-expiry' '8,8,0' -Budget 1 -Hold 1100 -Window 1
  $null = Finish-Case $case 0 3
  'PASS: backoff and restart window expiry'
} finally {
  foreach ($process in $children) {
    if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
    $process.Dispose()
  }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  Assert ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and
          [IO.Path]::GetFileName($resolved).StartsWith('rdsh-supervisor-')) 'Unexpected temporary test root.'
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
