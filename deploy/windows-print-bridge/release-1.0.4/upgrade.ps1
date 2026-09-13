param([string]$InstallDirectory = '')
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  try {
    $arguments = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'))
    if ($InstallDirectory) { $arguments += @('-InstallDirectory',('"' + $InstallDirectory + '"')) }
    $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList $arguments
    exit $elevated.ExitCode
  } catch { Write-Host '未获得管理员授权，未执行升级。'; exit 10 }
}
Add-Type -AssemblyName System.Windows.Forms
$mutex = New-Object System.Threading.Mutex($false, 'Global\MBOX-PrintBridge-Upgrade')
$ownsMutex = $false
$exitCode = 1
$stage = '初始化'
$backup = ''
try {
  try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { throw '另一个升级程序正在运行。' }
  $stage = '核对升级包完整性'
  $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.version -ne '1.0.4' -or $manifest.packageRevision -ne 'r1') { throw '升级包版本不正确。' }
  $expectedFiles = @('bridge.mjs','print-ticket.ps1','list-printers.ps1','upgrade.ps1','upgrade-core.ps1','MBOX-OneClick-Upgrade.cmd','使用说明.txt')
  if (@($manifest.files.psobject.Properties).Count -ne $expectedFiles.Count) { throw '升级包清单不完整。' }
  foreach ($file in $expectedFiles) {
    $entry = $manifest.files.psobject.Properties[$file]
    if ($null -eq $entry -or [string]$entry.Value -notmatch '^[a-fA-F0-9]{64}$') { throw '升级包清单无效。' }
    if ((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file) -Algorithm SHA256).Hash -ne $entry.Value) { throw '升级包文件校验失败。' }
  }
  . (Join-Path $PSScriptRoot 'upgrade-core.ps1')
  $stage = '识别现有安装和服务'
  $registration = Get-CimInstance Win32_Service -Filter "Name='MBoxPrintBridge'" -ErrorAction Stop
  if ($null -eq $registration) { throw '没有找到已安装的MBOX打印桥。' }
  $binaryPath = [Environment]::ExpandEnvironmentVariables([string]$registration.PathName)
  if ($binaryPath -match '^"([^"]+\.exe)"(?:\s|$)') { $executable = $Matches[1] }
  elseif ($binaryPath -match '^(.+?\.exe)(?:\s|$)') { $executable = $Matches[1] }
  else { throw '无法识别服务位置。' }
  $actualDirectory = Split-Path -Parent $executable
  if ($InstallDirectory -and [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\') -ne [IO.Path]::GetFullPath($actualDirectory).TrimEnd('\')) { throw '指定目录与实际服务不一致。' }
  $InstallDirectory = $actualDirectory
  if ([IO.Path]::GetFullPath($PSScriptRoot).StartsWith([IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $PSScriptRoot -eq $InstallDirectory) { throw '升级包需要放在独立目录。' }
  [xml]$serviceXml = Get-Content -LiteralPath ([IO.Path]::ChangeExtension($executable,'.xml')) -Raw -Encoding UTF8
  $dataDirectory = Join-Path $env:ProgramData 'MBOX\PrintBridge'
  foreach ($entry in @($serviceXml.service.env)) {
    if ($entry -and $entry.name -eq 'MBOX_PRINT_BRIDGE_DATA') {
      $dataDirectory = [Environment]::ExpandEnvironmentVariables(([string]$entry.value).Replace('%BASE%',$InstallDirectory))
    }
  }
  if (-not [IO.Path]::IsPathRooted($dataDirectory) -or $dataDirectory.Contains('%')) { throw '无法识别数据目录。' }
  $configPath = Join-Path $dataDirectory 'config.json'
  $journalPath = Join-Path $dataDirectory 'journal.json'
  $configHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $config.publicId -or -not $config.credential -or -not $config.serverUrl) { throw '现有配对信息不完整。' }
  $service = Get-Service -Name 'MBoxPrintBridge' -ErrorAction Stop
  if ($service.Status -notin @('Running','Stopped')) { throw '服务正在切换状态。' }
  $wasRunning = $service.Status -eq 'Running'
  $files = @('bridge.mjs','print-ticket.ps1','list-printers.ps1')
  $backup = Join-Path $InstallDirectory ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
  function Assert-MboxIdle {
    # Query failure never means an empty queue. No spooler jobs are removed.
    $jobs = @(Get-CimInstance Win32_PrintJob -ErrorAction Stop | Where-Object { $_.Document -like 'MBOX-*' })
    if ($jobs.Count -gt 0) { throw 'MBOX仍有排队打印任务。' }
    $children = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop | Where-Object {
      $_.CommandLine -and $_.CommandLine.IndexOf($InstallDirectory,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -match 'print-ticket\.ps1'
    })
    if ($children.Count -gt 0) { throw '仍有打印程序正在执行。' }
    if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
      $journal = Get-Content -LiteralPath $journalPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($null -eq $journal.entries -or $journal.entries -isnot [pscustomobject]) { throw '防重复记录格式无法核实。' }
      $printing = @($journal.entries.psobject.Properties | Where-Object { $_.Value.state -eq 'printing' })
      if ($printing.Count -gt 0) { throw '本地存在尚未确认结束的打印任务。' }
    }
  }
  function Stop-MboxBridge {
    $currentService = Get-Service -Name 'MBoxPrintBridge' -ErrorAction Stop
    if ($currentService.Status -eq 'Stopped') { return }
    if ($currentService.Status -ne 'StopPending') { $currentService.Stop() }
    $currentService.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(60))
  }
  function Start-MboxBridge {
    $currentService = Get-Service -Name 'MBoxPrintBridge' -ErrorAction Stop
    if ($currentService.Status -eq 'StopPending') { $currentService.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(60)) }
    $currentService.Refresh()
    if ($currentService.Status -eq 'Stopped') { $currentService.Start() }
    $currentService.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(30))
  }
  function Assert-MboxRunning {
    for ($i=0; $i -lt 3; $i++) {
      if ((Get-Service -Name 'MBoxPrintBridge' -ErrorAction Stop).Status -ne 'Running') { throw '服务未保持运行。' }
      Start-Sleep -Seconds 2
    }
    if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash -ne $configHash) { throw '配对配置发生变化，需要核对。' }
  }
  # Exact venue backup supplied by the operator. Unknown adaptations are never overwritten.
  $originalHashes = @{
    'bridge.mjs'='5042d4429996e9ec1c7aa40f34eef418ef446d2aa5464511f431c4a4c0316958'
    'list-printers.ps1'='11ce23cea5a830f1c74969551be27e19ff42a656adbc7d81cc978ba4f847e87b'
    'print-ticket.ps1'='1b9ca762efc5c705d3c5ac873358b90d7c3876a0476a3974062660d4439e11dc'
  }
  $validatedHashes = @{}
  $operations = @{
    Validate = {
      $old = Get-Content -LiteralPath (Join-Path $InstallDirectory 'bridge.mjs') -Raw -Encoding UTF8
      if ($old -notmatch "const VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'") { throw '原版本无法识别。' }
      if ([version]$Matches[1] -gt [version]'1.0.4') { throw '本包不会降级更新的版本。' }
      $same = $true
      foreach ($file in $files) {
        if ((Get-FileHash -LiteralPath (Join-Path $InstallDirectory $file) -Algorithm SHA256).Hash -ne $manifest.files.psobject.Properties[$file].Value) { $same = $false }
      }
      foreach ($file in $files) {
        $hash = (Get-FileHash -LiteralPath (Join-Path $InstallDirectory $file) -Algorithm SHA256).Hash
        if (-not $same -and $hash -ne $originalHashes[$file]) { throw '原程序与已核验门店备份不同，停止覆盖。' }
        $validatedHashes[$file] = $hash
      }
      return ($same -and $wasRunning)
    }
    ProbeIdle = { for ($i=0; $i -lt 3; $i++) { Assert-MboxIdle; Start-Sleep -Seconds 2 } }
    Backup = {
      New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
      foreach ($file in $files) {
        $original = Join-Path $InstallDirectory $file
        Copy-Item -LiteralPath $original -Destination $backup -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $original).Hash -ne (Get-FileHash -LiteralPath (Join-Path $backup $file)).Hash) { throw '备份校验失败。' }
      }
    }
    Stop = { Stop-MboxBridge }
    ProbeStoppedIdle = {
      Assert-MboxIdle
      foreach ($file in $files) {
        if ((Get-FileHash -LiteralPath (Join-Path $InstallDirectory $file) -Algorithm SHA256).Hash -ne $validatedHashes[$file]) { throw '升级期间原程序发生变化，停止覆盖。' }
      }
    }
    Copy = { foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $InstallDirectory $file) -Force -ErrorAction Stop } }
    VerifyFiles = {
      foreach ($file in $files) {
        if ((Get-FileHash -LiteralPath (Join-Path $InstallDirectory $file) -Algorithm SHA256).Hash -ne $manifest.files.psobject.Properties[$file].Value) { throw '更新文件校验失败。' }
      }
    }
    Start = { Start-MboxBridge }
    VerifyRunning = { Assert-MboxRunning }
    Restore = {
      foreach ($file in $files) {
        Copy-Item -LiteralPath (Join-Path $backup $file) -Destination (Join-Path $InstallDirectory $file) -Force -ErrorAction Stop
        if ((Get-FileHash -LiteralPath (Join-Path $InstallDirectory $file)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $backup $file)).Hash) { throw '恢复文件校验失败。' }
      }
    }
    RestoreServiceState = { if ($wasRunning) { Start-MboxBridge; Assert-MboxRunning } else { Stop-MboxBridge } }
  }
  $stage = '执行升级'
  $result = Invoke-MboxUpgradeTransaction -Operations $operations
  $stage = '显示升级结果'
  # Status only; never save credentials, ticket content or unfiltered exceptions.
  $record = [pscustomobject]@{ Time=(Get-Date).ToString('o'); Package='1.0.4-r1'; Result=$result; Backup=$backup; BackendHeartbeat='not-verified'; PhysicalPrinting='not-verified' }
  try { $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $InstallDirectory 'upgrade-last-result.json') -Encoding UTF8 } catch { Write-Host '结果文件未能保存，请保留当前提示。' }
  if ($result.State -eq 'failed') {
    $recoveryText = switch ($result.Recovery) {
      'not-needed' { '程序文件未替换。' }
      'original-restored' { '已恢复原程序及原服务状态。' }
      default { '自动恢复未完成，请联系运维。不要重装、重新配对或补打历史任务。' }
    }
    $message = "升级未完成。阶段：$($result.Stage)" + [Environment]::NewLine + $recoveryText + [Environment]::NewLine + '若处于validate阶段，原程序可能不符合已核验备份，请发此提示；若处于idle阶段，请等票据出完再试。' + [Environment]::NewLine + "备份：$backup"
    $exitCode = 1
  } else {
    $message = '打印程序已核验为1.0.4，服务正在运行。' + [Environment]::NewLine + '原配对和打印机配置保留。还需后台确认新心跳为1.0.4，并核对两台实体票。' + [Environment]::NewLine + "备份：$backup"
    $exitCode = 0
  }
  [System.Windows.Forms.MessageBox]::Show($message,'M-BOX打印桥升级结果') | Out-Null
} catch {
  # Parser errors may include file contents; display the stage only.
  [System.Windows.Forms.MessageBox]::Show("检查未完成：$stage。请保留提示并联系运维；如有另一个升级窗口，请查看其结果。",'M-BOX升级提示') | Out-Null
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
exit $exitCode
