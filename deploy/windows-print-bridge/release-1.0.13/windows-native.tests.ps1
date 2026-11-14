$ErrorActionPreference='Stop'
$repo=(Get-Location).Path
$package=Join-Path $repo 'artifacts\print-bridge-1.0.13\MBOX-PrintBridge-1.0.13-OneClick-r1'
$evidence=Join-Path $repo 'artifacts\print-bridge-native-evidence'
New-Item -ItemType Directory -Force $evidence | Out-Null
$root='C:\MBOX Native 验证'
$install=Join-Path $root '安装程序'
$data=Join-Path $root '数据'
$baseline=Join-Path $root 'baseline'
$exe=Join-Path $install 'MBoxPrintBridge.exe'
$node=(Get-Command node.exe).Source
$results=New-Object System.Collections.ArrayList
$mock=$null
function Assert($condition,[string]$message) { if(-not $condition){throw $message} }
function Record([string]$name) { [void]$results.Add($name);Write-Host "PASS: $name" }
function Stop-Bridge {
 $s=Get-Service MBoxPrintBridge -ErrorAction SilentlyContinue
 if($s -and $s.Status -ne 'Stopped') { Stop-Service MBoxPrintBridge; $s.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(45)) }
}
function Write-Config([string]$value) { [IO.File]::WriteAllText((Join-Path $data 'config.json'),$value,(New-Object Text.UTF8Encoding($false))) }
function Reset-Old {
 Stop-Bridge
 foreach($n in @('bridge.mjs','print-ticket.ps1','list-printers.ps1')) {Copy-Item -LiteralPath (Join-Path $baseline $n) -Destination (Join-Path $install $n) -Force}
 Remove-Item -LiteralPath (Join-Path $install 'diagnostic-events.mjs') -ErrorAction SilentlyContinue
 [IO.File]::WriteAllText((Join-Path $data 'journal.json'),'{"version":1,"entries":{}}')
 [IO.File]::WriteAllText((Join-Path $data 'control.json'),'{}')
 Remove-Item -LiteralPath (Join-Path $data 'runtime-status.json') -ErrorAction SilentlyContinue
 Start-Service MBoxPrintBridge
 (Get-Service MBoxPrintBridge).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
}
function Run-Upgrade([string]$directory=$package) {
 & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $directory 'upgrade.ps1') -NoDialogs -InstallDirectory $install | Out-Host
 return $LASTEXITCODE
}
function Assert-Old {
 foreach($n in @('bridge.mjs','print-ticket.ps1','list-printers.ps1')) {Assert ((Get-FileHash -LiteralPath (Join-Path $install $n)).Hash -eq (Get-FileHash -LiteralPath (Join-Path $baseline $n)).Hash) "old $n not restored"}
 Assert (-not (Test-Path -LiteralPath (Join-Path $install 'diagnostic-events.mjs'))) 'new module remained after rollback'
 Assert ((Get-Service MBoxPrintBridge).Status -eq 'Running') 'original service not running'
 Assert ((Get-FileHash -LiteralPath (Join-Path $data 'config.json')).Hash -eq $script:configHash) 'pairing changed'
}
try {
 Assert (-not (Get-Service MBoxPrintBridge -ErrorAction SilentlyContinue)) 'test runner already has MBoxPrintBridge; refuse touching it'
 Assert (-not (Test-Path $root)) 'fixture directory already exists'
 New-Item -ItemType Directory -Force $root,$install,$data,$baseline | Out-Null
 Expand-Archive -LiteralPath (Join-Path $PSScriptRoot 'baseline-1.0.11.zip') -DestinationPath $baseline
 Invoke-WebRequest -UseBasicParsing 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile $exe
 Assert ((Get-FileHash -LiteralPath $exe).Hash -eq '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da') 'WinSW digest mismatch'
 $xml='<service><id>MBoxPrintBridge</id><name>MBOX isolated upgrade test</name><description>Isolated CI service; no venue access</description><executable>'+[Security.SecurityElement]::Escape($node)+'</executable><arguments>&quot;%BASE%\bridge.mjs&quot; run</arguments><workingdirectory>%BASE%</workingdirectory><env name="MBOX_PRINT_BRIDGE_DATA" value="'+[Security.SecurityElement]::Escape($data)+'"/><log mode="roll"/><stoptimeout>20 sec</stoptimeout><startmode>Manual</startmode></service>'
 [IO.File]::WriteAllText([IO.Path]::ChangeExtension($exe,'.xml'),$xml,(New-Object Text.UTF8Encoding($false)))
 Write-Config '{"serverUrl":"http://127.0.0.1:19130","publicId":"fixture","credential":"fixture-only"}'
 $script:configHash=(Get-FileHash -LiteralPath (Join-Path $data 'config.json')).Hash
 $mock=Start-Process -FilePath $node -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'mock-backend.mjs')+'"'),('"'+$data+'"')) -PassThru -RedirectStandardError (Join-Path $evidence 'mock.stderr.log')
 Start-Sleep -Seconds 2
 Set-Service Spooler -StartupType Manual; Start-Service Spooler
 & $exe install
 Assert ($LASTEXITCODE -eq 0) 'WinSW service install failed'
 Reset-Old
 Start-Sleep -Seconds 8
 Assert ((Get-Content -LiteralPath (Join-Path $data 'requests.jsonl') -Raw) -match '1.0.11') 'original bridge heartbeat absent'
 Record 'real WinSW service runs original 1.0.11 and completes loopback heartbeat'
 foreach($script in Get-ChildItem -LiteralPath $package -Filter '*.ps1') {
  $tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile($script.FullName,[ref]$tokens,[ref]$errors)
  Assert ($errors.Count -eq 0) ('PowerShell 5.1 parse: '+$script.Name)
 }
 Record 'all packaged PowerShell parses on Windows 5.1'
 $bad=Join-Path $root 'bad-package';Copy-Item -LiteralPath $package -Destination $bad -Recurse
 Add-Content -LiteralPath (Join-Path $bad 'bridge.mjs') -Value '// tampered'
 Assert ((Run-Upgrade $bad) -ne 0) 'tampered package accepted';Assert-Old
 Record 'tampered package rejected before changing service files'
 Add-Content -LiteralPath (Join-Path $install 'bridge.mjs') -Value '// unknown venue edit'
 Assert ((Run-Upgrade) -ne 0) 'unknown baseline accepted'
 Reset-Old;Assert-Old
 Record 'unknown installed baseline rejected'
 $printing='{"version":1,"entries":{"test":{"state":"printing","jobId":"a1111111-1111-4111-8111-111111111111","updatedAt":"2026-11-14T00:00:00Z"}}}'
 [IO.File]::WriteAllText((Join-Path $data 'journal.json'),$printing)
 Assert ((Run-Upgrade) -ne 0) 'in-flight journal accepted';Assert-Old
 Assert ([IO.File]::ReadAllText((Join-Path $data 'journal.json')) -eq $printing) 'journal modified'
 Record 'in-flight journal blocks upgrade and remains unchanged'
 Reset-Old
 [IO.File]::WriteAllText((Join-Path $data 'journal.json'),'{"version":1,"entries":{"broken":{"state":"unknown"}}}')
 Assert ((Run-Upgrade) -ne 0) 'corrupt journal accepted';Assert-Old
 Record 'corrupt journal rejected without clearing records'
 Reset-Old
 [IO.File]::WriteAllText((Join-Path $data 'control.json'),'{"rejectNewHeartbeat":true}')
 Assert ((Run-Upgrade) -ne 0) 'new heartbeat failure not detected'
 $failure=Get-Content -LiteralPath (Join-Path $install 'upgrade-last-result.json') -Raw | ConvertFrom-Json
 Assert ($failure.Result.Recovery -eq 'original-restored') 'rollback not confirmed';Assert-Old
 Copy-Item -LiteralPath (Join-Path $install 'upgrade-last-result.json') -Destination (Join-Path $evidence 'rollback-result.json')
 Record 'real new-service heartbeat rejection restores old files, absent module and running state'
 Reset-Old
 $journalHash=(Get-FileHash -LiteralPath (Join-Path $data 'journal.json')).Hash
 Assert ((Run-Upgrade) -eq 0) 'upgrade failed'
 $success=Get-Content -LiteralPath (Join-Path $install 'upgrade-last-result.json') -Raw | ConvertFrom-Json
 Assert ($success.Result.State -eq 'updated') 'wrong upgrade result'
 Assert ($success.BackendHeartbeat -eq 'acknowledged') 'new heartbeat not verified'
 Assert ((Get-FileHash -LiteralPath (Join-Path $data 'journal.json')).Hash -eq $journalHash) 'journal changed during upgrade'
 Assert ((Get-FileHash -LiteralPath (Join-Path $data 'config.json')).Hash -eq $script:configHash) 'pairing changed'
 Copy-Item -LiteralPath (Join-Path $install 'upgrade-last-result.json') -Destination (Join-Path $evidence 'upgrade-result.json')
 Record 'real service upgrades 1.0.11 to 1.0.13 with fresh heartbeat; config and journal unchanged'
 Assert ((Run-Upgrade) -eq 0) 'repeat install failed'
 $same=Get-Content -LiteralPath (Join-Path $install 'upgrade-last-result.json') -Raw | ConvertFrom-Json
 Assert ($same.Result.State -eq 'already-current') 'repeat install is not idempotent'
 Record 'repeated upgrade is idempotent'
 # Exercise real winspool APIs through an isolated Generic/Text-only file port, never a physical printer.
 $capture=Join-Path $root 'capture.raw'
 Add-PrinterDriver -Name 'Generic / Text Only'
 Add-PrinterPort -Name $capture
 Add-Printer -Name 'MBOX-CI-RAW' -DriverName 'Generic / Text Only' -PortName $capture
 $printerSource=[IO.File]::ReadAllText((Join-Path $package 'print-ticket.ps1'))
 $match=[regex]::Match($printerSource,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
 Assert $match.Success 'native transport type missing'
 Add-Type -TypeDefinition $match.Groups[1].Value
 $payload=[byte[]](27,64,77,66,79,88,45,67,73,10,29,86,0)
 [MboxRawPrinter]::SendBytes('MBOX-CI-RAW','MBOX-CI-ONLY',$payload)
 for($i=0;$i -lt 30 -and -not (Test-Path -LiteralPath $capture);$i++){Start-Sleep -Seconds 1}
 Assert (Test-Path -LiteralPath $capture) 'native spooler file was not written'
 Start-Sleep -Seconds 2
 Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($capture)) -eq [Convert]::ToBase64String($payload)) 'RAW bytes altered by native spooler'
 $invalidFailed=$false;try{[MboxRawPrinter]::SendBytes('MBOX-NOT-EXIST','MBOX-CI-ONLY',$payload)}catch{$invalidFailed=$_.Exception.ToString().Contains('open_printer_failed')}
 Assert $invalidFailed 'nonexistent native queue did not fail closed'
 Record 'real Open/Start/Write/End/Close Windows spooler preserves RAW bytes and rejects invalid queue'
 $summary=[ordered]@{windowsNativeVerified=$true;physicalVerified=$false;os=[Environment]::OSVersion.VersionString;powershell=$PSVersionTable.PSVersion.ToString();tests=@($results);commit=$env:GITHUB_SHA;archiveSha256=(Get-FileHash 'artifacts/print-bridge-1.0.13/MBOX-PrintBridge-1.0.13-OneClick-r1.zip').Hash.ToLowerInvariant()}
 $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $repo 'artifacts/print-bridge-1.0.13/windows-evidence.json') -Encoding UTF8
} finally {
 if(Test-Path $root){
  Stop-Bridge
  if(Test-Path $exe){& $exe uninstall | Out-Null}
  Get-ChildItem -LiteralPath $install -Filter '*.log' -ErrorAction SilentlyContinue | Copy-Item -Destination $evidence
  foreach($n in @('requests.jsonl','runtime-status.json')){if(Test-Path (Join-Path $data $n)){Copy-Item (Join-Path $data $n) $evidence}}
 }
 if($mock -and -not $mock.HasExited){Stop-Process -Id $mock.Id -Force}
 if(Get-Printer -Name 'MBOX-CI-RAW' -ErrorAction SilentlyContinue){Remove-Printer -Name 'MBOX-CI-RAW'}
}
