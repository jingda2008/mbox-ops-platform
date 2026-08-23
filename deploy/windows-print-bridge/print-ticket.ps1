param(
  [Parameter(Mandatory=$true)][string]$QueueName,
  [Parameter(Mandatory=$true)][string]$ContentPath,
  [Parameter(Mandatory=$true)][string]$DocumentName,
  [Parameter(Mandatory=$true)][ValidateSet('escpos_58','escpos_80','windows_text')][string]$Profile,
  [Parameter(Mandatory=$true)][ValidateRange(1,5)][int]$Copies
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$printer = Get-Printer -Name $QueueName -ErrorAction Stop
if ($printer.PrinterStatus -match 'Error|Offline|PaperProblem|NoToner') {
  throw "printer_unavailable:$($printer.PrinterStatus)"
}
$content = [System.IO.File]::ReadAllText($ContentPath, [System.Text.Encoding]::UTF8)
$document = New-Object System.Drawing.Printing.PrintDocument
$document.DocumentName = $DocumentName
$document.PrinterSettings.PrinterName = $QueueName
$document.PrinterSettings.Copies = [int16]$Copies
if (-not $document.PrinterSettings.IsValid) { throw 'invalid_printer_queue' }

$width = if ($Profile -eq 'escpos_58') { 228 } else { 315 }
$fontSize = if ($Profile -eq 'escpos_58') { 8.5 } else { 10.0 }
$lineCount = [Math]::Max(8, ($content -split "`r?`n").Count)
$height = [Math]::Min(1200, [Math]::Max(360, 90 + ($lineCount * 24)))
$document.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('MBOX Ticket', $width, $height)
$document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(10, 10, 8, 8)
$font = New-Object System.Drawing.Font('Microsoft YaHei UI', $fontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
$brush = [System.Drawing.Brushes]::Black
$format = New-Object System.Drawing.StringFormat
$format.Trimming = [System.Drawing.StringTrimming]::Word

$handler = [System.Drawing.Printing.PrintPageEventHandler]{
  param($sender, $eventArgs)
  $bounds = $eventArgs.MarginBounds
  $eventArgs.Graphics.DrawString($content, $font, $brush, [System.Drawing.RectangleF]::new($bounds.X, $bounds.Y, $bounds.Width, $bounds.Height), $format)
  $eventArgs.HasMorePages = $false
}
$document.add_PrintPage($handler)
try {
  $document.Print()
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $job = Get-PrintJob -PrinterName $QueueName -ErrorAction SilentlyContinue |
      Where-Object { $_.DocumentName -eq $DocumentName } |
      Select-Object -First 1
    if ($null -eq $job) { break }
    if ([string]$job.JobStatus -match 'Error|Offline|PaperOut|Blocked|UserIntervention') {
      throw "print_job_failed:$($job.JobStatus)"
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($null -ne $job) { throw 'print_job_timeout' }
} finally {
  $document.remove_PrintPage($handler)
  $format.Dispose()
  $font.Dispose()
  $document.Dispose()
}
