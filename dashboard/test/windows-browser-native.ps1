$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../windows-browser.ps1')
function Assert-Rdsh($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('rdsh browser 日本語 & ' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $taskRoot | Out-Null
try {
    $taskUrl = [uri]'http://127.0.0.1:38081/?value=%27%20%26%20%24%60#key=fixture-only'
    foreach ($taskBrowserName in @('chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'chromium.exe')) {
        $taskExecutable = Join-Path $taskRoot $taskBrowserName
        New-Item -ItemType File -Path $taskExecutable | Out-Null
        $taskStart = New-RdshBrowserStartInfo -Url $taskUrl -StateDirectory $taskRoot -BrowserExecutable $taskExecutable
        Assert-Rdsh ($taskStart.FileName -eq $taskExecutable -and -not $taskStart.UseShellExecute) 'Selected default browser was not used'
        Assert-Rdsh ($taskStart.ArgumentList[0] -eq ('--app=' + $taskUrl.AbsoluteUri)) 'URL did not remain a single literal argument'
        Assert-Rdsh (@($taskStart.ArgumentList | Where-Object { $_ -match '^--(?:user-data-dir|incognito|guest|profile-directory)' }).Count -eq 0) 'Default launch replaced the existing browser context'
        $taskPinned = New-RdshBrowserStartInfo -Url $taskUrl -StateDirectory $taskRoot -BrowserExecutable $taskExecutable -ProfileDirectory 'Profile 4 & 日本語'
        Assert-Rdsh ($taskPinned.ArgumentList.Contains('--profile-directory=Profile 4 & 日本語')) 'Explicit profile was not preserved as one argument'
    }
    Assert-Rdsh (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'browser-profiles'))) 'App created isolated browser state'
    foreach ($taskProduct in @(
        @{Exe='chrome.exe'; Root='Google\Chrome'}, @{Exe='msedge.exe'; Root='Microsoft\Edge'},
        @{Exe='brave.exe'; Root='BraveSoftware\Brave-Browser'}, @{Exe='vivaldi.exe'; Root='Vivaldi'},
        @{Exe='chromium.exe'; Root='Chromium'},
        @{Exe='C:\Program Files\Google\Chrome Beta\Application\chrome.exe'; Root='Google\Chrome Beta'},
        @{Exe='C:\Program Files\Microsoft\Edge Dev\Application\msedge.exe'; Root='Microsoft\Edge Dev'}
    )) {
        $taskDataRoot = Join-Path $taskRoot ($taskProduct.Root + '\User Data')
        New-Item -ItemType Directory -Path (Join-Path $taskDataRoot 'Profile 4 & 日本語') -Force | Out-Null
        $taskLocalState = Join-Path $taskDataRoot 'Local State'
        Set-Content -LiteralPath $taskLocalState -Value '{"profile":{"last_used":"Profile 4 & 日本語"}}' -Encoding utf8NoBOM
        $taskChosen = Get-RdshBrowserProfileDirectory -BrowserExecutable $taskProduct.Exe -LocalAppDataDirectory $taskRoot
        Assert-Rdsh ($taskChosen -eq 'Profile 4 & 日本語') 'Last-used signed-in profile was not selected'
        New-Item -ItemType Directory -Path (Join-Path $taskDataRoot 'Profile 1') -Force | Out-Null
        Set-Content -LiteralPath $taskLocalState -Value '{"profile":{"last_used":"Profile 1"}}'
        Assert-Rdsh ((Get-RdshBrowserProfileDirectory $taskProduct.Exe $taskRoot) -eq 'Profile 1') 'Profile selection was cached across launches'
        foreach ($taskMetadata in @('not json', '{"profile":{"last_used":"missing"}}', '{"profile":{"last_used":"../outside"}}', '{}')) {
            Set-Content -LiteralPath $taskLocalState -Value $taskMetadata
            Assert-Rdsh ($null -eq (Get-RdshBrowserProfileDirectory $taskProduct.Exe $taskRoot)) 'Invalid metadata forced a new or external profile'
        }
    }
    Assert-Rdsh ($null -eq (Get-RdshBrowserProfileDirectory 'firefox.exe' $taskRoot)) 'Unknown browser used Chromium metadata'
    foreach ($taskInvalidProfile in @('.', '..', '../outside', 'C:\other', '--profile=foo/bar', 'Profile 4" --guest', "Profile`n4")) {
        $taskRejected = $false
        try { $null = New-RdshBrowserStartInfo -Url $taskUrl -StateDirectory $taskRoot -ProfileDirectory $taskInvalidProfile } catch { $taskRejected = $true }
        Assert-Rdsh $taskRejected 'Profile path was not limited to one folder name'
    }
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
    . (Join-Path $PSScriptRoot '../windows-shortcut.ps1')
    $taskExpectedIcon = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../assets/icon.ico')).Path
    foreach ($taskLink in $taskLinks) {
        $taskShortcut = [Rdsh.WindowsShortcut]::Read($taskLink)
        Assert-Rdsh ($taskShortcut.IconLocation -eq ($taskExpectedIcon + ',0')) 'Shortcut still uses a browser icon'
        Assert-Rdsh ($taskShortcut.Arguments.EndsWith('"' + $taskLauncher + '"')) 'Launcher path was not preserved'
        Assert-Rdsh ($taskShortcut.TargetPath -eq (Get-Command pwsh.exe).Source) 'Shortcut did not pin PowerShell'
        Assert-Rdsh ($taskShortcut.WorkingDirectory -eq $taskRoot) 'Shortcut working directory is incorrect'
    }
    # Re-running the installer refreshes an existing browser-branded shortcut.
    [Rdsh.WindowsShortcut]::Save($taskLink, $taskShortcut.TargetPath, $taskShortcut.Arguments, $taskRoot, (Get-Command pwsh.exe).Source)
    $null = & (Join-Path $PSScriptRoot '../install-windows-shortcut.ps1') -Launcher $taskLauncher -LauncherArguments @() -StartMenuDirectory $taskMenu -DesktopDirectory $taskDesktop -DesktopShortcut
    Assert-Rdsh ([Rdsh.WindowsShortcut]::Read($taskLink).IconLocation -eq ($taskExpectedIcon + ',0')) 'Shortcut icon repair was not applied'
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
