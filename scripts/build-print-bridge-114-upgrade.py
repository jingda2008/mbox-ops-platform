"""Build the queue-observation upgrade from the byte-verified deployed 1.0.13 package."""
import argparse
import hashlib
import json
import re
import tempfile
import zipfile
from pathlib import Path
import importlib.util
import sys
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'deploy/windows-print-bridge/release-1.0.14'
BASE_SHA = '8c8fbf461f28df6ef95ef8b9df73d6130d906b5985c6167c001eaf1e9c85558a'
NAME = 'MBOX-PrintBridge-1.0.14-OneClick-r1'
ACTIVE = ['bridge.mjs', 'print-ticket.ps1', 'list-printers.ps1', 'diagnostic-events.mjs']
ADDED = ['observe.mjs', 'read-queue.ps1']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def edit(source, before, after):
    if source.count(before) != 1:
        raise ValueError('Unexpected baseline: ' + before[:80])
    return source.replace(before, after)


def ps(text):
    return text.replace('\r\n', '\n').replace('\n', '\r\n').encode('utf-8-sig')


def build(baseline, output, rebuilt=False):
    if not rebuilt and sha(baseline.read_bytes()) != BASE_SHA:
        raise ValueError('Wrong 1.0.13 archive')
    with zipfile.ZipFile(baseline) as archive:
        files = {n: archive.read(n) for n in archive.namelist()}
    manifest = files.pop('manifest.json')
    if sha(manifest) != 'c954082f1250d9852e7830b6390b50a067b862991b1644c36e01221a98d82b62':
        raise ValueError('Wrong deployed baseline manifest')
    old = json.loads(manifest)['files']
    if old != {n: sha(data) for n, data in files.items()}:
        raise ValueError('Invalid baseline manifest')
    b = files['bridge.mjs'].decode().replace("const VERSION = '1.0.13'", "const VERSION = '1.0.14'")
    b = edit(b, "import { promisify }", "import { queueSampler, readQueue } from './observe.mjs'\nimport { promisify }")
    b = edit(b, 'await main(process.argv.slice(2))', 'const samples = queueSampler()\nawait main(process.argv.slice(2))')
    b = edit(b, "  await authenticatedRequest(config, '/api/print-bridge/heartbeat', {", "  const response = await authenticatedRequest(config, '/api/print-bridge/heartbeat', {")
    b = edit(b, 'hostname: hostname(), softwareVersion: VERSION, queues,', 'hostname: hostname(), softwareVersion: VERSION, queues, observeQueues: true, queueObservations: samples.latest(),')
    b = edit(b, '  await atomicState(runtimeStatusPath,', "  const monitored = response.data?.monitorQueues\n  samples.refresh(Array.isArray(monitored) ? monitored.filter(q => typeof q === 'string' && q.length <= 180).slice(0, 8) : ['batai', 'chufang'])\n  await atomicState(runtimeStatusPath,")
    b = edit(b, "    if (command.commandType === 'test_print')", "    let inspection\n    if (command.commandType === 'ping') {\n      inspection = await readQueue(queue)\n    } else if (command.commandType === 'test_print')")
    b = edit(b, "outcome: 'succeeded', resultSnapshot: { checkedAt: new Date().toISOString() },", "outcome: inspection && !inspection.readable ? 'failed' : 'succeeded',\n      ...(inspection && !inspection.readable ? {failureCode: 'queue_unavailable'} : {}),\n      resultSnapshot: { checkedAt: new Date().toISOString(), ...(inspection ? {queueObservation: inspection} : {}) },")
    b = edit(b, 'documentName: `MBOX-${businessKey}`.slice(0, 120)', 'documentName: `MBOX-job-${id}`')
    files['bridge.mjs'] = b.encode()
    files['observe.mjs'] = (SRC / 'observe.mjs').read_bytes()
    files['read-queue.ps1'] = ps((SRC / 'read-queue.ps1').read_text(encoding='utf-8'))
    files['MBOX-Check-Queues.cmd'] = (SRC / 'MBOX-Check-Queues.cmd').read_text().replace('\n', '\r\n').encode('ascii')
    files['check-queues.ps1'] = ps((SRC / 'check-queues.ps1').read_text(encoding='utf-8'))
    u = files['upgrade.ps1'].decode('utf-8-sig').replace('\r\n', '\n').replace('1.0.13', '1.0.14').replace('完整1.0.11', '完整1.0.13')
    def pslist(names):
        return ','.join("'" + n + "'" for n in names)
    u = edit(u, '$expectedFiles = @(', '$expectedFiles = @(' + pslist(ADDED + ['MBOX-Check-Queues.cmd', 'check-queues.ps1']) + ',')
    u = re.sub(r'(?m)^  \$baseFiles = @\([^\n]+', '  $baseFiles = @(' + pslist(ACTIVE) + ')', u)
    u = re.sub(r'(?m)^  \$files = @\([^\n]+', '  $files = @(' + pslist(ACTIVE + ADDED) + ')', u)
    start, end = u.index('  $productionBaseHashes = @{'), u.index('  $validatedHashes = @{}')
    u = u[:start] + '  $productionBaseHashes = @{\n' + ''.join(f"    '{n}'='{old[n]}'\n" for n in ACTIVE) + '  }\n' + u[end:]
    files['upgrade.ps1'] = ps(u)
    files['test-print.ps1'] = ps(files['test-print.ps1'].decode('utf-8-sig').replace('1.0.13', '1.0.14'))
    files['使用说明.txt'] = ps((SRC / '安装说明.txt').read_text(encoding='utf-8'))
    files['manifest.json'] = json.dumps(dict(version='1.0.14', packageRevision='r1', baselineVersion='1.0.13', files={n: sha(v) for n,v in files.items()}), indent=2).encode()
    output.mkdir(parents=True, exist_ok=True)
    dest = output / (NAME + '.zip')
    with zipfile.ZipFile(dest, 'w') as archive:
        for n, data in sorted(files.items()):
            info = zipfile.ZipInfo(n, (2026, 11, 22, 0, 0, 0))
            info.create_system = 0
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
    dest.with_suffix('.zip.sha256').write_text(sha(dest.read_bytes()) + '  ' + dest.name + '\n')
    return dest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/print-bridge-1.0.14')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        baseline = args.baseline
        if not baseline:
            spec = importlib.util.spec_from_file_location('baseline', ROOT/'scripts/build-print-bridge-113-upgrade.py')
            generator = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(generator)
            directory = generator.build(Path(tmp))
            baseline = directory.parent / (directory.name + '.zip')
        print(build(baseline, args.output, rebuilt=args.baseline is None))
