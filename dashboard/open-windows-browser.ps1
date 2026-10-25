$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'windows-browser.ps1')
    # The dashboard's private URL travels over stdin, never the helper argv.
    $taskRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Open-RdshBrowser -Url ([uri]$taskRequest.url) -StateDirectory ([string]$taskRequest.stateDirectory)
} catch {
    # Native launch exceptions can include the private URL; do not echo them.
    [Console]::Error.WriteLine('RustDSH could not open the Windows default browser.')
    exit 1
}
