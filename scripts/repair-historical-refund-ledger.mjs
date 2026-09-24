import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const integrationRef = 'postar:historical-refund-ledger-repair-v1'
const action = 'refund.historical_ledger_repaired'
const sha256 = value => createHash('sha256').update(value).digest('hex')
function requireCondition(value, message) { if (!value) throw new Error(message) }

// An operator-only, evidence-bound repair. The caller must supply one transaction;
// no provider calls, original money mutations, order projections or outbox writes.
export async function repairHistoricalRefundLedger(tx, proofText, expectedProofSha, services) {
  requireCondition(/^[a-f0-9]{64}$/.test(expectedProofSha) && sha256(proofText) === expectedProofSha, 'Proof checksum mismatch')
  const proof = JSON.parse(proofText)
  const s = proof.subject, o = proof.observation, t = proof.transport, d = t?.data
  requireCondition(proof.kind === 'mbox-bound-historical-refund-query-v1'
    && proof.providerTransactionMatches === true && proof.providerCalls === 1 && proof.businessWrites === 0
    && t?.httpStatus === 200 && t.code === '000000' && /^[a-f0-9]{64}$/.test(t.responseSha256)
    && ['4', 'c'].includes(d?.orderStatus), 'Successful bound provider query required')
  const amount = Number(s.amount_minor)
  requireCondition(Number.isSafeInteger(amount) && amount > 0 && s.currency === 'CNY' && s.provider === 'postar'
    && s.status === 'succeeded' && s.existing_refund_entries === 0
    && ['succeeded', 'partially_refunded', 'refunded'].includes(s.payment_status)
    && Number(s.payment_amount) >= amount && s.tenant_id === tx.scope.tenantId && s.store_id === tx.scope.storeId,
  'Proof scope or successful money identity mismatch')
  requireCondition(o.status === 'succeeded' && o.amount === amount && o.currency === s.currency
    && o.providerRefundTransactionId === s.provider_refund_id && o.originalProviderTransactionId === s.provider_transaction_id
    && o.refundId === s.merchant_refund_id && o.providerRefundId === s.merchant_refund_id
    && d.orderFlowNo === s.provider_refund_id && d.oldOrderNo === s.provider_transaction_id
    && String(d.refundAmt) === String(-amount), 'Provider refund identity mismatch')
  requireCondition(/^\d{14}$/.test(d.sucOrderTime) && /^\d{14}$/.test(d.orderTime)
    && d.sucOrderTime >= d.orderTime && d.orderTime.slice(0, 8) === s.refund_date,
  'Provider completion date missing or inconsistent')
  const stamp = d.sucOrderTime
  const completedAt = `${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(8,10)}:${stamp.slice(10,12)}:${stamp.slice(12,14)}+08:00`
  requireCondition(Number.isFinite(Date.parse(completedAt)) && Date.parse(completedAt) <= Date.parse(t.queriedAt), 'Invalid completion time')
  await tx.query("SET LOCAL TIME ZONE 'Asia/Shanghai'")
  // Order -> payment -> refund matches the command lock order. Do not serialize
  // unrelated business activity or acquire schema/table locks.
  const scope = [tx.scope.tenantId, tx.scope.storeId]
  await tx.query(`SELECT id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2
    AND id IN (SELECT order_id FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND id=$3)
    ORDER BY id FOR UPDATE`, [...scope, s.payment_id])
  const payment = (await tx.query(`SELECT *,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint
    FROM mbox.payments p WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`, [...scope, s.payment_id])).rows[0]
  const refund = (await tx.query(`SELECT *,encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') fingerprint
    FROM mbox.refunds r WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`, [...scope, s.refund_id])).rows[0]
  requireCondition(payment?.fingerprint === s.payment_fingerprint && refund?.fingerprint === s.refund_fingerprint
    && refund.status === 'succeeded' && String(refund.amount_minor) === String(amount) && refund.currency === s.currency
    && payment.status === s.payment_status && payment.provider === 'postar' && String(payment.amount_minor) === String(s.payment_amount)
    && refund.public_id === s.refund_public_id && refund.payment_id === payment.id
    && refund.provider_refund_id === s.provider_refund_id && payment.provider_transaction_id === s.provider_transaction_id,
  'Original financial rows changed; recollect evidence')
  const receipt = await tx.query(`SELECT amount_minor::text,currency,provider,provider_reference FROM mbox.reconciliation_entries
    WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3 AND entry_type='payment'`, [...scope, s.payment_id])
  requireCondition(receipt.rowCount === 1 && receipt.rows[0].amount_minor === String(s.payment_amount)
    && receipt.rows[0].currency === s.currency && receipt.rows[0].provider === s.provider
    && receipt.rows[0].provider_reference === s.provider_transaction_id, 'Original receipt ledger mismatch')
  const dates = (await tx.query(`SELECT timezone,
    (($3::timestamptz AT TIME ZONE timezone) - (business_day_cutoff-TIME '00:00'))::date::text business_date,
    (($4::timestamptz AT TIME ZONE timezone) - (business_day_cutoff-TIME '00:00'))::date::text original_business_date,
    to_char($3::timestamptz AT TIME ZONE 'Asia/Shanghai','YYYYMMDDHH24MISS') roundtrip
    FROM mbox.stores WHERE tenant_id=$1 AND id=$2`, [...scope, completedAt, refund.completed_at])).rows[0]
  requireCondition(dates?.timezone === 'Asia/Shanghai' && dates.roundtrip === stamp
    && dates.business_date === dates.original_business_date, 'Historical business date needs independent review')
  const key = `historical-refund-ledger:${refund.id}`
  const existing = await tx.query(`SELECT id,payment_id,refund_id,entry_type,amount_minor::text,currency,provider,provider_reference,
    business_date::text,occurred_at,evidence_snapshot FROM mbox.reconciliation_entries
    WHERE tenant_id=$1 AND store_id=$2 AND (refund_id=$3 OR (provider=$4 AND provider_reference=$5 AND entry_type='refund'))`,
  [...scope, refund.id, s.provider, s.provider_refund_id])
  if (existing.rowCount) {
    const e = existing.rows[0]
    requireCondition(existing.rowCount === 1 && e.entry_type === 'refund' && e.payment_id === payment.id && e.refund_id === refund.id
      && e.amount_minor === String(-amount) && e.currency === s.currency && e.provider === s.provider
      && e.provider_reference === s.provider_refund_id && e.business_date === dates.business_date
      && Date.parse(e.occurred_at) === Date.parse(completedAt) && e.evidence_snapshot?.eventId === `historical-refund-ledger:${expectedProofSha}`,
    'Existing refund ledger conflicts with repair')
    const closure = await tx.query(`SELECT a.id FROM mbox.audit_events a JOIN mbox.verified_provider_observations v
      ON v.tenant_id=a.tenant_id AND v.store_id=a.store_id AND v.id::text=a.after_snapshot->>'observationId'
      WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.action=$3 AND a.object_id=$4
        AND a.after_snapshot->>'entryId'=$5 AND a.after_snapshot->>'proofSha256'=$6
        AND v.refund_id=$7 AND v.integration_ref=$8 AND v.consumed_operation='refund.result'
        AND v.consumed_idempotency_key=$9 AND v.consumed_at IS NOT NULL`,
    [...scope, action, refund.id, e.id, expectedProofSha, refund.id, integrationRef, key])
    requireCondition(closure.rowCount === 1, 'Existing repair audit/observation closure missing')
    return { status: 'already_repaired', entryId: e.id, amountMinor: -amount, businessDate: dates.business_date, proofSha256: expectedProofSha }
  }
  const totals = (await tx.query(`SELECT
    (SELECT COALESCE(sum(amount_minor),0) FROM mbox.refunds WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3 AND status='succeeded')::text successful_refunds,
    (SELECT COALESCE(-sum(amount_minor),0) FROM mbox.reconciliation_entries WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3 AND entry_type='refund')::text recorded_refunds`, [...scope, payment.id])).rows[0]
  requireCondition(BigInt(totals.successful_refunds) <= BigInt(s.payment_amount)
    && BigInt(totals.recorded_refunds) + BigInt(amount) <= BigInt(s.payment_amount), 'Refund totals exceed original receipt')
  const recorder = new services.VerifiedProviderObservationService({ run: async (_scope, work) => work(tx) })
  const observationId = await recorder.recordRefund({ scope: tx.scope, provider: 'postar', verificationKind: 'active_query_binding',
    providerEventId: `historical-refund-ledger:${expectedProofSha}`, integrationRef, providerTransactionId: s.provider_refund_id,
    originalProviderTransactionId: s.provider_transaction_id, reportedAmountMinor: amount, reportedCurrency: s.currency,
    occurredAt: completedAt, refundPublicId: s.refund_public_id, status: 'succeeded',
    evidence: { source: 'operator_bound_refund_query', proofSha256: expectedProofSha, responseSha256: t.responseSha256,
      queriedAt: t.queriedAt, providerCompletedAt: completedAt, signedResponse: t.signedResponse === true } })
  await new services.NormalizedProviderObservationAuthority().consume({ transaction: tx, observationId, operation: 'refund.result',
    idempotencyKey: key, integrationRef, provider: 'postar', subjectPublicId: s.refund_public_id,
    providerTransactionId: s.provider_refund_id, originalProviderTransactionId: s.provider_transaction_id,
    reportedAmountMinor: amount, reportedCurrency: s.currency, observedStatus: 'refund_succeeded' })
  const entry = await new services.ReconciliationRepository(tx).append({ paymentId: payment.id, refundId: refund.id,
    entryType: 'refund', provider: 'postar', providerReference: s.provider_refund_id, amountMinor: -amount,
    currency: s.currency, businessDate: dates.business_date, occurredAt: completedAt,
    evidenceSnapshot: { eventId: `historical-refund-ledger:${expectedProofSha}`, merchantRefundId: s.merchant_refund_id,
      providerOrderId: s.provider_refund_id, providerReportedAmountMinor: amount, providerStatus: 'succeeded', occurredAt: completedAt } })
  await services.appendAuditEvent(tx, { actor: { type: 'system', ref: integrationRef }, action, objectType: 'refund', objectId: refund.id,
    businessDate: dates.business_date, beforeData: { refundEntryCount: 0 },
    afterData: { entryId: entry.id, observationId, amountMinor: -amount, proofSha256: expectedProofSha },
    reason: 'Append missing historical refund reconciliation after an exactly bound successful provider query; preserve original financial facts',
    metadata: { providerQueryAt: t.queriedAt, responseSha256: t.responseSha256, signedResponse: t.signedResponse === true,
      originalRefundFingerprint: s.refund_fingerprint, originalPaymentFingerprint: s.payment_fingerprint } })
  const unchanged = (await tx.query(`SELECT
    encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') refund_fingerprint,
    encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') payment_fingerprint
    FROM mbox.refunds r JOIN mbox.payments p ON(p.tenant_id,p.store_id,p.id)=(r.tenant_id,r.store_id,r.payment_id)
    WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.id=$3`, [...scope, refund.id])).rows[0]
  requireCondition(unchanged?.refund_fingerprint === s.refund_fingerprint && unchanged?.payment_fingerprint === s.payment_fingerprint, 'Original money facts unexpectedly changed')
  return { status: 'repaired', entryId: entry.id, amountMinor: -amount, businessDate: dates.business_date, proofSha256: expectedProofSha }
}

