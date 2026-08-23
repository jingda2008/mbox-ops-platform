param(
  [string]$ServerUrl = 'https://mbox.shmbox.com',
  [Parameter(Mandatory=$true)][string]$NodeExecutable,
  [Parameter(Mandatory=$true)][string]$WinSwExecutable,
  [string]$NodeSha256 = '',
  [string]$WinSwSha256 = '',
  [string]$PairingCode = '',
  [string]$BridgeName = ''
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请以Windows管理员身份运行安装脚本'
}

function Assert-FileHash([string]$Path, [string]$Expected, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label 文件不存在：$Path" }
  if ($Expected) {
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.Trim().ToLowerInvariant()) { throw "$Label SHA256校验失败" }
  }
}

Assert-FileHash $NodeExecutable $NodeSha256 'Node.js'
Assert-FileHash $WinSwExecutable $WinSwSha256 'WinSW'
$uri = [Uri]$ServerUrl
if ($uri.Scheme -ne 'https' -and $uri.Host -notin @('localhost','127.0.0.1')) { throw '正式服务地址必须使用HTTPS' }

$installDir = Join-Path $env:ProgramFiles 'MBOX\PrintBridge'
$dataDir = Join-Path $env:ProgramData 'MBOX\PrintBridge'
New-Item -ItemType Directory -Force -Path $installDir, $dataDir | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'bridge.mjs') -Destination $installDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'print-ticket.ps1') -Destination $installDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'list-printers.ps1') -Destination $installDir -Force
Copy-Item -LiteralPath $WinSwExecutable -Destination (Join-Path $installDir 'MBoxPrintBridge.exe') -Force

$configPath = Join-Path $dataDir 'config.json'
$config = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$config | Add-Member -NotePropertyName serverUrl -NotePropertyValue $ServerUrl.TrimEnd('/') -Force
$config | Add-Member -NotePropertyName name -NotePropertyValue $(if ($BridgeName) { $BridgeName } else { "M-BOX打印桥-$env:COMPUTERNAME" }) -Force
$config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8

$escapedNode = [Security.SecurityElement]::Escape((Resolve-Path -LiteralPath $NodeExecutable).Path)
$xml = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'MBoxPrintBridge.xml.template') -Raw).Replace('{{NODE_EXE}}', $escapedNode)
$xml | Set-Content -LiteralPath (Join-Path $installDir 'MBoxPrintBridge.xml') -Encoding UTF8

& icacls.exe $dataDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
if ($PairingCode) {
  $env:MBOX_PRINT_BRIDGE_DATA = $dataDir
  & $NodeExecutable (Join-Path $installDir 'bridge.mjs') pair $PairingCode
  if ($LASTEXITCODE -ne 0) { throw '打印桥配对失败' }
}

$service = Join-Path $installDir 'MBoxPrintBridge.exe'
if (Get-Service -Name 'MBoxPrintBridge' -ErrorAction SilentlyContinue) {
  & $service stop | Out-Null
  & $service uninstall | Out-Null
}
& $service install
if ($LASTEXITCODE -ne 0) { throw 'Windows服务安装失败' }
& $service start
if ($LASTEXITCODE -ne 0) { throw 'Windows服务启动失败，请检查配对状态和日志' }
Write-Host 'M-BOX门店打印桥已安装并设置为开机自动启动。'
