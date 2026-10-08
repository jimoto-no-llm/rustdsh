[CmdletBinding()]
param([string]$BinDirectory = (Join-Path $env:USERPROFILE '.local\bin'))
$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskCli = Join-Path $PSScriptRoot 'cli.mjs'
Push-Location $PSScriptRoot
try {
    & npm.cmd ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard dependency installation failed' }
    # Co-install the pinned native binary for an existing WSL distribution.
    # This does not create a distribution or run the DSH environment wrapper.
    $taskDistribution = if ($env:RDSH_WSL_DISTRO) { $env:RDSH_WSL_DISTRO } else { 'FlashNext' }
    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
        $taskMachine = & wsl.exe -d $taskDistribution --exec uname -m 2>$null
        $taskWslStatus = $LASTEXITCODE
        $taskArchitecture = @{ x86_64 = 'x64'; aarch64 = 'arm64' }[($taskMachine -join '').Trim()]
        if ($taskWslStatus -eq 0 -and $taskArchitecture) {
            & npm.cmd install --no-save --package-lock=false --ignore-scripts --force "@koromix/koffi-linux-$taskArchitecture@3.1.1"
            if ($LASTEXITCODE -ne 0) { throw 'WSL native dependency installation failed' }
        } else { Write-Verbose 'WSL native dependency not selected; see docs/SCOPED-STOP.md before Harness launch.' }
    }
} finally { Pop-Location }
New-Item -ItemType Directory -Force -Path $BinDirectory | Out-Null
$taskWrapper = "& '" + $taskNode.Replace("'", "''") + "' '" + $taskCli.Replace("'", "''") + "' @args`nexit `$LASTEXITCODE`n"
Set-Content -LiteralPath (Join-Path $BinDirectory 'rdsh-dashboard.ps1') -Value $taskWrapper -Encoding utf8NoBOM
Set-Content -LiteralPath (Join-Path $BinDirectory 'rdsh-dashboard.cmd') -Value '@echo off', 'pwsh.exe -NoLogo -NoProfile -File "%~dp0rdsh-dashboard.ps1" %*' -Encoding ascii
Write-Host "Installed rdsh-dashboard in $BinDirectory. Add that directory to PATH if needed."
