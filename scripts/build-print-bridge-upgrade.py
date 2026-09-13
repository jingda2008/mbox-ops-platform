"""Build an offline Windows upgrade archive without environment credentials."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
source = root / 'deploy/windows-print-bridge'
if (source / 'RELEASE-HOLD.txt').exists():
    raise SystemExit('Print bridge upgrade distribution is on hold: see RELEASE-HOLD.txt. Use the incident-specific original-backup recovery tool.')
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=False)
names = ['bridge.mjs', 'print-ticket.ps1', 'list-printers.ps1', 'upgrade.ps1',
         'upgrade-core.ps1', 'MBOX-OneClick-Upgrade.cmd', '使用说明.txt']
payload = {}
for name in names:
    value = (source / name).read_text(encoding='utf-8-sig').replace('\r\n', '\n')
    if name.endswith(('.ps1', '.cmd', '.txt')):
        value = value.replace('\n', '\r\n')
    # Windows PowerShell 5.1 needs an explicit Unicode encoding for Chinese.
    payload[name] = value.encode('utf-8-sig' if name.endswith(('.ps1', '.txt')) else 'utf-8')
assert b"const VERSION = '1.0.3'" in payload['bridge.mjs']
manifest = {'version': '1.0.3', 'packageRevision': 'r2',
            'files': {name: hashlib.sha256(data).hexdigest() for name, data in payload.items()}}
payload['manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
archive = output / 'MBOX-PrintBridge-1.0.3-OneClick-r2.zip'
with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as package:
    for name, data in payload.items():
        info = zipfile.ZipInfo(name, date_time=(2026, 9, 12, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        package.writestr(info, data)
with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None
    assert set(package.namelist()) == set(payload)
    for name, digest in manifest['files'].items():
        assert hashlib.sha256(package.read(name)).hexdigest() == digest
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n')
print(json.dumps({'archive': str(archive), 'sha256': digest, 'files': len(payload)}, ensure_ascii=False))
