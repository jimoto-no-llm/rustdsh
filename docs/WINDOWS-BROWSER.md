# Windows app browser and icon

Windows Dashboard `--open`, `rdsh-dashboard open` and the notification area's
Open action read the current Windows default for the URL's HTTP or HTTPS
protocol on every launch. They never require Edge or change the system default.

Chrome, Edge, Brave, Vivaldi and Chromium open an app window using their normal
browser profiles. The launcher does not pass `--user-data-dir` or create an
isolated RDSH browser profile, so existing Google and other website sign-ins
remain available when opening links from the app. The browser manages those
sessions; RDSH does not copy cookies or credentials.

For standard installations, the launcher reads `profile.last_used` from the
browser's `Local State` and selects that existing profile. Missing, unreadable or
unsupported profile metadata leaves selection to the browser itself. To keep
using a specific profile, set the `RDSH_BROWSER_PROFILE_DIRECTORY` environment
variable for the launcher to its folder name, such as `Default` or `Profile 4`.
This is the profile directory shown in `chrome://version`, not a Google email
address. With several Google accounts signed into that profile, Google still
controls which account a particular site uses and may show its account chooser.

Old RDSH-only `browser-profiles/` directories are left in place but no longer
used. Already-open app windows keep their old profile until closed; relaunch
RustDSH to use the normal browser profile. Other browsers, missing executables
and Store handlers use Windows' normal URL
activation. Those browsers control whether the page opens in a tab or a window.
The page's favicon supplies its in-browser icon; taskbar branding is controlled
by the selected browser and is not changed by the launcher.
Without PowerShell 7, CLI opens retain Windows' built-in URL activation.

`pwsh -File dashboard/install-windows.ps1` creates a Start menu shortcut named
RustDSH with the bundled `assets/icon.ico`. Add `-DesktopShortcut` to create the
same shortcut on the desktop. Both start `harness --open` with PowerShell hidden.

To repair shortcuts for an existing standalone app launcher:

```powershell
& .\dashboard\install-windows-shortcut.ps1 `
  -Launcher 'C:\Apps\RustDSH\Launch-RustDSH.ps1' `
  -LauncherArguments @() -DesktopShortcut
```

In that launcher's PowerShell code, replace any hard-coded `msedge.exe` or
`chrome.exe` invocation with the shared helper (substitute the installed source
directory and your existing URL/state variables):

```powershell
. (Join-Path $taskSource 'dashboard\windows-browser.ps1')
Open-RdshBrowser -Url $taskBuilder.Uri -StateDirectory (Join-Path $taskAppRoot 'state')
```

The helper resolves an executable through Windows' association API rather than
executing the registry's command template. The Dashboard passes its private URL
to the PowerShell helper over stdin and does not print browser launch exceptions.
