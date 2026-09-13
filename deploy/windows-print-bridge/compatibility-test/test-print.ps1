$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$mutex = New-Object System.Threading.Mutex($false, 'Global\MBOX-PrintBridge-CompatibilityTest')
$held = $false
try {
  try { $held = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
  if (-not $held) { throw '另一个试打窗口正在运行，请先查看该窗口。' }
  $choice = [System.Windows.Forms.MessageBox]::Show("只打印一张测试票，不升级、不改配置。请在打印空闲时操作。`r`n`r`n是：测试吧台 batai`r`n否：测试后厨 chufang`r`n取消：退出", 'M-BOX 兼容试打 1.0.4', 'YesNoCancel', 'Question')
  if ($choice -eq 'Cancel') { return }
  $queue = if ($choice -eq 'Yes') { 'batai' } else { 'chufang' }
  $printer = Get-Printer -Name $queue -ErrorAction Stop
  if ($printer.PrinterStatus -match 'Error|Offline|PaperProblem|NoToner') { throw '打印机当前不可用，请先恢复正常。' }
  if (@(Get-PrintJob -PrinterName $queue -ErrorAction Stop).Count -gt 0) { throw '打印队列还有任务，请等营业票打印完再试。' }
  $stateDir = Join-Path $env:LOCALAPPDATA 'MBOX-Print-Compatibility-1.0.4-test2'
  [void][System.IO.Directory]::CreateDirectory($stateDir)
  $marker = Join-Path $stateDir ($queue + '.json')
  if (Test-Path -LiteralPath $marker) { throw "这台打印机已尝试过本次试打，为免重复出纸已停止。请核对纸票并将结果发给开发人员。记录：$marker" }
  $record = @{ queue=$queue; candidate='1.0.4-test2'; state='attempting'; time=(Get-Date).ToString('o'); rendererSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'print-ticket.ps1') -Algorithm SHA256).Hash }
  $record | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
  $time = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'China Standard Time').ToString('yyyy-MM-dd HH:mm:ss')
  $ticket = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'test-ticket.txt'), [Text.Encoding]::UTF8).Replace('{{PRINT_TIME}}', $time)
  $ticketPath = Join-Path $stateDir ($queue + '-ticket.txt')
  [IO.File]::WriteAllText($ticketPath, $ticket, (New-Object Text.UTF8Encoding($false)))
  & (Join-Path $PSScriptRoot 'print-ticket.ps1') -QueueName $queue -ContentPath $ticketPath -DocumentName 'MBOX-COMPATIBILITY-TEST-NOT-ORDER' -Profile 'escpos_80' -Copies 1
  $record.state='submitted_not_physically_verified'
  $record | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
  [void][System.Windows.Forms.MessageBox]::Show("测试内容已提交，不代表实际出纸正常。`r`n请检查：中文完整、桌号放大、数量金额正确、长备注完整、末尾结束标记和自动切纸。`r`n请拍下整张小票并注明吧台或后厨。原营业程序没有被替换。", 'M-BOX 试打结果', 'OK', 'Information')
} catch {
  [void][System.Windows.Forms.MessageBox]::Show("试打未能确认完成：$($_.Exception.Message)`r`n不自动重试。若已出纸请先核对，原营业程序没有被替换。", 'M-BOX 试打提示', 'OK', 'Warning')
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
