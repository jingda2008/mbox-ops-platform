$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
  $manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $expected=@('diagnose.ps1','inspect-program.ps1','MBOX-Check-Printing.cmd','使用说明.txt')
  if($manifest.kind -ne 'read-only-print-diagnostics' -or @($manifest.files.psobject.Properties).Count -ne $expected.Count){throw 'invalid_manifest'}
  foreach($name in $expected){if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name)).Hash -ne $manifest.files.psobject.Properties[$name].Value){throw 'package_hash_mismatch'}}
  . (Join-Path $PSScriptRoot 'inspect-program.ps1')
  $out=Join-Path $PSScriptRoot ('MBOX-Check-Result-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6))
  New-Item -ItemType Directory -Path $out | Out-Null
  $report=[ordered]@{Time=(Get-Date).ToString('o'); PowerShell=$PSVersionTable.PSVersion.ToString(); Culture=(Get-Culture).Name; ANSICodePage=(Get-Culture).TextInfo.ANSICodePage; ConsoleCodePage=[Console]::OutputEncoding.CodePage; Service=$null; Programs=@(); Printers=@(); FontPreview='unavailable'; Errors=@(); Scope='Read only; no service/configuration/queue changes or printing; no credentials/receipt/journal content.'}
  try {
    $reg=Get-CimInstance Win32_Service -Filter "Name='MBoxPrintBridge'" -ErrorAction Stop
    if($null -eq $reg){throw 'service_missing'}
    $bin=[Environment]::ExpandEnvironmentVariables([string]$reg.PathName)
    if($bin -match '^"([^"]+\.exe)"(?:\s|$)'){$exe=$Matches[1]}elseif($bin -match '^(.+?\.exe)(?:\s|$)'){$exe=$Matches[1]}else{throw 'service_path_unreadable'}
    $dir=Split-Path $exe -Parent
    $report.Service=[pscustomobject]@{State=$reg.State; StartMode=$reg.StartMode; LocalSystem=($reg.StartName -eq 'LocalSystem'); InstallDirectory=$dir}
    $locations=@([pscustomobject]@{Label='installed'; Path=$dir})
    $backups=@(Get-ChildItem -LiteralPath $dir -Directory -ErrorAction Stop | Where-Object { $_.Name -match '^backup-[0-9]{8}-[0-9]{6}(?:-[a-fA-F0-9]{8})?$' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
    $report.BackupCount=$backups.Count
    $report.BackupNames=@($backups | ForEach-Object {$_.Name})
    try {
      $saved=Get-Content -LiteralPath (Join-Path $dir 'upgrade-last-result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      $savedPath=[string]$saved.Backup
      $savedExists=$false
      if($savedPath -and (Split-Path $savedPath -Parent) -eq $dir){$savedExists=Test-Path -LiteralPath $savedPath -PathType Container}
      $report.UpgradeRecord=[pscustomobject]@{Package=$saved.Package; ResultState=$saved.Result.State; RecordedBackup=$savedPath; BackupExists=$savedExists}
    }catch{$report.Errors += 'Upgrade result query: ' + $_.Exception.GetType().Name}
    $backups=@($backups | Sort-Object Name -Descending | Select-Object -First 20)
    foreach($b in $backups){$locations += [pscustomobject]@{Label=$b.Name; Path=$b.FullName}}
    foreach($loc in $locations){foreach($name in @('bridge.mjs','print-ticket.ps1','list-printers.ps1')){$report.Programs += [pscustomobject]@{Location=$loc.Label; Summary=(Get-MboxProgramSummary (Join-Path $loc.Path $name))}}}
  }catch{$report.Errors += 'Service/program inspection unavailable: ' + $_.Exception.GetType().Name}
  foreach($queue in @('batai','chufang')) {
    $item=[ordered]@{Queue=$queue; Printer=$null; Configuration=$null; Driver=$null; Features=@(); Errors=@()}
    try {$p=Get-Printer -Name $queue -ErrorAction Stop; $item.Printer=$p | Select-Object Name,DriverName,PrintProcessor,Datatype,PrinterStatus; $d=Get-PrinterDriver -Name $p.DriverName -ErrorAction Stop; $item.Driver=$d | Select-Object Name,MajorVersion,DriverVersion,Manufacturer}
    catch{$item.Errors += 'Printer/driver query: ' + $_.Exception.GetType().Name}
    try {$cfg=Get-PrintConfiguration -PrinterName $queue -ErrorAction Stop; $item.Configuration=$cfg | Select-Object PaperSize,Color,DuplexingMode; if($cfg.PrintTicketXML){[xml]$xml=$cfg.PrintTicketXML; foreach($feature in $xml.SelectNodes("//*[local-name()='Feature']")){$options=@($feature.SelectNodes("./*[local-name()='Option']") | ForEach-Object { $_.GetAttribute('name') }); $item.Features += [pscustomobject]@{Name=$feature.GetAttribute('name'); Options=$options}}}}
    catch{$item.Errors += 'Print settings query: ' + $_.Exception.GetType().Name}
    $report.Printers += [pscustomobject]$item
  }
  # Render synthetic text to a local image, never to a PrintDocument or a queue.
  $bitmap=$null; $graphics=$null; $font=$null
  try {
    Add-Type -AssemblyName System.Drawing
    $report.FontNames=@([Drawing.FontFamily]::Families | Where-Object {$_.Name -match 'YaHei|SimSun|SimHei|Noto|Arial'} | ForEach-Object {$_.Name})
    $bitmap=New-Object Drawing.Bitmap(760,220)
    $graphics=[Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([Drawing.Color]::White)
    $font=New-Object Drawing.Font('Microsoft YaHei UI',18)
    $report.RequestedFont='Microsoft YaHei UI'; $report.ResolvedFont=$font.Name
    $graphics.DrawString("M-BOX 中文显示检查（此图不会打印）`n桌号 B05  数量 2  单价 8.00  小计 16.00`n吧台 后厨 矿泉水 台式香肠 退款 切纸",$font,[Drawing.Brushes]::Black,[single]12,[single]12)
    $bitmap.Save((Join-Path $out 'Chinese-Font-Preview.png'),[Drawing.Imaging.ImageFormat]::Png)
    $report.FontPreview='generated-in-interactive-user-context-not-service-or-printer-proof'
  }catch{$report.Errors += 'Font preview: ' + $_.Exception.GetType().Name}
  finally{if($font){$font.Dispose()};if($graphics){$graphics.Dispose()};if($bitmap){$bitmap.Dispose()}}
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $out 'MBOX-Print-Diagnostics.json') -Encoding UTF8
  $zip=$out + '.zip'
  Compress-Archive -LiteralPath $out -DestinationPath $zip -ErrorAction Stop
  [Windows.Forms.MessageBox]::Show("检查完成，未改程序、驱动、配对、队列，也没有打印。`n请将下面的结果ZIP发到当前Codex对话：`n$zip",'M-BOX打印检查') | Out-Null
  exit 0
}catch{
  [Windows.Forms.MessageBox]::Show('检查未完成。请完整解压到桌面的新文件夹后运行，并保留此窗口；没有执行升级或打印。','M-BOX打印检查') | Out-Null
  exit 1
}
