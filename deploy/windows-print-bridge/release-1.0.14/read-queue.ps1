param([Parameter(Mandatory=$true)][string]$QueueName)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$report = [ordered]@{
  queue = $QueueName
  checkedAt = [DateTime]::UtcNow.ToString('o')
  readable = $false
  printerStatus = $null
  driver = $null
  port = $null
  count = $null
  truncated = $false
  jobs = @()
  error = $null
}
try {
  $printer = Get-Printer -Name ([WildcardPattern]::Escape($QueueName)) -ErrorAction Stop
  if (@($printer).Count -ne 1 -or $printer.Name -ne $QueueName) { throw 'queue_missing' }
  $report.printerStatus = [string]$printer.PrinterStatus
  $report.driver = [string]$printer.DriverName
  $report.port = [string]$printer.PortName
  $jobs = @(Get-PrintJob -PrinterObject $printer -ErrorAction Stop)
  $report.count = $jobs.Count
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($job in $jobs) {
      # Some drivers hide the name. Such jobs make a negative match inconclusive.
      $name = [string]$job.DocumentName
      if ([string]::IsNullOrWhiteSpace($name)) { $report.truncated = $true; continue }
      if (-not $name.StartsWith('MBOX-', [StringComparison]::Ordinal)) { continue }
      if ($report.jobs.Count -ge 128) { $report.truncated = $true; break }
      $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($name))).Replace('-','').ToLowerInvariant()
      $submitted = $null
      if ($job.SubmittedTime -is [DateTime]) { $submitted = $job.SubmittedTime.ToUniversalTime().ToString('o') }
      $report.jobs += [ordered]@{documentHash=$digest; id=[int]$job.Id; status=[string]$job.JobStatus; submittedAt=$submitted}
    }
  } finally { $sha.Dispose() }
  $report.readable = $true
} catch {
  $report.error = if ($_.Exception.Message -eq 'queue_missing') {'queue_missing'} else {'queue_read_failed'}
}
$report.checkedAt = [DateTime]::UtcNow.ToString('o')
[Console]::WriteLine(($report | ConvertTo-Json -Depth 5 -Compress))
