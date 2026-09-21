"""Only syntax/parameter and pure journal checks. No Docker, SQL or HTTP calls."""
import ast
import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import lab_parameters as parameters

HERE = pathlib.Path(__file__).parent


def valid_config():
    c = {key: '/root/LAB-parameters/' + key for key in parameters.PATH_KEYS}
    c.update(labId='parameters-unit', controllerHostname='mbox-maint-lab-unit',
             targetSha='a' * 40, sourceSha='b' * 40, backupOriginSha='c' * 40,
             imageTag='audit-maintenance:unit', imageDigest='sha256:' + 'd' * 64,
             platformImageDigest='sha256:' + 'e' * 64, platform='linux/amd64', version='1.0.0-rc.217',
             transitionId='local-parameters-unit', sourceContainerName='mbox-app',
             runtimeLogin='lab_runtime', retiredLogin='lab_old', migrationService='migration',
             clusterAdminService='cluster', labCiRunId='9000000001', schema=238,
             callbackUrls=['https://payments.localhost/api/payments/providers/postar/callback',
                           'https://payments.localhost/api/refunds/providers/postar/callback'],
             systemdUnits=['cron.service'], persistentMounts=[{'type': 'bind', 'source': '/opt/mbox/data', 'target': '/data', 'readOnly': False}])
    c['sourceReleaseDirectory'] = c['runtimeRoot'] + '/releases/' + c['sourceSha'][:7]
    return c


