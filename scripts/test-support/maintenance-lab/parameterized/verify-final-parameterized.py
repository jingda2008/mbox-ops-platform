"""LAB-only verification; no execution unless --execute-lab is explicitly set."""
import datetime
import hashlib
import ipaddress
import json
import os
import pathlib
import socket
import ssl
import urllib.parse
import urllib.request

from lab_parameters import cli, digest, financial_snapshot, require, run, sql


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def journal_records(path):
    rows = [json.loads(line) for line in pathlib.Path(path).read_text().splitlines()]
    previous = '0' * 64
    for sequence, row in enumerate(rows):
        payload = {k: v for k, v in row.items() if k != 'hash'}
        require(row['sequence'] == sequence and row['previous'] == previous and
                hashlib.sha256(canonical(payload)).hexdigest() == row['hash'], 'journal hash/sequence mismatch')
        previous = row['hash']
    require(bool(rows), 'journal is empty')
    return rows


def backup_origin(records, backup):
    # A failed initial bound event does not identify the later actual backup.
    # Legacy records without releaseSha inherit only the active target at that
    # record's exact position in the verified chain, never its first target.
    active = None
    seen = set()
    for row in records:
        if row['event'] in ('bound', 'forward-target'):
            active = row['data']['forwardRecoveryTarget']['releaseSha']
            seen.add(active)
        if row is backup:
            origin = row['data'].get('releaseSha', active)
            require(origin in seen, 'backup origin was not bound before the actual backup event')
            return origin
    raise ValueError('backup event is absent from verified journal')


