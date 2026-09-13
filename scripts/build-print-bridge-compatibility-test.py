from pathlib import Path
import hashlib, zipfile, json
root=Path(__file__).resolve().parents[1]
source=root/'deploy/windows-print-bridge'
out=root/'artifacts/print-bridge-compatibility-1.0.4-test2'
stage=out/'MBOX-Print-Test-1.0.4-test2'
stage.mkdir(parents=True,exist_ok=True)
names=['test-print.ps1','MBOX-Test-Only.cmd','test-ticket.txt','使用说明.txt','print-ticket.ps1']
for name in names:
    p=source/name if name=='print-ticket.ps1' else source/'compatibility-test'/name
    text=p.read_text(encoding='utf-8-sig').replace('\r\n','\n').replace('\n','\r\n')
    (stage/name).write_bytes(text.encode('utf-8-sig' if name.endswith('.ps1') else 'utf-8'))
manifest={n:hashlib.sha256((stage/n).read_bytes()).hexdigest() for n in names}
(stage/'SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
z=out/'MBOX-Print-Test-1.0.4-test2.zip'
with zipfile.ZipFile(z,'w',zipfile.ZIP_DEFLATED) as a:
    for n in names+['SHA256.json']: a.write(stage/n,stage.name+'/'+n)
with zipfile.ZipFile(z) as a:
    assert a.testzip() is None
    for n,h in manifest.items():assert hashlib.sha256(a.read(stage.name+'/'+n)).hexdigest()==h
print(z)
print(hashlib.sha256(z.read_bytes()).hexdigest())
