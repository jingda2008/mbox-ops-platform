#!/usr/bin/env python3
"""Prepare an update feed locally. Never uploads, signs, installs or replaces server files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile
from urllib.parse import urlsplit
import zipfile
import zlib

PREFIX = '/native-updates/staff/'
NATIVE_PAGE_SIZE = 16 * 1024
# Android's 16 KB execution requirement is for 64-bit devices. Retain 32-bit
# diagnostics without requiring those libraries to be rebuilt for a 64-bit ABI.
NATIVE_ABIS = {'arm64-v8a': (64, 183), 'x86_64': (64, 62),
               'armeabi-v7a': (32, 40), 'armeabi': (32, 40), 'x86': (32, 3)}

def require(ok, message):
    if not ok:
        raise ValueError(message)

def inspect_native_elf(content):
    """Parse real ELF program headers. No external tools or section-name heuristics."""
    require(len(content) >= 16 and content[:4] == b'\x7fELF', 'ELF文件头缺失或损坏')
    elf_class, encoding, ident_version = content[4:7]
    require(elf_class in (1, 2) and encoding in (1, 2) and ident_version == 1, 'ELF类别、字节序或版本不支持')
    order = '<' if encoding == 1 else '>'
    header_format = order + ('HHIIIIIHHHHHH' if elf_class == 1 else 'HHIQQQIHHHHHH')
    header_size = 16 + struct.calcsize(header_format)
    require(len(content) >= header_size, 'ELF文件头不完整')
    fields = struct.unpack_from(header_format, content, 16)
    elf_type, machine, version, _, phoff, _, _, ehsize, phentsize, phnum, _, _, _ = fields
    require(elf_type == 3 and version == 1 and ehsize == header_size, '原生库必须是有效ET_DYN共享对象')
    program_format = order + ('IIIIIIII' if elf_class == 1 else 'IIQQQQQQ')
    program_size = struct.calcsize(program_format)
    require(phentsize == program_size and 0 < phnum < 0xffff and phoff >= header_size,
            'ELF程序头大小、数量或偏移无效')
    require(phoff + phnum * phentsize <= len(content), 'ELF程序头表超出文件范围')
    loads, relro = [], []
    address_limit = 1 << (32 if elf_class == 1 else 64)
    for index in range(phnum):
        row = struct.unpack_from(program_format, content, phoff + index * phentsize)
        if elf_class == 1:
            kind, offset, vaddr, _, filesz, memsz, flags, alignment = row
        else:
            kind, flags, offset, vaddr, _, filesz, memsz, alignment = row
        if kind not in (1, 0x6474e552):  # PT_LOAD / PT_GNU_RELRO
            continue
        require(offset + filesz <= len(content) and vaddr + memsz < address_limit,
                'ELF段地址或文件范围无效')
        entry = {'index': index, 'offset': offset, 'virtualAddress': vaddr,
                 'fileSize': filesz, 'memorySize': memsz, 'alignment': alignment, 'flags': flags}
        if kind == 1:
            require(filesz <= memsz and (alignment in (0, 1) or alignment & (alignment - 1) == 0),
                    'ELF LOAD大小或对齐不是有效二次幂')
            require(alignment <= 1 or offset % alignment == vaddr % alignment,
                    'ELF LOAD文件偏移与虚拟地址不匹配')
            entry['aligned16Kb'] = alignment >= NATIVE_PAGE_SIZE
            loads.append(entry)
        else:
            entry['endAddress'] = vaddr + memsz
            entry['simpleFormulaAligned'] = entry['endAddress'] % NATIVE_PAGE_SIZE == 0
            relro.append(entry)
    require(loads, 'ELF共享对象缺少LOAD段')
    # Android's linker mprotects the page-rounded RELRO range. A non-aligned end
    # is safe when the extra protected bytes are only an unmapped segment gap;
    # reject when rounding covers real PF_W LOAD bytes outside declared RELRO.
    # Do not require libraries to relink merely to pad an otherwise safe gap.
    intended = sorted((row['virtualAddress'], row['endAddress']) for row in relro)
    for row in relro:
        row['protectedStart'] = row['virtualAddress'] // NATIVE_PAGE_SIZE * NATIVE_PAGE_SIZE
        row['protectedEnd'] = (row['endAddress'] + NATIVE_PAGE_SIZE - 1) // NATIVE_PAGE_SIZE * NATIVE_PAGE_SIZE
        overlaps = []
        for load in loads:
            if not load['flags'] & 2:  # PF_W
                continue
            start = max(row['protectedStart'], load['virtualAddress'])
            end = min(row['protectedEnd'], load['virtualAddress'] + load['memorySize'])
            cursor = start
            for allowed_start, allowed_end in intended:
                if cursor >= end:
                    break
                if allowed_end <= cursor:
                    continue
                if allowed_start > cursor:
                    overlaps.append({'loadIndex': load['index'], 'start': cursor, 'end': min(allowed_start, end)})
                cursor = max(cursor, allowed_end)
            if cursor < end:
                overlaps.append({'loadIndex': load['index'], 'start': cursor, 'end': end})
        row['writableOverlaps'] = overlaps
        row['protectionSafe'] = not overlaps
        row['safePadding'] = not row['simpleFormulaAligned'] and not overlaps
    return {'elfClass': 32 if elf_class == 1 else 64, 'machine': machine,
            'byteOrder': 'little' if encoding == 1 else 'big',
            'loadSegments': loads, 'relroSegments': relro,
            'load16KbAligned': all(row['aligned16Kb'] for row in loads),
            'simpleFormulaAligned': all(row['simpleFormulaAligned'] for row in relro),
            'relroProtectionSafe': all(row['protectionSafe'] for row in relro)}

def inspect_apk_native_alignment(apk, *, extract_native_libs=None):
    """Inspect every packaged .so and return all ABI diagnostics, including failures.

    https://developer.android.com/guide/practices/page-sizes documents 64-bit
    LOAD alignment, uncompressed ZIP data alignment, and the RELRO end boundary.
    This verifies layout only; it does not prove runtime or device acceptance.
    """
    report = {'schemaVersion': 1, 'pageSize': NATIVE_PAGE_SIZE,
              'enforcedAbis': ['arm64-v8a', 'x86_64'], 'libraries': [], 'errors': [],
              'extractNativeLibs': extract_native_libs,
              'manifestPackagingVerified': extract_native_libs is not None, 'runtimeTested': False}
    try:
        with Path(apk).open('rb') as raw, zipfile.ZipFile(raw) as archive:
            length = Path(apk).stat().st_size
            entries = [entry for entry in archive.infolist() if entry.filename.endswith('.so')]
            counts = {}
            for entry in entries:
                counts[entry.filename] = counts.get(entry.filename, 0) + 1
            for entry in entries:
                parts = entry.filename.split('/')
                abi = parts[1] if len(parts) == 3 and parts[0] == 'lib' else None
                item = {'path': entry.filename, 'abi': abi,
                        'enforced16Kb': abi in ('arm64-v8a', 'x86_64'),
                        'errors': [], 'warnings': []}
                report['libraries'].append(item)
                try:
                    require(abi in NATIVE_ABIS and parts[2] not in ('.so', '..so'), '原生库ABI或路径未知，须独立核对')
                    require(counts[entry.filename] == 1, 'APK含重复原生库路径')
                    require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), '原生库ZIP压缩方式不支持')
                    require(not entry.flag_bits & 1, 'APK原生库不得加密')
                    # Bound decompression of a corrupted or adversarial package.
                    require(0 < entry.file_size <= 256 * 1024 * 1024, '原生库解压大小越界')
                    raw.seek(entry.header_offset)
                    local = raw.read(30)
                    require(len(local) == 30, 'ZIP本地文件头不完整')
                    signature, _, flags, compression, _, _, _, _, _, name_length, extra_length = struct.unpack('<IHHHHHIIIHH', local)
                    require(signature == 0x04034b50 and flags == entry.flag_bits and compression == entry.compress_type,
                            'ZIP本地文件头与目录不一致')
                    data_offset = entry.header_offset + 30 + name_length + extra_length
                    require(data_offset + entry.compress_size <= length, 'ZIP原生库数据超出文件范围')
                    stored = entry.compress_type == zipfile.ZIP_STORED
                    item.update(compression='stored' if stored else 'deflated', dataOffset=data_offset,
                                zip16KbAligned=data_offset % NATIVE_PAGE_SIZE == 0 if stored else None)
                    if not stored and extract_native_libs is False:
                        item['errors'].append('Manifest extractNativeLibs=false不能搭配压缩.so')
                    elif not stored and extract_native_libs is None:
                        item['warnings'].append('尚未结合实际Manifest核对原生库解压设置')
                    # zipfile checks the local filename, overlap and actual CRC while reading.
                    elf = inspect_native_elf(archive.read(entry))
                    item.update(elf)
                    require((elf['elfClass'], elf['machine']) == NATIVE_ABIS[abi] and elf['byteOrder'] == 'little',
                            '原生库ELF类型与ABI目录不匹配')
                    alignment_issues = []
                    if stored and not item['zip16KbAligned']:
                        alignment_issues.append('未压缩.so的ZIP数据偏移未按16KB对齐')
                    if not elf['load16KbAligned']:
                        alignment_issues.append('ELF LOAD段对齐小于16KB')
                    if not elf['relroProtectionSafe']:
                        alignment_issues.append('ELF GNU_RELRO的16KB页保护范围覆盖了RELRO之外的可写LOAD字节')
                    elif not elf['simpleFormulaAligned']:
                        item['warnings'].append('RELRO结束地址非16KB边界，但扩展保护范围未覆盖其他可写LOAD字节（safePadding）')
                    item['errors' if item['enforced16Kb'] else 'warnings'].extend(alignment_issues)
                except (ValueError, struct.error, zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError, zlib.error) as error:
                    item['errors'].append(str(error))
    except (OSError, ValueError, zipfile.BadZipFile, EOFError) as error:
        report['errors'].append(f'APK ZIP读取失败：{error}')
    report['nativeCode'] = bool(report['libraries'])
    report['abis'] = sorted({item['abi'] for item in report['libraries'] if item['abi'] is not None})
    report['passed'] = not report['errors'] and not any(item['errors'] for item in report['libraries'])
    return report

def verify_apk_native_alignment(apk, *, extract_native_libs=None):
    report = inspect_apk_native_alignment(apk, extract_native_libs=extract_native_libs)
    require(report['passed'], 'APK原生库16KB校验失败：\n' + json.dumps(report, ensure_ascii=False, indent=2))
    return report

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
        attribute = re.match(r'^\s*A: android:(name|value|extractNativeLibs)(?:\([^)]*\))?=(.*)$', line)
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
    extraction = applications[0]['attributes'].get('extractNativeLibs')
    # AGP may inject the attribute during packaging. Inspect that actual value;
    # if genuinely absent from the packaged manifest, Android's parser defaults true.
    require(extraction in (None, '(type 0x12)0x0', '(type 0x12)0x1', '(type 0x12)0xffffffff'),
            '不能读取APK实际extractNativeLibs布尔配置')
    return extraction != '(type 0x12)0x0'

def prepare(args, *, diagnostics=None):
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
        extract_native_libs = verify_android_manifest(manifest, args.channel)
        package = re.search(r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging, re.M)
        minimum = re.search(r"^sdkVersion:'(\d+)'", badging, re.M)
        require(package is not None and minimum is not None, '不能读取APK版本及系统要求')
        app_id, build, version = package.groups()
        require(app_id == 'com.mbox.staff.nativeapp', 'APK包名不匹配')
        size = args.apk.stat().st_size
        require(0 < size <= 256 * 1024 * 1024 and 0 < int(build) <= 2100000000 and 26 <= int(minimum[1]) <= 100, 'APK版本、大小或系统要求越界')
        alignment = verify_apk_native_alignment(args.apk, extract_native_libs=extract_native_libs)
        if diagnostics is not None:
            diagnostics['nativeAlignment'] = alignment
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
        diagnostics = {}
        item = prepare(args, diagnostics=diagnostics)
        if diagnostics:
            print(json.dumps(diagnostics, ensure_ascii=False, indent=2))
        print(f"已生成本地更新清单：{args.output}；{item['platform']} {item['version']} ({item['build']})。尚未发布。")
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        p.exit(1, f'生成失败：{error}\n')
if __name__ == '__main__': main()
