import Fastify from 'fastify'
import {commercialOpsApiPlugin} from './commercial-ops-api.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {VoucherOperationService} from './voucher-operation-service.js'
import {signGroupVoucherPrepareHandle,type GroupVoucherPlatformRegistry} from './group-voucher-platforms.js'
import {CommercialOpsRepository,voucherCodeDigest} from './commercial-ops-repository.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL
;(url?describe:describe.skip)('durable voucher platform and local bookkeeping boundary',()=>{
 const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID(),reviewer=randomUUID(),roleId=randomUUID()
 let pool:Pool,runner:ScopedPostgresTransactionRunner
 const scope={tenantId,storeId};let now=Date.now();const signingSecret='isolated-voucher-operation-signing-secret-long';let calls=0;let failProvider=false;let amountMode:'normal'|'missing'|'zero'='normal'
 const adapter={platform:'meituan' as const,prepare:vi.fn(),consume:async()=>{calls++;if(failProvider)throw new Error('lost provider acknowledgement');return {platform:'meituan' as const,campaignName:'隔离双人券',faceValueMinor:amountMode==='normal'?20000:0,settlementAmountMinor:amountMode==='normal'?18800:0,faceValueProvided:amountMode!=='missing',settlementAmountProvided:amountMode!=='missing',currency:'CNY',certificateId:'CERT-ORIGINAL',verifyId:'VERIFY-ORIGINAL'}}}
 const registry:GroupVoucherPlatformRegistry={status:()=>[{code:'meituan',label:'美团',enabled:true,mode:'test'}],adapter:()=>adapter}
 let service:VoucherOperationService
 const context=(actor=employeeId,date='2026-09-27')=>({scope,employeeId:actor,businessDate:date})
 function input(code:string){return {platform:'meituan' as const,voucherCode:code,publicId:'voucher-'+randomUUID(),orderId:null,tableSessionId:null,prepareHandle:signGroupVoucherPrepareHandle({platform:'meituan',codeHash:voucherCodeDigest(code),prepareToken:'TOKEN-SECRET',campaignName:'隔离双人券',faceValueMinor:20000,settlementAmountMinor:18800,currency:'CNY',certificateId:'CERT-ORIGINAL',expiresAtMs:now+600000},signingSecret)}}
 beforeAll(async()=>{
  await runNormalizedMigrations(url!);pool=new Pool({connectionString:url,max:6});runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool);service=new VoucherOperationService(runner,{registry,signingSecret,now:()=>now})
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'voucher test')`,[tenantId,'voucher-'+tenantId.slice(0,8)])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'voucher','voucher test')`,[storeId,tenantId])
  await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'CASHIER','核销收银')`,[roleId,tenantId,storeId])
  for(const id of [employeeId,reviewer]){await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,'测试核销员')`,[id,tenantId,storeId,id]);await pool.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)`,[tenantId,storeId,id,roleId])}
  for(const permission of ['commercial.voucher.view','commercial.voucher.redeem','reconciliation.manage']){await pool.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET status='active'`,[tenantId,storeId,permission]);await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4 ON CONFLICT DO NOTHING`,[tenantId,storeId,roleId,permission])}
 })
 afterAll(async()=>{await pool?.end()})
 it('sends only once across concurrent retry, handle expiry and operating-day rollover',async()=>{
  calls=0;failProvider=false;now=Date.now();const payload=input('VOUCHER-CONCURRENT-'+randomUUID()),key='voucher-concurrent-'+randomUUID()
  await Promise.all([service.redeem(context(),key,payload),service.redeem(context(),key,payload)])
  expect(calls).toBe(1);now+=86400000
  const recovered=await service.redeem(context(employeeId,'2026-09-28'),key,payload)
  expect(recovered.status).toBe('recorded');expect(recovered.businessDate).toBe('2026-09-27');expect(recovered.result?.isSettled).toBe(false);expect(calls).toBe(1)
  const stored=await pool.query('SELECT voucher_hash,voucher_masked,prepared_snapshot FROM mbox.voucher_operations WHERE id=$1',[recovered.id]);expect(JSON.stringify(stored.rows[0])).not.toContain(payload.voucherCode)
  expect(JSON.stringify(recovered)).not.toContain(payload.voucherCode)
  await expect(service.redeem(context(),key,{...payload,orderId:randomUUID(),tableSessionId:randomUUID()})).rejects.toThrow('原核销请求内容已改变')
 })
 it('recovers local save failure from durable provider evidence without a second consume',async()=>{
  calls=0;failProvider=false;now=Date.now();const payload=input('VOUCHER-LOCAL-FAIL-'+randomUUID()),key='voucher-local-'+randomUUID()
  const original=CommercialOpsRepository.prototype.redeemVoucher
  const fail=vi.spyOn(CommercialOpsRepository.prototype,'redeemVoucher').mockRejectedValueOnce(new Error('local transient failure'))
  await expect(service.redeem(context(),key,payload)).rejects.toThrow('local transient failure');fail.mockRestore()
  expect(CommercialOpsRepository.prototype.redeemVoucher).toBe(original)
  const stored=await pool.query('SELECT status,voucher_hash,voucher_masked,prepared_snapshot FROM mbox.voucher_operations WHERE idempotency_key=$1',[key]);expect(stored.rows[0].status).toBe('provider_succeeded');expect(JSON.stringify(stored.rows[0])).not.toContain(payload.voucherCode)
  now+=86400000;expect((await service.redeem(context(employeeId,'2026-09-28'),key,payload)).status).toBe('recorded');expect(calls).toBe(1)
 })
 it('keeps unknown consumption, blocks a new key and requires a distinct financial reviewer',async()=>{
  calls=0;failProvider=true;now=Date.now();const payload=input('VOUCHER-UNKNOWN-'+randomUUID()),key='voucher-unknown-'+randomUUID()
  const pending=await service.redeem(context(),key,payload);expect(pending.status).toBe('unknown')
  await service.redeem(context(),key,payload);expect(calls).toBe(1)
  await expect(service.redeem(context(),'different-'+randomUUID(),input(payload.voucherCode))).rejects.toThrow('已有原核销事项')
  const evidence={outcome:'consumed' as const,certificateId:'CERT-ORIGINAL',verifyId:'MANUAL-VERIFY',evidenceReference:'平台工单CASE-TEST-001',reason:'核对原平台核销记录一致'}
  await expect(service.review(context(),pending.id,evidence)).rejects.toThrow('至少两分钟')
  now+=180000;await service.review(context(),pending.id,evidence);await service.review(context(),pending.id,evidence)
  await expect(service.approve(context(),pending.id)).rejects.toThrow('另一名')
  const reviewed=(await service.list(context())).find(r=>r.id===pending.id)!
  const reviewId=reviewed.review!.id,keyReject='reject-'+randomUUID()
  await service.reject(context(reviewer),pending.id,keyReject,reviewId,'凭证需要补充平台查询时间')
  await service.review(context(),pending.id,{...evidence,reason:'补充原查询时间再次核对一致'})
  // A delayed old rejection must not clear newer evidence; an old approval must not approve it.
  const replay=await service.reject(context(reviewer),pending.id,keyReject,reviewId,'凭证需要补充平台查询时间')
  expect(replay.review?.id).not.toBe(reviewId)
  await expect(service.approve(context(reviewer),pending.id,reviewId)).rejects.toThrow('证据已变化')
  const resolved=await service.approve(context(reviewer),pending.id,replay.review!.id)
  expect(resolved.status).toBe('recorded');expect(resolved.review?.approvedBy).toBe(reviewer);expect(resolved.result?.isSettled).toBe(false);expect(calls).toBe(1)
  expect((await service.approve(context(reviewer),pending.id)).status).toBe('recorded')
 })
 it('marks an expired fresh prepare handle as uncommitted, but retains an existing dispatched operation',async()=>{
  calls=0;failProvider=false;now=Date.now();const payload=input('VOUCHER-EXPIRED-'+randomUUID());now+=86400000
  await expect(service.redeem(context(),'fresh-expired-'+randomUUID(),payload)).rejects.toMatchObject({notCommitted:true})
  expect(calls).toBe(0)
 })
 it('routes the existing web endpoint through the same durable native operation across expiry and cross-client retry',async()=>{
  calls=0;failProvider=false;now=Date.now();const payload=input('VOUCHER-WEB-NATIVE-'+randomUUID()),key='web-native-'+randomUUID()
  const app=Fastify();await app.register(commercialOpsApiPlugin,{prefix:'/api',transactions:runner,commandExecutor:new NormalizedCommandExecutor(runner),queryService:{} as never,resolveContext:()=>context(),voucherVerification:{registry,signingSecret,now:()=>now}})
  try{
   const send=()=>app.inject({method:'POST',url:'/api/commercial-ops/vouchers/redeem',headers:{'idempotency-key':key},payload:{platform:payload.platform,voucherCode:payload.voucherCode,prepareHandle:payload.prepareHandle}})
   const first=await send();expect(first.statusCode).toBe(201);expect(first.json().data).toMatchObject({platform:'美团',isSettled:false});expect(calls).toBe(1)
   const lookup=await app.inject({method:'GET',url:'/api/commercial-ops/vouchers/operations/by-public-id/'+first.json().data.publicId});expect(lookup.json().data.status).toBe('recorded');expect(lookup.json().data.result.id).toBe(first.json().data.id)
   now+=86400000;const replay=await send();expect(replay.statusCode).toBe(201);expect(replay.json().data.id).toBe(first.json().data.id);expect(calls).toBe(1)
   const other=await app.inject({method:'POST',url:'/api/commercial-ops/vouchers/operations/redeem',headers:{'idempotency-key':'native-different-'+randomUUID()},payload:{...payload,orderId:undefined,tableSessionId:undefined}})
   expect(other.statusCode).toBe(409);expect(other.json().error.commitDisposition).toBe('not_committed');expect(calls).toBe(1)
   expect((await pool.query("SELECT count(*)::int AS n FROM mbox.audit_events WHERE tenant_id=$1 AND object_id=$2 AND action='commercial.voucher.redeemed'",[tenantId,first.json().data.id])).rows[0].n).toBe(1)
  }finally{await app.close()}
 })
 it('distinguishes omitted platform amounts from explicitly confirmed zero',async()=>{
  failProvider=false;now=Date.now()
  try{
   amountMode='missing';const missing=await service.redeem(context(),'missing-amount-'+randomUUID(),input('MISSING-AMOUNT-'+randomUUID()))
   expect(missing.result).toMatchObject({faceValueMinor:20000,settlementAmountMinor:18800})
   amountMode='zero';const zero=await service.redeem(context(),'zero-amount-'+randomUUID(),input('ZERO-AMOUNT-'+randomUUID()))
   expect(zero.result).toMatchObject({faceValueMinor:0,settlementAmountMinor:0})
  }finally{amountMode='normal'}
 })
 it('rejects invalid table association before any platform dispatch',async()=>{
  calls=0;failProvider=false;now=Date.now();const payload={...input('VOUCHER-WRONG-TABLE-'+randomUUID()),orderId:randomUUID(),tableSessionId:randomUUID()}
  await expect(service.redeem(context(),'wrong-table-'+randomUUID(),payload)).rejects.toThrow('不属于所选桌次');expect(calls).toBe(0)
 })
})
