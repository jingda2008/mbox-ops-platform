"""External LAB fixture parameters. Import/validation never starts a process."""
import argparse
import configparser
import hashlib
import json
import os
import pathlib
import re
import socket
import subprocess

PATH_KEYS = (
    'runtimeRoot', 'sourceDirectory', 'bundleDirectory', 'sourceReleaseDirectory',
    'imageArchive', 'sourceShaFile', 'formalEntryScript', 'playwrightModule',
    'playwrightBrowsers', 'tlsCaFile', 'sshKeyFile', 'pgServiceFile', 'pgPassFile',
    'labMarkerFile', 'labBinDirectory', 'objectStoreDirectory', 'objectTransferLog',
    'callbackBodyFile', 'financialBaselineFile', 'resultFile',
)
TEXT_KEYS = (
    'labId', 'controllerHostname', 'targetSha', 'sourceSha', 'backupOriginSha',
    'imageTag', 'imageDigest', 'platformImageDigest', 'platform', 'version',
    'transitionId', 'sourceContainerName', 'runtimeLogin', 'retiredLogin',
    'migrationService', 'clusterAdminService', 'labCiRunId',
)
OTHER_KEYS = ('schema', 'callbackUrls', 'systemdUnits', 'persistentMounts')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def read_config(path):
    config = json.loads(pathlib.Path(path).read_text())
    require(isinstance(config, dict), 'config must be an object')
    expected = set(PATH_KEYS + TEXT_KEYS + OTHER_KEYS)
    require(set(config) == expected, 'config has missing or unknown keys; use the supplied template')
    for key in PATH_KEYS + TEXT_KEYS:
        require(isinstance(config[key], str) and config[key].strip() == config[key] and bool(config[key]), 'invalid string parameter: ' + key)
    for key in ('targetSha', 'sourceSha', 'backupOriginSha'):
        require(re.fullmatch('[a-f0-9]{40}', config[key]), key + ' must be a full lowercase SHA')
    for key in ('imageDigest', 'platformImageDigest'):
        require(re.fullmatch('sha256:[a-f0-9]{64}', config[key]), key + ' must be an exact digest')
    require(type(config['schema']) is int and config['schema'] >= 238, 'schema must explicitly include 237 and 238')
    require(config['platform'] in ('linux/amd64', 'linux/arm64'), 'unsupported explicit platform')
    require(re.fullmatch(r'1\.0\.0-rc\.[0-9]+(?:\.[A-Za-z0-9.-]+)?', config['version']), 'invalid version')
    require(re.fullmatch(r'audit-[a-z0-9./_-]+:[a-zA-Z0-9_.-]+', config['imageTag']), 'image tag must be an explicit audit- LAB tag')
    for key in ('labId', 'controllerHostname', 'transitionId', 'sourceContainerName'):
        require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{2,95}', config[key]), 'invalid LAB identity: ' + key)
    require(config['controllerHostname'].startswith(('mbox-maint-lab-', 'audit-')), 'hostname must identify an isolated LAB')
    for key in ('runtimeLogin', 'retiredLogin', 'migrationService', 'clusterAdminService'):
        require(re.fullmatch('[a-z_][a-z0-9_]{2,62}', config[key]), 'invalid local role/service parameter: ' + key)
    require(config['runtimeLogin'] != config['retiredLogin'], 'runtime and retired login must differ')
    require(re.fullmatch('[0-9]+', config['labCiRunId']), 'LAB CI fixture identifier must be numeric')
    for key in PATH_KEYS:
        value = pathlib.PurePosixPath(config[key])
        require(value.is_absolute() and '..' not in value.parts and str(value) != '/', 'invalid absolute LAB path: ' + key)
    require(config['sourceDirectory'] != config['bundleDirectory'], 'source and bundle paths must differ')
    require(config['sourceReleaseDirectory'] == str(pathlib.PurePosixPath(config['runtimeRoot']) / 'releases' / config['sourceSha'][:7]), 'source release directory must bind the full source SHA')
    require(config['callbackUrls'] == [
        'https://payments.localhost/api/payments/providers/postar/callback',
        'https://payments.localhost/api/refunds/providers/postar/callback',
    ], 'only the exact synthetic localhost callbacks are allowed')
    require(isinstance(config['systemdUnits'], list) and all(isinstance(v, str) and re.fullmatch(r'[A-Za-z0-9_.@-]+\.service', v) for v in config['systemdUnits']), 'invalid explicit LAB systemd inventory')
    require(isinstance(config['persistentMounts'], list), 'persistentMounts must be explicit')
    for mount in config['persistentMounts']:
        require(set(mount) == {'type', 'source', 'target', 'readOnly'} and mount['type'] == 'bind' and type(mount['readOnly']) is bool, 'invalid bind mount')
        require(all(isinstance(mount[k], str) and mount[k].startswith('/') and '..' not in pathlib.PurePosixPath(mount[k]).parts for k in ('source', 'target')), 'invalid bind mount path')
        require('docker.sock' not in mount['source'], 'host Docker socket mounts are forbidden')
    return config


