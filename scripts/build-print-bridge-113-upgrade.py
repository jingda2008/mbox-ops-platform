"""Reproducible 1.0.11 -> 1.0.13 upgrade. Never touches a service or printer."""
import argparse, hashlib, json, re, subprocess, tempfile, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'deploy/windows-print-bridge'
sha=lambda b:hashlib.sha256(b).hexdigest()
windows=lambda s:s.replace('\r\n','\n').replace('\n','\r\n').encode('utf-8-sig')
def block(s,start,end):return s[s.index(start):s.index(end,s.index(start))]
def replace_once(s,a,b):
 assert s.count(a)==1,a[:100]
 return s.replace(a,b,1)
def build(output):
 baseline=SOURCE/'release-1.0.13/baseline-1.0.11.zip'
 assert sha(baseline.read_bytes())=='b7b6af7fae7b1e470487e4e835e8557374d9a0b4fee8fd7ca967cecfd97ba9d7'
 with zipfile.ZipFile(baseline) as z:
  assert z.testzip() is None
  old={n:z.read(n) for n in z.namelist()}
 manifest=json.loads(old.pop('manifest.json'))
 assert set(old)==set(manifest['files'])
 for n,h in manifest['files'].items():assert sha(old[n])==h,n
 files=dict(old)
 original=old['bridge.mjs'].decode('utf-8-sig').replace('\r\n','\n')
 ref=(SOURCE/'bridge.mjs').read_text()
 bridge=replace_once(original,"const VERSION = '1.0.11'","const VERSION = '1.0.13'")
 bridge=replace_once(bridge,"import { promisify } from 'node:util'","import { promisify } from 'node:util'\nimport { createDiagnosticQueue, atomicState } from './diagnostic-events.mjs'")
 bridge=replace_once(bridge,"const journalPath = join(dataDirectory, 'journal.json')","const journalPath = join(dataDirectory, 'journal.json')\nconst diagnosticQueue = createDiagnosticQueue(join(dataDirectory, 'diagnostic-events.json'))\nconst progressPath = join(dataDirectory, 'progress.json')\nconst runtimeStatusPath = join(dataDirectory, 'runtime-status.json')")
 bridge=replace_once(bridge,'  await serviceLoop(await readConfig(true))',"  await emitDiagnostic({ kind: 'bridge_started' })\n  await serviceLoop(await readConfig(true))")
 for start,end in [('async function serviceLoop','async function runCycle'),('async function heartbeat','async function processJob'),('async function readJournal()','function saveJournal'),('async function authenticatedRequest','async function request'),('function normalizeFailure','function isDefinitelyNotSubmitted')]:
  bridge=replace_once(bridge,block(bridge,start,end),block(ref,start,end))
 # Keep production rendering/flags byte-for-byte, transplant only submission/journal flow.
 job=block(ref,'async function processJob','async function processCommand')
 render=block(original,'    const content = JSON.stringify(renderReceiptLayout','    journal.entries[businessKey] = { state: \'printed\'')
 job=replace_once(job,block(job,'    const content = renderTicket','  } catch (error)'),render)
 bridge=replace_once(bridge,block(bridge,'async function processJob','async function processCommand'),job)
 marker="    hostname: hostname(), softwareVersion: VERSION, queues,\n  })"
 bridge=replace_once(bridge,marker,marker+"\n  await atomicState(runtimeStatusPath, { version: VERSION, lastHeartbeatAt: new Date().toISOString() })")
 # No supervisor service change: existing WinSW registration and node path are retained.
 bridge=replace_once(bridge,block(bridge,'async function reportSupervisorRecovery','async function emitDiagnostic'),'')
 assert block(bridge,'function usesSmallBillItems','async function authenticatedRequest')==block(original,'function usesSmallBillItems','async function authenticatedRequest')
 assert block(bridge,'async function printText','async function listQueues')==block(original,'async function printText','async function listQueues')
 files['bridge.mjs']=bridge.encode()
 files['diagnostic-events.mjs']=(SOURCE/'diagnostic-events.mjs').read_text().encode()
 b=old['print-ticket.ps1'];start=b.index(b'  public static void SendBytes(');end=b.index(b"\r\n}\r\n'@",start)
 ref_bytes=(SOURCE/'print-ticket.ps1').read_text().encode();rs=ref_bytes.index(b'  public static void SendBytes(');re_=ref_bytes.index(b"\n}\n'@",rs)
 files['print-ticket.ps1']=b[:start]+ref_bytes[rs:re_].replace(b'\n',b'\r\n')+b[end:]
 # Known original installer with explicit absent-file rollback and new-heartbeat verification.
 u=old['upgrade.ps1'].decode('utf-8-sig').replace('\r\n','\n').replace('1.0.11','1.0.13')
 u=replace_once(u,"param([string]$InstallDirectory = '')","param([string]$InstallDirectory = '', [switch]$NoDialogs)")
 u=replace_once(u,"    if ($InstallDirectory) {","    if ($NoDialogs) { $arguments += '-NoDialogs' }\n    if ($InstallDirectory) {")
 u=replace_once(u,"  $expectedFiles = @(","  $expectedFiles = @('diagnostic-events.mjs',")
 u=replace_once(u,"  $files = @('bridge.mjs','print-ticket.ps1','list-printers.ps1')","  $baseFiles = @('bridge.mjs','print-ticket.ps1','list-printers.ps1')\n  $files = @('bridge.mjs','print-ticket.ps1','list-printers.ps1','diagnostic-events.mjs')\n  $originalPresence = @{}\n  $activationStarted = $null")
 start=u.index('  $originalHashes = @{');end=u.index('  $validatedHashes = @{}',start)
 base="  $productionBaseHashes = @{\n"+''.join("    '%s'='%s'\n"%(n,manifest['files'][n]) for n in ['bridge.mjs','print-ticket.ps1','list-printers.ps1'])+'  }\n'
 u=u[:start]+base+u[end:]
 start=u.index('      $same = $true');end=u.index('      return ($same -and $wasRunning)',start)
 u=u[:start]+'''      $same = $true
      $knownBaseline = $true
      foreach ($file in $files) {
        $path = Join-Path $InstallDirectory $file
        $originalPresence[$file] = Test-Path -LiteralPath $path -PathType Leaf
        if ($originalPresence[$file]) {
          $validatedHashes[$file] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
          if ($validatedHashes[$file] -ne $manifest.files.psobject.Properties[$file].Value) { $same = $false }
          if ($file -notin $baseFiles -or $validatedHashes[$file] -ne $productionBaseHashes[$file]) { $knownBaseline = $false }
        } else {
          $same = $false
          if ($file -in $baseFiles) { $knownBaseline = $false }
        }
      }
      if (-not $same -and -not $knownBaseline) { throw '原程序与完整1.0.11或本版不同，停止覆盖。' }
'''+u[end:]
 u=replace_once(u,"        $original = Join-Path $InstallDirectory $file","        if (-not $originalPresence[$file]) { continue }\n        $original = Join-Path $InstallDirectory $file")
 u=replace_once(u,"        if ((Get-FileHash -LiteralPath (Join-Path $InstallDirectory $file) -Algorithm SHA256).Hash -ne $validatedHashes[$file]) { throw '升级期间原程序发生变化，停止覆盖。' }",'''        $path = Join-Path $InstallDirectory $file
        if ((Test-Path -LiteralPath $path -PathType Leaf) -ne $originalPresence[$file]) { throw '升级期间原程序发生变化。' }
        if ($originalPresence[$file] -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $validatedHashes[$file]) { throw '升级期间原程序发生变化。' }''')
 u=replace_once(u,"    Start = { Start-MboxBridge }","    Start = { $script:activationStarted = Get-Date; Start-MboxBridge }")
 u=replace_once(u,"    VerifyRunning = { Assert-MboxRunning }",'''    VerifyRunning = {
      Assert-MboxRunning
      $healthy = $false
      for ($attempt=0; $attempt -lt 30; $attempt++) {
        try {
          $runtime = Get-Content -LiteralPath (Join-Path $dataDirectory 'runtime-status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
          $seen = [DateTimeOffset]::Parse($runtime.lastHeartbeatAt)
          $age = ([DateTimeOffset]::UtcNow - $seen).TotalSeconds
          if ($runtime.version -eq '1.0.13' -and $age -ge 0 -and $age -lt 90 -and (-not $script:activationStarted -or $seen.UtcDateTime -ge $script:activationStarted.ToUniversalTime())) { $healthy=$true; break }
        } catch { }
        if ((Get-Service -Name 'MBoxPrintBridge').Status -ne 'Running') { throw '新服务已停止。' }
        Start-Sleep -Seconds 2
      }
      if (-not $healthy) { throw '新版未完成后台心跳，将恢复原程序。' }
    }''')
 u=replace_once(u,"        Copy-Item -LiteralPath (Join-Path $backup $file) -Destination (Join-Path $InstallDirectory $file) -Force -ErrorAction Stop",'''        if (-not $originalPresence[$file]) {
          if (Test-Path -LiteralPath (Join-Path $InstallDirectory $file)) { Remove-Item -LiteralPath (Join-Path $InstallDirectory $file) -Force -ErrorAction Stop }
          continue
        }
        if ((Get-FileHash -LiteralPath (Join-Path $backup $file)).Hash -ne $validatedHashes[$file]) { throw '恢复备份被修改。' }
        Copy-Item -LiteralPath (Join-Path $backup $file) -Destination (Join-Path $InstallDirectory $file) -Force -ErrorAction Stop''')
 u=u.replace("BackendHeartbeat='not-verified'","BackendHeartbeat=$(if($result.State -ne 'failed'){'acknowledged'}else{'not-verified'})")
 u=u.replace('还需后台确认新心跳为1.0.13，并核对两台实体票。','新版本已收到后台心跳确认；请继续核对两台打印机的实体票。')
 u=replace_once(u,"  [System.Windows.Forms.MessageBox]::Show($message,'M-BOX打印桥升级结果') | Out-Null","  Write-Host $message\n  if (-not $NoDialogs) { [System.Windows.Forms.MessageBox]::Show($message,'M-BOX打印桥升级结果') | Out-Null }")
 line='  [System.Windows.Forms.MessageBox]::Show("检查未完成：$stage。请保留提示并联系运维；如有另一个升级窗口，请查看其结果。",\'M-BOX升级提示\') | Out-Null'
 u=replace_once(u,line,"  Write-Host \"检查未完成：$stage。\"\n  if (-not $NoDialogs) { "+line.strip()+" }")
 files['upgrade.ps1']=windows(u)
 files['test-print.ps1']=windows(old['test-print.ps1'].decode('utf-8-sig').replace('1.0.11','1.0.13').replace('MBOX-PrintBridge-111-r1','MBOX-PrintBridge-113-r1').replace('MBOX-LAYOUT-111-','MBOX-LAYOUT-113-'))
 files['使用说明.txt']=windows('''M-BOX 打印桥 1.0.13 升级版
适用于本店完整原版1.0.11。不是新电脑首次安装工具，不需要重新配对。
1. 将整个ZIP解压到新文件夹，不要解压到原安装目录，不要在压缩包内运行。
2. 在没有出单时双击 MBOX-OneClick-Upgrade.cmd，允许Windows管理员授权。
3. 程序自动检查版本和打印队列，备份原程序、停止服务、升级并核验后台心跳；失败自动尝试恢复原程序。
4. 成功后员工网页刷新，并开启打印提醒声音。真实纸票请现场核对。
原打印机、配对、中文、排版、备注、切纸和防重复记录保留。不清队列、不重打历史订单。
仅“Windows接收”不能证明纸已出来；纸卷、卡纸、网络仍须现场检查。
未知/混合/更高版本、正在打印、日志损坏、无后台心跳等情况会停止升级或回滚，请保留提示和upgrade-last-result.json。
可选 MBOX-Test-Only.cmd 仅打印标记为系统测试的样票，会消耗纸张；正常升级本身不主动打印测试票。
''')
 assert files['list-printers.ps1']==old['list-printers.ps1']
 assert files['upgrade-core.ps1']==old['upgrade-core.ps1']
 output.mkdir(parents=True,exist_ok=True);package=output/'MBOX-PrintBridge-1.0.13-OneClick-r1';package.mkdir(exist_ok=True)
 m={'version':'1.0.13','packageRevision':'r1','baselineVersion':'1.0.11','files':{n:sha(b) for n,b in files.items()}}
 files['manifest.json']=(json.dumps(m,ensure_ascii=False,indent=2)+'\n').encode()
 archive=output/(package.name+'.zip')
 with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
  for n,b in sorted(files.items()):
   (package/n).write_bytes(b);info=zipfile.ZipInfo(n,date_time=(2026,11,14,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,b)
 archive.with_suffix('.zip.sha256').write_text(sha(archive.read_bytes())+'  '+archive.name+'\n')
 proof={'version':'1.0.13','baselineArchiveSha256':sha(baseline.read_bytes()),'archiveSha256':sha(archive.read_bytes()),'changedFiles':sorted(n for n in files if n not in old or files[n]!=old[n]),'renderingFunctionsUnchanged':True,'serviceRegistrationUnchanged':True,'physicalVerified':False}
 (output/'build-evidence.json').write_text(json.dumps(proof,indent=2)+'\n')
 print(json.dumps(proof,indent=2));return package
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,default=ROOT/'artifacts/print-bridge-1.0.13');a=p.parse_args();build(a.output)
