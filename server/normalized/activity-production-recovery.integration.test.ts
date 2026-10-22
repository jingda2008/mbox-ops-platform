import {createHash,randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor,type JsonValue} from './command-executor.js'
import {registerActivityProductionRoutes} from './activity-production-api.js'
import type {ActivityProductionCommand,ActivityProductionResult} from '../../src/shared/activity-service.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL
;(database?describe:describe.skip)('activity pickup original-login recovery',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),otherEmployee=randomUUID(),role=randomUUID(),credential=randomUUID(),lease=randomUUID(),oldSession=randomUUID(),device=randomUUID()
 let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,commands:NormalizedCommandExecutor
 let session=oldSession,currentEmployee=employee,currentLease=lease,requestScope=scope
 const app=Fastify(),digest=(text:string)=>createHash('sha256').update(text).digest('hex')
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL??database});runner=new ScopedPostgresTransactionRunner(runtime);commands=new NormalizedCommandExecutor(runner)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Activity recovery')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Activity recovery')",[scope.storeId,scope.tenantId])
  for(const id of [employee,otherEmployee])await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,'Recovery')",[id,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'RECOVERY','Recovery')",[role,scope.tenantId,scope.storeId])
  for(const id of [employee,otherEmployee])await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')",[scope.tenantId,scope.storeId,id,role])
  const permission=(await admin.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,'kds.deliver','Take','operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId])).rows[0].id
  await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,role,permission])
  await admin.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$recovery',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)",[credential,scope.tenantId,scope.storeId,employee])
  await deviceLease(lease,'a',device);await login(oldSession,employee,lease)
  await registerActivityProductionRoutes(app,{staffAccessTransactions:runner,commandExecutor:commands,resolveContext:()=>({scope:requestScope,employeeId:currentEmployee,staffSessionId:session,deviceAccessLeaseId:currentLease,businessDate:'2026-10-22'})})
 })
 afterAll(async()=>{await app.close();await runtime?.end();await admin?.end()})
 async function deviceLease(id:string,marker:string,deviceId:string){await admin.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,repeat($5,64),$6,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')",[id,scope.tenantId,scope.storeId,credential,marker,digest(id)]);await admin.query("INSERT INTO mbox.pickup_devices(id,tenant_id,store_id,device_key_hash,label,enabled,configured_by_employee_id) VALUES($1,$2,$3,repeat($4,64),'共用取餐屏',true,$5)",[deviceId,scope.tenantId,scope.storeId,marker,employee])}
 async function login(id:string,actor:string,deviceLeaseId:string){await admin.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,$6,statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[id,scope.tenantId,scope.storeId,actor,deviceLeaseId,digest(id)])}
 const board=()=>app.inject('/commerce/activity-service/board?station=pickup')
 const recover=(payload:unknown)=>app.inject({method:'POST',url:'/commerce/activity-service/recovery',payload})
 async function original(){
  currentEmployee=employee;session=oldSession;currentLease=lease
  const response=await board();expect(response.statusCode,response.body).toBe(200)
  const {commandScope,recoveryNamespace}=response.json().data,key=randomUUID(),command:ActivityProductionCommand={action:'take',lines:[{lineId:randomUUID(),quantity:1,expectedVersion:1}]}
  const result:ActivityProductionResult={receiptId:randomUUID(),action:'take',lines:[],command,source:{kind:'shared_pickup_device',id:device}}
  await commands.execute({scope,operationScope:'activity.service.production',idempotencyKey:digest(`${commandScope}:${key}`),requestFingerprint:JSON.stringify({commandScope,command}),retainReceipt:true,resultCodec:{encode:v=>v as unknown as JsonValue,decode:v=>v as unknown as ActivityProductionResult}},async()=>({result,auditEvents:[],outboxMessages:[]}))
  return {payload:{staffSessionId:oldSession,commandScope,idempotencyKey:key,command},result,recoveryNamespace}
 }
 it('replays the original committed receipt after same-employee login and preserves one receipt',async()=>{
  const old=await original();session=randomUUID();await login(session,employee,lease)
  const data=(await board()).json().data;expect(data.commandScope).not.toBe(old.payload.commandScope);expect(data.recoveryNamespace).toBe(old.recoveryNamespace)
  const response=await recover(old.payload);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({data:old.result,replayed:true})
  const conflict=await recover({...old.payload,command:{...old.payload.command,lines:[{...old.payload.command.lines[0],quantity:2}]}});expect(conflict.statusCode).toBe(409)
  expect((await recover(old.payload)).json().data.receiptId).toBe(old.result.receiptId)
 })
 it('rejects another employee, another physical device and a fabricated old command scope',async()=>{
  const old=await original();currentEmployee=otherEmployee;session=randomUUID();await login(session,otherEmployee,lease)
  expect((await board()).json().data.recoveryNamespace).not.toBe(old.recoveryNamespace)
  expect((await recover(old.payload)).statusCode).toBe(403)
  currentEmployee=employee;currentLease=randomUUID();await deviceLease(currentLease,'d',randomUUID());session=randomUUID();await login(session,employee,currentLease)
  expect((await recover(old.payload)).statusCode).toBe(403)
  currentLease=lease;session=randomUUID();await login(session,employee,lease)
  expect((await recover({...old.payload,commandScope:'0'.repeat(64)})).statusCode).toBe(403)
 })
 it('rechecks current pickup permission even for a cached successful receipt',async()=>{
  const old=await original();session=randomUUID();await login(session,employee,lease)
  await admin.query("UPDATE mbox.pickup_devices SET enabled=false WHERE id=$1",[device])
  expect((await recover(old.payload)).statusCode).toBe(403)
  await admin.query("UPDATE mbox.pickup_devices SET enabled=true WHERE id=$1",[device])
  await admin.query('UPDATE mbox.staff_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[session])
  expect((await recover(old.payload)).statusCode).toBe(403)
 })
 async function exceptionLine(){
  const activity=randomUUID(),customer=randomUUID(),product=randomUUID(),registration=randomUUID(),meal=randomUUID(),line=randomUUID();
  await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)",[customer,scope.tenantId,scope.storeId]);
  await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode) VALUES($1::uuid,$2,$3,$1::text,'测试原菜','food','kitchen','not_managed')",[product,scope.tenantId,scope.storeId]);
  await admin.query(`INSERT INTO mbox.community_activities(id,tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,assembly_location,capacity,fee_amount_minor,registration_payment_mode,payment_rule_text,safety_policy_version,safety_acknowledgement_text,safety_requirements,refund_policy_version,refund_policy_summary,activity_details,included_items,participation_requirements,contact_instructions,status,published_at,created_by_employee_id,approved_by_employee_id)
    VALUES($1::uuid,$2,$3,$1::text,'member_night','异常权限测试','核对原出品',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '3 hours','MBOX',30,0,'none','免费活动','safety-v1','已阅读安全要求',ARRAY['注意安全'],'refund-v1','按原约定','异常权限测试保留原菜品、原号和处理来源。',ARRAY['活动入场'],ARRAY['准时到场'],'店内核对','published',clock_timestamp(),$4,$4)`,[activity,scope.tenantId,scope.storeId,employee]);
  await admin.query(`INSERT INTO mbox.community_activity_registrations(id,tenant_id,store_id,public_id,activity_id,customer_id,party_size,status,payment_choice,payment_status,fee_amount_minor,amount_due_minor,paid_amount_minor,currency,safety_acknowledgement,idempotency_key,refund_policy_snapshot,acknowledged_safety_policy_version,acknowledged_refund_policy_version,terms_acknowledged_at,terms_acknowledgement_source,requested_payment_choice,requested_amount_due_minor,service_version,reserved_seats,max_participants,includes_admission,purchase_kind,service_has_meal)
    VALUES($1::uuid,$2,$3,$1::text,$4,$5,1,'confirmed','none','not_required',0,0,0,'CNY','{}',$1::text,'{"policyVersion":"refund-v1"}','safety-v1','refund-v1',clock_timestamp(),'staff_assisted','none',0,3,1,1,true,'admission_package',true)`,[registration,scope.tenantId,scope.storeId,activity,customer]);
  await admin.query("INSERT INTO mbox.activity_meals(id,tenant_id,store_id,registration_id,business_date,number,plaque_state,redeemed_by_employee_id) VALUES($1,$2,$3,$4,current_date,1,'issued',$5)",[meal,scope.tenantId,scope.storeId,registration,employee]);
  await admin.query(`INSERT INTO mbox.activity_service_lines(id,tenant_id,store_id,meal_id,registration_id,product_id,product_snapshot,station_code,quantity) VALUES($1,$2,$3,$4,$5,$6,'{"name":"原菜"}','kitchen',2)`,[line,scope.tenantId,scope.storeId,meal,registration,product]);
  return line;
 }
 it('enforces manager permission, station and active session on the real exception route',async()=>{
  currentEmployee=employee;currentLease=lease;session=randomUUID();await login(session,employee,lease);
  const line=await exceptionLine(),key=randomUUID(),command={action:'hold',lineId:line,expectedVersion:1,reason:'核对原菜品要求'};
  const post=(body:unknown=command)=>app.inject({method:'POST',url:'/commerce/activity-service/exceptions',headers:{'idempotency-key':key},payload:body});
  const verifier=(await admin.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,'community.activity.verify','核销','operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId])).rows[0].id;
  await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,role,verifier]);
  expect((await post({...command,action:'remake',quantity:1,remakeFrom:'ready',goodsLost:true})).statusCode).toBe(403);
  const manager=(await admin.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,'kds.exception.manage','异常管理','operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId])).rows[0].id;
  await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,role,manager]);
  expect((await post()).statusCode).toBe(403);
  await admin.query(`INSERT INTO mbox.role_data_scopes(tenant_id,store_id,role_id,scope_key,effect,scope_value,value_kind,text_values,enabled) VALUES($1,$2,$3,'kds.station_codes','include','["kitchen"]','text_set',ARRAY['kitchen'],true)`,[scope.tenantId,scope.storeId,role]);
  const allowed=await post();expect(allowed.statusCode,allowed.body).toBe(200);expect(allowed.json().data.lines[0]).toMatchObject({held:true,quantity:2,takenQuantity:0});
  expect((await post()).json().data.receiptId).toBe(allowed.json().data.receiptId);
  await admin.query('UPDATE mbox.staff_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[session]);expect((await post()).statusCode).toBe(403);
  requestScope={tenantId:randomUUID(),storeId:randomUUID()};
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Other tenant')",[requestScope.tenantId]);await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Other store')",[requestScope.storeId,requestScope.tenantId]);
  try{expect((await post()).statusCode).toBe(404)}finally{requestScope=scope}
  expect((await admin.query('SELECT quantity,taken_quantity,held FROM mbox.activity_service_lines WHERE id=$1',[line])).rows[0]).toEqual({quantity:2,taken_quantity:0,held:true});
 });

})
