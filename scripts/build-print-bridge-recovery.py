"""Package a backup-only recovery tool, without any replacement print engine."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
source = root / 'deploy/windows-print-bridge/recovery'
incident = root / 'artifacts/print-bridge-one-click-r2-20260912/MBOX-PrintBridge-1.0.3-OneClick-r2.zip'
with zipfile.ZipFile(incident) as archive:
    incident_manifest = json.loads(archive.read('manifest.json'))
    assert incident_manifest['packageRevision'] == 'r2'
    incident_hashes = {}
    for name in ('bridge.mjs', 'print-ticket.ps1', 'list-printers.ps1'):
        digest = hashlib.sha256(archive.read(name)).hexdigest()
        assert digest == incident_manifest['files'][name]
        incident_hashes[name] = digest

output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=False)
names = ['restore.ps1', 'restore-policy.ps1', 'upgrade-core.ps1',
         'MBOX-Restore-Before-Upgrade.cmd', '使用说明.txt']
payload = {}
for name in names:
    content = (source / name).read_text(encoding='utf-8-sig').replace('\r\n', '\n').replace('\n', '\r\n')
    payload[name] = content.encode('ascii' if name.endswith('.cmd') else 'utf-8-sig')
manifest = {'kind': 'incident-original-restore', 'packageRevision': 'recovery-r2',
            'incidentBackupDirectory': 'backup-20260913-001241-bb38d4d9', 'incidentHashes': incident_hashes,
            'files': {name: hashlib.sha256(data).hexdigest() for name, data in payload.items()}}
payload['manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
target = output / 'MBOX-PrintBridge-Restore-20260913-r2.zip'
with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in payload.items():
        archive.writestr(name, data)
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == set(payload)
    for name, digest in manifest['files'].items():
        assert hashlib.sha256(archive.read(name)).hexdigest() == digest
    assert not set(incident_hashes).intersection(archive.namelist())
digest = hashlib.sha256(target.read_bytes()).hexdigest()
target.with_suffix('.zip.sha256').write_text(f'{digest}  {target.name}\n')
print(json.dumps({'archive': str(target), 'sha256': digest, 'files': len(payload)}, ensure_ascii=False))
