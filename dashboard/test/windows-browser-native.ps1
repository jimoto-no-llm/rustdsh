$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../windows-browser.ps1')
function Assert-Rdsh($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('rdsh browser 日本語 & ' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $taskRoot | Out-Null
try {
    $taskUrl = [uri]'http://127.0.0.1:38081/?value=%27%20%26%20%24%60#key=fixture-only'
    $taskProfiles = @{}
    foreach ($taskBrowserName in @('chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'chromium.exe')) {
        $taskExecutable = Join-Path $taskRoot $taskBrowserName
        New-Item -ItemType File -Path $taskExecutable | Out-Null
        $taskStart = New-RdshBrowserStartInfo -Url $taskUrl -StateDirectory $taskRoot -BrowserExecutable $taskExecutable
        Assert-Rdsh ($taskStart.FileName -eq $taskExecutable -and -not $taskStart.UseShellExecute) 'Selected default browser was not used'
        Assert-Rdsh ($taskStart.ArgumentList[0] -eq ('--app=' + $taskUrl.AbsoluteUri)) 'URL did not remain a single literal argument'
        $taskProfileArgument = $taskStart.ArgumentList[1]
        Assert-Rdsh ($taskProfileArgument.StartsWith('--user-data-dir=' + $taskRoot)) 'Browser profile escaped the app state'
        Assert-Rdsh ($taskStart.ArgumentList.Contains('--no-first-run')) 'App first-run suppression missing'
        $taskProfiles[$taskBrowserName] = $taskProfileArgument
        $taskAgain = New-RdshBrowserStartInfo -Url $taskUrl -StateDirectory $taskRoot -BrowserExecutable $taskExecutable
        Assert-Rdsh ($taskAgain.ArgumentList[1] -eq $taskProfileArgument) 'Same browser did not reuse its profile'
    }
    Assert-Rdsh (@($taskProfiles.Values | Select-Object -Unique).Count -eq 5) 'Different browser executables share a profile'
    $taskOtherChrome = Join-Path $taskRoot 'other\chrome.exe'
    New-Item -ItemType Directory -Path (Split-Path $taskOtherChrome) | Out-Null
    New-Item -ItemType File -Path $taskOtherChrome | Out-Null
    $taskOther = New-RdshBrowserStartInfo -Url $taskUrl -StateDirectory $taskRoot -BrowserExecutable $taskOtherChrome
    Assert-Rdsh ($taskOther.ArgumentList[1] -ne $taskProfiles['chrome.exe']) 'Different installations share a profile'
    $taskFirefox = Join-Path $taskRoot 'firefox.exe'
    New-Item -ItemType File -Path $taskFirefox | Out-Null
    foreach ($taskExecutable in @($null, '', 'chrome.exe', $taskFirefox, (Join-Path $taskRoot 'missing\msedge.exe'))) {
        $taskStart = New-RdshBrowserStartInfo -Url $taskUrl -StateDirectory $taskRoot -BrowserExecutable $taskExecutable
        Assert-Rdsh ($taskStart.UseShellExecute -and $taskStart.FileName -eq $taskUrl.AbsoluteUri) 'Fallback did not use Windows URL activation'
        Assert-Rdsh ($taskStart.ArgumentList.Count -eq 0) 'Unsupported handler received Chromium switches'
    }
    foreach ($taskInvalid in @('file:///C:/test.html', 'javascript:alert(1)', '/relative')) {
        $taskRejected = $false
        try { $null = New-RdshBrowserStartInfo -Url $taskInvalid -StateDirectory $taskRoot } catch { $taskRejected = $true }
        Assert-Rdsh $taskRejected 'Non-HTTP URL was accepted'
    }
    # Exercise the real association API without changing the user's defaults
    # or launching any browser. CI hosts may have no UserChoice at all.
    foreach ($taskProtocol in @('http', 'https')) {
        $taskDefault = Get-RdshDefaultBrowser $taskProtocol
        Assert-Rdsh (-not $taskDefault -or [IO.Path]::IsPathFullyQualified($taskDefault)) 'Association query returned a command template'
    }

    $taskLauncher = Join-Path $taskRoot "launch ' & `$ 日本語.ps1"
    Set-Content -LiteralPath $taskLauncher -Value '# fixture only'
    $taskMenu = Join-Path $taskRoot 'Start menu'
    $taskDesktop = Join-Path $taskRoot 'Desktop'
    $taskLinks = & (Join-Path $PSScriptRoot '../install-windows-shortcut.ps1') -Launcher $taskLauncher -LauncherArguments @() -StartMenuDirectory $taskMenu -DesktopDirectory $taskDesktop -DesktopShortcut
    Assert-Rdsh ($taskLinks.Count -eq 2) 'Shortcut installer did not create both links'
    $taskShell = New-Object -ComObject WScript.Shell
    $taskExpectedIcon = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../assets/icon.ico')).Path
    foreach ($taskLink in $taskLinks) {
        $taskShortcut = $taskShell.CreateShortcut($taskLink)
        Assert-Rdsh ($taskShortcut.IconLocation -eq ($taskExpectedIcon + ',0')) 'Shortcut still uses a browser icon'
        Assert-Rdsh ($taskShortcut.Arguments.EndsWith('"' + $taskLauncher + '"')) 'Launcher path was not preserved'
        Assert-Rdsh ($taskShortcut.TargetPath -eq (Get-Command pwsh.exe).Source) 'Shortcut did not pin PowerShell'
        Assert-Rdsh ($taskShortcut.WorkingDirectory -eq $taskRoot) 'Shortcut working directory is incorrect'
    }
    # Re-running the installer refreshes an existing browser-branded shortcut.
    $taskShortcut.IconLocation = (Get-Command pwsh.exe).Source + ',0'
    $taskShortcut.Save()
    $null = & (Join-Path $PSScriptRoot '../install-windows-shortcut.ps1') -Launcher $taskLauncher -LauncherArguments @() -StartMenuDirectory $taskMenu -DesktopDirectory $taskDesktop -DesktopShortcut
    Assert-Rdsh ($taskShell.CreateShortcut($taskLink).IconLocation -eq ($taskExpectedIcon + ',0')) 'Shortcut icon repair was not applied'
    Write-Output 'Windows default-browser routing and RDSH shortcuts verified'
} finally {
    # Only this test's newly-created absolute temporary directory is removed.
    $taskResolved = [IO.Path]::GetFullPath($taskRoot)
    $taskTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($taskResolved.StartsWith($taskTempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($taskResolved).StartsWith('rdsh browser ')) {
        Remove-Item -LiteralPath $taskResolved -Recurse -Force
    }
}
