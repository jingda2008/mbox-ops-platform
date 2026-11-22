# Called only after the installer has verified the package and service registration.
Add-Type -Path (Join-Path $PSScriptRoot 'RecoveryActions.cs')

function Get-MboxServicePolicy {
  $service = Get-CimInstance Win32_Service -Filter "Name='MBoxPrintBridge'" -ErrorAction Stop
  if (-not $service -or $service.DesktopInteract -or $service.ServiceType -ne 'Own Process') {
    throw '无法确认打印桥使用独立后台服务。'
  }
  $startup = switch ($service.StartMode) {
    'Auto' { if ($service.DelayedAutoStart) { 'delayed-auto' } else { 'auto' } }
    'Manual' { 'demand' }
    'Disabled' { 'disabled' }
    default { throw '无法识别服务启动方式。' }
  }
  $controller = Get-Service MBoxPrintBridge -ErrorAction Stop
  try {
    $recovery = [MboxRecoveryActions]::Read($controller.ServiceHandle)
    return [ordered]@{
      Startup = $startup
      ResetSeconds = $recovery.ResetSeconds
      Actions = $recovery.Actions
      OnError = $recovery.OnError
    }
  } finally { $controller.Dispose() }
}

function Set-MboxServicePolicy($policy) {
  & "$env:SystemRoot\System32\sc.exe" config MBoxPrintBridge start= $policy.Startup | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Windows 拒绝修改打印桥启动方式。' }
  $controller = Get-Service MBoxPrintBridge -ErrorAction Stop
  try {
    [MboxRecoveryActions]::Write($controller.ServiceHandle, $policy.ResetSeconds, $policy.Actions, $policy.OnError)
  } finally { $controller.Dispose() }
}

function Test-MboxServicePolicy($expected) {
  $actual = Get-MboxServicePolicy
  return ($actual.Startup -eq $expected.Startup -and $actual.OnError -eq $expected.OnError -and
    ($actual.Actions -join ',') -eq ($expected.Actions -join ',') -and
    ($actual.Actions.Count -eq 0 -or $actual.ResetSeconds -eq $expected.ResetSeconds))
}

$targetPolicy = [ordered]@{
  Startup = 'auto'
  ResetSeconds = 3600
  # Each pair is the Windows SC_ACTION type (restart = 1) and its delay in ms.
  Actions = [uint32[]]@(1,10000,1,30000)
  OnError = $true
}
