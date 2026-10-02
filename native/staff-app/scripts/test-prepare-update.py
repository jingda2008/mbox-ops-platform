#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from argparse import Namespace

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('prepare-update.py'))
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)

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
        for url in ['https://mbox.shmbox.com/native-updates/staff/../app.apk','http://mbox.shmbox.com/native-updates/staff/app.apk','https://evil.example/native-updates/staff/app.apk','https://mbox.shmbox.com/native-updates/staff/app.apk?token=secret']:
            self.assertFalse(release.trusted_apk_url(url))
if __name__=='__main__': unittest.main()
