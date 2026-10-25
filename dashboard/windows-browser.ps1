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

function New-RdshBrowserStartInfo {
    param(
        [Parameter(Mandatory)][uri]$Url,
        [Parameter(Mandatory)][string]$StateDirectory,
        [AllowNull()][string]$BrowserExecutable
    )
    if (-not $Url.IsAbsoluteUri -or $Url.Scheme -notin @('http', 'https')) {
        throw 'RustDSH requires an absolute HTTP or HTTPS browser URL.'
    }
    $taskStart = [Diagnostics.ProcessStartInfo]::new()
    # Only known Chromium executables receive app/profile switches. Firefox,
    # Store apps and unknown handlers retain Windows' normal URL activation.
    $taskName = [IO.Path]::GetFileName($BrowserExecutable)
    if ($BrowserExecutable -and [IO.Path]::IsPathFullyQualified($BrowserExecutable) -and
        (Test-Path -LiteralPath $BrowserExecutable -PathType Leaf) -and
        $taskName -in @('chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'chromium.exe')) {
        $taskIdentity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
            [Text.Encoding]::UTF8.GetBytes($BrowserExecutable.ToLowerInvariant())
        )).Substring(0, 16).ToLowerInvariant()
        $taskProfile = Join-Path ([IO.Path]::GetFullPath($StateDirectory)) ('browser-profiles\' + $taskIdentity)
        $taskStart.FileName = $BrowserExecutable
        $taskStart.UseShellExecute = $false
        $taskStart.CreateNoWindow = $true
        foreach ($taskArgument in @(
            ('--app=' + $Url.AbsoluteUri), ('--user-data-dir=' + $taskProfile),
            '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000'
        )) { $taskStart.ArgumentList.Add($taskArgument) }
    } else {
        $taskStart.FileName = $Url.AbsoluteUri
        $taskStart.UseShellExecute = $true
    }
    return $taskStart
}

function Open-RdshBrowser {
    param([Parameter(Mandatory)][uri]$Url, [Parameter(Mandatory)][string]$StateDirectory)
    $taskBrowser = $null
    try { $taskBrowser = Get-RdshDefaultBrowser $Url.Scheme } catch {
        # An unavailable association query must not force Edge or block a
        # registered URL handler that ShellExecute can still activate.
    }
    $taskStart = New-RdshBrowserStartInfo -Url $Url -StateDirectory $StateDirectory -BrowserExecutable $taskBrowser
    $taskBrowserProcess = [Diagnostics.Process]::Start($taskStart)
    if ($taskBrowserProcess) { $taskBrowserProcess.Dispose() }
}
