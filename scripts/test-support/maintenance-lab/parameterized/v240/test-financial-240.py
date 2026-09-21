"""Pure parameter/data tests only. No subprocess, DB, HTTP, SSH or containers."""
import ast
import contextlib
import copy
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('financial_240', HERE / 'verify-financial-240.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
old_spec = importlib.util.spec_from_file_location('old_parameter_cases', HERE.parent / 'test-parameters.py')
old_cases = importlib.util.module_from_spec(old_spec)
old_spec.loader.exec_module(old_cases)


def config():
    result = old_cases.valid_config()
    result['schema'] = 240
    return result


def facts():
    result = {table: {'count': 1, 'rowsSha256': 'a' * 64, **{field: 1 for field in fields}}
              for table, fields in v.parameters.FINANCIAL_TABLES.items()}
    result[v.ADMISSIONS] = {'count': 2, 'rowsSha256': 'b' * 64, 'bindingRowsSha256': 'c' * 64,
                           'invalidBindingCount': 0, 'amountsByCurrency': {'CNY': 2400, 'USD': 100}}
    return result


class Financial240Test(unittest.TestCase):
    def setUp(self):
        # Any accidental effect fails the test immediately. In-process Python
        # CLI tests replace the earlier test suite's child-Python convenience.
        self.guards = [patch.object(v.parameters.subprocess, 'run', side_effect=AssertionError('subprocess forbidden')),
                       patch.object(v.parameters, 'run', side_effect=AssertionError('process forbidden')),
                       patch.object(v.parameters, 'sql', side_effect=AssertionError('SQL forbidden')),
                       patch.object(v.parameters.socket, 'create_connection', side_effect=AssertionError('network forbidden')),
                       patch.object(v.legacy, 'request', side_effect=AssertionError('HTTP forbidden')),
                       patch.object(v.parameters, 'assert_isolated_lab', side_effect=AssertionError('LAB execution forbidden'))]
        for guard in self.guards:
            guard.start()
            self.addCleanup(guard.stop)

    def invoke(self, value, args=()):
        with tempfile.TemporaryDirectory(prefix='mbox-financial240-parameters-') as directory:
            path = pathlib.Path(directory) / 'config.json'
            path.write_text(json.dumps(value))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                v.main(['--config', str(path), *args])
            self.assertEqual(set(pathlib.Path(directory).iterdir()), {path})
            return json.loads(output.getvalue())

    def test_default_and_validate_only_require_all_six_tables_without_execution(self):
        for args in ((), ('--validate-only',), ('--validate-only', '--capture-financial-baseline')):
            result = self.invoke(config(), args)
            self.assertFalse(result['executed'])
            self.assertEqual(result['financialEvidenceContract'], '237-238-240-v1')
            self.assertEqual(result['requiredTables'], list(v.REQUIRED_TABLES))
        self.assertEqual(len(v.parameters.FINANCIAL_TABLES), 5)
        self.assertEqual(len(v.REQUIRED_TABLES), 6)

    def test_old_schema_fails_before_any_execution_even_with_execute_flag(self):
        for schema in (238, 239, '240'):
            c = config(); c['schema'] = schema
            with self.assertRaises(ValueError):
                self.invoke(c, ('--execute-lab',))

    def test_future_schema_still_requires_admissions_without_claiming_new_table_coverage(self):
        c = config(); c['schema'] = 241
        result = self.invoke(c)
        self.assertIn(v.ADMISSIONS, result['requiredTables'])
        self.assertFalse(result['executed'])

    def test_explicit_identity_and_localhost_restrictions_remain(self):
        for key, value in [('targetSha', 'main'), ('backupOriginSha', 'abc1234'),
                           ('platform', 'auto'), ('imageTag', 'production:latest'),
                           ('callbackUrls', ['https://example.invalid/callback'])]:
            c = config(); c[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.invoke(c)
        c = config(); c['credential'] = 'synthetic-test-marker'
        with self.assertRaises(ValueError): self.invoke(c)

    def test_legacy_dependency_drift_is_rejected_without_importing_changed_code(self):
        with patch.object(pathlib.Path, 'read_bytes', return_value=b'unreviewed changes'):
            with self.assertRaisesRegex(ValueError, 'dependency changed'):
                v.load_legacy()

    def test_old_five_table_or_empty_admission_baseline_fails_closed(self):
        old = facts(); del old[v.ADMISSIONS]
        with self.assertRaises(ValueError): v.validate_evidence(old)
        for table in v.REQUIRED_TABLES:
            empty = facts(); empty[table]['count'] = 0
            with self.subTest(table=table), self.assertRaises(ValueError):
                v.validate_evidence(empty)

    def test_full_row_currency_or_exact_binding_change_breaks_conservation(self):
        before = facts()
        v.compare_evidence(before, copy.deepcopy(before))
        for field, changed in [('rowsSha256', 'd' * 64), ('bindingRowsSha256', 'e' * 64),
                               ('amountsByCurrency', {'CNY': 2500, 'USD': 100}), ('count', 3)]:
            after = facts(); after[v.ADMISSIONS][field] = changed
            with self.subTest(field=field), self.assertRaises(ValueError):
                v.compare_evidence(before, after)

    def test_mismatched_relations_and_invalid_numeric_evidence_are_rejected(self):
        for field, value in [('invalidBindingCount', 1), ('invalidBindingCount', False),
                             ('amountsByCurrency', {}), ('amountsByCurrency', {'CNY': 0}),
                             ('amountsByCurrency', {'CNY': 24.0}), ('amountsByCurrency', {'CNY': -1}),
                             ('bindingRowsSha256', ''), ('rowsSha256', 'short')]:
            bad = facts(); bad[v.ADMISSIONS][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                v.validate_evidence(bad)
        bad = facts(); del bad['loyalty_recollection_restorations']['expired_points']
        with self.assertRaises(ValueError): v.validate_evidence(bad)

    def test_snapshot_reads_one_fixed_aggregate_statement_and_checks_output(self):
        observed = []
        def only_fake_sql(_, query):
            observed.append(query)
            return facts()
        with patch.object(v.parameters, 'sql', side_effect=only_fake_sql):
            self.assertEqual(v.financial_snapshot(config()), facts())
        self.assertEqual(len(observed), 1)
        self.assertTrue(observed[0].startswith('SELECT json_build_object('))
        self.assertNotRegex(observed[0], r'(?i)\b(?:INSERT|UPDATE|DELETE|TRUNCATE|COPY|CREATE|ALTER)\b')
        self.assertIn('receipt.receipt_count=1', observed[0])
        self.assertIn('approval.consumed_payment_id=admission.payment_id', observed[0])
        self.assertIn('(payment.tenant_id,payment.store_id,payment.id)=(admission.tenant_id,admission.store_id,admission.payment_id)', observed[0])

    def test_actual_baseline_writer_is_exclusive_and_preserves_original_facts(self):
        with tempfile.TemporaryDirectory(prefix='mbox-baseline-writer-') as td:
            root=pathlib.Path(td); c=config(); c['schema']=242
            c['runtimeRoot']=td; c['financialBaselineFile']=str(root/'baseline.json')
            directory=root/'maintenance'/c['transitionId']; directory.mkdir(parents=True)
            epoch=directory/'business-write-epoch.json'; epoch.write_text('{"reason":"synthetic"}')
            row={'sequence':0,'previous':'0'*64,'event':'bound','data':{
                'forwardRecoveryTarget':{'releaseSha':c['targetSha']},'sourceLive':{'releaseSha':c['sourceSha']}}}
            row['hash']=v.legacy.hashlib.sha256(v.legacy.canonical(row)).hexdigest()
            (directory/'journal.jsonl').write_text(json.dumps(row)+'\n')
            with patch.object(v.legacy,'sql',return_value=242),patch.object(v.legacy,'financial_snapshot',return_value=facts()),contextlib.redirect_stdout(io.StringIO()):
                v.legacy.capture(c)
                baseline=pathlib.Path(c['financialBaselineFile']); original=baseline.read_bytes()
                self.assertEqual(json.loads(original)['financialFacts'],facts())
                self.assertEqual(baseline.stat().st_mode & 0o777,0o600)
                with self.assertRaises(FileExistsError): v.legacy.capture(c)
                self.assertEqual(baseline.read_bytes(),original)

    def test_python_syntax_and_valid_execute_cannot_bypass_existing_lab_gate(self):
        ast.parse((HERE / 'verify-financial-240.py').read_text())
        with self.assertRaisesRegex(AssertionError, 'LAB execution forbidden'):
            self.invoke(config(), ('--execute-lab',))


if __name__ == '__main__':
    unittest.main(verbosity=2)
