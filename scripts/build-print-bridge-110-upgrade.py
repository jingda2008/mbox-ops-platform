"""Package the approved r4 layout with the verified transactional Windows upgrader.

No deployment, installation, printer access, or credential access is performed.
"""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--previous-package', type=Path, required=True)
parser.add_argument('--approved-package', type=Path, required=True)
parser.add_argument('--fixtures', type=Path, required=True)
parser.add_argument('--pwsh', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verified_package(path, expected):
    assert digest(path.read_bytes()) == expected, f'Wrong package: {path.name}'
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        data = {name: archive.read(name) for name in archive.namelist()}
    manifest = json.loads(data['manifest.json'])
    assert set(data) == set(manifest['files']) | {'manifest.json'}
    for name, expected_hash in manifest['files'].items():
        assert digest(data[name]) == expected_hash, name
    return data, manifest


def windows(text):
    return text.replace('\r\n', '\n').replace('\n', '\r\n').encode('utf-8-sig')


original, original_manifest = verified_package(args.previous_package, '4a8d72f736d26a26af5c406f81510534cdfbd4b0e99a4cafb03f746157213e00')
approved, _ = verified_package(args.approved_package, '55203d664e85d4ccfac6b1c76a6785dbb6e66d7f65e0c95c9af26e7c715c3b70')
assert digest(args.fixtures.read_bytes()) == '411ae9a6e4538d03c87b70acb71bb3f1f487e84dbf9bfbc599adf40d510e410f'
payload = {name: value for name, value in approved.items() if name != 'manifest.json'}
bridge = approved['bridge.mjs'].decode()
assert bridge.count("const VERSION = '1.0.9'") == 1
payload['bridge.mjs'] = bridge.replace("const VERSION = '1.0.9'", "const VERSION = '1.0.10'", 1).encode()
for name in ('list-printers.ps1', 'upgrade-core.ps1', 'MBOX-OneClick-Upgrade.cmd'):
    payload[name] = original[name]
catalog = json.loads(payload['test-catalog.json'])

with tempfile.TemporaryDirectory(prefix='mbox-110-build-') as temp:
    temp = Path(temp)
    # Regenerate from the current source and demand exact approved renderer bytes.
    (temp / 'original.mjs').write_bytes(original['bridge.mjs'])
    (temp / 'original.ps1').write_bytes(original['print-ticket.ps1'])
    subprocess.run(['node', str(root / 'scripts/patch-checkout-print-venue.mjs'), str(temp / 'original.mjs'), str(temp / 'approved.mjs'), str(temp / 'original.ps1'), str(temp / 'approved.ps1')], check=True, stdout=subprocess.DEVNULL)
    assert (temp / 'approved.mjs').read_bytes() == approved['bridge.mjs']
    assert (temp / 'approved.ps1').read_bytes() == approved['print-ticket.ps1']
    (temp / 'bridge.mjs').write_bytes(payload['bridge.mjs'])
    (temp / 'print-ticket.ps1').write_bytes(payload['print-ticket.ps1'])
    for fixture in json.loads(args.fixtures.read_text()):
        snapshot = dict(fixture['snapshot'])
        if snapshot['kind'] == 'table_settlement':
            snapshot['displayNumber'] = '20260914-211000-004271'
        snapshot_path = temp / 'snapshot.json'
        snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False))
        layout = subprocess.check_output(['node', str(temp / 'bridge.mjs'), 'render-layout', str(snapshot_path)])
        name = f"test-{fixture['id']}.layout.json"
        payload[name] = layout.replace(b'{{PRINT_TIME}}', b'2026-09-19 00:50:00')
        catalog.append({'label': fixture['label'], 'file': name})
    # Verify all 15 samples with the exact packaged printer function.
    for entry in catalog:
        layout_path = temp / entry['file']
        layout_path.write_bytes(payload[entry['file']])
        prefix = temp / 'ticket'
        subprocess.run([str(args.pwsh.resolve()), '-NoLogo', '-NoProfile', '-File', str(root / 'scripts/emit-checkout-print-preview.ps1'), '-BridgeDirectory', str(temp), '-LayoutPath', str(layout_path), '-OutputPrefix', str(prefix)], check=True, stdout=subprocess.DEVNULL)
        hashes = {profile: digest((temp / f'ticket-{profile}.bin').read_bytes()) for profile in ('escpos_58', 'escpos_80', 'windows_text')}
        if 'rawSha256' in entry:
            assert hashes == entry['rawSha256'], entry['file']
        entry['rawSha256'] = hashes
