param([Parameter(Mandatory=$true)][string]$Package)
$ErrorActionPreference='Stop'
function Assert($ok,$message){if(-not $ok){throw $message}}
function Get-Printer($Name){if($Name -ne 'batai'){throw 'unknown queue'};[pscustomobject]@{Name='batai';PrinterStatus='PaperOut';DriverName='fixtureDriver';PortName='fixturePort'}}
function Get-PrintJob($PrinterObject) {
  if($global:bridgeFixtureBroken){throw 'spooler unavailable'}
  foreach($job in $global:bridgeFixtureQueueJobs){$job}
}
function Read-Observation($queue='batai') {
  # Capture Console output as emitted by the packaged script. Mocks supply only Windows cmdlet inputs.
  $capture=New-Object IO.StringWriter
  $original=[Console]::Out
  try {[Console]::SetOut($capture); & (Join-Path $Package 'read-queue.ps1') -QueueName $queue}
  finally {[Console]::SetOut($original)}
  return ($capture.ToString() | ConvertFrom-Json)
}
function Job($id,$name){[pscustomobject]@{Id=$id;DocumentName=$name;JobStatus='Paused';SubmittedTime=[DateTime]::Now}}
$global:bridgeFixtureQueueJobs=@((Job 41 'MBOX-job-example#1'),(Job 42 'private document'))
$r=Read-Observation
Assert ($r.readable -and $r.count -eq 2 -and $r.jobs.Count -eq 1 -and $r.jobs[0].id -eq 41) 'matching/foreign jobs'
Assert ($r.jobs[0].status -eq 'Paused' -and $r.printerStatus -eq 'PaperOut') 'device and job state'
$expected=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes('MBOX-job-example#1'))).Replace('-','').ToLowerInvariant()
Assert ($r.jobs[0].documentHash -eq $expected -and ($r|ConvertTo-Json -Depth 6) -notmatch 'private document') 'document mapping'
$global:bridgeFixtureQueueJobs=@()
$r=Read-Observation
Assert ($r.readable -and $r.count -eq 0 -and @($r.jobs).Count -eq 0) 'empty snapshot'
$global:bridgeFixtureQueueJobs=@((Job 9 ''))
Assert ((Read-Observation).truncated) 'redacted name marked inconclusive'
$global:bridgeFixtureQueueJobs=@(foreach($i in 1..130){Job $i "MBOX-job-$i"})
$r=Read-Observation
Assert ($r.readable -and $r.truncated -and $r.jobs.Count -eq 128 -and $r.count -eq 130) 'bounded queue'
$global:bridgeFixtureBroken=$true
$r=Read-Observation
Assert (-not $r.readable -and $null -eq $r.count) 'failed read must not become an empty queue'
$r=Read-Observation 'missing'
Assert (-not $r.readable) 'missing queue'
Write-Host 'PASS observer: paused job, printer state, hash, privacy, empty, unknown name, truncation, failed read and missing queue'
