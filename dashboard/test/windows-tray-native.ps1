param([string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
# Load the actual menu and callbacks. Only the message-loop entry is deferred.
$taskHelper = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../windows-tray.ps1')).Path
$taskSource = Get-Content -LiteralPath $taskHelper -Raw
# Keep the production asset path relative to the helper while deferring its loop.
$taskSource = $taskSource.Replace('$PSScriptRoot', ("'" + (Split-Path -Parent $taskHelper).Replace("'", "''") + "'"))
$taskOutput = New-Object System.IO.StringWriter
[Console]::SetOut($taskOutput)
Invoke-Expression $taskSource.Substring(0, $taskSource.LastIndexOf("try {"))
[void]$taskOutput.GetStringBuilder().Clear()
if ($EvidenceDirectory) {
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RdshTrayCapture {
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
}
'@
}
$taskForm = New-Object System.Windows.Forms.Form
$taskForm.Text = 'rdsh tray verification (dummy data)'
$taskForm.ClientSize = New-Object System.Drawing.Size(380, 140)
$taskForm.StartPosition = 'CenterScreen'
$taskForm.BackColor = [System.Drawing.Color]::White
$taskForm.TopMost = $true
function Save-TrayStep([string]$Name, $Control) {
    if (-not $EvidenceDirectory) { return }
    [System.Windows.Forms.Application]::DoEvents()
    [System.Threading.Thread]::Sleep(250)
    [System.Windows.Forms.Application]::DoEvents()
    $taskBitmap = New-Object System.Drawing.Bitmap($Control.Width, $Control.Height)
    $taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
    $taskDC = $taskGraphics.GetHdc()
    try {
        if (-not [RdshTrayCapture]::PrintWindow($Control.Handle, $taskDC, 2)) { throw 'Native window capture failed' }
        $taskGraphics.ReleaseHdc($taskDC)
        $taskDC = [IntPtr]::Zero
        $taskBitmap.Save((Join-Path $EvidenceDirectory $Name), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        if ($taskDC -ne [IntPtr]::Zero) { $taskGraphics.ReleaseHdc($taskDC) }
        $taskGraphics.Dispose(); $taskBitmap.Dispose()
    }
}
try {
    if ($EvidenceDirectory) { New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null }
    $taskForm.Show()
    $taskForm.Activate()
    $taskIcon.Visible = $true
    Save-TrayStep 'before.png' $taskForm
    $taskMenu.Show($taskForm, 24, 24)
    Save-TrayStep 'menu.png' $taskMenu
    if ($taskOpen.Text -ne 'Open / 開く' -or $taskExit.Text -ne 'Exit / 終了') { throw 'Menu labels differ' }
    $taskOpen.PerformClick()
    $taskMenu.Show($taskForm, 24, 24)
    $taskExit.PerformClick()
    if ($taskOutput.ToString().Replace("`r", '') -ne "open`nexit`n") { throw 'Menu callbacks did not emit exact IPC actions' }
    $taskMenu.Close()
    Save-TrayStep 'after.png' $taskForm
} finally {
    $taskIcon.Visible = $false
    $taskIcon.Dispose()
    $taskBrandIcon.Dispose()
    $taskMenu.Dispose()
    $taskTimer.Dispose()
    $taskContext.Dispose()
    $taskForm.Dispose()
    $taskOutput.Dispose()
}
