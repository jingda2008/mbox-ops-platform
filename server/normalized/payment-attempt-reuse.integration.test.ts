import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority,VerifiedProviderObservationService} from './provider-verification-observation.js'
import {execFileSync} from 'node:child_process'
import { PaymentProviderActionRepository } from './payment-provider-action-repository.js'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { PaymentRepository } from './payment-repository.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js'

const adminUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const secret = 'isolated-provider-concurrency-fixture-at-least-32-bytes'


;(adminUrl && runtimeUrl ? describe : describe.skip)('Repeated online collection requests, restricted LOGIN', () => {
  let admin: Pool, runtime: Pool, runner: ScopedPostgresTransactionRunner
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }, area = randomUUID(), product = randomUUID()
  let date: string
  beforeAll(async () => {
    await runNormalizedMigrations(adminUrl!)
    admin = new Pool({ connectionString: adminUrl, max: 5, options: '-c statement_timeout=3000' })
    runtime = new Pool({ connectionString: runtimeUrl, max: 8 })
    runner = new ScopedPostgresTransactionRunner(runtime)
    expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Provider concurrency')", [scope.tenantId, scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,$3,'Provider concurrency','Asia/Shanghai','06:00')", [scope.storeId, scope.tenantId, scope.storeId])
    date = await runner.run(scope, async tx => (await tx.query<{ date: string }>('SELECT mbox.current_operating_business_date($1,$2)::text date', [scope.tenantId,scope.storeId])).rows[0]!.date)
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')", [area,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode) VALUES($1,$2,$3,'FIXTURE','Fixture','food','none','not_managed')", [product,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',4000,'CNY',clock_timestamp()-interval '1 minute')", [scope.tenantId,scope.storeId,product])
  }, 30_000)
  afterAll(async () => { await runtime?.end(); await admin?.end() })

  async function fixture(withPayment = true) {
    const table = randomUUID(), session = randomUUID(), customer = randomUUID(), order = randomUUID(), payment = randomUUID()
    await admin.query('INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)', [table,scope.tenantId,scope.storeId,area,table.slice(0,8)])
    await admin.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)', [customer,scope.tenantId,scope.storeId])
    await admin.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,2)', [session,scope.tenantId,scope.storeId,table,date])
    await admin.query("INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship) VALUES($1,$2,$3,$4,'primary')", [scope.tenantId,scope.storeId,session,customer])
    const actorRef = await seedActiveGuestTableAuthority(admin,{...scope,tableSessionId:session,customerId:customer})
    if (withPayment) {
      await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,settlement_mode,fulfillment_state) VALUES($1::uuid,$2,$3,$4,$1::text,'guest_qr','submitted',clock_timestamp(),4000,4000,'immediate_payment','awaiting_payment')", [order,scope.tenantId,scope.storeId,session])
      await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status) VALUES($1::uuid,$2,$3,$4,$1::text,'simulation','native_qr',4000,'CNY','pending')", [payment,scope.tenantId,scope.storeId,order])
    }
    const principal = { type:'guest' as const,tableSessionId:session,customerId:customer,guestSessionId:actorRef.slice('guest-session:'.length) }
    await admin.query('DELETE FROM mbox.payments WHERE id=$1',[payment])
    return { table,session,customer,order,payment,actorRef,principal }
  }

  it.each([false,true])('reuses one pending attempt across 12 different request IDs (batch=%s)', async batch => {
    const f=await fixture()
    const request=() => runner.run(scope, tx => {
      const repository=new PaymentRepository(tx)
      const input={orderId:f.order,orderIds:[f.order],publicId:'P'+randomUUID().replaceAll('-',''),
        provider:'postar' as const,method:'native_qr' as const,initialStatus:'pending' as const,principal:f.principal}
      return batch?repository.createForOrders(input):repository.createForOrder(input)
    })
    const results=await Promise.all(Array.from({length:12},request))
    expect(new Set(results.map(p=>p.id)).size).toBe(1)
    expect((await admin.query('SELECT count(DISTINCT id)::int n FROM mbox.order_payment_facts WHERE order_id=$1',[f.order])).rows[0].n).toBe(1)
    expect((await request()).id).toBe(results[0]!.id)
    // Read-only reuse must preserve the original creation and update timestamps.
    expect((await request()).updatedAt).toBe(results[0]!.updatedAt)
  },15000)
  it('does not append a second initiation event when a fresh request key repeats the original public ID',async()=>{
    const f=await fixture(),publicId='P'+randomUUID().replaceAll('-','')
    const commands=new PaymentCommandService(new NormalizedCommandExecutor(runner),new NormalizedPaymentCapabilityAuthorization())
    const create=()=>commands.initiate({scope,actor:{type:'guest',ref:f.actorRef},businessDate:date,
      idempotencyKey:'retry-'+randomUUID(),requestFingerprint:publicId,orderId:f.order,publicId,
      provider:'postar',method:'native_qr',principal:f.principal})
    const first=await create(),second=await create()
    expect(second.value.id).toBe(first.value.id)
    expect((await admin.query("SELECT count(*)::int n FROM mbox.audit_events WHERE object_id=$1 AND action='payment.initiated'",[first.value.id])).rows[0].n).toBe(1)
  })
  it('does not reuse a batch QR for a different partial amount or method',async()=>{
    const f=await fixture()
    const create=(amountMinor:number,method:'native_qr'|'auth_code'='native_qr')=>runner.run(scope,tx=>new PaymentRepository(tx).createForOrders({
      orderIds:[f.order],amountMinor,publicId:'P'+randomUUID().replaceAll('-',''),provider:'postar',method,principal:f.principal,
    }))
    const full=await create(4000),partial=await create(2000),barcode=await create(4000,'auth_code')
    expect(new Set([full.id,partial.id,barcode.id]).size).toBe(3)
    expect((await create(2000)).id).toBe(partial.id)
  })
  const evidenceSql=()=>execFileSync('python3',['-c',"import runpy; print(runpy.run_path('deploy/aliyun/maintenance-bootstrap.py')['HISTORICAL_ATTEMPT_EVIDENCE_SQL'])"],{encoding:'utf8'})
  it.each([false,true])('associates only closed zero-due orders with matching ledgers (ordinary refund=%s)',async refunded=>{
    const f=await fixture(),receipt=randomUUID(),pending=await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({
      orderId:f.order,publicId:'P'+randomUUID().replaceAll('-',''),provider:'postar',method:'native_qr',principal:f.principal,
    }))
    const evidence=async()=>(await admin.query(evidenceSql())).rows[0].coalesce.find((row:{id:string})=>row.id===pending.id)
    expect((await evidence()).eligible).toBe(false)
    await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,succeeded_at) VALUES($1::uuid,$2,$3,$4,$1::text,'cash',$1::text,'cash',4000,'CNY','succeeded',clock_timestamp())",[receipt,scope.tenantId,scope.storeId,f.order])
    await admin.query("UPDATE mbox.orders SET status='completed',payment_status='paid',fulfillment_state='active',fulfillment_expires_at=NULL,fulfillment_activated_at=clock_timestamp() WHERE id=$1",[f.order])
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[f.session])
    expect((await evidence()).eligible).toBe(false)
    await admin.query("INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,entry_type,provider,provider_reference,amount_minor,currency,business_date,occurred_at) VALUES($1,$2,$3::uuid,'payment','cash',$3::text,4000,'CNY',$4,clock_timestamp())",[scope.tenantId,scope.storeId,receipt,date])
    if(refunded){
      const requester=randomUUID(),approver=randomUUID(),refund=randomUUID()
      for(const id of [requester,approver])await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,$1::text)',[id,scope.tenantId,scope.storeId])
      await admin.query("INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,order_id,public_id,provider_refund_id,amount_minor,currency,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at,purpose) VALUES($1::uuid,$2,$3,$4,$5,$1::text,$1::text,4000,'CNY','succeeded','原商品普通退款',$6,$7,'已核对原款',clock_timestamp(),'price_adjustment')",[refund,scope.tenantId,scope.storeId,receipt,f.order,requester,approver])
      expect((await evidence()).eligible).toBe(false)
      await admin.query("INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,refund_id,entry_type,provider,provider_reference,amount_minor,currency,business_date,occurred_at) VALUES($1,$2,$3,$4::uuid,'refund','cash',$4::text,-4000,'CNY',$5,clock_timestamp())",[scope.tenantId,scope.storeId,receipt,refund,date])
      await admin.query("UPDATE mbox.payments SET status='refunded' WHERE id=$1",[receipt])
      await admin.query("UPDATE mbox.orders SET payment_status='refunded' WHERE id=$1",[f.order])
    }
    const valid=await evidence();expect(valid.eligible).toBe(true)
    expect(valid.facts.orders[0].receipts[0].id).toBe(receipt)
    expect(valid.facts.orders[0].dueMinor).toBe(0)
    // Marker blocks further QR presentation while preserving every financial fact.
    const result=execFileSync('python3',['-c',`
import runpy,os,json,subprocess,tempfile
from pathlib import Path
m=runpy.run_path('deploy/aliyun/maintenance-bootstrap.py'); H=m['Host']
# Only this isolated fixture replaces root-owned-file and zero-writer host checks.
H.apply_historical_review.__globals__['protected']=lambda path:Path(path)
with tempfile.TemporaryDirectory() as directory:
 h=H.__new__(H);h.directory=Path(directory);h.database='isolated';h.clusteradmin='isolated';h.pg_env={}
 def run(args,input=None,env=None,check=True):
  assert args[0]=='psql'
  r=subprocess.run(['psql','-XqAt','--set=ON_ERROR_STOP=1','--dbname='+os.environ['HOLD_TEST_DATABASE']],input=input,text=True,capture_output=True)
  if r.returncode:raise RuntimeError(r.stderr)
  return r.stdout.strip()
 h.run=run;h.assert_zero=lambda:None
 h.journal=m['Journal'](directory,{'fixture':True})
 proof=json.loads(os.environ['HOLD_TEST_PROOF'])
 h.plan={'historicalPaymentReview':{'reason':'business-confirmed-system-duplicate-settled-orders','attempts':[{k:proof[k] for k in ('tenant_id','store_id','id','fingerprint')}]}}
 preview=h.directory/'provider-funds-preview.json';m['atomic'](preview,{'rows':h.funds_snapshot()})
 h.journal.append('provider-preview',{'sha256':m['sha'](preview)})
 original=h.journal.append
 def crash(event,data=None):
  if event=='historical-payment-review':raise RuntimeError('injected crash after durable receipt')
  return original(event,data)
 h.journal.append=crash
 try:h.apply_historical_review()
 except RuntimeError as e:
  if str(e)!='injected crash after durable receipt':raise
 else:raise AssertionError('crash not reached')
 h.journal.append=original
 h.apply_historical_review();h.apply_historical_review()
 assert len(h.reviewed_funds(h.funds_snapshot()))==1
 print('held-without-financial-mutation')
`],{encoding:'utf8',env:{...process.env,HOLD_TEST_DATABASE:adminUrl!,HOLD_TEST_PROOF:JSON.stringify(valid)}})
    expect(result.trim()).toBe('held-without-financial-mutation')
    expect((await admin.query("SELECT count(*)::int n FROM mbox.audit_events WHERE object_id=$1 AND action='payment.historical_attempt.held'",[pending.id])).rows[0].n).toBe(1)
    expect((await admin.query('SELECT phase,next_query_at,stop_reason FROM mbox.payment_reconciliation_states WHERE payment_id=$1',[pending.id])).rows[0]).toEqual({phase:'stopped',next_query_at:null,stop_reason:'historical_system_attempt_review'})
    await expect(runner.run(scope,tx=>new PaymentProviderActionRepository(tx,secret).claim(pending.id,'qr',new Date(Date.now()+60000).toISOString(),f.principal))).rejects.toThrow('历史重复尝试已停止使用')
    expect((await evidence()).fingerprint).toBe(valid.fingerprint)
    expect((await admin.query('SELECT status FROM mbox.payments WHERE id=$1',[pending.id])).rows[0].status).toBe('created')
    const callback={scope,actor:{type:'integration' as const,ref:'postar-callback'},businessDate:date,
      idempotencyKey:'late-'+randomUUID(),requestFingerprint:'late-proof-'+randomUUID(),
      paymentPublicId:pending.publicId,provider:'postar' as const,providerTransactionId:'LATE'+randomUUID(),
      reportedAmountMinor:4000,reportedCurrency:'CNY',occurredAt:new Date().toISOString(),providerSnapshot:{fixture:'late-confirmed'}}
    const observed=await new VerifiedProviderObservationService(runner).recordPayment({...callback,
      verificationKind:'callback_signature',providerEventId:'event-'+randomUUID(),integrationRef:callback.actor.ref,
      status:'succeeded',evidence:callback.providerSnapshot})
    expect((await evidence()).eligible).toBe(false) // Unconsumed verified success is never waived.
    const commands=new PaymentCommandService(new NormalizedCommandExecutor(runner),new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
    await commands.recordSucceededCallback({...callback,verifiedObservationId:observed})
    await commands.recordSucceededCallback({...callback,verifiedObservationId:observed})
    expect((await admin.query("SELECT count(*)::int n FROM mbox.reconciliation_entries WHERE payment_id=$1 AND entry_type='payment'",[pending.id])).rows[0].n).toBe(1)
    expect((await admin.query("SELECT signal FROM mbox.payment_financial_monitoring_signals WHERE subject_id=$1 AND signal='order_overcollected'",[f.order])).rows).toHaveLength(refunded?0:1)
    expect((await admin.query('SELECT status,amount_minor FROM mbox.payments WHERE id=$1',[receipt])).rows[0]).toEqual({status:refunded?'refunded':'succeeded',amount_minor:'4000'})

  })

})
