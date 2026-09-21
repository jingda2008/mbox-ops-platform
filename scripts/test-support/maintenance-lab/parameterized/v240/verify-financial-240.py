"""Versioned LAB verifier supplement. Import/validation performs no execution."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
LEGACY = HERE.parent
INPUT_HASHES = {
    'lab_parameters.py': 'dab2106230e722330cd110961ccda377e5923db7ca37ee34f80ac1b6af24cdc8',
    'verify-final-parameterized.py': '5aa0b2a0755a132dae566a25ebbacd16a4072e131ffeff35041e86206930c34a',
}


def require(value, message):
    if not value:
        raise ValueError(message)


def load_legacy():
    for name, expected in INPUT_HASHES.items():
        require(hashlib.sha256((LEGACY / name).read_bytes()).hexdigest() == expected,
                'reviewed external verifier dependency changed: ' + name)
    # The existing verifier imports this exact sibling; no product source is
    # imported or modified. Pinned bytes prevent silently inheriting a new driver.
    sys.path.insert(0, str(LEGACY))
    try:
        import lab_parameters
        require(pathlib.Path(lab_parameters.__file__).resolve() == LEGACY / 'lab_parameters.py',
                'unexpected parameter module origin')
        spec = importlib.util.spec_from_file_location('lab_verify_240_legacy', LEGACY / 'verify-final-parameterized.py')
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)
        return lab_parameters, verifier
    finally:
        sys.path.pop(0)


parameters, legacy = load_legacy()
ADMISSIONS = 'closed_debt_manual_payment_admissions'
REQUIRED_TABLES = tuple(parameters.FINANCIAL_TABLES) + (ADMISSIONS,)

# Read only, fixed identifiers, aggregate/hash-only output. The six snapshots
# are one SQL statement in the original READ ONLY transaction, not six races.
# This query is prepared here; no SQL is run on import or parameter validation.
ADMISSION_EVIDENCE_SQL = r"""(
 SELECT json_build_object(
  'count',count(*),
  'rowsSha256',encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(admission)::text,E'\n' ORDER BY to_jsonb(admission)::text),''),'UTF8')),'hex'),
  'amountsByCurrency',(SELECT COALESCE(jsonb_object_agg(currency,total),'{}'::jsonb)
    FROM (SELECT currency::text currency,sum(amount_minor) total FROM mbox.closed_debt_manual_payment_admissions GROUP BY currency) amounts),
  'bindingRowsSha256',encode(sha256(convert_to(COALESCE(string_agg(jsonb_build_object(
    'paymentId',payment.id,'orderId',ordering.id,'sessionId',session.id,'collectorId',employee.id,
    'paymentAmount',payment.amount_minor,'paymentCurrency',payment.currency,'payableKind',payment.payable_kind,
    'provider',payment.provider,'method',payment.method,'reference',payment.provider_transaction_id,
    'paymentCreatedAt',payment.created_at,'paymentSucceededAt',payment.succeeded_at,
    'authorizationId',approval.id,'authorizationOrderId',approval.order_id,'authorizationStatus',approval.status,
    'consumedPaymentId',approval.consumed_payment_id,'consumedAt',approval.consumed_at,
    'authorizationAmount',approval.amount_minor,'authorizationCurrency',approval.currency,
    'authorizationCreatedAt',approval.created_at,'authorizationExpiresAt',approval.expires_at,
    'ledgerCount',receipt.receipt_count,'ledgerRowsSha256',receipt.rows_sha256
  )::text,E'\n' ORDER BY admission.tenant_id,admission.store_id,admission.payment_id),''),'UTF8')),'hex'),
  'invalidBindingCount',COALESCE(sum(CASE WHEN
    payment.payable_kind='order' AND payment.order_id=admission.order_id
    AND payment.status IN ('succeeded','partially_refunded','refunded')
    AND payment.amount_minor=admission.amount_minor AND payment.currency=admission.currency
    AND payment.provider=admission.provider AND payment.method=admission.method
    AND payment.provider_transaction_id=admission.provider_reference
    AND payment.created_at=admission.payment_created_at AND payment.succeeded_at=admission.payment_succeeded_at
    AND payment.provider_snapshot->>'collectedByEmployeeId'=admission.collected_by_employee_id::text
    AND ordering.table_session_id=admission.table_session_id AND ordering.currency=admission.currency
    AND session.status='closed' AND session.closed_at=admission.closed_at
    AND employee.id=admission.collected_by_employee_id
    AND approval.order_id=admission.order_id AND approval.status='consumed'
    AND approval.consumed_payment_id=admission.payment_id
    AND approval.amount_minor=admission.amount_minor AND approval.currency=admission.currency
    AND approval.created_at=admission.authorization_created_at AND approval.expires_at=admission.authorization_expires_at
    AND approval.created_at<=payment.created_at AND approval.consumed_at>=admission.admitted_at
    AND approval.consumed_at<admission.authorization_expires_at
    AND admission.admitted_at>=admission.closed_at AND admission.payment_created_at>=admission.closed_at
    AND admission.payment_succeeded_at>=admission.closed_at
    AND receipt.receipt_count=1 AND receipt.exact_match IS TRUE
    THEN 0 ELSE 1 END),0)
 )
 FROM mbox.closed_debt_manual_payment_admissions admission
 LEFT JOIN mbox.payments payment ON (payment.tenant_id,payment.store_id,payment.id)=(admission.tenant_id,admission.store_id,admission.payment_id)
 LEFT JOIN mbox.orders ordering ON (ordering.tenant_id,ordering.store_id,ordering.id)=(admission.tenant_id,admission.store_id,admission.order_id)
 LEFT JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(admission.tenant_id,admission.store_id,admission.table_session_id)
 LEFT JOIN mbox.employees employee ON (employee.tenant_id,employee.store_id,employee.id)=(admission.tenant_id,admission.store_id,admission.collected_by_employee_id)
 LEFT JOIN mbox.order_recollection_authorizations approval ON (approval.tenant_id,approval.store_id,approval.id)=(admission.tenant_id,admission.store_id,admission.authorization_id)
 LEFT JOIN LATERAL (
  SELECT count(*) receipt_count,
    bool_and(entry.refund_id IS NULL AND entry.provider=admission.provider
      AND entry.provider_reference=admission.provider_reference AND entry.amount_minor=admission.amount_minor
      AND entry.currency=admission.currency AND entry.occurred_at=admission.payment_succeeded_at
      AND entry.created_at>=admission.admitted_at
      AND entry.evidence_snapshot->>'collectedByEmployeeId'=admission.collected_by_employee_id::text
      AND entry.evidence_snapshot->>'receiptReference'=admission.provider_reference) exact_match,
    encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(entry)::text,E'\n' ORDER BY to_jsonb(entry)::text),''),'UTF8')),'hex') rows_sha256
  FROM mbox.reconciliation_entries entry
  WHERE (entry.tenant_id,entry.store_id,entry.payment_id)=(admission.tenant_id,admission.store_id,admission.payment_id)
    AND entry.entry_type='payment'
 ) receipt ON true
)"""


def snapshot_sql():
    pairs = []
    for table, sums in parameters.FINANCIAL_TABLES.items():
        columns = ["'count',count(*)", "'rowsSha256',encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(row)::text,E'\\n' ORDER BY to_jsonb(row)::text),''),'UTF8')),'hex')"]
        columns += ["'%s',COALESCE(sum(%s),0)" % (field, field) for field in sums]
        pairs.append("'%s',(SELECT json_build_object(%s) FROM mbox.%s row)" % (table, ','.join(columns), table))
    pairs.append("'%s',%s" % (ADMISSIONS, ADMISSION_EVIDENCE_SQL))
    return 'SELECT json_build_object(' + ','.join(pairs) + ')'


def validate_evidence(facts):
    require(isinstance(facts, dict) and set(facts) == set(REQUIRED_TABLES), 'schema 240 requires exactly the six reviewed financial fact tables')
    for table in REQUIRED_TABLES:
        row = facts[table]
        require(isinstance(row, dict) and type(row.get('count')) is int and row['count'] > 0,
                'real nonempty LAB facts required: ' + table)
        require(isinstance(row.get('rowsSha256'), str) and re.fullmatch('[a-f0-9]{64}', row['rowsSha256']),
                'full-row SHA256 required: ' + table)
    admission = facts[ADMISSIONS]
    require(type(admission.get('invalidBindingCount')) is int and admission['invalidBindingCount'] == 0,
            'manual admission financial/authorization/scope binding mismatch')
    require(isinstance(admission.get('bindingRowsSha256'), str) and re.fullmatch('[a-f0-9]{64}', admission['bindingRowsSha256']),
            'exact binding/ledger hash required')
    amounts = admission.get('amountsByCurrency')
    require(isinstance(amounts, dict) and bool(amounts) and all(
        re.fullmatch('[A-Z]{3}', currency) and type(amount) is int and amount > 0 for currency, amount in amounts.items()),
        'nonempty per-currency integer amounts required')
    for table, sums in parameters.FINANCIAL_TABLES.items():
        require(all(type(facts[table].get(field)) is int for field in sums), 'original financial sums must remain present: ' + table)
    return facts


def compare_evidence(before, after):
    validate_evidence(before)
    validate_evidence(after)
    require(before == after, '237/238/240 facts or their exact manual receipt bindings changed')


def financial_snapshot(config):
    require(config['schema'] >= 240, 'use the original verifier for schema 238/239')
    return validate_evidence(parameters.sql(config, snapshot_sql()))


def read_config(path):
    config = parameters.read_config(path)
    require(config['schema'] >= 240, 'versioned verifier requires an explicit schema >= 240')
    return config


def main(argv=None):
    parser = argparse.ArgumentParser(description='Prepared LAB-only 237/238/240 financial conservation supplement')
    parser.add_argument('--config', required=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--validate-only', action='store_true')
    modes.add_argument('--execute-lab', action='store_true')
    parser.add_argument('--capture-financial-baseline', action='store_true')
    args = parser.parse_args(argv)
    config = read_config(args.config)
    if not args.execute_lab:
        print(json.dumps({'parametersValid': True, 'executed': False, 'labOnly': True,
                          'schema': config['schema'], 'platform': config['platform'], 'targetSha': config['targetSha'],
                          'financialEvidenceContract': '237-238-240-v1', 'requiredTables': REQUIRED_TABLES}))
        return
    parameters.assert_isolated_lab(config)
    # Reuse the pinned original journal/epoch/backup-origin/role/duplicate-
    # callback checks. Only its financial snapshot function gains the new table.
    legacy.financial_snapshot = financial_snapshot
    if args.capture_financial_baseline:
        legacy.capture(config)
    else:
        baseline = json.loads(pathlib.Path(config['financialBaselineFile']).read_text())
        require(type(baseline.get('schema')) is int and baseline['schema'] >= 240,
                'old five-table baseline cannot prove schema 240 financial conservation')
        validate_evidence(baseline.get('financialFacts'))
        legacy.verify(config)


if __name__ == '__main__':
    main()
