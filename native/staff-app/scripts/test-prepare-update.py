#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from argparse import Namespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('prepare-update.py'))
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)
package_spec = importlib.util.spec_from_file_location('package_release', Path(__file__).with_name('package-android-release.py'))
packager = importlib.util.module_from_spec(package_spec); package_spec.loader.exec_module(packager)

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
            apk = root/'staff.apk'; apk.write_bytes(b'APK fixture, not a signed installer')
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
            apk = root/'staff.apk'; apk.write_bytes(b'APK fixture, not a signed installer')
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
            apk = root/'staff.apk'; apk.write_bytes(b'APK fixture, not a signed installer')
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
                self.assertEqual(1, len(list(args.output.glob('*.apk'))))
                original = (args.output/'stable.json').read_bytes()
                with self.assertRaisesRegex(ValueError, '已存在'):
                    packager.package(args)
                self.assertEqual(original, (args.output/'stable.json').read_bytes())
if __name__=='__main__': unittest.main()
