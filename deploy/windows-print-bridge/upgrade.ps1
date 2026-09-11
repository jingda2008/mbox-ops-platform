param([string]$InstallDirectory = (Join-Path $env:ProgramFiles 'MBOX\PrintBridge'))
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '请以管理员身份运行' }
$service = Get-Service -Name 'MBoxPrintBridge' -ErrorAction Stop
$files = @('bridge.mjs','print-ticket.ps1','list-printers.ps1')
foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $file) -PathType Leaf)) { throw "升级文件缺失：$file" }
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDirectory $file) -PathType Leaf)) { throw "原安装文件缺失：$file" }
}
if ((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'bridge.mjs') -Raw) -notmatch "const VERSION = '1\.0\.3'") { throw '升级包版本不匹配' }
$backup = Join-Path $InstallDirectory ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $InstallDirectory $file) -Destination $backup }
Stop-Service -Name 'MBoxPrintBridge' -ErrorAction Stop
$service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(60))
try {
  foreach ($file in $files) {
    $source = Join-Path $PSScriptRoot $file
    $target = Join-Path $InstallDirectory $file
    Copy-Item -LiteralPath $source -Destination $target -Force
    if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $target).Hash) { throw "文件校验失败：$file" }
  }
  Start-Service -Name 'MBoxPrintBridge'
  (Get-Service -Name 'MBoxPrintBridge').WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
} catch {
  Stop-Service -Name 'MBoxPrintBridge' -ErrorAction Stop
  (Get-Service -Name 'MBoxPrintBridge').WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(60))
  foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $backup $file) -Destination $InstallDirectory -Force }
  Start-Service -Name 'MBoxPrintBridge'
  throw
}
Write-Host '程序文件已更新到1.0.3，原配对、队列配置和防重复日志均保留。'
Write-Host '请等待后台出现1.0.3且心跳更新；服务启动不能代替后台版本核验或实体纸票验收。'
Write-Host "旧程序备份：$backup"
