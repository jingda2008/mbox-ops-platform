#!/usr/bin/env python3
"""Prepare a minimal v25 -> v26 website clone; --activate runs only after backend rc290 is verified.
No accounts, offers or business records are created. Existing website files are copied verbatim,
except data/pages.json navigation. Caddy routes cooperation assets/API to the standard app.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

OLD = 'mbox-public-site-www-v25'
NEW = 'mbox-public-site-www-v26'
ORIGIN = 'https://www.shmbox.com'
LABELS = {'zh': '合作', 'en': 'Partners', 'ru': 'Партнёрам', 'ja': '提携', 'ko': '제휴', 'fr': 'Partenaires', 'de': 'Partner'}


def update_pages(pages):
    result = {}
    for path, html in pages.items():
        language = path.split('/')[1]
        if language not in LABELS or html.count('<nav aria-label="M-BOX">') != 1:
            raise ValueError('Unexpected website navigation: ' + path)
        if '/cooperation/' in html:
            raise ValueError('Cooperation already exists: ' + path)
        result[path] = html.replace('<nav aria-label="M-BOX">', '<nav aria-label="M-BOX"><a class="cooperation-nav" href="/cooperation/">' + LABELS[language] + '</a>', 1)
    if len(result) != 14 or '/zh/' not in result or '/zh/menu/' not in result:
        raise ValueError('Website page set changed; review latest content before preparing')
    return result


def update_caddy(source):
    old = '\treverse_proxy ' + OLD + ':8080 {\n\t\theader_up X-Mbox-Client-Ip {remote_host}\n\t}'
    if source.count(old) != 1 or 'handle /cooperation' in source:
        raise ValueError('Website ingress changed; do not overwrite it')
    new = '''\thandle /cooperation {
        redir /cooperation/ 308
    }
    handle /cooperation/api/* {
        uri replace /cooperation/api/ /api/cooperation/
        reverse_proxy mbox-app:8787
    }
    handle /cooperation/* {
        reverse_proxy mbox-app:8787
    }
    handle {
        reverse_proxy mbox-public-site-www-v26:8080 {
            header_up X-Mbox-Client-Ip {remote_host}
        }
    }'''
    return source.replace(old, new, 1)


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


def fingerprint(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file()}


def prepare(source, target, caddy, evidence):
    if target.exists():
        raise ValueError('Candidate already exists; review it instead of overwriting')
    pages = json.loads((source / 'data/pages.json').read_text())
    updated = update_pages(pages)
    ingress = update_caddy(caddy.read_text())
    before = fingerprint(source)
    shutil.copytree(source, target, symlinks=True)
    (target / 'data/pages.json').write_text(json.dumps(updated, ensure_ascii=False, separators=(',', ':')))
    after = fingerprint(target)
    changed = [name for name in before if before[name] != after.get(name)]
    if changed != ['data/pages.json'] or before.keys() != after.keys():
        raise ValueError('Unexpected website clone changes')
    evidence.mkdir(parents=True, exist_ok=False)
    (evidence / 'Caddyfile.before').write_bytes(caddy.read_bytes())
    (evidence / 'Caddyfile.candidate').write_text(ingress)
    (evidence / 'files-before.json').write_text(json.dumps(before, sort_keys=True))
    (evidence / 'files-after.json').write_text(json.dumps(after, sort_keys=True))
    return {'changedFiles': changed, 'pages': len(updated), 'activated': False}


def activate(target, caddy, evidence, expected_sha):
    if not re.fullmatch(r'[0-9a-f]{40}', expected_sha):
        raise ValueError('Exact backend commit required')
    ready = json.loads(run('curl', '--fail', '--silent', '--show-error', '--max-time', '15', '--resolve', 'mbox.shmbox.com:443:127.0.0.1', 'https://mbox.shmbox.com/api/ready'))
    if ready.get('commitSha') != expected_sha or str(ready.get('schemaVersion')) != '314' or ready.get('status') != 'ready' or ready.get('writeEnabled') is not True:
        raise ValueError('Backend candidate is not ready at schema 314')
    before = (evidence / 'Caddyfile.before').read_bytes()
    if caddy.read_bytes() != before:
        raise ValueError('Ingress changed since preparation')
    info = json.loads(run('docker', 'inspect', OLD))[0]
    if info['HostConfig'].get('PortBindings'):
        raise ValueError('Published website ports require separate review')
    mounts = [m for m in info['Mounts'] if m['Destination'] == '/site']
    if len(mounts) != 1 or mounts[0]['RW'] or Path(mounts[0]['Source']).name != '20261030-venue-v25':
        raise ValueError('Website source mount changed')
    if info['HostConfig'].get('NetworkMode') != 'mbox-net':
        raise ValueError('Website network changed')
    config = info['Config'].copy()
    config['Image'] = info['Image']  # immutable, already-running image
    config.pop('Hostname', None)
    host = info['HostConfig'].copy()
    host['Binds'] = [f'{target}:/site:ro']
    if len(info['Mounts']) != 1:
        raise ValueError('Unexpected website mounts')
    payload = json.dumps({**config, 'HostConfig': host}).encode()
    created = json.loads(run('curl', '--fail', '--silent', '--show-error', '--unix-socket', '/var/run/docker.sock', '-H', 'Content-Type: application/json', '--data-binary', '@-', f'http://localhost/containers/create?name={NEW}', input=payload))
    new_id = created['Id']
    switched = False
    try:
        run('docker', 'start', new_id)
        run('docker', 'exec', new_id, 'node', '--input-type=module', '-e', "let ok=false;for(let i=0;i<20;i++){try{const r=await fetch('http://127.0.0.1:8080/healthz',{headers:{host:'www.shmbox.com'}});if(r.ok){ok=true;break}}catch{}await new Promise(r=>setTimeout(r,250))}if(!ok)process.exit(1)")
        caddy.write_bytes((evidence / 'Caddyfile.candidate').read_bytes())
        switched = True
        run('docker', 'exec', 'mbox-caddy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile')
        run('docker', 'exec', 'mbox-caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile')
        for path, expected in [('/cooperation/', '合作账号登录'), ('/zh/', 'href="/cooperation/"')]:
            body = run('curl', '--fail', '--silent', '--show-error', '--max-time', '30', '--resolve', 'www.shmbox.com:443:127.0.0.1', ORIGIN + path).decode()
            if expected not in body:
                raise ValueError('Website readback mismatch: ' + path)
        response = run('curl', '--silent', '--show-error', '--max-time', '15', '--resolve', 'www.shmbox.com:443:127.0.0.1', '-w', '\n%{http_code}', ORIGIN + '/cooperation/api/partner').decode()
        if not response.endswith('\n401'):
            raise ValueError('Anonymous partner API did not deny access')
        result = {'activated': True, 'container': new_id, 'backendSha': expected_sha, 'schema': 314, 'previousContainer': info['Id']}
        (evidence / 'activation.json').write_text(json.dumps(result, indent=2))
        # Keep the previous container available as a known rollback target until final acceptance.
        return result
    except Exception:
        if switched:
            caddy.write_bytes(before)
            run('docker', 'exec', 'mbox-caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile')
        run('docker', 'stop', new_id)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--caddy', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--activate', action='store_true')
    parser.add_argument('--backend-sha')
    args = parser.parse_args()
    result = activate(args.target, args.caddy, args.evidence, args.backend_sha or '') if args.activate else prepare(args.source, args.target, args.caddy, args.evidence)
    print(json.dumps(result, ensure_ascii=False))
