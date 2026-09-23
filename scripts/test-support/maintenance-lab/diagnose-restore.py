"""After a failed LAB entry, expose the unmodified restore tool's private error.

Runs only inside the network-isolated synthetic host. The original failed entry
remains failed, and no acceptance condition or production script is changed.
"""
import json, os, pathlib, socket, subprocess

root = pathlib.Path('/root/LAB-final')
assert pathlib.Path('/.dockerenv').exists()
assert socket.gethostname().startswith('mbox-maint-lab-')
assert not any(row.split()[1] == '00000000' for row in pathlib.Path('/proc/net/route').read_text().splitlines()[1:])
config = json.loads((root / 'active-config.json').read_text())
if not any('restore-postgres.sh (exit ' in p.read_text(errors='replace') for p in (root / 'private-logs').glob('*.log')):
    raise SystemExit(0)
release = pathlib.Path('/opt/mbox/releases') / config['targetSha'][:7]
evidence = release / 'maintenance-restore-source.json'
backups = sorted(pathlib.Path('/opt/mbox/backups').glob('*.dump'), key=lambda p: p.stat().st_mtime)
if evidence.exists() and backups:
    facts = json.loads(evidence.read_text())
    plan = json.loads((release / 'maintenance-plan.json').read_text())
    maintenance = dict(line.split('=', 1) for line in pathlib.Path('/opt/mbox/secrets/database-maintenance.env').read_text().splitlines() if line and not line.startswith('#'))
    env = {**os.environ, **maintenance,
        'DATABASE_SERVICE': maintenance['BACKUP_DATABASE_SERVICE'],
        'ADMIN_DATABASE_SERVICE': plan['clusterAdminService'],
        'MBOX_EXPECTED_RESTORE_DATABASE': facts['database']['name'],
        'MBOX_EXPECTED_RESTORE_SCHEMA_VERSION': str(facts['schemaVersion']),
        'MBOX_EXPECTED_RESTORE_MANIFEST': str(pathlib.Path(plan['sourceLive']['releaseDirectory']) / 'release-manifest.json'),
        'MBOX_EXPECTED_RESTORE_EVIDENCE': str(evidence),
        'MBOX_RESTORE_REPORT': str(root / 'diagnostic-restore-report.json'),
        'MBOX_CONFIRM_RESTORE': 'VERIFY',
        'MBOX_RESTORE_PYTHON': plan['controllerPython']}
    with (root / 'private-logs/diagnostic-restore.log').open('w') as stream:
        result = subprocess.run([str(release / 'restore-postgres.sh'), 'verify', str(backups[-1])], env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=300)
        stream.write('\ndiagnostic_restore_exit=' + str(result.returncode) + '\n')
