param([string]$Binary = './target/debug/rdsh.exe')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskActual = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $Binary).Path)
$taskExpected = [System.Drawing.Icon]::new((Resolve-Path -LiteralPath './assets/icon.ico').Path, $taskActual.Size)
$taskActualBitmap = $taskActual.ToBitmap()
$taskExpectedBitmap = $taskExpected.ToBitmap()
try {
    $taskOpaque = 0
    for ($taskY = 0; $taskY -lt $taskExpectedBitmap.Height; $taskY++) {
        for ($taskX = 0; $taskX -lt $taskExpectedBitmap.Width; $taskX++) {
            $taskColor = $taskExpectedBitmap.GetPixel($taskX, $taskY)
            if ($taskColor.A -ne 255) { continue }
            $taskOpaque++
            if ($taskActualBitmap.GetPixel($taskX, $taskY).ToArgb() -ne $taskColor.ToArgb()) {
                throw 'The Windows executable does not contain the common rdsh icon'
            }
        }
    }
    if ($taskOpaque -lt 64) { throw 'The embedded icon contains too few opaque pixels to verify' }
    Write-Host "Verified executable icon: $taskOpaque opaque pixels match the common artwork"
} finally {
    $taskActualBitmap.Dispose()
    $taskExpectedBitmap.Dispose()
    $taskActual.Dispose()
    $taskExpected.Dispose()
}
