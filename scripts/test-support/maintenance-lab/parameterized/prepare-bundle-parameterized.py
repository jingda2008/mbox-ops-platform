"""Parameter-only successor of prepare-bundle-86b0344.py; original is unchanged."""
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import shlex
import shutil

from lab_parameters import cli, digest, require, run


def prepare(c):
    P = pathlib.Path
    root, repo, bundle, old = [P(c[k]) for k in ('runtimeRoot', 'sourceDirectory', 'bundleDirectory', 'sourceReleaseDirectory')]
    require(P(c['sourceShaFile']).read_text().strip() == c['targetSha'], 'source artifact full SHA mismatch')
    require(not (repo / '.git').exists() or run(['git', '-C', repo, 'rev-parse', 'HEAD']) == c['targetSha'], 'source checkout SHA mismatch')
    inspected = json.loads(run(['docker', 'image', 'inspect', c['imageTag']]))[0]
    require(inspected['Id'] == c['platformImageDigest'], 'actual image/config digest mismatch')
    require(inspected['Os'] + '/' + inspected['Architecture'] == c['platform'], 'actual image platform mismatch')
    require(inspected.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == c['targetSha'], 'image revision does not bind the target SHA')
    bundle.mkdir(parents=True, exist_ok=True)
    require(P(c['imageArchive']).is_file(), 'verified OCI archive is missing')
    if P(c['imageArchive']).resolve() != (bundle / 'candidate-image.tar').resolve():
        shutil.copy2(c['imageArchive'], bundle / 'candidate-image.tar')
    module = repo / 'node_modules/@playwright/test'
    module.parent.mkdir(parents=True, exist_ok=True)
    if not module.exists():
        module.symlink_to(c['playwrightModule'])
    scripts = ['deploy-release.sh', 'activate-release.sh', 'rollback-activated-release.sh', 'verify-public-app.sh',
               'stage-release-evidence.sh', 'upload-oss-verified.sh', 'send-sls-events.sh', 'prune-oss-images.sh',
               'release-state.sh', 'normalize-runtime-env.sh', 'backup-postgres.sh', 'restore-postgres.sh',
               'maintenance-bootstrap.sh', 'maintenance-bootstrap.py', 'maintenance-ingress.mjs']
    for name in scripts:
        shutil.copy2(repo / 'deploy/aliyun' / name, bundle / name)
    for name in ('store.json', 'catalog.json'):
        shutil.copy2(old / name, bundle / name)
    run(['node', repo / 'scripts/generate-migration-manifest.mjs', '--directory', repo / 'database/normalized-migrations', '--output', bundle / 'migration-manifest.json'])
    run(['node', repo / 'scripts/write-release-bundle-manifest.mjs'], {
        'MBOX_BUNDLE_ARCHIVE': str(bundle / 'candidate-image.tar'), 'MBOX_MIGRATION_MANIFEST': str(bundle / 'migration-manifest.json'),
        'MBOX_STORE_CONFIG': str(bundle / 'store.json'), 'MBOX_CATALOG_CONFIG': str(bundle / 'catalog.json'),
        'MBOX_BUNDLE_SHA': c['targetSha'], 'MBOX_BUNDLE_IMAGE_DIGEST': c['imageDigest'],
        'MBOX_BUNDLE_PLATFORM_IMAGE_DIGEST': c['platformImageDigest'], 'MBOX_BUNDLE_SOURCE_BRANCH': 'main',
        'MBOX_BUNDLE_FROZEN_AT': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'MBOX_BUNDLE_CONFIG_VERSION': 'normalized-runtime-config/v1', 'MBOX_DEPLOYMENT_SCRIPT_DIR': str(bundle),
        'MBOX_BUNDLE_VERSION': c['version'], 'MBOX_BUNDLE_IMAGE_TAG': c['imageTag'],
        'MBOX_BUNDLE_MANIFEST': str(bundle / 'release-manifest.json'), 'GITHUB_REPOSITORY': 'LOCAL-LAB-NOT-GITHUB', 'GITHUB_RUN_ID': c['labCiRunId'],
    })
    manifest = json.loads((bundle / 'release-manifest.json').read_text())
    require(manifest['releaseSha'] == c['targetSha'] and int(manifest['migration']['count']) == c['schema'], 'bundle SHA/schema mismatch')
    for kind in ('quality', 'runtime'):
        directory = bundle / 'verified-ci-evidence' / kind
        directory.mkdir(parents=True, exist_ok=True)
        data = {'scope': 'LAB TRANSPORT FIXTURE ONLY; not real CI or release approval', 'source': {'commitSha': c['targetSha']}, 'ci': {'runId': c['labCiRunId']}}
        file = directory / ('ci-quality-evidence.json' if kind == 'quality' else 'lab-runtime-evidence.json')
        file.write_text(json.dumps(data))
        (directory / 'SHA256SUMS').write_text(digest(file) + '  ' + file.name + '\n')
    install_lab_adapters(c)
    release = root / 'releases' / c['targetSha'][:7]
    release.mkdir(parents=True, exist_ok=True)
    for file in bundle.iterdir():
        if file.is_file() and file.name != 'candidate-image.tar':
            shutil.copy2(file, release / file.name)
    spec = importlib.util.spec_from_file_location('maintenance', release / 'maintenance-bootstrap.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    source = json.loads(run(['docker', 'inspect', c['sourceContainerName']]))[0]
    source_env = source['Config']['Env']  # Hash only; never include values in output.
    require(any(value == 'MBOX_RELEASE_SHA=' + c['sourceSha'] for value in source_env), 'source live full SHA mismatch')
    adapter = old / 'worker-adapters'
    tree = [(str(p.relative_to(adapter)), digest(p)) for p in sorted(adapter.rglob('*')) if p.is_file()]
    require(bool(tree), 'source worker adapter inventory is empty')
    units = run(['systemctl', 'list-unit-files', '--no-legend', '--no-pager'])
    plan = {'mode': 'planned-maintenance-forward-only', 'transitionId': c['transitionId'], 'targetReleaseSha': c['targetSha'],
            'targetImageDigest': manifest['imageDigest'], 'sourceLive': {'containerId': source['Id'], 'platformImageDigest': source['Image'],
            'releaseSha': c['sourceSha'], 'environmentSha256': hashlib.sha256(module.canonical(sorted(source_env))).hexdigest(), 'releaseDirectory': str(old)},
            'retiredLogins': [c['retiredLogin']], 'persistentMounts': c['persistentMounts'], 'writerContainerIds': [source['Id']],
            'workerAdapterDirectory': str(adapter), 'workerAdapterTreeSha256': hashlib.sha256(module.canonical(tree)).hexdigest(),
            'systemdUnits': c['systemdUnits'], 'systemdInventorySha256': module.systemd_inventory_sha256(units),
            'callbackUrls': c['callbackUrls'], 'controllerPython': os.sys.executable, 'clusterAdminService': c['clusterAdminService']}
    journal = root / 'maintenance' / c['transitionId'] / 'journal.jsonl'
    if journal.exists():
        plan['recoveryFromJournalHash'] = json.loads(journal.read_text().splitlines()[-1])['hash']
    module.atomic(bundle / 'maintenance-plan.json', plan)
    module.atomic(release / 'maintenance-plan.json', plan)
    env = {'PLAYWRIGHT_BROWSERS_PATH': c['playwrightBrowsers'], 'NODE_EXTRA_CA_CERTS': c['tlsCaFile'],
           'MBOX_RELEASE_TAG': 'v' + c['version'], 'MBOX_RELEASE_BUNDLE_DIR': str(bundle), 'MBOX_DEPLOYMENT_TIER': 'production',
           'MBOX_SSH_HOST': 'localhost', 'MBOX_SSH_PORT': '22', 'MBOX_SSH_USER': 'root', 'MBOX_SSH_KEY_PATH': c['sshKeyFile'],
           'MBOX_PUBLIC_URL': 'https://localhost', 'MBOX_MAINTENANCE_PLAN': str(bundle / 'maintenance-plan.json'), 'MBOX_CI_RUN_ID': c['labCiRunId']}
    lines = ['#!/bin/bash', 'set -euo pipefail', 'cd ' + shlex.quote(str(repo))]
    lines += ['export ' + key + '=' + shlex.quote(value) for key, value in env.items()]
    lines += ['# LAB transport only; the unchanged formal entry enforces its own platform gates.', './deploy/aliyun/deploy-release.sh']
    P(c['formalEntryScript']).write_text('\n'.join(lines) + '\n')
    os.chmod(c['formalEntryScript'], 0o700)
    print(json.dumps({'prepared': True, 'formalEntryExecuted': False, 'labOnly': True, 'notRealCIOrOSS': True,
                      'sha': c['targetSha'], 'platform': c['platform'], 'schema': c['schema'],
                      'bundleManifestSha256': digest(bundle / 'release-manifest.json')}))


def install_lab_adapters(c):
    """Same explicitly synthetic adapters as the original disposable LAB fixture."""
    directory = pathlib.Path(c['labBinDirectory'])
    directory.mkdir(parents=True, exist_ok=True)
    curl = directory / 'curl'
    curl.write_text('#!/usr/bin/env python3\nimport os,sys\nif "http://100.100.100.200/latest/meta-data/ram/security-credentials/" in sys.argv: print("LAB-LOCAL-ROLE-NOT-RAM")\nelse: os.execv("/usr/bin/curl",["/usr/bin/curl",*sys.argv[1:]])\n')
    oss = directory / 'ossutil'
    oss.write_text('''#!/usr/bin/env python3
import sys,pathlib,shutil,json
args=sys.argv[1:]
if len(args)<3 or args[0]!='cp':raise SystemExit('LAB adapter only implements verified cp')
def path(value):
 if value.startswith('oss://'):
  relative=pathlib.PurePosixPath(value[6:])
  if relative.is_absolute() or '..' in relative.parts:raise SystemExit(3)
  return pathlib.Path(ROOT)/relative
 return pathlib.Path(value)
a,b=map(path,args[1:3]);b.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(a,b)
with open(LOG,'a') as log:log.write(json.dumps({'fixture':'LOCAL-ONLY-NOT-OSS','direction':'readback' if args[1].startswith('oss://') else 'upload','bytes':a.stat().st_size})+'\\n')
'''.replace('pathlib.Path(ROOT)', 'pathlib.Path(' + repr(c['objectStoreDirectory']) + ')').replace('open(LOG,', 'open(' + repr(c['objectTransferLog']) + ','))
    os.chmod(curl, 0o755)
    os.chmod(oss, 0o755)


if __name__ == '__main__':
    config, _ = cli('Prepare a parameter-bound isolated localhost LAB bundle; default is validation only')
    if config is not None:
        prepare(config)
