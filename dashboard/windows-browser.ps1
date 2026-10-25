# Shared by the dashboard and standalone Windows app launchers (PowerShell 7).
function Get-RdshDefaultBrowser([string]$Scheme) {
    if (-not ('Rdsh.BrowserAssociation' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace Rdsh {
    public static class BrowserAssociation {
        [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
        private static extern int AssocQueryStringW(uint flags, uint str,
            string association, string extra, StringBuilder output, ref uint length);
        public static string Executable(string association) {
            uint length = 0;
            AssocQueryStringW(0, 2, association, "open", null, ref length);
            if (length == 0 || length > 32768) return null;
            var output = new StringBuilder((int)length);
            return AssocQueryStringW(0, 2, association, "open", output, ref length) == 0
                ? output.ToString() : null;
        }
    }
}
'@
    }
    # Read UserChoice each time: changing Windows' default needs no reinstall.
    # Ask Windows for the executable; never evaluate a registry command string.
    $taskChoice = Get-ItemProperty -LiteralPath (
        'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\' + $Scheme + '\UserChoice'
    ) -Name ProgId -ErrorAction SilentlyContinue
    if (-not $taskChoice.ProgId) { return $null }
    return [Rdsh.BrowserAssociation]::Executable([string]$taskChoice.ProgId)
}

function Test-RdshBrowserProfileDirectory([string]$Directory) {
    return $Directory -and $Directory -notin @('.', '..') -and
        $Directory -notmatch '[\\/:*?"<>|\x00-\x1f]' -and $Directory -notmatch '[. ]$'
}

function Get-RdshBrowserProfileDirectory {
    param([string]$BrowserExecutable, [string]$LocalAppDataDirectory = $env:LOCALAPPDATA)
    if (-not $BrowserExecutable -or -not $LocalAppDataDirectory) { return $null }
    $taskName = [IO.Path]::GetFileName($BrowserExecutable).ToLowerInvariant()
    $taskProduct = switch ($taskName) {
        'chrome.exe' {
            if ($BrowserExecutable -match '[\\/]Google[\\/](Chrome(?: Beta| Dev| SxS| for Testing)?)[\\/]Application[\\/]chrome\.exe$') {
                'Google\' + $Matches[1]
            } else { 'Google\Chrome' }
        }
        'msedge.exe' {
            if ($BrowserExecutable -match '[\\/]Microsoft[\\/](Edge(?: Beta| Dev| SxS)?)[\\/]Application[\\/]msedge\.exe$') {
                'Microsoft\' + $Matches[1]
            } else { 'Microsoft\Edge' }
        }
        'brave.exe' { 'BraveSoftware\Brave-Browser' }
        'vivaldi.exe' { 'Vivaldi' }
        'chromium.exe' { 'Chromium' }
        default { return $null }
    }
    $taskUserData = Join-Path $LocalAppDataDirectory ($taskProduct + '\User Data')
    try {
        # Only profile selection metadata is used. Cookies and credentials stay
        # in the browser's own existing profile; none are copied into app state.
        $taskLocalState = Get-Content -LiteralPath (Join-Path $taskUserData 'Local State') -Raw | ConvertFrom-Json
        $taskProfile = [string]$taskLocalState.profile.last_used
        if ((Test-RdshBrowserProfileDirectory $taskProfile) -and
            (Test-Path -LiteralPath (Join-Path $taskUserData $taskProfile) -PathType Container)) {
            return $taskProfile
        }
    } catch {
        # Custom installations and unreadable metadata use the browser's own
        # normal profile selection, never a newly-created RDSH profile.
    }
    return $null
}

function New-RdshBrowserStartInfo {
    param(
        [Parameter(Mandatory)][uri]$Url,
        # Retained for existing launchers; browser data stays in its normal home.
        [Parameter(Mandatory)][string]$StateDirectory,
        [AllowNull()][string]$BrowserExecutable,
        [AllowNull()][string]$ProfileDirectory
    )
    if (-not $Url.IsAbsoluteUri -or $Url.Scheme -notin @('http', 'https')) {
        throw 'RustDSH requires an absolute HTTP or HTTPS browser URL.'
    }
    if ($ProfileDirectory -and -not (Test-RdshBrowserProfileDirectory $ProfileDirectory)) {
        throw 'RDSH_BROWSER_PROFILE_DIRECTORY must name one browser profile folder, such as Default or Profile 1.'
    }
    $taskStart = [Diagnostics.ProcessStartInfo]::new()
    # Only known Chromium executables receive app/profile switches. Firefox,
    # Store apps and unknown handlers retain Windows' normal URL activation.
    $taskName = [IO.Path]::GetFileName($BrowserExecutable)
    if ($BrowserExecutable -and [IO.Path]::IsPathFullyQualified($BrowserExecutable) -and
        (Test-Path -LiteralPath $BrowserExecutable -PathType Leaf) -and
        $taskName -in @('chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'chromium.exe')) {
        $taskStart.FileName = $BrowserExecutable
        $taskStart.UseShellExecute = $false
        $taskStart.CreateNoWindow = $true
        foreach ($taskArgument in @(
            ('--app=' + $Url.AbsoluteUri), '--window-size=1440,1000'
        )) { $taskStart.ArgumentList.Add($taskArgument) }
        if ($ProfileDirectory) { $taskStart.ArgumentList.Add('--profile-directory=' + $ProfileDirectory) }
    } else {
        $taskStart.FileName = $Url.AbsoluteUri
        $taskStart.UseShellExecute = $true
    }
    return $taskStart
}

function Open-RdshBrowser {
    param(
        [Parameter(Mandatory)][uri]$Url,
        [Parameter(Mandatory)][string]$StateDirectory,
        [string]$ProfileDirectory = $env:RDSH_BROWSER_PROFILE_DIRECTORY
    )
    $taskBrowser = $null
    try { $taskBrowser = Get-RdshDefaultBrowser $Url.Scheme } catch {
        # An unavailable association query must not force Edge or block a
        # registered URL handler that ShellExecute can still activate.
    }
    if (-not $ProfileDirectory -and $taskBrowser) {
        $ProfileDirectory = Get-RdshBrowserProfileDirectory -BrowserExecutable $taskBrowser
    }
    $taskStart = New-RdshBrowserStartInfo -Url $Url -StateDirectory $StateDirectory -BrowserExecutable $taskBrowser -ProfileDirectory $ProfileDirectory
    $taskBrowserProcess = [Diagnostics.Process]::Start($taskStart)
    if ($taskBrowserProcess) { $taskBrowserProcess.Dispose() }
}
