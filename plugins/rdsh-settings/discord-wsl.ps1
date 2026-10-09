# Binary stdio <-> Windows Discord named-pipe bridge for WSL.
$ErrorActionPreference = 'Stop'
$pipe = $null
[Console]::Error.WriteLine("RDSH_DISCORD_PID=$PID")
try {
  foreach ($index in 0..9) {
    $candidate = [System.IO.Pipes.NamedPipeClientStream]::new('.', "discord-ipc-$index", [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    try { $candidate.Connect(100); $pipe = $candidate; break } catch { $candidate.Dispose() }
  }
  if ($null -eq $pipe) { exit 1 }
  $inputStream = [Console]::OpenStandardInput()
  $outputStream = [Console]::OpenStandardOutput()
  $inputBuffer = [byte[]]::new(65544)
  $pipeBuffer = [byte[]]::new(65544)
  $pending = [byte[]]@()
  $inputRead = $inputStream.ReadAsync($inputBuffer, 0, $inputBuffer.Length)
  $pipeRead = $pipe.ReadAsync($pipeBuffer, 0, $pipeBuffer.Length)
  while ($pipe.IsConnected) {
    $completed = [System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($inputRead, $pipeRead))
    if ($completed -eq 0) {
      $count = $inputRead.GetAwaiter().GetResult()
      if ($count -eq 0) { break }
      # stdin may split/coalesce frames; each Windows pipe write must be a full frame.
      $pending = [byte[]]($pending + $inputBuffer[0..($count - 1)])
      while ($pending.Length -ge 8) {
        $payloadLength = [BitConverter]::ToUInt32($pending, 4)
        if ($payloadLength -gt 65536) { throw 'oversized IPC frame' }
        $packetLength = [int]$payloadLength + 8
        if ($pending.Length -lt $packetLength) { break }
        $packet = [byte[]]$pending[0..($packetLength - 1)]
        $pipe.Write($packet, 0, $packet.Length)
        $pipe.Flush()
        if ($pending.Length -eq $packetLength) { $pending = [byte[]]@() }
        else { $pending = [byte[]]$pending[$packetLength..($pending.Length - 1)] }
      }
      $inputRead = $inputStream.ReadAsync($inputBuffer, 0, $inputBuffer.Length)
    } else {
      $count = $pipeRead.GetAwaiter().GetResult()
      if ($count -eq 0) { break }
      $outputStream.Write($pipeBuffer, 0, $count)
      $outputStream.Flush()
      $pipeRead = $pipe.ReadAsync($pipeBuffer, 0, $pipeBuffer.Length)
    }
  }
} catch { exit 1 } finally { if ($null -ne $pipe) { $pipe.Dispose() } }
