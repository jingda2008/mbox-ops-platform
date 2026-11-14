"""Offline renderer-byte, manifest and Windows PowerShell parsing verification."""
import argparse,hashlib,json,subprocess,tempfile,zipfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--package',type=Path,required=True);p.add_argument('--pwsh',required=True);a=p.parse_args();root=Path(__file__).resolve().parents[1]
sha=lambda b:hashlib.sha256(b).hexdigest()
m=json.loads((a.package/'manifest.json').read_text())
for n,h in m['files'].items():assert sha((a.package/n).read_bytes())==h,n
with tempfile.TemporaryDirectory() as t:
 t=Path(t);cases=0
 for entry in json.loads((a.package/'test-catalog.json').read_text()):
  f=t/entry['file'];f.write_text((a.package/entry['file']).read_text().replace('{{PRINT_TIME}}','2026-09-21 02:30:00'),encoding='utf-8')
  subprocess.run([a.pwsh,'-NoProfile','-File',str(root/'scripts/emit-checkout-print-preview.ps1'),'-BridgeDirectory',str(a.package),'-LayoutPath',str(f),'-OutputPrefix',str(t/'raw')],check=True,stdout=subprocess.DEVNULL)
  for profile,h in entry['rawSha256'].items():assert sha((t/('raw-'+profile+'.bin')).read_bytes())==h,(entry['file'],profile);cases+=1
 print(json.dumps({'rawPayloadsUnchanged':cases,'manifestFilesVerified':len(m['files']),'physicalVerified':False}))
