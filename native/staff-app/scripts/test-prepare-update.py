#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile
from argparse import Namespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('prepare-update.py'))
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)
package_spec = importlib.util.spec_from_file_location('package_release', Path(__file__).with_name('package-android-release.py'))
packager = importlib.util.module_from_spec(package_spec); package_spec.loader.exec_module(packager)

def native_elf(bits=64, alignment=16384, relro_end=0x6000, writable_end=0x5fd0, bss_at=0x9fd0, order='<'):
    """Real ELF headers and segments, including the AndroidX safe-padding layout."""
    elf_class = 2 if bits == 64 else 1
    machine = 183 if bits == 64 else 40
    header_format = order + ('HHIQQQIHHHHHH' if bits == 64 else 'HHIIIIIHHHHHH')
    program_format = order + ('IIQQQQQQ' if bits == 64 else 'IIIIIIII')
    header_size = 16 + struct.calcsize(header_format)
    program_size = struct.calcsize(program_format)
    # p_type, p_flags, p_offset, p_vaddr, p_filesz, p_memsz, p_align
    rows = [(1, 5, 0, 0, 0x400, 0x400, alignment),
            (1, 6, 0x1c40, 0x5c40, 0x390, writable_end - 0x5c40, alignment),
            (1, 6, bss_at % alignment, bss_at, 0, 0x10, alignment)]
    if relro_end is not None:
        rows.append((0x6474e552, 4, 0x1c40, 0x5c40, 0x390, relro_end - 0x5c40, 1))
    content = bytearray(0x4000)
    content[:16] = b'\x7fELF' + bytes((elf_class, 1 if order == '<' else 2, 1, 0)) + bytes(8)
    struct.pack_into(header_format, content, 16, 3, machine, 1, 0, header_size, 0, 0,
                     header_size, program_size, len(rows), 0, 0, 0)
    for index, (kind, flags, offset, address, filesz, memsz, align) in enumerate(rows):
        values = ((kind, flags, offset, address, address, filesz, memsz, align) if bits == 64
                  else (kind, offset, address, address, filesz, memsz, flags, align))
        struct.pack_into(program_format, content, header_size + index * program_size, *values)
    return bytes(content)

def write_apk(path, libraries=(), prefix=False):
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('classes.dex', b'dex fixture for mocked aapt only')
        if prefix:
            archive.writestr('assets/prefix.bin', bytes(713))
        for name, content, aligned, compression in libraries:
            info = zipfile.ZipInfo(name)
            if aligned:
                base = archive.fp.tell() + 30 + len(name.encode('utf-8'))
                padding = (-base) % 16384
                if padding < 4:
                    padding += 16384
                info.extra = struct.pack('<HH', 0xcafe, padding - 4) + bytes(padding - 4)
            archive.writestr(info, content, compress_type=compression)

