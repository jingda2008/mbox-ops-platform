$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'upgrade-core.ps1')
$count = 0
function Run-Scenario {
  param([string]$Name, [string[]]$Failures=@(), [bool]$Current=$false,
    [string]$ExpectedState='failed', [string]$ExpectedRecovery='not-needed', [string]$ExpectedStage='validate')
  $state = @{ Calls=[System.Collections.Generic.List[string]]::new(); Failed=@{}; Counts=@{} }
  $ops = @{}
  foreach ($op in @('Validate','ProbeIdle','Backup','Stop','ProbeStoppedIdle','Copy','VerifyFiles','Start','VerifyRunning','Restore','RestoreServiceState')) {
    $ops[$op] = {
      $state.Calls.Add($op)
      $state.Counts[$op] = 1 + [int]$state.Counts[$op]
      # Fault only once; recovery operations must also run and be observable.
      if ($Failures -contains $op -and -not $state.Failed[$op]) { $state.Failed[$op]=$true; throw 'injected' }
      if ($Failures -contains ($op + ':' + $state.Counts[$op])) { throw 'injected occurrence' }
      if ($op -eq 'Validate') { return $Current }
    }.GetNewClosure()
  }
  $result = Invoke-MboxUpgradeTransaction -Operations $ops
  if ($result.State -ne $ExpectedState -or $result.Recovery -ne $ExpectedRecovery -or $result.Stage -ne $ExpectedStage) { throw "$Name unexpected result: $($result | ConvertTo-Json -Compress)" }
  if ($ExpectedRecovery -eq 'not-needed' -and $ExpectedState -eq 'failed' -and $state.Calls.Contains('Copy')) { throw "$Name changed payload before safe preflight" }
  if ($ExpectedRecovery -eq 'original-restored' -and -not $state.Calls.Contains('RestoreServiceState')) { throw "$Name did not restore service" }
  if ($state.Calls.Contains('Restore')) {
    $index = $state.Calls.IndexOf('Restore')
    if ($state.Calls[$index-1] -ne 'Stop') { throw "$Name restored while service might be running" }
  }
  if ($Current -and $state.Calls.Contains('Stop')) { throw "$Name interrupted current service" }
  Write-Output "PASS $Name"
}
Run-Scenario 'clean upgrade' -ExpectedState updated -ExpectedStage verify-running; $count++
Run-Scenario 'already installed' -Current $true -ExpectedState already-current -ExpectedStage verify-current; $count++
Run-Scenario 'already current but unhealthy' -Current $true -Failures VerifyRunning -ExpectedStage verify-current; $count++
Run-Scenario 'invalid package' -Failures Validate; $count++
Run-Scenario 'busy or unreadable queue' -Failures ProbeIdle -ExpectedStage idle-before-stop; $count++
Run-Scenario 'backup failure' -Failures Backup -ExpectedStage backup; $count++
Run-Scenario 'stop failure recovers original service' -Failures Stop -ExpectedStage stop -ExpectedRecovery original-restored; $count++
Run-Scenario 'in-flight detected after stop' -Failures ProbeStoppedIdle -ExpectedStage idle-after-stop -ExpectedRecovery original-restored; $count++
Run-Scenario 'partial copy rollback' -Failures Copy -ExpectedStage copy -ExpectedRecovery original-restored; $count++
Run-Scenario 'hash mismatch rollback' -Failures VerifyFiles -ExpectedStage verify-files -ExpectedRecovery original-restored; $count++
Run-Scenario 'startup failure rollback' -Failures Start -ExpectedStage start -ExpectedRecovery original-restored; $count++
Run-Scenario 'service falls over after startup' -Failures VerifyRunning -ExpectedStage verify-running -ExpectedRecovery original-restored; $count++
Run-Scenario 'rollback copy fails explicitly' -Failures @('Copy','Restore') -ExpectedStage copy -ExpectedRecovery manual-recovery-required; $count++
Run-Scenario 'rollback cannot stop new service' -Failures @('Start','Stop:2') -ExpectedStage start -ExpectedRecovery manual-recovery-required; $count++
Run-Scenario 'stop fails and cannot restart old service' -Failures @('Stop','RestoreServiceState') -ExpectedStage stop -ExpectedRecovery manual-recovery-required; $count++
# Parse every package PS1 using the actual PowerShell parser (no native actions).
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') {
  $tokens = $null; $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$parseErrors) | Out-Null
  if ($parseErrors.Count -gt 0) { throw "Syntax error in $($file.Name): $($parseErrors | Out-String)" }
}
Write-Output "PASS $count transaction scenarios and all PowerShell syntax checks (native Windows not tested)"
