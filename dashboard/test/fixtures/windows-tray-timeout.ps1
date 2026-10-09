$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('phase:powershell-start:' + $PSVersionTable.PSVersion.ToString())
[Console]::Out.Flush()
[Console]::Error.Write('DUMMY_TRAY_STDERR_SECRET')
[Console]::Error.Flush()
[System.Threading.Thread]::Sleep(60000)
