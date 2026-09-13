# Fault-injectable transaction policy; operations preserve configuration and journal.
function Invoke-MboxUpgradeTransaction {
  param([Parameter(Mandatory=$true)][hashtable]$Operations)
  $stage = 'validate'
  $stopAttempted = $false
  $copyAttempted = $false
  try {
    $current = & $Operations.Validate
    if ($current) {
      $stage = 'verify-current'
      & $Operations.VerifyRunning
      return [pscustomobject]@{ State='already-current'; Stage=$stage; Recovery='not-needed' }
    }
    $stage = 'idle-before-stop'; & $Operations.ProbeIdle
    $stage = 'backup'; & $Operations.Backup
    $stage = 'stop'; $stopAttempted = $true; & $Operations.Stop
    $stage = 'idle-after-stop'; & $Operations.ProbeStoppedIdle
    $stage = 'copy'; $copyAttempted = $true; & $Operations.Copy
    $stage = 'verify-files'; & $Operations.VerifyFiles
    $stage = 'start'; & $Operations.Start
    $stage = 'verify-running'; & $Operations.VerifyRunning
    return [pscustomobject]@{ State='updated'; Stage=$stage; Recovery='not-needed' }
  } catch {
    $failureCode = $_.Exception.GetType().Name
    $recovery = 'not-needed'
    if ($stopAttempted) {
      try {
        if ($copyAttempted) {
          # No overwrite until stopping the service has been confirmed.
          & $Operations.Stop
          & $Operations.Restore
        }
        & $Operations.RestoreServiceState
        $recovery = 'original-restored'
      } catch { $recovery = 'manual-recovery-required' }
    }
    return [pscustomobject]@{ State='failed'; Stage=$stage; Recovery=$recovery; ErrorType=$failureCode }
  }
}