class NativeAlignmentTests(unittest.TestCase):
    def inspect(self, libraries=(), prefix=False):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / 'candidate.apk'
            write_apk(apk, libraries, prefix)
            return release.inspect_apk_native_alignment(apk)

    def test_elf32_and_64_program_headers_and_byte_order(self):
        for bits in (32, 64):
            for order in ('<', '>'):
                with self.subTest(bits=bits, order=order):
                    elf = release.inspect_native_elf(native_elf(bits=bits, order=order))
                    self.assertEqual(bits, elf['elfClass'])
                    self.assertEqual(3, len(elf['loadSegments']))
                    self.assertTrue(elf['load16KbAligned'])
                    self.assertTrue(elf['relroProtectionSafe'])

    def test_all_64bit_loads_and_stored_zip_data_must_align(self):
        report = self.inspect([
            ('lib/arm64-v8a/good.so', native_elf(), True, zipfile.ZIP_STORED),
            ('lib/arm64-v8a/bad-load.so', native_elf(alignment=4096), True, zipfile.ZIP_STORED),
            ('lib/arm64-v8a/bad-zip.so', native_elf(), False, zipfile.ZIP_STORED)], prefix=True)
        self.assertFalse(report['passed'])
        good, load, zipped = report['libraries']
        self.assertFalse(good['errors'])
        self.assertEqual(0, good['dataOffset'] % 16384)
        self.assertTrue(any('LOAD' in issue for issue in load['errors']))
        self.assertTrue(any('ZIP' in issue for issue in zipped['errors']))
        self.assertEqual(3, len(report['libraries']))

    def test_zip_alignment_uses_actual_local_extra_and_filename(self):
        report = self.inspect([('lib/arm64-v8a/' + 'long-name-' * 11 + '.so', native_elf(), True, zipfile.ZIP_STORED)], prefix=True)
        self.assertTrue(report['passed'])
        self.assertGreater(report['libraries'][0]['dataOffset'], 713)
        self.assertEqual(0, report['libraries'][0]['dataOffset'] % 16384)

    def test_relro_formula_safe_gap_and_real_writable_overlap(self):
        for arguments, formula, safe in [({}, False, True), ({'relro_end': 0x8000}, True, True),
                                         ({'writable_end': 0x6100}, False, False),
                                         ({'bss_at': 0x6fd0}, False, False)]:
            with self.subTest(arguments=arguments):
                report = self.inspect([('lib/arm64-v8a/lib.so', native_elf(**arguments), True, zipfile.ZIP_STORED)])
                entry = report['libraries'][0]
                self.assertEqual(formula, entry['simpleFormulaAligned'])
                self.assertEqual(safe, entry['relroProtectionSafe'])
                self.assertEqual(safe, report['passed'])
                self.assertEqual(not formula and safe, entry['relroSegments'][0]['safePadding'])
        aligned_end_with_unsafe_prefix = bytearray(native_elf(relro_end=0x8000))
        struct.pack_into('<Q', aligned_end_with_unsafe_prefix, 64 + 3 * 56 + 16, 0x5c80)
        struct.pack_into('<Q', aligned_end_with_unsafe_prefix, 64 + 3 * 56 + 40, 0x8000 - 0x5c80)
        result = release.inspect_native_elf(bytes(aligned_end_with_unsafe_prefix))
        self.assertTrue(result['simpleFormulaAligned'])
        self.assertFalse(result['relroProtectionSafe'])

    def test_compressed_libraries_skip_zip_alignment_but_not_elf_checks(self):
        for align, expected in [(16384, True), (4096, False)]:
            report = self.inspect([('lib/arm64-v8a/lib.so', native_elf(alignment=align, relro_end=None), False, zipfile.ZIP_DEFLATED)])
            self.assertEqual(expected, report['passed'])
            self.assertIsNone(report['libraries'][0]['zip16KbAligned'])
            self.assertEqual([], report['libraries'][0]['relroSegments'])

    def test_32bit_alignment_is_diagnostic_but_abi_mismatch_is_rejected(self):
        report = self.inspect([('lib/armeabi-v7a/legacy.so', native_elf(bits=32, alignment=4096, writable_end=0x6100), False, zipfile.ZIP_STORED)])
        self.assertTrue(report['passed'])
        self.assertEqual(3, len(report['libraries'][0]['warnings']))
        self.assertFalse(report['libraries'][0]['enforced16Kb'])
        for name in ['lib/arm64-v8a/actually32.so', 'lib/unknown/lib.so', 'assets/native.so']:
            with self.subTest(name=name):
                self.assertFalse(self.inspect([(name, native_elf(bits=32), True, zipfile.ZIP_STORED)])['passed'])
        # x86_64 requires ELF64 EM_X86_64, independently of the ARM64 rule.
        intel = bytearray(native_elf()); struct.pack_into('<H', intel, 18, 62)
        self.assertTrue(self.inspect([('lib/x86_64/lib.so', bytes(intel), True, zipfile.ZIP_STORED)])['passed'])

    def test_no_native_code_is_valid_but_malformed_elf_zip_and_crc_fail(self):
        report = self.inspect()
        self.assertTrue(report['passed']); self.assertFalse(report['nativeCode'])
        self.assertFalse(report['runtimeTested'])
        for content in [b'not an ELF', native_elf()[:50], native_elf()[:200]]:
            with self.subTest(length=len(content)):
                self.assertFalse(self.inspect([('lib/arm64-v8a/bad.so', content, True, zipfile.ZIP_STORED)])['passed'])
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / 'bad.apk'; apk.write_bytes(b'not a zip')
            with self.assertRaisesRegex(ValueError, 'ZIP'):
                release.verify_apk_native_alignment(apk)
            write_apk(apk, [('lib/arm64-v8a/lib.so', native_elf(), True, zipfile.ZIP_STORED)])
            valid = release.verify_apk_native_alignment(apk)
            corrupted = bytearray(apk.read_bytes())
            corrupted[valid['libraries'][0]['dataOffset'] + 1000] ^= 1
            apk.write_bytes(corrupted)
            self.assertFalse(release.inspect_apk_native_alignment(apk)['passed'])

