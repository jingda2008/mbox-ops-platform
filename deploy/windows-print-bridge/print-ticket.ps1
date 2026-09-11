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
$fontSize = if ($Profile -eq 'escpos_58') { 9.0 } else { 11.0 }
$lineCount = [Math]::Max(8, ($content -split "`r?`n").Count)
$height = [Math]::Min(1200, [Math]::Max(360, 90 + ($lineCount * 24)))
$document.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('MBOX Ticket', $width, $height)
$document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(10, 10, 8, 8)
$font = New-Object System.Drawing.Font('Microsoft YaHei UI', $fontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
$brush = [System.Drawing.Brushes]::Black
$format = New-Object System.Drawing.StringFormat
$format.Trimming = [System.Drawing.StringTrimming]::None
$format.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
# Classify original logical lines so wrapped table and product names keep their emphasis.
$tableSize = if ($Profile -eq 'escpos_58') { 22.0 } else { 28.0 }
$itemSize = if ($Profile -eq 'escpos_58') { 12.0 } else { 15.0 }
$tableFont = New-Object System.Drawing.Font('Microsoft YaHei UI', $tableSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
$itemFont = New-Object System.Drawing.Font('Microsoft YaHei UI', $itemSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
$ticketLines = @($content -split "`r?`n")
$pageState = @{ Index = 0; Offset = 0 }
$handler = [System.Drawing.Printing.PrintPageEventHandler]{
  param($sender, $eventArgs)
  $bounds = $eventArgs.MarginBounds
  [single]$y = $bounds.Y
  while ($pageState.Index -lt $ticketLines.Count) {
    $original = $ticketLines[$pageState.Index]
    $lineFont = if ($original -match '^桌台：') { $tableFont } elseif ($original -match '×\d+\s*$|^(合计|净收|应收)：') { $itemFont } else { $font }
    $remaining = $original.Substring($pageState.Offset)
    if ($remaining.Length -eq 0) { $remaining = ' ' }
    [single]$available = $bounds.Bottom - $y
    [int]$characters = 0
    [int]$measuredLines = 0
    $size = $eventArgs.Graphics.MeasureString($remaining, $lineFont,
      [System.Drawing.SizeF]::new($bounds.Width, [Math]::Max(0, $available)), $format,
      [ref]$characters, [ref]$measuredLines)
    if ($characters -le 0) {
      if ($y -eq $bounds.Y) { throw 'invalid_print_page_bounds' }
      break
    }
    $fragment = $remaining.Substring(0, $characters)
    $eventArgs.Graphics.DrawString($fragment, $lineFont, $brush,
      [System.Drawing.RectangleF]::new($bounds.X, $y, $bounds.Width, $available), $format)
    $y += $size.Height + 2
    $pageState.Offset += $characters
    if ($pageState.Offset -ge $original.Length) { $pageState.Index++; $pageState.Offset = 0 }
    if ($y -ge $bounds.Bottom) { break }
  }
  $eventArgs.HasMorePages = $pageState.Index -lt $ticketLines.Count
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
  $tableFont.Dispose()
  $itemFont.Dispose()
  $document.Dispose()
}
