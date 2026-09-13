"""Incident-specific 1.0.4 package; legacy 1.0.3 distribution stays frozen."""
from pathlib import Path
import hashlib,json,zipfile
root=Path(__file__).resolve().parents[1];src=root/'deploy/windows-print-bridge'
accepted=root/'artifacts/print-bridge-compatibility-1.0.4-test2/MBOX-Print-Test-1.0.4-test2.zip'
assert hashlib.sha256(accepted.read_bytes()).hexdigest()=='aaa82498f80a5bd595a08dbc0919bef9ef40561be6ca53e9fe4a34aed588ef8e'
with zipfile.ZipFile(accepted) as z: renderer=z.read('MBOX-Print-Test-1.0.4-test2/print-ticket.ps1')
assert renderer.decode('utf-8-sig').replace('\r\n','\n')==(src/'print-ticket.ps1').read_text(encoding='utf-8-sig')
names=['bridge.mjs','print-ticket.ps1','list-printers.ps1','upgrade.ps1','upgrade-core.ps1','MBOX-OneClick-Upgrade.cmd','使用说明.txt']
payload={}
for name in names:
    p=src/'release-1.0.4'/name if name in ['upgrade.ps1','使用说明.txt'] else src/name
    t=p.read_text(encoding='utf-8-sig').replace('\r\n','\n')
    if name.endswith(('.ps1','.cmd','.txt')):t=t.replace('\n','\r\n')
    payload[name]=t.encode('utf-8-sig' if name.endswith(('.ps1','.txt')) else 'utf-8')
assert payload['print-ticket.ps1']==renderer
assert b"const VERSION = '1.0.4'" in payload['bridge.mjs']
manifest={'version':'1.0.4','packageRevision':'r1','files':{n:hashlib.sha256(b).hexdigest() for n,b in payload.items()}}
payload['manifest.json']=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
out=root/'artifacts/print-bridge-one-click-1.0.4-r1';out.mkdir(exist_ok=False)
archive=out/'MBOX-PrintBridge-1.0.4-OneClick-r1.zip'
with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
    for n,b in payload.items():z.writestr(n,b)
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for n,h in manifest['files'].items():assert hashlib.sha256(z.read(n)).hexdigest()==h
sha=hashlib.sha256(archive.read_bytes()).hexdigest();archive.with_suffix('.zip.sha256').write_text(sha+'\n')
print(archive);print(sha)
