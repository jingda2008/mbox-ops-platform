#!/usr/bin/env python3
"""Prepare an update feed locally. Never uploads, signs, installs or replaces server files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlsplit

PREFIX = '/native-updates/staff/'

def require(ok, message):
    if not ok:
        raise ValueError(message)

def trusted_apk_url(value):
    u = urlsplit(value)
    return (u.scheme == 'https' and u.netloc == 'mbox.shmbox.com' and not u.query and not u.fragment
            and re.fullmatch(r'/native-updates/staff/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.apk', u.path)
            and '..' not in u.path and '//' not in u.path)

def verify_android_manifest(xml, channel):
    """Read packaged metadata, not build filenames or the caller's claimed variant."""
    # aapt's indentation is the XML hierarchy. Only application-owned metadata is
    # available through PackageInfo.applicationInfo.metaData in AndroidUpdater.
    stack = []
    applications = []
    entries = []
    for line in xml.splitlines():
        element = re.match(r'^(\s*)E: ([^\s(]+)(?:\s|$)', line)
        if element:
            depth = len(element[1])
            while stack and stack[-1]['depth'] >= depth:
                stack.pop()
            parent = stack[-1] if stack else None
            node = {'depth': depth, 'tag': element[2], 'attributes': {}}
            if node['tag'] == 'application' and parent and parent['tag'] == 'manifest':
                applications.append(node)
            if node['tag'] == 'meta-data' and parent and any(parent is app for app in applications):
                entries.append(node)
            stack.append(node)
            continue
        attribute = re.match(r'^\s*A: android:(name|value)(?:\([^)]*\))?=(.*)$', line)
        if attribute and stack:
            require(attribute[1] not in stack[-1]['attributes'], 'APK存在重复发布属性')
            stack[-1]['attributes'][attribute[1]] = attribute[2].strip()
    require(len(applications) == 1, 'APK必须具有唯一application配置')
    metadata = {}
    for node in entries:
        name = re.match(r'^"([^"]+)"(?:\s|$)', node['attributes'].get('name', ''))
        value = node['attributes'].get('value')
        if name and value is not None:
            require(name[1] not in metadata, 'APK存在重复发布元数据')
            metadata[name[1]] = value
    channel_value = metadata.get('com.mbox.staff.UPDATE_CHANNEL', '')
    require(channel_value.split(' (Raw:', 1)[0] == json.dumps(channel), 'APK实际更新渠道与清单不匹配或缺少渠道证明')
    require(metadata.get('com.mbox.staff.ALLOW_LOCAL_DEMO') == '(type 0x12)0x0', 'APK未证明已禁用本地演练')

