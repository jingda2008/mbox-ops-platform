param([Parameter(Mandatory=$true)][string]$Package)
$ErrorActionPreference='Stop'
$probe=Join-Path $Package 'read-queue.ps1'
function Probe($name){return (& powershell.exe -NoProfile -File $probe -QueueName $name | ConvertFrom-Json)}
$queue='MBOX-CI-RAW'
$p=Get-CimInstance Win32_Printer -Filter "Name='$queue'"
if((Invoke-CimMethod -InputObject $p -MethodName Pause).ReturnValue -ne 0){throw 'pause fixture printer failed'}
try {
  $title='MBOX-job-a1111111-1111-4111-8111-111111111111'
  [MboxRawPrinter]::SendBytes($queue,$title,[Text.Encoding]::ASCII.GetBytes('fixture'))
  $expected=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($title))).Replace('-','').ToLowerInvariant()
  $r=Probe $queue
  if(-not $r.readable -or $r.count -lt 1 -or -not ($r.jobs.documentHash -contains $expected)){throw "Missing fixture job: $($r|ConvertTo-Json -Depth 5)"}
  if(-not $r.jobs[0].id){throw 'missing Windows job id'}
} finally {
  if((Invoke-CimMethod -InputObject $p -MethodName Resume).ReturnValue -ne 0){throw 'resume fixture printer failed'}
}
for($i=0;$i -lt 10;$i++){$r=Probe $queue;if($r.readable -and $r.count -eq 0){break};Start-Sleep -Seconds 1}
if(-not $r.readable -or $r.count -ne 0){throw 'fixture queue failed to drain'}
$r=Probe 'MBOX-CI-NOT-FOUND'
if($r.readable -or $null -ne $r.count){throw 'missing printer reported as empty'}