class ParametersTest(unittest.TestCase):
    def config(self, c):
        with tempfile.TemporaryDirectory(prefix='mbox-parameter-validation-') as directory:
            path = pathlib.Path(directory) / 'config.json'
            path.write_text(json.dumps(c))
            with patch.object(parameters.subprocess, 'run', side_effect=AssertionError('no process permitted during parameter validation')):
                return parameters.read_config(path)

    def test_valid_parameters_have_no_subprocess_effect(self):
        self.assertEqual(self.config(valid_config())['schema'], 238)

    def test_invalid_or_ambiguous_inputs_fail_closed(self):
        cases = [
            ('targetSha', 'a' * 7), ('sourceSha', 'main'), ('backupOriginSha', ''), ('schema', 235),
            ('imageTag', 'production:latest'), ('platform', 'auto'), ('imageDigest', 'latest'),
            ('callbackUrls', ['https://example.invalid/callback']), ('runtimeRoot', '/tmp/../production'),
            ('controllerHostname', 'production-host'), ('runtimeLogin', "bad'role"),
            ('sourceReleaseDirectory', '/different/source'), ('schema', '238'),
        ]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                c = valid_config(); c[key] = value
                with self.assertRaises(ValueError): self.config(c)
        for mutation in ('missing', 'unknown_secret_key'):
            c = valid_config()
            if mutation == 'missing': del c['backupOriginSha']
            else: c['credential'] = 'synthetic-marker-not-a-credential'
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): self.config(c)

    def test_syntax_and_default_validation_never_execute_lab(self):
        for name in ('prepare-bundle-parameterized.py', 'verify-final-parameterized.py'):
            ast.parse((HERE / name).read_text())
            with tempfile.TemporaryDirectory(prefix='mbox-parameter-cli-') as directory:
                config = pathlib.Path(directory) / 'config.json'; config.write_text(json.dumps(valid_config()))
                # The only child here is Python's validation path. No execution
                # flag is supplied and no nonexistent LAB path may be touched.
                result = subprocess.run([sys.executable, str(HERE / name), '--config', str(config), '--validate-only'],
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)['executed'], False)
                self.assertEqual(set(pathlib.Path(directory).iterdir()), {config})

    def test_nested_docker_mounts_require_exact_local_filesystem_identity(self):
        root = '1 0 0:42 / / rw - overlay overlay rw,lowerdir=synthetic,upperdir=local'
        own = '2 1 0:42 /var/lib/docker /var/lib/docker rw - overlay overlay rw,lowerdir=synthetic,upperdir=local'
        self.assertTrue(parameters.allowed_lab_mount(own, root))
        for bad in (own.replace('0:42', '8:1'), own.replace('/var/lib/docker /var/lib/docker', '/host-data /var/lib/docker'),
                    own.replace('upperdir=local', 'upperdir=other'), own.replace('/var/lib/docker rw', '/var/lib/docker2 rw')):
            self.assertFalse(parameters.allowed_lab_mount(bad, root))
        shm = '3 1 0:43 / /var/lib/docker/containers/' + 'a' * 64 + '/mounts/shm rw - tmpfs shm rw,size=65536k'
        self.assertTrue(parameters.allowed_lab_mount(shm, root))
        self.assertFalse(parameters.allowed_lab_mount(shm.replace('tmpfs shm', 'ext4 /dev/sda'), root))
        self.assertFalse(parameters.allowed_lab_mount(shm.replace('a' * 64, 'arbitrary'), root))

    def test_formal_entry_allows_only_exact_loopback_ssh_environment(self):
        for value in ('', '127.0.0.1 40123 127.0.0.1 22', '::1 40123 ::1 22'):
            self.assertTrue(parameters.allowed_lab_environment({'SSH_CONNECTION':value}))
        for value in ('10.0.0.1 40123 127.0.0.1 22', '127.0.0.1 40123 10.0.0.1 22',
                      '::1 40123 2001:db8::1 22', 'localhost 40123 localhost 22',
                      '127.0.0.1 0 127.0.0.1 22', '127.0.0.1 65536 127.0.0.1 22',
                      '127.0.0.1 x 127.0.0.1 22', '127.0.0.1 22', '127.0.0.1 22 127.0.0.1 22 extra'):
            self.assertFalse(parameters.allowed_lab_environment({'SSH_CONNECTION':value}))
        for key in ('DOCKER_HOST','DOCKER_CONTEXT'):
            self.assertFalse(parameters.allowed_lab_environment({key:'remote','SSH_CONNECTION':'127.0.0.1 40123 127.0.0.1 22'}))

    def test_actual_backup_position_wins_over_failed_initial_bound(self):
        spec = importlib.util.spec_from_file_location('verify_parameters', HERE / 'verify-final-parameterized.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        rows = [
            {'event': 'bound', 'data': {'forwardRecoveryTarget': {'releaseSha': 'a' * 40}}},
            {'event': 'forward-target', 'data': {'forwardRecoveryTarget': {'releaseSha': 'b' * 40}}},
            {'event': 'backup-verified', 'data': {'releaseSha': 'b' * 40}},
            {'event': 'forward-target', 'data': {'forwardRecoveryTarget': {'releaseSha': 'c' * 40}}},
        ]
        self.assertEqual(module.backup_origin(rows, rows[2]), 'b' * 40)
        legacy = copy.deepcopy(rows); del legacy[2]['data']['releaseSha']
        self.assertEqual(module.backup_origin(legacy, legacy[2]), 'b' * 40)
        forged = copy.deepcopy(rows); forged[2]['data']['releaseSha'] = 'c' * 40
        with self.assertRaises(ValueError): module.backup_origin(forged, forged[2])

    def test_financial_evidence_requires_all_five_nonempty_tables(self):
        with patch.object(parameters, 'sql', return_value={t: {'count': 0} for t in parameters.FINANCIAL_TABLES}):
            with self.assertRaises(ValueError): parameters.financial_snapshot(valid_config())
        captured = []
        def fake_sql(_, query):
            captured.append(query)
            return {t: {'count': 1} for t in parameters.FINANCIAL_TABLES}
        with patch.object(parameters, 'sql', side_effect=fake_sql): parameters.financial_snapshot(valid_config())
        self.assertIn('sha256(convert_to', captured[0])
        self.assertIn('released_recovery_points', captured[0])
        self.assertEqual(len(parameters.FINANCIAL_TABLES), 5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
