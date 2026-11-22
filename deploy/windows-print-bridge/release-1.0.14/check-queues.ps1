$ErrorActionPreference='Stop'
$rows = foreach ($q in @('batai','chufang')) {
  $raw = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'read-queue.ps1') -QueueName $q
  if ($LASTEXITCODE -ne 0) { throw "Cannot read queue $q" }
  $raw | ConvertFrom-Json
}
$file=Join-Path $PSScriptRoot ('MBOX-Queues-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.json')
ConvertTo-Json -InputObject @($rows) -Depth 6 | Set-Content -LiteralPath $file -Encoding UTF8
Write-Host "Queue report: $file"
