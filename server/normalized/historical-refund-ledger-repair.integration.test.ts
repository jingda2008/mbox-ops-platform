import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { VerifiedProviderObservationService, NormalizedProviderObservationAuthority } from './provider-verification-observation.js'
import { ReconciliationRepository } from './reconciliation-repository.js'
import { appendAuditEvent } from './command-executor.js'
import { repairHistoricalRefundLedger } from '../../scripts/repair-historical-refund-ledger.mjs'

const url=process.env.TEST_NORMALIZED_DATABASE_URL, runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const services={VerifiedProviderObservationService,NormalizedProviderObservationAuthority,ReconciliationRepository,appendAuditEvent}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex')
;(url&&runtimeUrl?describe:describe.skip)('historical refund ledger operator repair with restricted LOGIN',()=>{
  let admin:Pool, runtime:Pool, runner:ScopedPostgresTransactionRunner
  const scope={tenantId:randomUUID(),storeId:randomUUID()},session=randomUUID(),requester=randomUUID(),approver=randomUUID()
  beforeAll(async()=>{
    await runNormalizedMigrations(url!)
    admin=new Pool({connectionString:url});runtime=new Pool({connectionString:runtimeUrl,max:8});runner=new ScopedPostgresTransactionRunner(runtime)
    expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Repair fixture')",[scope.tenantId,scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'repair','Repair fixture')",[scope.storeId,scope.tenantId])
    for(const id of [requester,approver])await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,'Repair fixture')",[id,scope.tenantId,scope.storeId])
    const area=randomUUID(),table=randomUUID()
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'REPAIR','Repair','indoor')",[area,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'REPAIR','Repair',4)",[table,scope.tenantId,scope.storeId,area])
    await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1::uuid,$2,$3,$4,$1::text,'2026-08-23',2,'open')",[session,scope.tenantId,scope.storeId,table])
  })
  afterAll(async()=>{await runtime?.end();await admin?.end()})
  async function fixture(){
    const order=randomUUID(),payment=randomUUID(),refund=randomUUID(),platformPayment=`PAY-${payment}`,platformRefund=`REF-${refund}`
    await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,settlement_mode,status,payment_status,subtotal_amount_minor,total_amount_minor) VALUES($1::uuid,$2,$3,$4,$1::text,'integration','table_tab','submitted','paid',9800,9800)",[order,scope.tenantId,scope.storeId,session])
    await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,settlement_channel,succeeded_at) VALUES($1::uuid,$2,$3,$4,$1::text,'postar',$5,'native_qr',9800,'CNY','partially_refunded','wechat','2026-08-23T12:00:00+08:00')",[payment,scope.tenantId,scope.storeId,order,platformPayment])
    await admin.query(`INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,amount_minor,currency,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,merchant_refund_id,provider_refund_id,provider_submission_started_at,provider_submission_state,completed_at)
      VALUES($1::uuid,$2,$3,$4,$1::text,2000,'CNY','succeeded','Historical fixture',$5,$6,'Approved fixture',replace($1::text,'-',''),$7,'2026-08-23T13:47:50+08:00','submitted','2026-08-23T13:50:49+08:00')`,[refund,scope.tenantId,scope.storeId,payment,requester,approver,platformRefund])
    await runner.run(scope,tx=>new ReconciliationRepository(tx).append({paymentId:payment,entryType:'payment',provider:'postar',providerReference:platformPayment,amountMinor:9800,currency:'CNY',businessDate:'2026-08-23',occurredAt:'2026-08-23T12:00:00+08:00'}))
    const fingerprints=await runner.run(scope,async tx=>{
      await tx.query("SET LOCAL TIME ZONE 'Asia/Shanghai'")
      return (await tx.query(`SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') refund_fingerprint,
        encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') payment_fingerprint
        FROM mbox.refunds r JOIN mbox.payments p ON p.id=r.payment_id WHERE r.id=$1`,[refund])).rows[0]
    })
    const proof={kind:'mbox-bound-historical-refund-query-v1',providerTransactionMatches:true,providerCalls:1,businessWrites:0,
      subject:{refund_id:refund,refund_public_id:refund,payment_id:payment,tenant_id:scope.tenantId,store_id:scope.storeId,status:'succeeded',amount_minor:'2000',currency:'CNY',merchant_refund_id:refund.replaceAll('-',''),provider_refund_id:platformRefund,refund_date:'20260823',...fingerprints,provider:'postar',provider_transaction_id:platformPayment,payment_status:'partially_refunded',payment_amount:'9800',existing_refund_entries:0},
      observation:{status:'succeeded',amount:2000,currency:'CNY',providerRefundTransactionId:platformRefund,originalProviderTransactionId:platformPayment,refundId:refund.replaceAll('-',''),providerRefundId:refund.replaceAll('-','')},
      transport:{httpStatus:200,code:'000000',responseSha256:'a'.repeat(64),queriedAt:'2026-09-24T00:00:00Z',signedResponse:false,data:{orderStatus:'4',orderTime:'20260823134238',sucOrderTime:'20260823134239',refundAmt:'-2000',orderFlowNo:platformRefund,oldOrderNo:platformPayment}}}
    return {order,payment,refund,proof}
  }
  const apply=(f:any,overrides=services)=>{const text=JSON.stringify(f.proof);return runner.run(scope,tx=>repairHistoricalRefundLedger(tx,text,digest(text),overrides))}
  async function counts(f:any){return (await admin.query(`SELECT
    (SELECT count(*)::int FROM mbox.reconciliation_entries WHERE refund_id=$1) ledger,
    (SELECT count(*)::int FROM mbox.audit_events WHERE object_id=$1::text AND action='refund.historical_ledger_repaired') audit,
    (SELECT count(*)::int FROM mbox.verified_provider_observations WHERE refund_id=$1) observations`,[f.refund])).rows[0]}
  async function facts(f:any){return (await admin.query(`SELECT to_jsonb(p) payment,to_jsonb(r) refund,to_jsonb(o) orders
    FROM mbox.payments p JOIN mbox.refunds r ON r.payment_id=p.id JOIN mbox.orders o ON o.id=p.order_id WHERE r.id=$1`,[f.refund])).rows[0]}
  it('previews by rollback, repairs once on the original business date, and leaves original facts unchanged',async()=>{
    const f=await fixture(),before=await facts(f),text=JSON.stringify(f.proof)
    await expect(runner.run(scope,async tx=>{await repairHistoricalRefundLedger(tx,text,digest(text),services);throw Error('preview rollback')})).rejects.toThrow('preview rollback')
    expect(await counts(f)).toEqual({ledger:0,audit:0,observations:0})
    expect(await apply(f)).toMatchObject({status:'repaired',amountMinor:-2000,businessDate:'2026-08-23'})
    expect(await apply(f)).toMatchObject({status:'already_repaired'})
    expect(await counts(f)).toEqual({ledger:1,audit:1,observations:1});expect(await facts(f)).toEqual(before)
    const stored=(await admin.query("SELECT e.occurred_at,v.consumed_operation FROM mbox.reconciliation_entries e JOIN mbox.verified_provider_observations v ON v.refund_id=e.refund_id WHERE e.refund_id=$1",[f.refund])).rows[0]
    expect(stored.occurred_at.toISOString()).toBe('2026-08-23T05:42:39.000Z');expect(stored.consumed_operation).toBe('refund.result')
  })
  it('serializes concurrent retries to one ledger, audit and consumed observation',async()=>{
    const f=await fixture(),results=await Promise.all(Array.from({length:8},()=>apply(f)))
    expect(results.filter(r=>r.status==='repaired')).toHaveLength(1);expect(await counts(f)).toEqual({ledger:1,audit:1,observations:1})
  })
  it('rolls back observation and ledger if audit append fails',async()=>{
    const f=await fixture()
    await expect(apply(f,{...services,appendAuditEvent:async()=>{throw Error('audit unavailable')}})).rejects.toThrow('audit unavailable')
    expect(await counts(f)).toEqual({ledger:0,audit:0,observations:0});expect(await apply(f)).toMatchObject({status:'repaired'})
  })
  it.each(['amount','originalPayment','refund','status','date','impossibleDate','scope','fingerprint','proofHash'])( 'rejects %s mismatch without any writes',async mismatch=>{
    const f=await fixture()
    if(mismatch==='amount')f.proof.observation.amount=2100
    if(mismatch==='originalPayment')f.proof.observation.originalProviderTransactionId='OTHER-PAYMENT'
    if(mismatch==='refund')f.proof.observation.providerRefundTransactionId='OTHER-REFUND'
    if(mismatch==='status')f.proof.transport.data.orderStatus='b'
    if(mismatch==='date')f.proof.transport.data.sucOrderTime='20260824134239'
    if(mismatch==='impossibleDate')f.proof.transport.data.sucOrderTime='20260832134239'
    if(mismatch==='scope')f.proof.subject.store_id=randomUUID()
    if(mismatch==='fingerprint')await admin.query("UPDATE mbox.payments SET provider_snapshot='{}'::jsonb,updated_at=clock_timestamp() WHERE id=$1",[f.payment])
    const text=JSON.stringify(f.proof)
    await expect(runner.run(scope,tx=>repairHistoricalRefundLedger(tx,text,mismatch==='proofHash'?'0'.repeat(64):digest(text),services))).rejects.toThrow()
    expect(await counts(f)).toEqual({ledger:0,audit:0,observations:0})
  })
  it('rejects an existing conflicting ledger instead of silently claiming a repair',async()=>{
    const f=await fixture()
    await runner.run(scope,tx=>new ReconciliationRepository(tx).append({paymentId:f.payment,refundId:f.refund,entryType:'refund',provider:'postar',providerReference:f.proof.subject.provider_refund_id,amountMinor:-1000,currency:'CNY',businessDate:'2026-08-23',occurredAt:'2026-08-23T13:42:39+08:00'}))
    await expect(apply(f)).rejects.toThrow('conflicts');expect(await counts(f)).toEqual({ledger:1,audit:0,observations:0})
  })
})
