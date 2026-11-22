# Sourced exclusively by the isolated Windows native service harness.
function Invoke-FixtureSc([string[]]$arguments) {
  $output = & sc.exe @arguments
  Assert ($LASTEXITCODE -eq 0) ('sc.exe failed: '+$arguments[0])
  return ($output -join [Environment]::NewLine)
}
function Read-FixturePolicy {
  $startup = Invoke-FixtureSc @('qc','MBoxPrintBridge')
  $actions = Invoke-FixtureSc @('qfailure','MBoxPrintBridge')
  $flag = Invoke-FixtureSc @('qfailureflag','MBoxPrintBridge')
  return "$startup`n$actions`n$flag"
}
function Set-FixtureOriginalPolicy {
  if($ServiceUpgradeFrom -eq '1.0.14'){
    $null = Invoke-FixtureSc @('config','MBoxPrintBridge','start=','delayed-auto')
  }
  $null = Invoke-FixtureSc @('failure','MBoxPrintBridge','reset=','55','actions=','restart/42000')
  $null = Invoke-FixtureSc @('failureflag','MBoxPrintBridge','0')
}
function Test-FixtureRecovery {
  $registered = Get-CimInstance Win32_Service -Filter "Name='MBoxPrintBridge'"
  Assert ($registered.StartMode -eq 'Auto' -and -not $registered.DelayedAutoStart) 'service not automatic'
  Assert ($registered.StartName -eq 'LocalSystem' -and -not $registered.DesktopInteract) 'unattended service identity changed'
  $actions = Invoke-FixtureSc @('qfailure','MBoxPrintBridge')
  Assert ($actions -match '3600' -and $actions -match 'RESTART[^\r\n]*10000' -and $actions -match 'RESTART[^\r\n]*30000') 'SCM restart action readback failed'
  Assert ((Invoke-FixtureSc @('qfailureflag','MBoxPrintBridge')) -match 'TRUE') 'non-crash failure flag absent'
  Assert ((Get-Process -Id $registered.ProcessId).SessionId -eq 0) 'service not in session zero'
  Record 'automatic service in noninteractive Session 0, first/next restart delays and failure flag verified via sc.exe'

  $child = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($registered.ProcessId) AND Name='node.exe'")
  Assert ($child.Count -eq 1) 'isolated service child not found'
  $faultTime = [DateTimeOffset]::UtcNow
  Stop-Process -Id $child[0].ProcessId -Force
  $recovered = $false
  for ($attempt=0; $attempt -lt 90; $attempt++) {
    Start-Sleep -Seconds 1
    $now = Get-CimInstance Win32_Service -Filter "Name='MBoxPrintBridge'"
    if($now.State -eq 'Running' -and $now.ProcessId -ne $registered.ProcessId){
      try {
        $runtime = Get-Content -LiteralPath (Join-Path $data 'runtime-status.json') -Raw | ConvertFrom-Json
        $recovered = ($runtime.version -eq $version -and [DateTimeOffset]::Parse($runtime.lastHeartbeatAt) -gt $faultTime)
      } catch { }
      if($recovered){break}
    }
  }
  Assert $recovered 'SCM did not recover a crashed bridge worker and produce a fresh heartbeat'
  Record 'forced bridge worker termination recovered automatically with a new service PID and fresh backend heartbeat'

  Set-FixtureOriginalPolicy
  Assert ((Run-Upgrade) -eq 0) 'repeat upgrade did not repair policy drift'
  Assert ((Invoke-FixtureSc @('qfailure','MBoxPrintBridge')) -ceq $actions) 'repaired action list differs'
  $repaired = Get-CimInstance Win32_Service -Filter "Name='MBoxPrintBridge'"
  Assert ($repaired.StartMode -eq 'Auto' -and -not $repaired.DelayedAutoStart) 'repaired startup type differs'
  Record 'same-version installer repairs recovery and startup settings'
}
