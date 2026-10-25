[CmdletBinding()]
param(
    [string]$Launcher = (Join-Path $PSScriptRoot 'rdsh-dashboard.ps1'),
    [string[]]$LauncherArguments = @('harness', '--open'),
    [string]$IconPath = (Join-Path $PSScriptRoot '../assets/icon.ico'),
    [string]$StartMenuDirectory = (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'),
    [string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop'),
    [switch]$DesktopShortcut
)
$ErrorActionPreference = 'Stop'
$taskLauncher = (Resolve-Path -LiteralPath $Launcher).Path
$taskIcon = (Resolve-Path -LiteralPath $IconPath).Path
$taskPwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
# Windows paths cannot contain quotes. Quote every argv element so spaces,
# apostrophes, ampersands and dollar signs remain data for -File, not code.
$taskArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $taskLauncher) + $LauncherArguments
if ($taskArguments | Where-Object { $_ -match '["\r\n\x00]' }) { throw 'Shortcut arguments must not contain quotes or control characters.' }
. (Join-Path $PSScriptRoot 'windows-shortcut.ps1')
$taskDestinations = @($StartMenuDirectory)
if ($DesktopShortcut) { $taskDestinations += $DesktopDirectory }
foreach ($taskDestination in $taskDestinations | Select-Object -Unique) {
    New-Item -ItemType Directory -Path $taskDestination -Force | Out-Null
    $taskLink = Join-Path $taskDestination 'RustDSH.lnk'
    [Rdsh.WindowsShortcut]::Save(
        $taskLink, $taskPwsh,
        (($taskArguments | ForEach-Object { '"' + $_ + '"' }) -join ' '),
        (Split-Path -Parent $taskLauncher), $taskIcon
    )
    Write-Output $taskLink
}
