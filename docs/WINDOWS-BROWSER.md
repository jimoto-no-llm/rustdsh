# Windows app browser and icon

Windows Dashboard `--open`, `rdsh-dashboard open` and the notification area's
Open action read the current Windows default for the URL's HTTP or HTTPS
protocol on every launch. They never require Edge or change the system default.

Chrome, Edge, Brave, Vivaldi and Chromium open an app window. Each executable
gets its own profile under the Dashboard state directory's `browser-profiles/`;
existing Edge profiles and normal browser profiles are left intact. Other
browsers, missing executables and Store handlers use Windows' normal URL
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
