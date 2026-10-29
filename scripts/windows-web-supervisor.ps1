#requires -Version 7.0
param(
  [Parameter(Mandatory)][string]$ConfigPath,
  [ValidateRange(1,65535)][int]$Port = 3080,
  [string]$StateDirectory,
  [ValidateRange(0,100)][int]$MaxRestarts = 3,
  [ValidateRange(1,86400)][int]$WindowSeconds = 600,
  [ValidateRange(0,3600)][int]$DelaySeconds = 5,
  [ValidateRange(0,3600)][int]$MaxDelaySeconds = 60
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This supervisor requires Windows and PowerShell 7.' }

# Configuration is local operator input, never a shell command string.
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json -AsHashtable
if (-not [IO.Path]::IsPathFullyQualified([string]$config.executable) -or
    -not (Test-Path -LiteralPath $config.executable -PathType Leaf) -or
    -not [IO.Path]::IsPathFullyQualified([string]$config.workingDirectory) -or
    -not (Test-Path -LiteralPath $config.workingDirectory -PathType Container) -or
    ($config.ContainsKey('arguments') -and $config.arguments -isnot [array]) -or
    @($config.arguments | Where-Object { $_ -isnot [string] }).Count) {
  throw 'Use an absolute executable, an absolute workingDirectory and a string arguments array.'
}
if (-not $StateDirectory) {
  $StateDirectory = Join-Path $env:LOCALAPPDATA "rdsh/web-service/$Port"
}
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
$logPath = Join-Path $StateDirectory 'lifecycle.jsonl'
function Write-Lifecycle([string]$Event, [hashtable]$Fields = @{}) {
  $record = @{ at = [DateTimeOffset]::UtcNow.ToString('o'); event = $Event }
  foreach ($key in $Fields.Keys) { $record[$key] = $Fields[$key] }
  # Do not persist argv, environment, stdout, stderr, URLs or credentials.
  Add-Content -LiteralPath $logPath -Value ($record | ConvertTo-Json -Compress) -Encoding utf8
}
function Test-Listener {
  $socket = [Net.Sockets.TcpClient]::new()
  try {
    $pending = $socket.ConnectAsync('127.0.0.1', $Port)
    return $pending.Wait(500) -and $socket.Connected
  } catch { return $false }
  finally { $socket.Dispose() }
}

$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = [Threading.Mutex]::new($false, "Local\RDSH-WebSupervisor-$sid-$Port")
$ownsMutex = $false
$result = 0
try {
  try { $ownsMutex = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { exit 0 }
  $failures = [Collections.Generic.Queue[DateTimeOffset]]::new()
  while ($true) {
    if (Test-Listener) { Write-Lifecycle 'existing_listener'; break }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $config.executable
    $startInfo.WorkingDirectory = $config.workingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $config.arguments) { $startInfo.ArgumentList.Add($argument) }
    $child = $null
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
      $child = [Diagnostics.Process]::Start($startInfo)
      Write-Lifecycle 'process_started' @{ processId = $child.Id }
      $child.StandardInput.Close()
      # Drain both streams concurrently without buffering output in memory.
      $stdout = $child.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
      $stderr = $child.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
      $child.WaitForExit()
      # A descendant may retain an inherited pipe after the launcher exits.
      # Its output must not prevent recovery; disposal closes our pipe ends.
      $null = [Threading.Tasks.Task]::WaitAll(@($stdout, $stderr), 2000)
      $result = $child.ExitCode
      Write-Lifecycle 'process_exited' @{
        exitCode = $result
        exitHex = '0x{0:X8}' -f ([BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$result)))
        elapsedSeconds = [math]::Round($clock.Elapsed.TotalSeconds, 3)
      }
    } finally {
      if ($child) {
        if (-not $child.HasExited) { $child.Kill($true); $child.WaitForExit() }
        $child.Dispose()
      }
    }
    # A deliberate clean exit or Ctrl+C is never turned into a restart.
    if ($result -eq 0 -or $result -eq -1073741510) { break }
    $now = [DateTimeOffset]::UtcNow
    while ($failures.Count -and ($now - $failures.Peek()).TotalSeconds -ge $WindowSeconds) {
      $null = $failures.Dequeue()
    }
    if ($failures.Count -ge $MaxRestarts) {
      Write-Lifecycle 'restart_limit' @{ restarts = $failures.Count }
      break
    }
    $delay = [math]::Min($MaxDelaySeconds, $DelaySeconds * [math]::Pow(2, $failures.Count))
    $failures.Enqueue($now)
    Write-Lifecycle 'restart_scheduled' @{ delaySeconds = $delay; restart = $failures.Count }
    Start-Sleep -Milliseconds ([int]($delay * 1000))
  }
} catch {
  # Exception text can contain command arguments or credentials.
  Write-Lifecycle 'supervisor_failed'
  $result = 1
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
exit $result