class PublisherTests(unittest.TestCase):
    def test_monotonic_atomic_merge_and_bad_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);notes=root/'notes.md';notes.write_text('修复桌台和收银功能。')
            target=root/'preview.json'
            args=Namespace(platform='ios',channel='preview',notes=notes,output=target,url='https://testflight.apple.com/join/TESTONLY',priority='normal',version='0.3.0',build=3,minimum_os='17.0',delivery='testflight')
            release.prepare(args)
            first=target.read_bytes()
            with self.assertRaises(ValueError): release.prepare(args)
            self.assertEqual(first,target.read_bytes())
            args.build=4;args.url='https://testflight.apple.com.evil.example/join/TESTONLY'
            with self.assertRaises(ValueError):release.prepare(args)
            self.assertEqual(first,target.read_bytes())
            args.url='https://apps.apple.com/cn/app/mbox/id123456789';args.delivery='appstore'
            release.prepare(args);self.assertEqual(4,json.loads(target.read_bytes())['releases'][0]['build'])
            args.output=root/'stable.json';args.channel='stable';args.delivery='testflight';args.url='https://testflight.apple.com/join/TESTONLY'
            with self.assertRaises(ValueError):release.prepare(args)
            self.assertFalse(args.output.exists())
    def test_apk_url_cannot_escape_release_directory(self):
        self.assertTrue(release.trusted_apk_url('https://mbox.shmbox.com/native-updates/staff/mbox-3.apk'))
        self.assertTrue(release.trusted_apk_url('https://mbox.shmbox.com/native-updates/staff/MBOX-0.4.0-build8.apk'))
        for url in ['https://mbox.shmbox.com/native-updates/staff/../app.apk','http://mbox.shmbox.com/native-updates/staff/app.apk','https://evil.example/native-updates/staff/app.apk','https://mbox.shmbox.com/native-updates/staff/app.apk?token=secret','https://mbox.shmbox.com/native-updates/staff/nested/app.apk','https://mbox.shmbox.com/native-updates/staff/.hidden.apk']:
            self.assertFalse(release.trusted_apk_url(url))

    @staticmethod
    def manifest(channel='stable', demo='0x0'):
        return f'''E: manifest (line=1)
  E: application (line=2)
    E: meta-data (line=3)
      A: android:name(0x01010003)="com.mbox.staff.UPDATE_CHANNEL" (Raw: "com.mbox.staff.UPDATE_CHANNEL")
      A: android:value(0x01010024)="{channel}" (Raw: "{channel}")
    E: meta-data (line=4)
      A: android:name(0x01010003)="com.mbox.staff.ALLOW_LOCAL_DEMO" (Raw: "com.mbox.staff.ALLOW_LOCAL_DEMO")
      A: android:value(0x01010024)=(type 0x12){demo}
'''

    def test_packaged_channel_and_disabled_demo_are_required(self):
        release.verify_android_manifest(self.manifest(), 'stable')
        for xml in [self.manifest('preview'), self.manifest(demo='0xffffffff'), '', self.manifest()+self.manifest()]:
            with self.assertRaises(ValueError):
                release.verify_android_manifest(xml, 'stable')

    def test_only_direct_application_metadata_can_authorize_distribution(self):
        for component in ['activity', 'provider', 'service', 'receiver']:
            lines = self.manifest().splitlines()
            nested = '\n'.join(lines[:2] + [f'    E: {component} (line=3)'] + ['  '+line for line in lines[2:]])
            with self.subTest(component=component), self.assertRaises(ValueError):
                release.verify_android_manifest(nested, 'stable')
        # Metadata in a component cannot override, supply or conflict with application metadata.
        nested = '    E: activity (line=5)\n' + '\n'.join('  '+line for line in self.manifest('preview').splitlines()[2:])
        release.verify_android_manifest(self.manifest()+nested, 'stable')

    def test_formal_certificate_does_not_make_debug_build_releasable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notes = root/'notes.md'; notes.write_text('正式营业更新')
            apk = root/'staff.apk'; write_apk(apk)
            args = Namespace(platform='android', channel='stable', notes=notes, output=root/'stable.json', url='https://mbox.shmbox.com/native-updates/staff/mbox-build8.apk', priority='normal', apk=apk, aapt='aapt', apksigner='apksigner', certificate_sha256='a'*64)
            badging = "package: name='com.mbox.staff.nativeapp' versionCode='8' versionName='0.4.0'\nsdkVersion:'26'\n"
            def command(argv, **_):
                if argv[0] == 'apksigner':
                    return Namespace(stdout='Signer #1 certificate SHA-256 digest: '+ 'a'*64 +'\n')
                return Namespace(stdout=(badging + 'application-debuggable\n') if argv[2] == 'badging' else self.manifest())
            with patch.object(release.subprocess, 'run', side_effect=command):
                with self.assertRaisesRegex(ValueError, '可调试'):
                    release.prepare(args)
            self.assertFalse(args.output.exists())

    def test_new_apk_cannot_reuse_published_url_and_failure_keeps_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notes = root/'notes.md'; notes.write_text('正式营业更新')
            apk = root/'staff.apk'; write_apk(apk)
            args = Namespace(platform='android', channel='stable', notes=notes, output=root/'stable.json', url='https://mbox.shmbox.com/native-updates/staff/mbox-build8.apk', priority='normal', apk=apk, aapt='aapt', apksigner='apksigner', certificate_sha256='a'*64)
            build = 8
            def command(argv, **_):
                if argv[0] == 'apksigner':
                    return Namespace(stdout='Signer #1 certificate SHA-256 digest: '+ 'a'*64 +'\n')
                return Namespace(stdout=f"package: name='com.mbox.staff.nativeapp' versionCode='{build}' versionName='0.4.0'\nsdkVersion:'26'\n" if argv[2] == 'badging' else self.manifest())
            with patch.object(release.subprocess, 'run', side_effect=command):
                release.prepare(args)
                original = args.output.read_bytes()
                build = 9
                with self.assertRaisesRegex(ValueError, '不可变'):
                    release.prepare(args)
                self.assertEqual(original, args.output.read_bytes())
                args.url = 'https://mbox.shmbox.com/native-updates/staff/mbox-build9.apk'
                release.prepare(args)
                self.assertEqual(9, json.loads(args.output.read_bytes())['releases'][0]['build'])

    def test_distribution_folder_binds_actual_version_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notes = root/'notes.md'; notes.write_text('正式营业更新')
            apk = root/'staff.apk'; write_apk(apk)
            args = Namespace(apk=apk, output=root/'delivery', notes=notes, aapt='aapt', apksigner='apksigner', certificate_sha256='a'*64, version='0.4.0', build=9, previous_feed=None, priority='normal')
            def command(argv, **_):
                if argv[0] == 'apksigner':
                    return Namespace(stdout='Signer #1 certificate SHA-256 digest: '+ 'a'*64 +'\n')
                return Namespace(stdout="package: name='com.mbox.staff.nativeapp' versionCode='8' versionName='0.4.0'\nsdkVersion:'26'\n" if argv[2] == 'badging' else self.manifest())
            with patch.object(packager.publisher.subprocess, 'run', side_effect=command):
                with self.assertRaisesRegex(ValueError, '声明版本'):
                    packager.package(args)
                self.assertFalse(args.output.exists())
                args.build = 8
                packager.package(args)
                receipt = json.loads((args.output/'verification.json').read_text())
                self.assertFalse(receipt['published'])
                self.assertFalse(receipt['installedOnDevice'])
                self.assertEqual(8, receipt['release']['build'])
                self.assertTrue(receipt['nativeAlignment']['passed'])
                self.assertFalse(receipt['nativeAlignment']['nativeCode'])
                self.assertEqual(1, len(list(args.output.glob('*.apk'))))
                original = (args.output/'stable.json').read_bytes()
                with self.assertRaisesRegex(ValueError, '已存在'):
                    packager.package(args)
                self.assertEqual(original, (args.output/'stable.json').read_bytes())

    def test_compressed_native_libraries_require_packaged_extraction_enabled(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notes = root/'notes.md'; notes.write_text('原生布局校验')
            apk = root/'staff.apk'
            write_apk(apk, [('lib/arm64-v8a/lib.so', native_elf(), False, zipfile.ZIP_DEFLATED)])
            args = Namespace(platform='android', channel='stable', notes=notes, output=root/'stable.json', url='https://mbox.shmbox.com/native-updates/staff/mbox-build8.apk', priority='normal', apk=apk, aapt='aapt', apksigner='apksigner', certificate_sha256='a'*64)
            for extraction in [None, '0xffffffff', '0x0']:
                with self.subTest(extraction=extraction):
                    args.output = root/f'manifest-{extraction}.json'
                    manifest = self.manifest()
                    if extraction is not None:
                        manifest = manifest.replace('  E: application (line=2)',
                            f'  E: application (line=2)\n    A: android:extractNativeLibs(0x010104ea)=(type 0x12){extraction}')
                    # A nested component must never override the application's setting.
                    manifest += '    E: activity (line=8)\n      A: android:extractNativeLibs(0x010104ea)=(type 0x12)0xffffffff\n'
                    def command(argv, **_):
                        if argv[0] == 'apksigner':
                            return Namespace(stdout='Signer #1 certificate SHA-256 digest: '+ 'a'*64 +'\n')
                        return Namespace(stdout="package: name='com.mbox.staff.nativeapp' versionCode='8' versionName='0.4.0'\nsdkVersion:'26'\n" if argv[2] == 'badging' else manifest)
                    with patch.object(release.subprocess, 'run', side_effect=command):
                        if extraction == '0x0':
                            with self.assertRaisesRegex(ValueError, 'extractNativeLibs=false'):
                                release.prepare(args)
                            self.assertFalse(args.output.exists())
                        else:
                            diagnostics = {}
                            release.prepare(args, diagnostics=diagnostics)
                            self.assertTrue(diagnostics['nativeAlignment']['extractNativeLibs'])
                            self.assertTrue(diagnostics['nativeAlignment']['manifestPackagingVerified'])

    def test_native_layout_failure_preserves_feed_and_blocks_distribution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notes = root/'notes.md'; notes.write_text('原生布局校验')
            apk = root/'staff.apk'
            write_apk(apk, [('lib/arm64-v8a/lib.so', native_elf(alignment=4096), True, zipfile.ZIP_STORED)])
            target = root/'stable.json'
            original = b'{"schemaVersion":1,"channel":"stable","releases":[]}'
            target.write_bytes(original)
            args = Namespace(platform='android', channel='stable', notes=notes, output=target, url='https://mbox.shmbox.com/native-updates/staff/mbox-build8.apk', priority='normal', apk=apk, aapt='aapt', apksigner='apksigner', certificate_sha256='a'*64)
            def command(argv, **_):
                if argv[0] == 'apksigner':
                    return Namespace(stdout='Signer #1 certificate SHA-256 digest: '+ 'a'*64 +'\n')
                return Namespace(stdout="package: name='com.mbox.staff.nativeapp' versionCode='8' versionName='0.4.0'\nsdkVersion:'26'\n" if argv[2] == 'badging' else self.manifest())
            with patch.object(release.subprocess, 'run', side_effect=command):
                with self.assertRaisesRegex(ValueError, 'LOAD'):
                    release.prepare(args)
                self.assertEqual(original, target.read_bytes())
                args.output = root/'delivery'; args.version='0.4.0'; args.build=8; args.previous_feed=target
                with self.assertRaisesRegex(ValueError, 'LOAD'):
                    packager.package(args)
                self.assertFalse(args.output.exists())
                self.assertEqual(original, target.read_bytes())
if __name__=='__main__': unittest.main()
