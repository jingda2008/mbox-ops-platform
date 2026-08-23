param([switch]$PurgeCredentials)
$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:ProgramFiles 'MBOX\PrintBridge'
$service = Join-Path $installDir 'MBoxPrintBridge.exe'
if (Test-Path -LiteralPath $service) {
  & $service stop | Out-Null
  & $service uninstall | Out-Null
}
if ($PurgeCredentials) {
  $dataDir = Join-Path $env:ProgramData 'MBOX\PrintBridge'
  if (Test-Path -LiteralPath $dataDir) { Remove-Item -LiteralPath $dataDir -Recurse -Force }
}
Write-Host '打印桥服务已卸载。未指定PurgeCredentials时，配对凭据和防重复日志仍保留。'