def request(c, url, body=None):
    parts = urllib.parse.urlsplit(url)
    require(parts.scheme == 'https' and parts.hostname in ('localhost', 'payments.localhost') and parts.port in (None, 443)
            and not parts.username and not parts.password, 'HTTP target must be exact loopback LAB HTTPS')
    require(all(ipaddress.ip_address(row[4][0]).is_loopback for row in socket.getaddrinfo(parts.hostname, 443)), 'LAB HTTPS hostname resolved outside loopback')
    context = ssl.create_default_context(cafile=c['tlsCaFile'])
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise ValueError('LAB HTTP redirects are forbidden')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context), NoRedirect())
    response = opener.open(urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'}), timeout=15)
    with response:
        return {'status': response.status, 'body': json.loads(response.read())}


def capture(c):
    directory = pathlib.Path(c['runtimeRoot']) / 'maintenance' / c['transitionId']
    records = journal_records(directory / 'journal.jsonl')
    epoch = directory / 'business-write-epoch.json'
    require(epoch.is_file(), 'baseline must follow the protected business-write epoch')
    binding = next(r['data'] for r in reversed(records) if r['event'] in ('bound', 'forward-target'))
    require(binding['forwardRecoveryTarget']['releaseSha'] == c['targetSha'] and binding['sourceLive']['releaseSha'] == c['sourceSha'], 'baseline transition identity mismatch')
    actual_schema = sql(c, "SELECT to_json(schema_version::integer) FROM mbox.normalized_schema_metadata WHERE singleton=true AND schema_flavor='normalized-core-v1'")
    require(actual_schema == c['schema'], 'baseline actual schema mismatch')
    facts = financial_snapshot(c)
    data = {'labOnly': True, 'transitionId': c['transitionId'], 'sourceSha': c['sourceSha'], 'capturedTargetSha': c['targetSha'],
            'schema': c['schema'], 'journalAnchorHash': records[-1]['hash'], 'epochSha256': digest(epoch), 'financialFacts': facts}
    # Never silently replace an already captured before-failure baseline.
    fd = os.open(c['financialBaselineFile'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(data, file, sort_keys=True, indent=2)
        file.write('\n')
    print(json.dumps({'captured': True, 'verifiedFinalEntry': False, 'labOnly': True,
                      'baselineSha256': digest(c['financialBaselineFile']), 'financialFacts': facts}, indent=2))


def verify(c):
    P = pathlib.Path
    root = P(c['runtimeRoot'])
    release = root / 'releases' / c['targetSha'][:7]
    directory = root / 'maintenance' / c['transitionId']
    manifest = json.loads((release / 'release-manifest.json').read_text())
    records = journal_records(directory / 'journal.jsonl')
    require(records[-1]['event'] == 'completed', 'transition is not completed')
    binding = next(r['data'] for r in reversed(records) if r['event'] in ('bound', 'forward-target'))
    require(binding['forwardRecoveryTarget']['releaseSha'] == c['targetSha'] and binding['sourceLive']['releaseSha'] == c['sourceSha'], 'final journal SHA binding mismatch')
    require(manifest['releaseSha'] == c['targetSha'] and int(manifest['migration']['count']) == c['schema'], 'manifest SHA/schema mismatch')
    require(manifest['imageDigest'] == c['imageDigest'] and manifest['platformImageDigest'] == c['platformImageDigest'], 'manifest image identity mismatch')
    ready = request(c, 'https://localhost/api/ready')
    require(ready['status'] == 200 and ready['body']['commitSha'] == c['targetSha'] and int(ready['body']['schemaVersion']) == c['schema']
            and ready['body']['writeEnabled'] is True and ready['body']['releaseImageDigest'] == c['imageDigest'], 'candidate ready identity/state mismatch')
    baseline = json.loads(P(c['financialBaselineFile']).read_text())
    require(baseline['labOnly'] is True and baseline['transitionId'] == c['transitionId'] and baseline['sourceSha'] == c['sourceSha'], 'financial baseline identity mismatch')
    require(baseline['capturedTargetSha'] in {r['data']['forwardRecoveryTarget']['releaseSha'] for r in records if r['event'] in ('bound', 'forward-target')}
            and baseline['journalAnchorHash'] in {r['hash'] for r in records}, 'financial baseline is not anchored in this transition')
    require(baseline['epochSha256'] == digest(directory / 'business-write-epoch.json'), 'protected business-write epoch changed')
    before_facts = financial_snapshot(c)
    require(before_facts == baseline['financialFacts'], '237/238 facts changed across the measured forward restart')
    money = sql(c, """SELECT json_build_object(
      'payments',(SELECT json_agg(json_build_object('id',id,'status',status,'amount',amount_minor,'currency',currency,'transaction',provider_transaction_id)) FROM mbox.payments WHERE public_id='lab-original-payment'),
      'ledger',(SELECT json_agg(json_build_object('id',r.id,'payment',r.payment_id,'type',r.entry_type,'amount',r.amount_minor,'currency',r.currency,'reference',r.provider_reference)) FROM mbox.reconciliation_entries r JOIN mbox.payments p ON p.id=r.payment_id WHERE p.public_id='lab-original-payment'),
      'observations',(SELECT json_agg(json_build_object('id',o.id,'payment',o.payment_id,'status',o.observed_status,'kind',o.verification_kind,'transaction',o.provider_transaction_id,'amount',o.reported_amount_minor,'currency',o.reported_currency,'consumed',o.consumed_at IS NOT NULL)) FROM mbox.verified_provider_observations o JOIN mbox.payments p ON p.id=o.payment_id WHERE p.public_id='lab-original-payment'),
      'providerActions',(SELECT count(*) FROM mbox.payment_provider_actions a JOIN mbox.payments p ON p.id=a.payment_id WHERE p.public_id='lab-original-payment'))""")
    require(all(len(money[k] or []) == 1 for k in ('payments', 'ledger', 'observations')), 'original synthetic callback facts are not unique')
    payment, ledger, observation = [money[k][0] for k in ('payments', 'ledger', 'observations')]
    require(payment['status'] == 'succeeded' and payment['amount'] == ledger['amount'] == observation['amount'] == 100
            and payment['currency'] == ledger['currency'] == observation['currency'] == 'CNY'
            and ledger['type'] == 'payment' and payment['id'] == ledger['payment'] == observation['payment']
            and payment['transaction'] == ledger['reference'] == observation['transaction'] == 'LAB-ORIGINAL-PROVIDER-TX'
            and observation['status'] == 'payment_succeeded' and observation['kind'] == 'callback_signature'
            and observation['consumed'] is True and money['providerActions'] == 0, 'original callback/ledger conservation mismatch')
    duplicate = request(c, c['callbackUrls'][0], P(c['callbackBodyFile']).read_bytes())
    require(duplicate['status'] == 200 and duplicate['body'].get('rspCod') == '000000', 'synthetic duplicate callback not acknowledged')
    after = sql(c, "SELECT json_build_object('ledgerCount',(SELECT count(*) FROM mbox.reconciliation_entries r JOIN mbox.payments p ON p.id=r.payment_id WHERE p.public_id='lab-original-payment'),'observationCount',(SELECT count(*) FROM mbox.verified_provider_observations o JOIN mbox.payments p ON p.id=o.payment_id WHERE p.public_id='lab-original-payment'))")
    require(after == {'ledgerCount': 1, 'observationCount': 1}, 'duplicate callback created extra facts')
    require(financial_snapshot(c) == before_facts, 'duplicate callback changed 237/238 facts')
    sessions = sql(c, "SELECT COALESCE(json_agg(json_build_object('login',usename,'application',application_name)),'[]') FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()")
    require(sessions and all(s['login'] == c['runtimeLogin'] for s in sessions), 'unexpected live database identity')
    require({'mbox-normalized:' + c['targetSha'][:16], 'mbox-normalized-worker:' + c['targetSha'][:16]} <= {s['application'] for s in sessions}, 'both actual runtime pools must be present')
    roles = sql(c, "SELECT json_agg(json_build_object('name',rolname,'login',rolcanlogin,'super',rolsuper,'bypass',rolbypassrls,'createDB',rolcreatedb,'createRole',rolcreaterole,'replication',rolreplication)) FROM pg_roles WHERE rolname IN ('%s','%s')" % (c['retiredLogin'], c['runtimeLogin']))
    runtime = next(r for r in roles if r['name'] == c['runtimeLogin'])
    old = next(r for r in roles if r['name'] == c['retiredLogin'])
    require(runtime['login'] is True and not any(runtime[k] for k in ('super', 'bypass', 'createDB', 'createRole', 'replication')) and old['login'] is False, 'runtime/retired login attributes invalid')
    callbacks = [json.loads(p.read_text()) for p in (directory / 'callbacks').glob('*.json')]
    require(len(callbacks) == 1 and callbacks[0]['status'] == 'acknowledged', 'synthetic spool not uniquely acknowledged')
    containers = json.loads(run(['docker', 'inspect', *run(['docker', 'ps', '-aq']).splitlines()]))
    active = next(container for container in containers if container['Name'] == '/' + c['sourceContainerName'])
    require(active['Image'] == c['platformImageDigest'] and active['State']['Running'] and active['HostConfig']['RestartPolicy']['Name'] == 'unless-stopped', 'active container identity/restart state mismatch')
    actual_image = json.loads(run(['docker', 'image', 'inspect', active['Image']]))[0]
    require(actual_image['Os'] + '/' + actual_image['Architecture'] == c['platform'], 'active platform mismatch')
    retired = next(container for container in containers if container['Id'] == binding['sourceLive']['containerId'])
    require(not retired['State']['Running'] and retired['HostConfig']['RestartPolicy']['Name'] == 'no', 'retired writer is not fenced')
    backup = next(row for row in records if row['event'] == 'backup-verified')
    origin = backup_origin(records, backup)
    require(origin == c['backupOriginSha'], 'actual backup origin differs from explicit expected full SHA')
    origin_release = root / 'releases' / origin[:7]
    require(json.loads((origin_release / 'release-manifest.json').read_text())['releaseSha'] == origin, 'backup origin manifest mismatch')
    data = backup['data']
    require(digest(data['backup']) == data['sha256'] and digest(origin_release / 'oss-maintenance-backup' / P(data['backup']).name) == data['sha256'], 'actual original backup archive changed')
    require(digest(origin_release / 'oss-maintenance-backup/maintenance-restore-verification.json') == data['restoreReportSha256'], 'original restore evidence changed')
    require(digest(release / 'oss-maintenance-backup' / P(data['backup']).name) == data['sha256'], 'forward target did not preserve the exact verified backup')
    reconciliation = json.loads((release / 'maintenance-provider-reconciliation.json').read_text())
    require(reconciliation['queue']['pending'] == reconciliation['queue']['active'] == reconciliation['funds']['blockingCount'] == 0, 'current provider recovery remains blocked')
    result = {'verified': True, 'localOnly': True, 'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'sourceSha': c['targetSha'], 'sourceLiveSha': c['sourceSha'], 'platform': c['platform'], 'imageDigest': c['imageDigest'],
              'platformImageDigest': c['platformImageDigest'], 'schema': c['schema'], 'migration': manifest['migration'],
              'backupOriginSha': origin, 'backupSha256': data['sha256'], 'epochSha256': digest(directory / 'business-write-epoch.json'),
              'journalLastHash': records[-1]['hash'], 'journalEvents': [r['event'] for r in records],
              'financialBaselineSha256': digest(c['financialBaselineFile']), 'financialFacts': before_facts,
              'originalMoneyFactsSha256': hashlib.sha256(canonical(money)).hexdigest(), 'duplicateCallback': {'status': 200, 'rspCod': '000000', **after},
              'runtimePools': sessions, 'runtimeRoleAttributes': roles, 'sourceStoppedRestartNo': True,
              'limits': ['LAB adapters are not GitHub CI/OSS/RAM evidence', 'synthetic signed callback is not a real provider transaction',
                         'local PostgreSQL is not RDS acceptance', 'this verifier does not itself prove formal-entry execution; retain its separate log']}
    P(c['resultFile']).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    config, args = cli('Verify explicit SHA/schema/backup-origin/platform and nonempty 237/238 conservation in isolated LAB', capture=True)
    if config is not None:
        capture(config) if args.capture_financial_baseline else verify(config)
