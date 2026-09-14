"""Build a reproducible 1.0.5 candidate without publishing or installing it."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
src = root / 'deploy/windows-print-bridge'
names = ['bridge.mjs', 'print-ticket.ps1', 'list-printers.ps1', 'upgrade.ps1',
         'upgrade-core.ps1', 'MBOX-OneClick-Upgrade.cmd', '使用说明.txt']
payload = {}
for name in names:
    path = src / 'release-1.0.5' / name if name in ['upgrade.ps1', '使用说明.txt'] else src / name
    value = path.read_text(encoding='utf-8-sig').replace('\r\n', '\n')
    if name.endswith(('.ps1', '.cmd', '.txt')):
        value = value.replace('\n', '\r\n')
    payload[name] = value.encode('utf-8-sig' if name.endswith(('.ps1', '.txt')) else 'utf-8')
assert b"const VERSION = '1.0.5'" in payload['bridge.mjs']
# Preserve the exact 1.0.4 transport bytes, including BOM and CRLF.
assert hashlib.sha256(payload['print-ticket.ps1']).hexdigest() == '5b4a8a1335978ccf56d44a42d93d4b73be1b8b36fe53c19bba7cf8da1a6bc7e7'
assert hashlib.sha256(payload['list-printers.ps1']).hexdigest() == 'b317985f5812785d32ef8fb3c149969e26d3b811cf5e5a3bf2244403636ffb26'
manifest = {'version': '1.0.5', 'packageRevision': 'r1',
            'files': {name: hashlib.sha256(value).hexdigest() for name, value in payload.items()}}
payload['manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
out = root / 'artifacts/print-bridge-one-click-1.0.5-r1'
out.mkdir(parents=True, exist_ok=True)
archive = out / 'MBOX-PrintBridge-1.0.5-OneClick-r1.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for name, value in payload.items():
        entry = zipfile.ZipInfo(name, date_time=(2026, 9, 14, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        bundle.writestr(entry, value)
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    for name, digest in manifest['files'].items():
        assert hashlib.sha256(bundle.read(name)).hexdigest() == digest
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n')
print(archive)
print(digest)
