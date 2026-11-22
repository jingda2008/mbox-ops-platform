"""Package the unattended service upgrade on top of the verified 1.0.14 payload."""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'deploy/windows-print-bridge/release-1.0.15'
ARTIFACTS = ROOT / 'artifacts'
BASE = ARTIFACTS / 'print-bridge-1.0.14/MBOX-PrintBridge-1.0.14-OneClick-r1.zip'
NAME = 'MBOX-PrintBridge-1.0.15-OneClick-r1.zip'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def build(baseline, output):
    with zipfile.ZipFile(baseline) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    manifest = json.loads(files.pop('manifest.json'))
    # Verify uncompressed contents so CI can rebuild with any supported zlib.
    if sha(json.dumps(manifest, sort_keys=True).encode()) != '55cd5917b478df0132460bb94599b9df1d278f4d39f5e65947904f87b55b2c1e':
        raise ValueError('Unrecognized 1.0.14 baseline manifest')
    if manifest['files'] != {name: sha(data) for name, data in files.items()}:
        raise ValueError('Damaged 1.0.14 payload')

    for name in ('bridge.mjs', 'test-print.ps1'):
        files[name] = files[name].replace(b'1.0.14', b'1.0.15')
    marker = b"    $stage = 'start'; & $Operations.Start"
    if files['upgrade-core.ps1'].count(marker) != 1:
        raise ValueError('Unrecognized upgrade transaction')
    files['upgrade-core.ps1'] = files['upgrade-core.ps1'].replace(
        marker, b"    $stage = 'configure-service'; & $Operations.ConfigureService\r\n" + marker)
    for name in ('RecoveryActions.cs', 'upgrade.ps1', 'service-policy.ps1', '使用说明.txt'):
        source = SRC / ('安装说明.txt' if name == '使用说明.txt' else name)
        files[name] = source.read_text(encoding='utf-8').replace('\n', '\r\n').encode('utf-8-sig')
    manifest = dict(version='1.0.15', packageRevision='r1', baselineVersions=['1.0.13', '1.0.14'],
                    files={name: sha(data) for name, data in sorted(files.items())})
    files['manifest.json'] = json.dumps(manifest, indent=2).encode()
    output.mkdir(parents=True, exist_ok=True)
    dest = output / NAME
    with zipfile.ZipFile(dest, 'w') as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 11, 23, 0, 0, 0))
            info.create_system = 0
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
    dest.with_suffix('.zip.sha256').write_text(sha(dest.read_bytes()) + '  ' + dest.name + '\n')
    return dest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', type=Path, default=BASE)
    parser.add_argument('--output', type=Path, default=ARTIFACTS / 'print-bridge-1.0.15')
    args = parser.parse_args()
    print(build(args.baseline, args.output))
