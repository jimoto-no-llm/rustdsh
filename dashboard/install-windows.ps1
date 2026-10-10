[CmdletBinding()]
param([string]$BinDirectory = (Join-Path $env:USERPROFILE '.local\bin'))
$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskPwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$taskLauncher = Join-Path $PSScriptRoot 'rdsh-dashboard.ps1'
$taskNpm = Join-Path (Split-Path (Get-Command npm.cmd -ErrorAction Stop).Source) 'node_modules/npm/bin/npm-cli.js'
if (-not (Test-Path -LiteralPath $taskNpm -PathType Leaf)) { throw 'Cannot locate npm CLI beside npm.cmd' }
function Invoke-DashboardInstallerProcess([string]$Executable, [string[]]$Arguments, [switch]$Capture) {
    $taskStart = [System.Diagnostics.ProcessStartInfo]::new()
    $taskStart.FileName = $Executable
    $taskStart.WorkingDirectory = $PSScriptRoot
    $taskStart.UseShellExecute = $false
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    foreach ($taskArgument in $Arguments) { $taskStart.ArgumentList.Add($taskArgument) }
    $taskProcess = [System.Diagnostics.Process]::Start($taskStart)
    try {
        $taskOutput = if ($Capture) { $taskProcess.StandardOutput.ReadToEndAsync() } else { $taskProcess.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput()) }
        $taskErrorStream = if ($Capture) { [System.IO.Stream]::Null } else { [Console]::OpenStandardError() }
        $taskError = $taskProcess.StandardError.BaseStream.CopyToAsync($taskErrorStream)
        $taskProcess.WaitForExit()
        $taskText = $taskOutput.GetAwaiter().GetResult()
        $taskError.GetAwaiter().GetResult()
        return [pscustomobject]@{ ExitCode = $taskProcess.ExitCode; Output = $taskText }
    } finally { $taskProcess.Dispose() }
}
Push-Location $PSScriptRoot
try {
    # Install the pinned native prebuilts without running package lifecycle shells.
    $taskInstall = Invoke-DashboardInstallerProcess $taskNode @($taskNpm, 'ci', '--omit=dev', '--ignore-scripts')
    if ($taskInstall.ExitCode -ne 0) { throw 'Dashboard dependency installation failed' }
    $taskNative = Invoke-DashboardInstallerProcess $taskNode @('--input-type=module', '--eval', "import koffi from 'koffi'; if (!koffi.version) throw new Error('Native Koffi unavailable'); console.log(koffi.version);") -Capture
    if ($taskNative.ExitCode -ne 0) { throw 'Windows native prebuilt unavailable; installation did not complete' }
    $taskKoffiVersion = $taskNative.Output.Trim()
    if ($taskKoffiVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Native Koffi version could not be verified' }
    # Co-install the pinned native binary for an existing WSL distribution.
    # This does not create a distribution or run the DSH environment wrapper.
    $taskDistribution = if ($env:RDSH_WSL_DISTRO) { $env:RDSH_WSL_DISTRO } else { 'FlashNext' }
    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
        $taskWsl = Invoke-DashboardInstallerProcess (Get-Command wsl.exe).Source @('-d', $taskDistribution, '--exec', 'uname', '-m') -Capture
        $taskMachine = $taskWsl.Output
        $taskWslStatus = $taskWsl.ExitCode
        $taskArchitecture = @{ x86_64 = 'x64'; aarch64 = 'arm64' }[($taskMachine -join '').Trim()]
        if ($taskWslStatus -eq 0 -and $taskArchitecture) {
            $taskInstall = Invoke-DashboardInstallerProcess $taskNode @($taskNpm, 'install', '--no-save', '--package-lock=false', '--ignore-scripts', '--force', "@koromix/koffi-linux-$taskArchitecture@$taskKoffiVersion")
            if ($taskInstall.ExitCode -ne 0) { throw 'WSL native dependency installation failed' }
        } else { Write-Verbose 'WSL native dependency not selected; see docs/SCOPED-STOP.md before Harness launch.' }
    }
} finally { Pop-Location }
New-Item -ItemType Directory -Force -Path $BinDirectory | Out-Null
$taskWrapper = "`$taskInstalledDashboardNode = '" + $taskNode.Replace("'", "''") + "'`n& '" + $taskLauncher.Replace("'", "''") + "' @args`nexit `$LASTEXITCODE`n"
Set-Content -LiteralPath (Join-Path $BinDirectory 'rdsh-dashboard.ps1') -Value $taskWrapper -Encoding utf8NoBOM
# cmd.exe resolves a bare command name in the working directory first; pin the captured path.
$taskCmdPwsh = '"' + $taskPwsh.Replace('%', '%%') + '"'
Set-Content -LiteralPath (Join-Path $BinDirectory 'rdsh-dashboard.cmd') -Value '@echo off', "$taskCmdPwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"%~dp0rdsh-dashboard.ps1`" %*" -Encoding oem
Write-Host "Installed rdsh-dashboard in $BinDirectory. Add that directory to PATH if needed."