async function main() {
  const args = process.argv.slice(2)
  const options = new Map()
  for (let i=0;i<args.length;i++) {
    const key=args[i]
    requireCondition(['--proof','--proof-sha256','--expected-commit','--apply'].includes(key) && !options.has(key), 'Invalid or duplicate option')
    options.set(key, key==='--apply' ? true : args[++i])
  }
  requireCondition(options.get('--proof') && /^[a-f0-9]{64}$/.test(options.get('--proof-sha256'))
    && /^[a-f0-9]{40}$/.test(options.get('--expected-commit')), 'Require --proof FILE --proof-sha256 SHA256 --expected-commit SHA; default is rollback preview')
  const load = file => import(pathToFileURL(resolve('dist-normalized/server/normalized', file)).href)
  const { loadNormalizedRuntimeConfig } = await load('normalized-runtime-config.js')
  const config = loadNormalizedRuntimeConfig()
  requireCondition(config.commitSha === options.get('--expected-commit'), 'Runtime commit changed')
  const pg = createRequire(resolve('package.json'))('pg')
  const services = Object.assign({}, await load('provider-verification-observation.js'), await load('reconciliation-repository.js'), await load('command-executor.js'))
  const proof = await readFile(options.get('--proof'), 'utf8')
  const client = new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis:5000, application_name:'mbox-historical-refund-ledger-repair' })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='750ms'; SET LOCAL idle_in_transaction_session_timeout='5s'")
    const identity = (await client.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=session_user')).rows[0]
    requireCondition(identity && Object.values(identity).every(v => v===false), 'A restricted runtime LOGIN is required')
    const scope = { tenantId:config.tenantId, storeId:config.storeId }
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)", [scope.tenantId,scope.storeId])
    const result = await repairHistoricalRefundLedger({scope,query:(...values)=>client.query(...values)}, proof, options.get('--proof-sha256'), services)
    await client.query(options.has('--apply') ? 'COMMIT' : 'ROLLBACK')
    console.log(JSON.stringify({...result,committed:options.has('--apply'),runtimeCommit:config.commitSha}))
  } finally { await client.query('ROLLBACK').catch(()=>{}); await client.end() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ error:error.message, code:error.code??null })); process.exitCode=1 })
}
