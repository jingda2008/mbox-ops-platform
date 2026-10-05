#!/usr/bin/env python3
"""Publish a verified Android APK, recheck its public bytes, then atomically CAS the feed.

Run `publish` on an operator machine with Android build-tools. Remote phases run
only from the active, hash-verified release bundle under the shared release lock.
Pre-commit failures never replace an existing APK or channel feed. After commit,
uncertain readback is recovered by retrying the same publication, never rollback.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from urllib.parse import urlsplit

INSTALL_ROOT = Path('/opt/mbox')
ORIGIN = 'https://mbox.shmbox.com'
PREFIX = '/native-updates/staff/'
MAX_APK_BYTES = 256 * 1024 * 1024
MAX_FEED_BYTES = 65536
SHA256 = re.compile(r'^[a-f0-9]{64}$')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def unlink_if_present(path):
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def apk_name(item):
    url = urlsplit(item.get('url', ''))
    name = url.path[len(PREFIX):] if url.path.startswith(PREFIX) else ''
    require(url.scheme == 'https' and url.netloc == 'mbox.shmbox.com'
            and not url.query and not url.fragment and url.path == PREFIX + name
            and re.fullmatch(r'MBOX-Staff-[A-Za-z0-9][A-Za-z0-9._-]{0,39}-build[1-9][0-9]{0,9}-[a-f0-9]{12,64}\.apk', name)
            and '..' not in name, 'APK URL must be a single immutable filename on the fixed HTTPS origin')
    require(SHA256.fullmatch(item.get('sha256', '')) is not None, 'APK SHA256 is invalid')
    hash_part = name.rsplit('-', 1)[-1][:-4]
    require(item['sha256'].startswith(hash_part) and name == f"MBOX-Staff-{item['version']}-build{item['build']}-{hash_part}.apk", 'APK filename must match the build, version and content hash')
    return name


def validate_release(item):
    require(isinstance(item, dict) and item.get('platform') == 'android'
            and item.get('appId') == 'com.mbox.staff.nativeapp' and item.get('delivery') == 'apk', 'Android release identity is invalid')
    require(type(item.get('bytes')) is int and 0 < item['bytes'] <= MAX_APK_BYTES, 'APK byte length is invalid')
    require(type(item.get('build')) is int and 0 < item['build'] <= 2100000000, 'APK build is invalid')
    require(isinstance(item.get('version'), str) and 0 < len(item['version']) <= 40, 'APK version is invalid')
    require(isinstance(item.get('minimumOS'), str) and re.fullmatch(r'\d{2,3}', item['minimumOS']) and 26 <= int(item['minimumOS']) <= 100, 'APK minimum OS is invalid')
    require(item.get('priority') in ['normal', 'urgent'] and isinstance(item.get('notes'), str)
            and 0 < len(item['notes'].strip()) <= 6000, 'Release guidance is invalid')
    return apk_name(item)


def validate_feed(feed, channel):
    require(isinstance(feed, dict) and feed.get('schemaVersion') == 1 and feed.get('channel') == channel
            and isinstance(feed.get('releases'), list), 'Channel feed is invalid')
    platforms = [row.get('platform') if isinstance(row, dict) else None for row in feed['releases']]
    require(all(value in ['android', 'ios'] for value in platforms) and len(set(platforms)) == len(platforms), 'Duplicate or unknown feed platforms')
    return feed


def read_feed(root, channel):
    path = root / f'{channel}.json'
    require(not path.is_symlink(), 'Channel feed must not be a symlink')
    if not path.exists():
        return {'schemaVersion': 1, 'channel': channel, 'releases': []}, 'absent'
    require(path.is_file() and path.stat().st_size <= MAX_FEED_BYTES
            and path.stat().st_uid == os.geteuid() and not path.stat().st_mode & 0o022, 'Existing feed is not a bounded operator-owned file')
    data = path.read_bytes()
    return validate_feed(json.loads(data), channel), digest(data)


def verify_apk(path, item, channel, args):
    validate_release(item)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size == item['bytes']
            and file_digest(path) == item['sha256'], 'APK bytes differ from the proposed release')
    require(SHA256.fullmatch(args.certificate_sha256.lower()) is not None, 'A pinned certificate SHA256 is required')
    spec = importlib.util.spec_from_file_location('native_update_prepare', args.prepare_script)
    require(spec is not None and spec.loader is not None, 'Missing prepare-update verifier')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    require(callable(getattr(module, 'verify_android_manifest', None)), 'Use the updated verifier with packaged channel/demo checks')
    with tempfile.TemporaryDirectory(prefix='mbox-apk-verify-') as directory:
        notes = Path(directory) / 'notes.txt'
        notes.write_text(item['notes'], encoding='utf-8')
        actual = module.prepare(SimpleNamespace(platform='android', channel=channel, output=Path(directory) / 'feed.json', notes=notes,
            url=item['url'], priority=item['priority'], apk=path, aapt=args.aapt, apksigner=args.apksigner,
            certificate_sha256=args.certificate_sha256))
    require(actual == item, 'Packaged APK metadata differs from the proposed feed')
    return {'sha256': item['sha256'], 'bytes': item['bytes'], 'certificateSha256': args.certificate_sha256.lower(),
            'channel': channel, 'url': item['url'], 'apkDebuggable': False, 'allowLocalDemo': False}


def secure_directory(path, create=False, mode=0o755):
    # Parent directories are checked before creation; no symlink or untrusted
    # writer can redirect an immutable APK or the atomic feed destination.
    if path.parent != path:
        secure_directory(path.parent)
    if create and not path.exists():
        path.mkdir(mode=mode)
    require(path.is_dir() and not path.is_symlink(), 'Deployment directory must be a real directory')
    stat = path.stat()
    require(stat.st_uid == 0 and not stat.st_mode & 0o022, 'Deployment directory must be root-owned and not group/world writable')


def distribution_root():
    root = INSTALL_ROOT / 'native-updates' / 'staff'
    secure_directory(INSTALL_ROOT / 'native-updates', create=True)
    secure_directory(root, create=True)
    return root


@contextmanager
def deployment_lock():
    directory = INSTALL_ROOT / 'locks'
    secure_directory(directory, create=True, mode=0o700)
    path = directory / 'release.lock'
    require(not path.is_symlink(), 'Release lock must not be a symlink')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        require(os.fstat(fd).st_uid == 0, 'Release lock owner is invalid')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def assert_deployment(args):
    require(os.geteuid() == 0, 'Remote phases require the deployment operator root account')
    release = Path(args.release_dir)
    require(release.parent == INSTALL_ROOT / 'releases' and re.fullmatch(r'[A-Za-z0-9_.-]+', release.name)
            and not release.is_symlink(), 'Release directory is outside the fixed installation root')
    require((INSTALL_ROOT / 'current').resolve(strict=True) == release.resolve(strict=True), 'Active release changed; publication refused')
    secure_directory(release)
    manifest_path = release / 'release-manifest.json'
    require(not manifest_path.is_symlink() and manifest_path.stat().st_uid == 0
            and not manifest_path.stat().st_mode & 0o022, 'Release manifest ownership or permissions are invalid')
    manifest = json.loads(manifest_path.read_text())
    require(manifest.get('releaseSha') == args.expected_live_sha and re.fullmatch(r'[a-f0-9]{40}', args.expected_live_sha), 'Release SHA does not match the publication target')
    source = Path(__file__).resolve()
    require(source == release / 'publish-native-update.py', 'Run the frozen publisher from the active release bundle')
    scripts = manifest.get('deploymentScripts', {})
    entries = [entry for entry in scripts.values() if entry.get('file') == source.name]
    require(len(entries) == 1 and entries[0].get('sha256') == file_digest(source), 'Publisher hash does not match the release bundle')
    ready = subprocess.run(['docker', 'exec', 'mbox-app', 'wget', '-q', '-O', '-', 'http://127.0.0.1:8787/api/ready'], check=True, capture_output=True, timeout=20)
    health = json.loads(ready.stdout)
    require(health.get('status') == 'ready' and health.get('commitSha') == args.expected_live_sha
            and health.get('releaseImageDigest') == manifest.get('imageDigest'), 'Running service does not match the publication target')


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def stage_apk(root, item, source):
    name = validate_release(item)
    target = root / name
    require(not target.is_symlink(), 'APK target must not be a symlink')
    replayed = target.exists()
    if replayed:
        require(target.is_file() and target.stat().st_uid == os.geteuid() and not target.stat().st_mode & 0o022
                and target.stat().st_size == item['bytes'] and file_digest(target) == item['sha256'], 'Immutable APK filename already contains different bytes')
    fd, temporary = tempfile.mkstemp(prefix='.apk-stage-', dir=root)
    try:
        total = 0
        hashed = hashlib.sha256()
        with os.fdopen(fd, 'wb') as output:
            while True:
                chunk = source.read(min(1024 * 1024, item['bytes'] - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                require(total <= item['bytes'], 'Uploaded APK exceeds its declared byte length')
                output.write(chunk)
                hashed.update(chunk)
            require(total == item['bytes'] and hashed.hexdigest() == item['sha256'], 'Uploaded APK byte length or SHA256 mismatch')
            output.flush()
            os.fsync(output.fileno())
            os.fchmod(output.fileno(), 0o644)
        # Hard-link creation is exclusive; never overwrite an immutable file.
        if not replayed:
            os.link(temporary, target)
            sync_directory(root)
    finally:
        unlink_if_present(Path(temporary))
    return {'staged': True, 'replayed': replayed, 'sha256': item['sha256']}


def commit_feed(root, channel, expected_digest, item, verification, certificate):
    name = validate_release(item)
    expected = {'sha256': item['sha256'], 'bytes': item['bytes'], 'certificateSha256': certificate.lower(),
                'channel': channel, 'url': item['url'], 'apkDebuggable': False, 'allowLocalDemo': False, 'source': 'public_https_reverified'}
    require(SHA256.fullmatch(certificate.lower()) and verification == expected, 'Missing matching public HTTPS APK verification')
    target = root / name
    require(target.is_file() and not target.is_symlink() and target.stat().st_uid == os.geteuid()
            and not target.stat().st_mode & 0o022 and target.stat().st_size == item['bytes']
            and file_digest(target) == item['sha256'], 'Staged APK does not match the publicly verified bytes')
    feed, current_digest = read_feed(root, channel)
    previous = next((row for row in feed['releases'] if row['platform'] == 'android'), None)
    if previous == item:
        return {'published': True, 'replayed': True, 'feedSha256': current_digest}
    require(current_digest == expected_digest, 'Channel changed after inspection; re-read and retry the original publication')
    require(previous is None or (type(previous.get('build')) is int and item['build'] > previous['build']
            and item['url'] != previous.get('url')), 'Android build must increase with a new immutable APK URL')
    feed['releases'] = [row for row in feed['releases'] if row['platform'] != 'android'] + [item]
    data = encode(feed)
    require(len(data) <= MAX_FEED_BYTES, 'Updated feed exceeds 64 KiB')
    fd, temporary = tempfile.mkstemp(prefix='.feed-publish-', dir=root)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
            os.fchmod(output.fileno(), 0o644)
        os.replace(temporary, root / f'{channel}.json')
        sync_directory(root)
    finally:
        unlink_if_present(Path(temporary))
    return {'published': True, 'replayed': False, 'feedSha256': digest(data)}


def ssh_command(args, phase):
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,252}', args.ssh_host), 'SSH host is invalid')
    require(re.fullmatch(r'/opt/mbox/releases/[A-Za-z0-9_.-]+', args.release_dir), 'Remote release directory is invalid')
    require(re.fullmatch(r'[a-f0-9]{40}', args.expected_live_sha), 'Expected live SHA is invalid')
    remote_python = getattr(args, 'remote_python', '/usr/bin/python3')
    require(isinstance(remote_python, str) and re.fullmatch(r'/[A-Za-z0-9_./-]+', remote_python)
            and '..' not in remote_python.split('/'), 'Remote Python must be an explicit absolute executable path')
    port = getattr(args, 'ssh_port', 6122)
    require(type(port) is int and 1 <= port <= 65535, 'SSH port is invalid')
    identity = Path(getattr(args, 'identity_file', Path.home() / '.ssh/mbox_aliyun_ed25519')).expanduser()
    require(identity.is_absolute(), 'SSH identity path must be absolute')
    command = [remote_python, args.release_dir + '/publish-native-update.py', phase, '--release-dir', args.release_dir,
               '--expected-live-sha', args.expected_live_sha, '--channel', args.channel]
    return ['ssh', '-p', str(port), '-i', str(identity), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', args.ssh_host, ' '.join(shlex.quote(part) for part in command)]


def remote_json(args, phase, payload=None):
    result = subprocess.run(ssh_command(args, phase), input=encode(payload) if payload else None, check=True, capture_output=True, timeout=180)
    return json.loads(result.stdout)


def fetch_public(url, target, origin_ip=None):
    parsed = urlsplit(url)
    require(parsed.scheme == 'https' and parsed.netloc == 'mbox.shmbox.com' and not parsed.query and not parsed.fragment, 'Public verification must use the fixed HTTPS origin')
    command = ['curl', '--fail', '--silent', '--show-error', '--proto', '=https', '--tlsv1.2', '--connect-timeout', '10', '--max-time', '180', '--max-filesize', str(MAX_APK_BYTES)]
    if origin_ip:
        address = ipaddress.ip_address(origin_ip)
        resolved = f'[{address}]' if address.version == 6 else str(address)
        command += ['--noproxy', '*', '--resolve', f'mbox.shmbox.com:443:{resolved}']
    subprocess.run(command + ['--output', str(target), url], check=True, timeout=190)


def publish(args):
    feed = validate_feed(json.loads(args.feed.read_text()), args.channel)
    rows = [row for row in feed['releases'] if row['platform'] == 'android']
    require(len(rows) == 1, 'Candidate must include exactly one Android release')
    item = rows[0]
    verify_apk(args.apk, item, args.channel, args)
    original = remote_json(args, 'inspect')
    require(original.get('publisherSha256') == file_digest(Path(__file__).resolve()), 'Local and frozen remote publishers differ')
    # A bounded local stream lets subprocess enforce a timeout for the entire
    # transfer, including a remote process that stops reading upload bytes.
    with tempfile.TemporaryFile() as upload:
        upload.write(json.dumps(item).encode() + b'\n')
        with args.apk.open('rb') as package:
            while True:
                chunk = package.read(1024 * 1024)
                if not chunk:
                    break
                upload.write(chunk)
        upload.seek(0)
        staged = subprocess.run(ssh_command(args, 'stage'), stdin=upload, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        require(json.loads(staged.stdout).get('staged') is True, 'Remote APK stage was not confirmed')
    with tempfile.TemporaryDirectory(prefix='mbox-public-apk-') as directory:
        downloaded = Path(directory) / 'verified.apk'
        fetch_public(item['url'], downloaded, args.origin_ip)
        proof = verify_apk(downloaded, item, args.channel, args)
        proof['source'] = 'public_https_reverified'
        outcome = remote_json(args, 'commit', {'expectedFeedSha256': original['feedSha256'], 'release': item,
            'verification': proof, 'certificateSha256': args.certificate_sha256.lower()})
        # A feedback failure here is recovered by repeating the SAME publication;
        # no automatic feed rollback can overwrite another operator's newer feed.
        fetched_feed = Path(directory) / 'channel.json'
        fetch_public(ORIGIN + PREFIX + args.channel + '.json', fetched_feed, args.origin_ip)
        live = validate_feed(json.loads(fetched_feed.read_text()), args.channel)
        require(next((row for row in live['releases'] if row['platform'] == 'android'), None) == item, 'Feed commit may have succeeded but public readback differs; retry the same publication')
    return {**outcome, 'channel': args.channel, 'build': item['build'], 'url': item['url'], 'publicReadbackVerified': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['verify', 'publish', 'inspect', 'stage', 'commit'])
    parser.add_argument('--channel', choices=['stable', 'preview'], required=True)
    parser.add_argument('--release-dir')
    parser.add_argument('--expected-live-sha')
    parser.add_argument('--ssh-host')
    parser.add_argument('--ssh-port', type=int, default=6122)
    parser.add_argument('--identity-file', type=Path, default=Path.home() / '.ssh/mbox_aliyun_ed25519')
    parser.add_argument('--remote-python', default='/usr/bin/python3', help='Absolute Python 3.7+ executable; never uses a pyenv shim')
    parser.add_argument('--origin-ip')
    parser.add_argument('--apk', type=Path)
    parser.add_argument('--feed', type=Path)
    parser.add_argument('--certificate-sha256')
    parser.add_argument('--aapt', type=Path)
    parser.add_argument('--apksigner', type=Path)
    parser.add_argument('--prepare-script', type=Path, default=Path(__file__).resolve().parents[2] / 'native/staff-app/scripts/prepare-update.py')
    args = parser.parse_args()
    try:
        if args.phase in ['verify', 'publish']:
            require(all([args.apk, args.feed, args.certificate_sha256, args.aapt, args.apksigner]), 'APK, feed, Android tools and pinned certificate are required')
            if args.phase == 'publish':
                result = publish(args)
            else:
                feed = validate_feed(json.loads(args.feed.read_text()), args.channel)
                items = [row for row in feed['releases'] if row['platform'] == 'android']
                require(len(items) == 1, 'Candidate must include one Android release')
                result = {**verify_apk(args.apk, items[0], args.channel, args), 'published': False}
        else:
            with deployment_lock():
                assert_deployment(args)
                root = distribution_root()
                if args.phase == 'inspect':
                    feed, sha = read_feed(root, args.channel)
                    result = {'feedSha256': sha, 'feed': feed, 'publisherSha256': file_digest(Path(__file__).resolve())}
                elif args.phase == 'stage':
                    line = sys.stdin.buffer.readline(MAX_FEED_BYTES + 1)
                    require(len(line) <= MAX_FEED_BYTES and line.endswith(b'\n'), 'APK stage metadata is invalid')
                    result = stage_apk(root, json.loads(line), sys.stdin.buffer)
                else:
                    raw = sys.stdin.buffer.read(MAX_FEED_BYTES + 1)
                    require(len(raw) <= MAX_FEED_BYTES, 'Publication metadata is too large')
                    value = json.loads(raw)
                    result = commit_feed(root, args.channel, value['expectedFeedSha256'], value['release'], value['verification'], value['certificateSha256'])
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        parser.exit(1, f'Publication stopped: {error}\n')


if __name__ == '__main__':
    main()
