#!/usr/bin/env python3
"""Fault tests use actual temp files; no SSH, production HTTP or Android signing."""
import ast
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-native-update.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
CERT = 'c' * 64


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.content = b'fixture-signed-package-bytes'
        sha = m.digest(self.content)
        self.item = dict(platform='android', appId='com.mbox.staff.nativeapp', delivery='apk',
            build=8, version='0.4.0-rc.3', minimumOS='26', priority='normal', notes='真实更新说明',
            bytes=len(self.content), sha256=sha,
            url=m.ORIGIN + m.PREFIX + f'MBOX-Staff-0.4.0-rc.3-build8-{sha[:12]}.apk')
        self.ios = dict(platform='ios', appId='com.mbox.staff.native', build=5, version='1.0', delivery='appstore',
            url='https://apps.apple.com/app/id12345', minimumOS='16.0', priority='normal', notes='iOS说明')
        self.proof = dict(sha256=sha, bytes=len(self.content), certificateSha256=CERT, channel='stable',
            url=self.item['url'], apkDebuggable=False, allowLocalDemo=False, source='public_https_reverified')

    def existing(self, android=None):
        data = m.encode(dict(schemaVersion=1, channel='stable', releases=[self.ios] + ([android] if android else [])))
        (self.root / 'stable.json').write_bytes(data)
        return data

    def stage(self):
        return m.stage_apk(self.root, self.item, io.BytesIO(self.content))

    def commit(self, digest='absent', item=None, proof=None):
        return m.commit_feed(self.root, 'stable', digest, item or self.item, proof or self.proof, CERT)

    def test_stage_immutable_replay_reads_the_full_upload(self):
        self.assertFalse(self.stage()['replayed'])
        source = io.BytesIO(self.content)
        self.assertTrue(m.stage_apk(self.root, self.item, source)['replayed'])
        self.assertEqual(source.tell(), len(self.content))
        self.assertEqual((self.root / m.apk_name(self.item)).read_bytes(), self.content)

    def test_truncated_and_corrupt_uploads_never_create_a_public_apk_or_change_feed(self):
        previous = self.existing()
        for content in [self.content[:-1], b'X' * len(self.content), self.content + b'X']:
            with self.assertRaises(ValueError):
                m.stage_apk(self.root, self.item, io.BytesIO(content))
            self.assertEqual((self.root / 'stable.json').read_bytes(), previous)
            self.assertFalse((self.root / m.apk_name(self.item)).exists())
            self.assertEqual(list(self.root.glob('.apk-stage-*')), [])

    def test_existing_different_apk_is_never_overwritten(self):
        target = self.root / m.apk_name(self.item)
        target.write_bytes(b'prior-package')
        with self.assertRaises(ValueError):
            self.stage()
        self.assertEqual(target.read_bytes(), b'prior-package')

    def test_success_preserves_ios_and_other_channel_and_replays_after_lost_feedback(self):
        previous = self.existing()
        (self.root / 'preview.json').write_bytes(b'preview-original')
        self.stage()
        result = self.commit(m.digest(previous))
        self.assertTrue(result['published'])
        feed = json.loads((self.root / 'stable.json').read_bytes())
        self.assertEqual(feed['releases'], [self.ios, self.item])
        self.assertEqual((self.root / 'preview.json').read_bytes(), b'preview-original')
        # The pre-commit digest remains valid for recovery of the same result.
        self.assertTrue(self.commit(m.digest(previous))['replayed'])

    def test_cas_conflict_preserves_another_operators_feed(self):
        self.stage()
        old = self.existing()
        changed = old + b'\n'
        (self.root / 'stable.json').write_bytes(changed)
        with self.assertRaisesRegex(ValueError, 'Channel changed'):
            self.commit(m.digest(old))
        self.assertEqual((self.root / 'stable.json').read_bytes(), changed)

    def test_commit_requires_matching_https_signature_byte_and_channel_proof(self):
        self.stage()
        previous = self.existing()
        for key, value in [('sha256', 'd'*64), ('bytes', 1), ('certificateSha256', 'e'*64),
                           ('channel', 'preview'), ('source', 'local-only'), ('allowLocalDemo', True)]:
            with self.assertRaises(ValueError):
                self.commit(m.digest(previous), proof={**self.proof, key: value})
            self.assertEqual((self.root / 'stable.json').read_bytes(), previous)

    def test_failed_atomic_replace_keeps_previous_feed(self):
        self.stage()
        previous = self.existing()
        with patch.object(m.os, 'replace', side_effect=OSError('simulated disk failure')):
            with self.assertRaises(OSError):
                self.commit(m.digest(previous))
        self.assertEqual((self.root / 'stable.json').read_bytes(), previous)
        self.assertEqual(list(self.root.glob('.feed-publish-*')), [])

    def test_existing_same_build_different_metadata_cannot_be_republished(self):
        self.stage()
        previous = self.existing({**self.item, 'notes': '原更新说明'})
        with self.assertRaisesRegex(ValueError, 'build must increase'):
            self.commit(m.digest(previous))
        self.assertEqual((self.root / 'stable.json').read_bytes(), previous)

    def test_symlinks_and_unsafe_urls_cannot_redirect_writes(self):
        outside = self.root / 'outside'
        outside.write_bytes(b'untouched')
        (self.root / m.apk_name(self.item)).symlink_to(outside)
        with self.assertRaises(ValueError):
            self.stage()
        for url in ['http://mbox.shmbox.com'+m.PREFIX+'bad.apk', self.item['url']+'?token=a',
                    m.ORIGIN+m.PREFIX+'../evil.apk', 'https://evil.example/x.apk']:
            with self.assertRaises(ValueError):
                m.validate_release({**self.item, 'url': url})
        self.assertEqual(outside.read_bytes(), b'untouched')

    def test_corrupt_or_duplicate_existing_feed_is_not_overwritten(self):
        self.stage()
        for data in [b'not-json', m.encode(dict(schemaVersion=1, channel='stable', releases=[self.ios, self.ios]))]:
            (self.root / 'stable.json').write_bytes(data)
            with self.assertRaises(ValueError):
                self.commit(m.digest(data))
            self.assertEqual((self.root / 'stable.json').read_bytes(), data)

    def test_https_reverification_pins_host_without_disabling_tls_or_following_redirects(self):
        with patch.object(m.subprocess, 'run') as run:
            m.fetch_public(self.item['url'], self.root/'download.apk', '192.0.2.1')
        argv = run.call_args.args[0]
        self.assertIn('--resolve', argv)
        self.assertEqual(argv[argv.index('--noproxy')+1], '*')
        self.assertIn('mbox.shmbox.com:443:192.0.2.1', argv)
        self.assertNotIn('--insecure', argv)
        self.assertNotIn('--location', argv)
        self.assertIn('--max-filesize', argv)
        with self.assertRaises(ValueError):
            m.fetch_public('http://mbox.shmbox.com/x', self.root/'download.apk')

    def test_ssh_arguments_cannot_inject_a_shell_command(self):
        args=SimpleNamespace(ssh_host='root@example.test', release_dir='/opt/mbox/releases/rc246', expected_live_sha='a'*40, channel='stable')
        command=m.ssh_command(args,'inspect')
        self.assertIn('StrictHostKeyChecking=yes',command)
        self.assertEqual(command[command.index('-p')+1],'6122')
        self.assertIn('IdentitiesOnly=yes',command)
        selected=m.ssh_command(SimpleNamespace(**{**vars(args),'remote_python':'/root/.pyenv/versions/3.7.17/bin/python3.7'}),'inspect')
        self.assertTrue(selected[-1].startswith('/root/.pyenv/versions/3.7.17/bin/python3.7 '))
        for field,value in [('ssh_host','root@host; echo secret'),('release_dir','/tmp/evil'),('expected_live_sha','$(id)'),('remote_python','python3'),('remote_python','/tmp/python;id'),('ssh_port',0)]:
            with self.assertRaises(ValueError):
                m.ssh_command(SimpleNamespace(**{**vars(args),field:value}),'inspect')

    def test_remote_script_uses_python37_syntax_and_library_surface(self):
        source=Path(m.__file__).read_text()
        # The host compiler also catches newer grammar such as assignment expressions.
        try:
            ast.parse(source,feature_version=(3,7))
        except TypeError:  # Python 3.7 itself needs no feature-version override.
            ast.parse(source)
        for unsupported in ['hashlib.file_digest','shlex.join(','.removeprefix(','.removesuffix(','missing_ok=']:
            self.assertNotIn(unsupported,source)

    def test_local_validation_failure_never_contacts_remote(self):
        feed=self.root/'candidate.json';feed.write_bytes(m.encode(dict(schemaVersion=1,channel='stable',releases=[self.item])))
        args=SimpleNamespace(feed=feed,apk=self.root/'missing.apk',channel='stable')
        with patch.object(m,'remote_json') as remote:
            with self.assertRaises(ValueError):m.publish(args)
            remote.assert_not_called()

    def publication_args(self):
        feed=self.root/'candidate.json';feed.write_bytes(m.encode(dict(schemaVersion=1,channel='stable',releases=[self.item])))
        apk=self.root/'local.apk';apk.write_bytes(self.content)
        return SimpleNamespace(feed=feed,apk=apk,channel='stable',certificate_sha256=CERT,origin_ip=None,
            ssh_host='root@example.test',release_dir='/opt/mbox/releases/rc246',expected_live_sha='a'*40)

    def test_public_download_or_signature_failure_cannot_commit_a_feed(self):
        for failure in ['download','signature']:
            args=self.publication_args()
            with patch.object(m,'remote_json',return_value={'feedSha256':'absent','publisherSha256':m.file_digest(Path(m.__file__))}) as remote, \
                 patch.object(m,'verify_apk',side_effect=[{},ValueError('public signature differs')] if failure=='signature' else [{},{}]), \
                 patch.object(m.subprocess,'run',return_value=SimpleNamespace(stdout=b'{"staged":true}')), \
                 patch.object(m,'fetch_public',side_effect=OSError('HTTP failed') if failure=='download' else None):
                with self.assertRaises((OSError,ValueError)):m.publish(args)
                self.assertEqual([call.args[1] for call in remote.call_args_list],['inspect'])

    def test_success_orders_public_verification_before_cas_commit(self):
        args=self.publication_args();events=[]
        def verify(path,*unused):events.append('public-verified' if path.name=='verified.apk' else 'local-verified');return {**self.proof}
        def remote(unused,phase,payload=None):
            events.append(phase)
            if phase=='inspect':return {'feedSha256':'absent','publisherSha256':m.file_digest(Path(m.__file__))}
            self.assertIn('public-verified',events);self.assertEqual(payload['expectedFeedSha256'],'absent')
            return {'published':True,'replayed':False}
        def fetch(url,target,ip):
            events.append('fetch')
            if target.name=='channel.json':target.write_bytes(m.encode(dict(schemaVersion=1,channel='stable',releases=[self.ios,self.item])))
        with patch.object(m,'remote_json',side_effect=remote),patch.object(m,'verify_apk',side_effect=verify), \
             patch.object(m.subprocess,'run',return_value=SimpleNamespace(stdout=b'{"staged":true}')),patch.object(m,'fetch_public',side_effect=fetch):
            self.assertTrue(m.publish(args)['publicReadbackVerified'])
        self.assertLess(events.index('local-verified'),events.index('inspect'))
        self.assertLess(events.index('public-verified'),events.index('commit'))

    def test_local_publisher_must_match_the_frozen_remote_script(self):
        args=self.publication_args()
        with patch.object(m,'verify_apk',return_value={}),patch.object(m,'remote_json',return_value={'feedSha256':'absent','publisherSha256':'0'*64}),patch.object(m.subprocess,'run') as run:
            with self.assertRaisesRegex(ValueError,'publishers differ'):m.publish(args)
            run.assert_not_called()

    def test_live_release_binding_is_checked_before_remote_mutations(self):
        with patch.object(m, 'INSTALL_ROOT', self.root):
            releases=self.root/'releases';releases.mkdir()
            previous=releases/'previous';previous.mkdir()
            candidate=releases/'candidate';candidate.mkdir()
            (self.root/'current').symlink_to(previous)
            with patch.object(m.os,'geteuid',return_value=0):
                with self.assertRaisesRegex(ValueError,'Active release changed'):
                    m.assert_deployment(SimpleNamespace(release_dir=str(candidate),expected_live_sha='a'*40))
        self.assertFalse((self.root/'native-updates').exists())


if __name__ == '__main__':
    unittest.main()
