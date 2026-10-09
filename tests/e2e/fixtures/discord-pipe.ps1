param([string]$PipeName)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Read-Exact($Stream, [int]$Length) {
  $bytes = [byte[]]::new($Length)
  $offset = 0
  while ($offset -lt $Length) {
    $count = $Stream.Read($bytes, $offset, $Length - $offset)
    if ($count -eq 0) { throw 'end of pipe' }
    $offset += $count
  }
  return ,$bytes
}
$pipe = [IO.Pipes.NamedPipeServerStream]::new($PipeName, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous)
try {
  [Console]::Out.WriteLine('READY')
  $pipe.WaitForConnection()
  while ($pipe.IsConnected) {
    $header = Read-Exact $pipe 8
    $op = [BitConverter]::ToUInt32($header, 0)
    $size = [BitConverter]::ToUInt32($header, 4)
    $body = Read-Exact $pipe $size
    $request = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
    if ($op -eq 0) { $response = @{ cmd = 'DISPATCH'; evt = 'READY'; data = @{ v = 1 } } }
    else {
      [Console]::Out.WriteLine(($request | ConvertTo-Json -Compress -Depth 10))
      $response = @{ cmd = $request.cmd; nonce = $request.nonce; data = $request.args }
    }
    $payload = [Text.Encoding]::UTF8.GetBytes(($response | ConvertTo-Json -Compress -Depth 10))
    $packet = [BitConverter]::GetBytes([uint32]1) + [BitConverter]::GetBytes([uint32]$payload.Length) + $payload
    $pipe.Write($packet, 0, $packet.Length); $pipe.Flush()
  }
} catch { } finally { $pipe.Dispose() }
