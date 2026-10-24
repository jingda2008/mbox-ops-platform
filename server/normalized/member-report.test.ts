import {randomUUID} from 'node:crypto'
import {createMembershipRecoveryPhoneProtector} from './membership-recovery-service.js'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {Pool} from 'pg'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {memberReportFilter,readMemberReport,readMemberReportDetail} from './member-report-query.js'
import {createActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {memberReportApiPlugin} from './member-report-api.js'
import Fastify from 'fastify'
const secret='member-report-synthetic-key',protection=createActivityContactProtectionKeyring(null,secret)
const url=process.env.TEST_NORMALIZED_DATABASE_URL
const tenantId=randomUUID(),storeId=randomUUID(),customer=randomUUID(),alias=randomUUID(),other=randomUUID(),employee=randomUUID(),scope={tenantId,storeId}
let pool:Pool,runner:ScopedPostgresTransactionRunner

describe('member report input and phone protection',()=>{
 it('rejects invalid dates, ranges, pages and unsupported parameters',()=>{
  for(const f of [{joinedFrom:'2026-02-30'},{joinedFrom:'2026-10-25',joinedTo:'2026-10-24'},{page:0},{page:'1 OR 1=1'},{customerId:customer}])expect(()=>memberReportFilter.parse(f)).toThrow()
 })
 it('decrypts current verified phones and rejects a changed hash',()=>{
  const p=protection.protectPhone('+8613800000000');expect(protection.revealPhone!({...p})).toBe('+8613800000000')
  expect(()=>protection.revealPhone!({...p,contactHash:'0'.repeat(64)})).toThrow('受保护')
 })
 it('supports the historical phone envelope without weakening hash checks',()=>{
  const p=createMembershipRecoveryPhoneProtector(secret).protect('+8613800000001')
  expect(protection.revealPhone!(p)).toBe('+8613800000001')
  expect(()=>protection.revealPhone!({...p,contactHash:'0'.repeat(64)})).toThrow()
 })
})
;(url?describe:describe.skip)('member report with PostgreSQL',()=>{
 beforeAll(async()=>{
  await runNormalizedMigrations(url!);pool=new Pool({connectionString:url,max:3});runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
  await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Report fixture')",[tenantId,`report-${tenantId.slice(0,8)}`])
  await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'report','Report fixture','Asia/Shanghai','06:00')",[storeId,tenantId])
  await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'REPORT','Report')",[employee,tenantId,storeId])
  for(const id of [customer,alias,other])await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[id,tenantId,storeId,`report-${id}`])
  await pool.query("UPDATE mbox.customers SET status='merged',merged_into_customer_id=$1 WHERE id=$2",[customer,alias])
  for(const [id,no,at] of [[customer,'MBXREPORT01','2026-10-24T06:01:00+08:00'],[alias,'MBXREPORT02','2026-10-24T05:59:00+08:00'],[other,'MBXREPORT03','2026-10-24T06:00:00+08:00']])await pool.query('INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no,joined_at) VALUES($1,$2,$3,$4,$5)',[tenantId,storeId,id,no,at])
 },60000)
 afterAll(async()=>pool?.end())
 it('deduplicates identities, retains earliest joining time, and does not invent sex or spend',async()=>{
  const report=await runner.run(scope,tx=>readMemberReport(tx,memberReportFilter.parse({}),protection),{readOnly:true})
  expect(report.totalMembers).toBe(2);expect(report.items.find(x=>x.customerId===customer)).toMatchObject({memberNo:'MBXREPORT01',gender:null,phone:null,phoneStatus:'missing',netMinor:0,consumptionCount:0})
  const day=await runner.run(scope,tx=>readMemberReport(tx,memberReportFilter.parse({joinedFrom:'2026-10-24',joinedTo:'2026-10-24'}),protection),{readOnly:true})
  expect(day.items.map(x=>x.customerId)).toEqual([other])
  const prior=await runner.run(scope,tx=>readMemberReport(tx,memberReportFilter.parse({joinedFrom:'2026-10-23',joinedTo:'2026-10-23'}),protection),{readOnly:true})
  expect(prior.items.map(x=>x.customerId)).toEqual([customer])
 })
 it('returns accurate empty pages and blocks arbitrary member detail identifiers',async()=>{
  const report=await runner.run(scope,tx=>readMemberReport(tx,memberReportFilter.parse({page:2}),protection),{readOnly:true})
  expect(report.items).toEqual([]);expect(report.matchedMembers).toBe(2)
  const detail=await runner.run(scope,tx=>readMemberReportDetail(tx,randomUUID(),1),{readOnly:true});expect(detail.total).toBe(0)
 })
 it('requires explicit report authority on both endpoints, with no shared-role grant',async()=>{
  const app=Fastify();await app.register(memberReportApiPlugin,{transactions:runner,protection,resolveStaffContext:()=>({scope,employeeId:employee,permissions:[],businessDate:'2026-10-24'})})
  try{
   for(const request of [{method:'POST' as const,url:'/staff/member-report',payload:{}},{method:'GET' as const,url:`/staff/member-report/${customer}/consumption`}]){const res=await app.inject(request);expect(res.statusCode).toBe(403);expect(res.headers['cache-control']).toContain('no-store')}
   await runner.run(scope,async tx=>{const a=new StaffAccessRepository(tx);await a.upsertPermissionDefinition({code:'member.report.view',name:'会员查询报表'});await a.setEmployeePermissionOverride({employeeId:employee,permissionCode:'member.report.view',effect:'grant',reason:'Synthetic report test',configuredByEmployeeId:employee})})
   const ok=await app.inject({method:'POST',url:'/staff/member-report',payload:{}});expect(ok.statusCode).toBe(200);expect(ok.json().data.totalMembers).toBe(2)
   expect(JSON.stringify(ok.json())).not.toMatch(/encrypted_value|contact_hash|phone_cipher/)
   expect((await app.inject({method:'POST',url:'/staff/member-report',payload:{search:'MBXREPORT01'}})).json().data.matchedMembers).toBe(1)
   expect((await app.inject('/staff/member-report?search=13800000000')).statusCode).toBe(404)
   expect((await app.inject({method:'POST',url:'/staff/member-report',payload:{page:0}})).statusCode).toBe(400)
  }finally{await app.close()}
 })
 it('counts two orders at one table once, subtracts successful refunds and excludes pending/simulated payments',async()=>{
  const area=randomUUID(),table=randomUUID(),session=randomUUID(),reviewer=randomUUID()
  await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'REVIEW','Review')",[reviewer,tenantId,storeId])
  await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'R','Room','indoor')",[area,tenantId,storeId])
  await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'R1','Room 1',4)",[table,tenantId,storeId,area])
  await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,'report-session-001','2026-10-24',2)",[session,tenantId,storeId,table])
  const orders:string[]=[],payments:string[]=[]
  for(let i=0;i<4;i++){
   const order=randomUUID(),payment=randomUUID();orders.push(order);payments.push(payment)
   await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,subtotal_amount_minor,total_amount_minor,created_by_customer_id) VALUES($1,$2,$3,$4,$5,'guest_qr','submitted',10000,10000,$6)",[order,tenantId,storeId,session,`report-order-${i}`,i===0?alias:customer])
   await pool.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status,succeeded_at,provider_transaction_id) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6='simulation' THEN 'native_qr' ELSE 'cash' END,10000,$7,$8,$5)",[payment,tenantId,storeId,order,`report-payment-${i}`,i===2?'simulation':'cash',i===3?'pending':'succeeded',i===3?null:'2026-10-24T12:00:00Z'])
  }
  await pool.query("INSERT INTO mbox.refunds(tenant_id,store_id,payment_id,public_id,amount_minor,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at,provider_refund_id) VALUES($1,$2,$3,'report-refund-001',2500,'succeeded','部分退款',$4,$5,'批准',now(),'provider-refund-001')",[tenantId,storeId,payments[0],employee,reviewer])
  let report=await runner.run(scope,tx=>readMemberReport(tx,memberReportFilter.parse({search:'MBXREPORT01'}),protection),{readOnly:true})
  expect(report.items[0]).toMatchObject({paidMinor:20000,refundMinor:2500,netMinor:17500,consumptionCount:1,orderCount:2})
  let detail=await runner.run(scope,tx=>readMemberReportDetail(tx,customer,1),{readOnly:true});expect(detail.total).toBe(2);expect(detail.items.reduce((n,x)=>n+x.netMinor,0)).toBe(17500)
  await pool.query("INSERT INTO mbox.refunds(tenant_id,store_id,payment_id,public_id,amount_minor,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at,provider_refund_id) VALUES($1,$2,$3,'report-refund-002',7500,'succeeded','余款退款',$4,$5,'批准',now(),'provider-refund-002'),($1,$2,$6,'report-refund-003',10000,'succeeded','全额退款',$4,$5,'批准',now(),'provider-refund-003')",[tenantId,storeId,payments[0],employee,reviewer,payments[1]])
  report=await runner.run(scope,tx=>readMemberReport(tx,memberReportFilter.parse({search:'MBXREPORT01'}),protection),{readOnly:true});expect(report.items[0]).toMatchObject({paidMinor:20000,refundMinor:20000,netMinor:0,consumptionCount:0,orderCount:0})
 })
 it('shows only current verified phones and distinguishes active interest cards from suspended cards',async()=>{
  await runner.run(scope,async tx=>{const access=new StaffAccessRepository(tx);await access.upsertPermissionDefinition({code:'customer.membership.recovery.verify',name:'Verify fixture phone'});await access.setEmployeePermissionOverride({employeeId:employee,permissionCode:'customer.membership.recovery.verify',effect:'grant',reason:'Synthetic verified phone fixture',configuredByEmployeeId:employee})})
  const phone=protection.protectPhone('+8613800000000')
  await runner.run(scope,tx=>tx.query(`INSERT INTO mbox.customer_verified_contacts(tenant_id,store_id,customer_id,contact_type,contact_hash,encrypted_value,encryption_key_version,contact_encryption_key_id,masked_value,verification_source,verified_by_employee_id,verified_at,provider_reference_sha256)
   VALUES($1,$2,$3,'phone',$4,$5,2,$6,$7,'staff_controlled',$8,now(),$4)`,[tenantId,storeId,other,phone.contactHash,phone.encryptedValue,phone.encryptionKeyId,phone.maskedValue,employee]))
  const project=randomUUID(),application=randomUUID(),card=randomUUID()
  await pool.query(`INSERT INTO mbox.member_card_projects(id,tenant_id,store_id,code,name,kind,terms,available_from,available_until,created_by_employee_id,flow_mode) VALUES($1,$2,$3,'MUSIC','音乐会','interest','普通兴趣卡',now()-interval '1 day',NULL,$4,'simple')`,[project,tenantId,storeId,employee])
  await pool.query(`INSERT INTO mbox.member_card_applications(id,tenant_id,store_id,project_id,customer_id,accepted_project_version,status,reviewed_by_employee_id,resolved_at) VALUES($1,$2,$3,$4,$5,1,'approved',$6,now())`,[application,tenantId,storeId,project,other,employee])
  await pool.query(`INSERT INTO mbox.member_cards(id,tenant_id,store_id,project_id,customer_id,application_id,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,$6,now()-interval '1 day',NULL)`,[card,tenantId,storeId,project,other,application])
  let report=await runner.run(scope,tx=>readMemberReport(tx,memberReportFilter.parse({search:'13800000000',interest:'yes',card:'音乐'}),protection),{readOnly:true})
  expect(report.items).toHaveLength(1);expect(report.items[0]).toMatchObject({phone:'+8613800000000',phoneStatus:'available',hasInterestCard:true,cards:[{name:'音乐会',kind:'interest',status:'active',validUntil:null}]})
  await pool.query("UPDATE mbox.member_cards SET status='suspended' WHERE id=$1",[card])
  report=await runner.run(scope,tx=>readMemberReport(tx,memberReportFilter.parse({interest:'yes'}),protection),{readOnly:true});expect(report.items).toHaveLength(0)
  report=await runner.run(scope,tx=>readMemberReport(tx,memberReportFilter.parse({search:'MBXREPORT03'}),protection),{readOnly:true});expect(report.items[0]!.cards[0]!.status).toBe('suspended')
 })
 it('works as the restricted runtime role and never crosses store scope',async()=>{
  const report=await runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return readMemberReport(tx,memberReportFilter.parse({}),protection)},{readOnly:true})
  expect(report.totalMembers).toBe(2)
  const foreignScope={tenantId,storeId:randomUUID()}
  const foreign=await runner.run(foreignScope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return readMemberReportDetail(tx,customer,1)},{readOnly:true})
  expect(foreign).toMatchObject({total:0,items:[]})
 })
})
