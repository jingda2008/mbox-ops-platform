function Get-MboxIncidentBackup {
  param([string]$InstallDirectory)
  # Exact directory independently shown by the user in Windows Explorer.
  $path = Join-Path $InstallDirectory 'backup-20260913-001241-bb38d4d9'
  if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw 'incident_backup_missing' }
  $source = Get-Item -LiteralPath $path -ErrorAction Stop
  if ($source.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'backup_link_not_allowed' }
  $hashes = @{}
  foreach ($name in @('bridge.mjs','print-ticket.ps1','list-printers.ps1')) {
    $filePath = Join-Path $source.FullName $name
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { throw 'backup_file_missing' }
    $file = Get-Item -LiteralPath $filePath -ErrorAction Stop
    if ($file.PSIsContainer -or $file.Length -eq 0 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'backup_file_invalid' }
    $hashes[$name] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  }
  return @{ Path=$source.FullName; Hashes=$hashes }
}
function Test-MboxRecoveryTarget {
  param([string]$InstallDirectory,[hashtable]$OriginalHashes,$IncidentHashes)
  $original = $true
  $incident = $true
  foreach ($name in @('bridge.mjs','print-ticket.ps1','list-printers.ps1')) {
    $file = Get-Item -LiteralPath (Join-Path $InstallDirectory $name) -ErrorAction Stop
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'installed_file_invalid' }
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    if ($hash -ne $OriginalHashes[$name]) { $original=$false }
    if ($hash -ne $IncidentHashes.psobject.Properties[$name].Value) { $incident=$false }
  }
  if ($original) { return $true }
  if (-not $incident) { throw 'installed_program_changed_do_not_overwrite' }
  return $false
}