def cli(description, capture=False):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument('--config', required=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--validate-only', action='store_true')
    modes.add_argument('--execute-lab', action='store_true')
    if capture:
        parser.add_argument('--capture-financial-baseline', action='store_true')
    args = parser.parse_args()
    config = read_config(args.config)
    if not args.execute_lab:
        print(json.dumps({'parametersValid': True, 'executed': False, 'labOnly': True,
                          'targetSha': config['targetSha'], 'schema': config['schema'], 'platform': config['platform']}))
        return None, args
    assert_isolated_lab(config)
    return config, args


def allowed_lab_mount(row, root_row):
    fields, root_fields = row.split(), root_row.split()
    mountpoint = fields[4]
    separator, root_separator = fields.index('-'), root_fields.index('-')
    if mountpoint in ('/', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf') or any(
            mountpoint == prefix or mountpoint.startswith(prefix + '/') for prefix in ('/proc', '/sys', '/dev', '/run', '/tmp')):
        return True
    # Dockerd creates this private self-bind in its own root filesystem.
    # Require identical device, filesystem/source/options and exact subtree;
    # a different filesystem or arbitrary host subtree must fail closed.
    if mountpoint == '/var/lib/docker':
        return (fields[2] == root_fields[2]
                and fields[3] == root_fields[3].rstrip('/') + '/var/lib/docker'
                and fields[separator + 1:] == root_fields[root_separator + 1:])
    # The only other nested data mount admitted is a generated per-container
    # shared-memory tmpfs. Outer Docker inspection still forbids all binds.
    return bool(re.fullmatch(r'/var/lib/docker/containers/[a-f0-9]{64}/mounts/shm', mountpoint)
                and fields[separator + 1:separator + 3] == ['tmpfs', 'shm'])


def assert_isolated_lab(config):
    require(pathlib.Path('/.dockerenv').is_file(), 'execution requires an isolated disposable LAB container')
    require(socket.gethostname() == config['controllerHostname'], 'LAB hostname mismatch')
    marker = json.loads(pathlib.Path(config['labMarkerFile']).read_text())
    require(marker == {'labId': config['labId'], 'controllerHostname': config['controllerHostname'],
                       'isolatedNestedDocker': True, 'externalNetwork': False}, 'LAB marker does not match explicit isolation inventory')
    require(not any(os.environ.get(k) for k in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'SSH_CONNECTION')), 'remote Docker/SSH execution environment is not allowed')
    mounts = pathlib.Path('/proc/self/mountinfo').read_text().splitlines()
    require(not any('docker.sock' in line for line in mounts), 'host-mounted Docker socket is forbidden')
    # Original handoff copies assets with docker cp; it does not bind arbitrary
    # host source/production directories into this privileged disposable host.
    roots = [row for row in mounts if row.split()[4] == '/']
    require(len(roots) == 1, 'ambiguous LAB root filesystem')
    for row in mounts:
        require(allowed_lab_mount(row, roots[0]),
                'unexpected mounted directory: ' + row.split()[4] + '; LAB must not expose host data')
    routes = pathlib.Path('/proc/net/route').read_text().splitlines()[1:]
    require(not any(row.split()[1] == '00000000' for row in routes if len(row.split()) > 1), 'LAB must have no IPv4 default route')
    ipv6_routes = pathlib.Path('/proc/net/ipv6_route').read_text().splitlines()
    require(not any(row.split()[0] == '0' * 32 and row.split()[1] == '00' and row.split()[-1] != 'lo'
                    for row in ipv6_routes if len(row.split()) >= 10), 'LAB must have no external IPv6 default route')
    arch = {'x86_64': 'linux/amd64', 'aarch64': 'linux/arm64'}.get(os.uname().machine)
    require(arch == config['platform'], 'real kernel architecture differs from explicit platform')
    # Never put passwords into config, command lines or output. Protected existing
    # LAB service/pass files supply credentials only when execution is authorized.
    services = configparser.ConfigParser(interpolation=None)
    services.read(config['pgServiceFile'])
    for name in (config['migrationService'], config['clusterAdminService']):
        require(services.has_section(name), 'required local PG service missing')
        section = services[name]
        require(section.get('host') in ('localhost', '127.0.0.1', '::1'), 'PG service is not loopback')
        require(section.get('hostaddr', section['host']) in ('localhost', '127.0.0.1', '::1'), 'PG hostaddr is not loopback')
        require(not section.get('service'), 'chained PG services are not allowed')
    require(pathlib.Path(config['pgPassFile']).stat().st_mode & 0o077 == 0, 'PG pass file must be private')


