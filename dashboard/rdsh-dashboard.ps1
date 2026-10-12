$ErrorActionPreference = 'Stop'
$taskStart = [System.Diagnostics.ProcessStartInfo]::new()
# Installed wrappers retain their captured Node path; direct launches use PATH.
$taskPinnedNode = Get-Variable -Name taskInstalledDashboardNode -ValueOnly -ErrorAction SilentlyContinue
$taskStart.FileName = if ($taskPinnedNode) { [string]$taskPinnedNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
$taskStart.UseShellExecute = $false
$taskStart.RedirectStandardOutput = $true
$taskStart.RedirectStandardError = $true
$taskStart.ArgumentList.Add((Join-Path $PSScriptRoot 'windows-launcher.mjs'))
foreach ($taskArgument in $args) { $taskStart.ArgumentList.Add([string]$taskArgument) }
$taskProcess = [System.Diagnostics.Process]::Start($taskStart)
try {
    $taskOutput = $taskProcess.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
    $taskError = $taskProcess.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
    $taskProcess.WaitForExit()
    $null = $taskOutput.GetAwaiter().GetResult()
    $null = $taskError.GetAwaiter().GetResult()
    exit $taskProcess.ExitCode
} finally { $taskProcess.Dispose() }
