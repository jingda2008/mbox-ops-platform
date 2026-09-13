$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'restore-policy.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('mbox-recovery-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
$names=@('bridge.mjs','print-ticket.ps1','list-printers.ps1')
function Expect-Rejection([scriptblock]$Call,[string]$Expected) {
  try { & $Call | Out-Null } catch { if ($_.Exception.Message -eq $Expected) { return }; throw }
  throw "Expected rejection: $Expected"
}
try {
  Expect-Rejection { Get-MboxIncidentBackup $root } 'incident_backup_missing'
  $source=Join-Path $root 'backup-20260913-001241-bb38d4d9'
  New-Item -ItemType Directory $source | Out-Null
  foreach($name in $names) { [IO.File]::WriteAllText((Join-Path $source $name),"original $name 中文") }
  $found=Get-MboxIncidentBackup $root
  if($found.Path -ne $source) {throw 'Wrong source'}
  $wrong=Join-Path $root 'backup-20260913-090000-12345678'
  New-Item -ItemType Directory $wrong | Out-Null
  if((Get-MboxIncidentBackup $root).Path -ne $source) {throw 'Selected newer unrelated backup'}
  $second=Join-Path $root 'backup-20260913-001341-12345678'
  New-Item -ItemType Directory $second | Out-Null
  if((Get-MboxIncidentBackup $root).Path -ne $source) {throw 'Selected mismatched photograph backup'}
  Remove-Item -LiteralPath $second
  $incident=[pscustomobject]@{}
  foreach($name in $names) { [IO.File]::WriteAllText((Join-Path $root $name),"r2 $name"); $incident|Add-Member -NotePropertyName $name -NotePropertyValue (Get-FileHash (Join-Path $root $name)).Hash }
  if(Test-MboxRecoveryTarget $root $found.Hashes $incident) {throw 'r2 incorrectly called original'}
  foreach($name in $names){ Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $root $name) -Force }
  if(-not(Test-MboxRecoveryTarget $root $found.Hashes $incident)){throw 'Repeat restore not idempotent'}
  [IO.File]::WriteAllText((Join-Path $root 'bridge.mjs'),'modified later')
  Expect-Rejection { Test-MboxRecoveryTarget $root $found.Hashes $incident } 'installed_program_changed_do_not_overwrite'
  [IO.File]::WriteAllText((Join-Path $source 'print-ticket.ps1'),'')
  Expect-Rejection { Get-MboxIncidentBackup $root } 'backup_file_invalid'
  [IO.File]::WriteAllText((Join-Path $source 'print-ticket.ps1'),'original print')
  Remove-Item -LiteralPath (Join-Path $source 'list-printers.ps1')
  Expect-Rejection { Get-MboxIncidentBackup $root } 'backup_file_missing'
  Write-Output 'PASS 9 backup-selection and target-integrity scenarios'
  foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') {
    $tokens=$null; $errors=$null
    [System.Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)|Out-Null
    if($errors.Count){throw "Syntax error: $($file.Name)"}
  }
  Write-Output 'PASS recovery PowerShell syntax'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