def run(args, env=None):
    args = [str(v) for v in args]
    if args[0] == 'docker':
        args = ['docker', '--host', 'unix:///var/run/docker.sock', *args[1:]]
    result = subprocess.run(args, env={**os.environ, **(env or {})}, text=True, capture_output=True)
    # Raw stderr may contain URLs or credentials. Keep it out of the evidence.
    require(result.returncode == 0, 'LAB subprocess failed: ' + pathlib.Path(args[0]).name + ' (output suppressed)')
    return result.stdout.strip()


def digest(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def sql(config, query):
    env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    env.update(PGSERVICEFILE=config['pgServiceFile'], PGPASSFILE=config['pgPassFile'])
    # `run` merges environments; explicitly erase caller-supplied PG overrides.
    env.update({key: '' for key in os.environ if key.startswith('PG') and key not in env})
    return json.loads(run(['psql', '-XqAt', '--dbname=service=' + config['migrationService'], '-v', 'ON_ERROR_STOP=1',
                          '-c', "BEGIN READ ONLY; SET LOCAL timezone='UTC'; " + query + '; COMMIT'], env))


FINANCIAL_TABLES = {
    'order_recollection_item_restorations': ['amount_minor'],
    'loyalty_recollection_restorations': ['eligible_amount_minor', 'points_delta', 'growth_delta',
                                        'credited_points', 'released_recovery_points', 'expired_points'],
    'order_financial_recovery_requests': [],
    'order_financial_recovery_decisions': [],
    'order_financial_recovery_command_receipts': [],
}


def financial_snapshot(config):
    pairs = []
    for table, sums in FINANCIAL_TABLES.items():
        columns = ["'count',count(*)", "'rowsSha256',encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(row)::text,E'\\n' ORDER BY to_jsonb(row)::text),''),'UTF8')),'hex')"]
        columns += ["'%s',COALESCE(sum(%s),0)" % (field, field) for field in sums]
        pairs += ["'%s',(SELECT json_build_object(%s) FROM mbox.%s row)" % (table, ','.join(columns), table)]
    result = sql(config, 'SELECT json_build_object(' + ','.join(pairs) + ')')
    require(all(result[t]['count'] > 0 for t in FINANCIAL_TABLES), '237/238 conservation requires nonempty real LAB recovery facts in all five tables')
    return result
