$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System.Threading.Tasks;
public static class RdshTrayInput {
    public static Task<string> ReadLine() {
        return Task.Run(() => System.Console.In.ReadLine());
    }
}
'@
[void][System.Windows.Forms.Application]::SetHighDpiMode([System.Windows.Forms.HighDpiMode]::PerMonitorV2)
[System.Windows.Forms.Application]::EnableVisualStyles()
$taskMenu = New-Object System.Windows.Forms.ContextMenuStrip
$taskOpen = $taskMenu.Items.Add('Open / 開く')
$taskExit = $taskMenu.Items.Add('Exit / 終了')
$taskIcon = New-Object System.Windows.Forms.NotifyIcon
$taskBrandIcon = [System.Drawing.Icon]::new((Join-Path $PSScriptRoot '../assets/icon.ico'))
$taskIcon.Icon = $taskBrandIcon
$taskIcon.Text = if ($env:RDSH_TRAY_LABEL) { $env:RDSH_TRAY_LABEL } else { 'rdsh-dashboard' }
$taskIcon.ContextMenuStrip = $taskMenu
$taskOpen.add_Click({ [Console]::Out.WriteLine('open'); [Console]::Out.Flush() })
$taskExit.add_Click({ [Console]::Out.WriteLine('exit'); [Console]::Out.Flush() })
$taskIcon.add_DoubleClick({ [Console]::Out.WriteLine('open'); [Console]::Out.Flush() })
$taskContext = New-Object System.Windows.Forms.ApplicationContext
$taskTimer = New-Object System.Windows.Forms.Timer
$taskTimer.Interval = 100
$script:taskRead = [RdshTrayInput]::ReadLine()
$taskTimer.add_Tick({
    if (-not $script:taskRead.IsCompleted) { return }
    $taskLine = $script:taskRead.GetAwaiter().GetResult()
    if ($null -eq $taskLine) { $taskContext.ExitThread(); return }
    $taskMessage = $taskLine | ConvertFrom-Json
    if ($taskMessage.error) {
        $taskIcon.ShowBalloonTip(5000, 'rdsh-dashboard', [string]$taskMessage.error, [System.Windows.Forms.ToolTipIcon]::Warning)
    }
    $script:taskRead = [RdshTrayInput]::ReadLine()
})
try {
    $taskIcon.Visible = $true
    $taskTimer.Start()
    [Console]::Out.WriteLine('ready')
    [Console]::Out.Flush()
    [System.Windows.Forms.Application]::Run($taskContext)
} finally {
    $taskTimer.Stop()
    $taskIcon.Visible = $false
    $taskIcon.Dispose()
    $taskBrandIcon.Dispose()
    $taskMenu.Dispose()
    $taskTimer.Dispose()
    $taskContext.Dispose()
}