payload['test-catalog.json'] = (json.dumps(catalog, ensure_ascii=False, indent=2) + '\n').encode()
test = approved['test-print.ps1'].decode('utf-8-sig').replace('1.0.9', '1.0.10').replace('checkout-preview-r4', 'r1').replace('$catalog.Count -ne 4', '$catalog.Count -ne 15').replace('MBOX-Checkout-Preview-20260919-r4', 'MBOX-PrintBridge-110-r1').replace('MBOX-LAYOUT-109-', 'MBOX-LAYOUT-110-')
payload['test-print.ps1'] = windows(test)
payload['使用说明.txt'] = windows('''M-BOX PrintBridge 1.0.10-r1 门店升级包

适用于已经安装MBOX打印桥的门店电脑，不是首次安装或重新配对工具。
本包使用已确认的r4样式：陆家嘴中心 L+MALL与M-BOX字标协调，结账和支付凭条统一抬头，删除指定冗余说明。

1. 完整解压到新的独立文件夹，不要放进现有打印桥安装目录。
2. 先运行MBOX-Test-Only.cmd，选择原打印机及实际纸宽，核对新版票据、中文、金额和切纸；试打不会改服务。
3. 在没有出单的空档，双击MBOX-OneClick-Upgrade.cmd，允许Windows管理员授权。
4. 程序核对包和原安装文件，自动备份，停服务复查后升级；失败尝试恢复原文件和服务状态。
5. 完成后核对后台打印桥心跳为1.0.10，并核对吧台、后厨纸票。不要删除防重复记录或盲目补打。

保留原配对、打印队列、驱动、配置和防重复记录。未知混装、打印队列繁忙或更高版本会停止覆盖。
若失败，保留升级窗口提示及原安装目录的upgrade-last-result.json，备份路径会在结果中显示。

本包只更新门店打印程序，不会发布后台。预结账/结账按收款状态判断及整桌总合计还需要后台版本单独发布。
四张新版样例均为系统测试；支付凭条1000元为演示金额，不是真实交易。
已完成本地包和排版核验，尚未完成本包的Windows服务/UAC及门店实物验收。
''')
upgrade = original['upgrade.ps1'].decode('utf-8-sig').replace('\r\n', '\n').replace('1.0.9', '1.0.10')
baseline = '  $brand109Hashes = @{\n' + ''.join(f"    '{name}'='{original_manifest['files'][name]}'\n" for name in ('bridge.mjs', 'print-ticket.ps1', 'list-printers.ps1')) + '  }\n'
assert upgrade.count('  $validatedHashes = @{}') == 1
upgrade = upgrade.replace('  $validatedHashes = @{}', baseline + '  $validatedHashes = @{}')
assert upgrade.count('$allTicketsHashes, $brand108Hashes))') == 1
upgrade = upgrade.replace('$allTicketsHashes, $brand108Hashes))', '$allTicketsHashes, $brand108Hashes, $brand109Hashes))')
names = sorted(set(payload) | {'upgrade.ps1'})
old_expected = next(line for line in upgrade.splitlines() if line.startswith('  $expectedFiles = '))
upgrade = upgrade.replace(old_expected, '  $expectedFiles = @(' + ','.join(f"'{name}'" for name in names) + ')')
payload['upgrade.ps1'] = windows(upgrade)
manifest = {'version': '1.0.10', 'packageRevision': 'r1', 'files': {name: digest(value) for name, value in payload.items()}}
payload['manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
out = root / 'artifacts/print-bridge-one-click-1.0.10-r1'
out.mkdir(parents=True, exist_ok=True)
unpacked = out / 'MBOX-PrintBridge-1.0.10-OneClick-r1'
unpacked.mkdir(exist_ok=True)
archive_path = out / 'MBOX-PrintBridge-1.0.10-OneClick-r1.zip'
with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, data in sorted(payload.items()):
        (unpacked / name).write_bytes(data)
        entry = zipfile.ZipInfo(name, date_time=(2026, 9, 19, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, data)
with zipfile.ZipFile(archive_path) as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == set(payload)
    for name, data in payload.items():
        assert archive.read(name) == data
sha = digest(archive_path.read_bytes())
archive_path.with_suffix('.zip.sha256').write_text(f'{sha}  {archive_path.name}\n')
(out / 'build-evidence.json').write_text(json.dumps({'version': '1.0.10', 'sha256': sha, 'samples': len(catalog), 'profilePayloadsVerified': len(catalog) * 3, 'approvedR4PayloadsUnchanged': True, 'physicalVerified': False, 'windowsNativeVerified': False}, indent=2))
print(archive_path)
print(sha)