def prepare(args):
    notes = args.notes.read_text(encoding='utf-8').strip()
    require(0 < len(notes) <= 6000, '更新说明必须为1—6000字')
    require(args.output.resolve() != args.notes.resolve(), '不能覆盖更新说明源文件')
    raw = json.loads(args.output.read_text()) if args.output.exists() else {'schemaVersion': 1, 'channel': args.channel, 'releases': []}
    require(raw.get('schemaVersion') == 1 and raw.get('channel') == args.channel and isinstance(raw.get('releases'), list), '已有更新渠道不兼容')
    item = dict(platform=args.platform, priority=args.priority, notes=notes, url=args.url)
    if args.platform == 'android':
        require(args.apk and args.apk.is_file() and args.aapt and args.apksigner and args.certificate_sha256, 'Android必须提供APK、aapt、apksigner及固定证书SHA256')
        require(re.fullmatch(r'[a-fA-F0-9]{64}', args.certificate_sha256), '固定签名证书SHA256必须为64位十六进制')
        require(trusted_apk_url(args.url), 'APK必须位于本站native-updates/staff HTTPS路径')
        require(args.output.resolve() != args.apk.resolve(), '不能覆盖安装包')
        # apksigner verifies all package signatures; this is not just a certificate filename check.
        signature = subprocess.run([str(args.apksigner), 'verify', '--print-certs', str(args.apk)], check=True, capture_output=True, text=True).stdout
        require('android debug' not in signature.lower() and 'androiddebugkey' not in signature.lower(), '禁止发布调试签名；请使用长期保存的正式签名')
        signers = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)$', signature, re.M)
        require(len(signers) == 1 and signers[0].lower() == args.certificate_sha256.lower(), '证书与指定长期签名不一致')
        badging = subprocess.run([str(args.aapt), 'dump', 'badging', str(args.apk)], check=True, capture_output=True, text=True).stdout
        require(not re.search(r'^application-debuggable\s*$', badging, re.M), '禁止发布可调试APK；请使用release构建')
        manifest = subprocess.run([str(args.aapt), 'dump', 'xmltree', str(args.apk), 'AndroidManifest.xml'], check=True, capture_output=True, text=True).stdout
        verify_android_manifest(manifest, args.channel)
        package = re.search(r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging, re.M)
        minimum = re.search(r"^sdkVersion:'(\d+)'", badging, re.M)
        require(package is not None and minimum is not None, '不能读取APK版本及系统要求')
        app_id, build, version = package.groups()
        require(app_id == 'com.mbox.staff.nativeapp', 'APK包名不匹配')
        size = args.apk.stat().st_size
        require(0 < size <= 256 * 1024 * 1024 and 0 < int(build) <= 2100000000 and 26 <= int(minimum[1]) <= 100, 'APK版本、大小或系统要求越界')
        with args.apk.open('rb') as package_file:
            digest = hashlib.file_digest(package_file, 'sha256').hexdigest()
        item.update(appId=app_id, build=int(build), version=version, minimumOS=minimum[1], delivery='apk', bytes=size, sha256=digest)
    else:
        require(args.build and args.build > 0 and args.version and 0 < len(args.version) <= 40, 'iOS必须提供真实已分发的版本和整数构建号')
        require(args.minimum_os and re.fullmatch(r'[0-9]{1,2}(\.[0-9]{1,2}){0,2}', args.minimum_os), 'iOS系统版本无效')
        u = urlsplit(args.url)
        require(u.scheme == 'https' and not u.query and not u.fragment and not u.username and not u.password and u.port is None, 'iOS更新必须使用官方HTTPS入口')
        require(args.channel != 'stable' or args.delivery == 'appstore', '正式iOS渠道必须使用App Store分发入口')
        if args.delivery == 'testflight':
            require(u.netloc == 'testflight.apple.com' and re.fullmatch(r'/join/[A-Za-z0-9]+', u.path), 'TestFlight邀请链接无效')
        else:
            require(args.delivery == 'appstore' and u.netloc == 'apps.apple.com' and re.fullmatch(r'/(?:[a-z]{2}/)?app/(?:[^/]+/)?id[0-9]+', u.path), 'App Store链接无效')
        item.update(appId='com.mbox.staff.native', build=args.build, version=args.version, minimumOS=args.minimum_os, delivery=args.delivery)
    require(0 < len(item['version']) <= 40, '版本名称过长')
    previous = [r for r in raw['releases'] if r.get('platform') == args.platform]
    require(len(previous) <= 1 and (not previous or item['build'] > previous[0]['build']), '新构建号必须严格递增；不要覆盖已发布原版本')
    if args.platform == 'android':
        require(not previous or previous[0].get('url') != item['url'], '新APK必须使用新的不可变地址，不能覆盖旧安装包')
    raw['releases'] = [r for r in raw['releases'] if r.get('platform') != args.platform] + [item]
    content = (json.dumps(raw, ensure_ascii=False, indent=2) + '\n').encode()
    require(len(content) <= 65536, '更新清单超过64KB')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.update-', dir=args.output.parent)
    try:
        with os.fdopen(fd, 'wb') as target:
            target.write(content); target.flush(); os.fsync(target.fileno())
        os.replace(temporary, args.output)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    return item

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('platform', choices=['ios', 'android'])
    p.add_argument('--channel', choices=['preview','stable'], default='preview')
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--notes', required=True, type=Path)
    p.add_argument('--url', required=True)
    p.add_argument('--priority', choices=['normal', 'urgent'], default='normal')
    p.add_argument('--apk', type=Path); p.add_argument('--aapt', type=Path); p.add_argument('--apksigner', type=Path)
    p.add_argument('--certificate-sha256')
    p.add_argument('--version'); p.add_argument('--build', type=int); p.add_argument('--minimum-os')
    p.add_argument('--delivery', choices=['appstore', 'testflight'])
    args = p.parse_args()
    try:
        item = prepare(args)
        print(f"已生成本地更新清单：{args.output}；{item['platform']} {item['version']} ({item['build']})。尚未发布。")
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        p.exit(1, f'生成失败：{error}\n')
if __name__ == '__main__': main()
