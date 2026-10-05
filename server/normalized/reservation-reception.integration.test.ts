import { createHash, randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { ReservationCommandService } from './reservation-command-service.js'
import { PerformanceCommandService } from './performance-command-service.js'
import { reservationReceptionApiPlugin } from './reservation-reception-api.js'
import { reservationPerformanceApiPlugin } from './reservation-performance-api.js'
import { publicReservationApiPlugin } from './public-reservation-api.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { TableManagementCommandService } from './table-management-repository.js'
import { WaitlistCommandService } from './waitlist-repository.js'

const adminUrl=process.env.TEST_NORMALIZED_DATABASE_URL, runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=adminUrl&&runtimeUrl?describe:describe.skip
integration('reservation admission and actual multi-table reception (real restricted PostgreSQL)',()=>{
  let admin:Pool,runtime:Pool,app:FastifyInstance,transactions:ScopedPostgresTransactionRunner
  let tenantId:string,storeId:string,employee:string,other:string,actor:string,customer:string,area:string,tables:string[]
  let now:Date,legacyFixture:boolean,businessDate:string,creationEnabled:boolean
  let payload:Record<string,unknown>
  const scope=()=>({tenantId,storeId})
  const protect=(contact:string)=>({hash:createHash('sha256').update(contact).digest('hex'),encryptedBase64:Buffer.from(`test-encrypted:${contact}`).toString('base64'),keyId:'test',masked:'138****8000'})
  beforeAll(async()=>{await runNormalizedMigrations(adminUrl!);admin=new Pool({connectionString:adminUrl,max:8});runtime=new Pool({connectionString:runtimeUrl,max:8})},30000)
  afterAll(async()=>{await runtime?.end();await admin?.end()})
  afterEach(async()=>{await app?.close()})
  beforeEach(async()=>{
    tenantId=randomUUID();storeId=randomUUID();employee=randomUUID();other=randomUUID();actor=employee;customer=randomUUID();area=randomUUID();tables=[randomUUID(),randomUUID(),randomUUID()];now=new Date();businessDate=now.toISOString().slice(0,10);legacyFixture=false;creationEnabled=true
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Reception test')",[tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'test','Test')",[storeId,tenantId])
    await admin.query('INSERT INTO mbox.public_reservation_policies(tenant_id,store_id) VALUES($1,$2)',[tenantId,storeId])
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','Area','indoor')",[area,tenantId,storeId])
    for(let index=0;index<tables.length;index++)await admin.query('INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)',[tables[index],tenantId,storeId,area,`A${index+1}`])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$3,$4,'FIRST','First'),($2,$3,$4,'SECOND','Second')",[employee,other,tenantId,storeId])
    await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)",[customer,tenantId,storeId])
    for(const code of ['reservation.manage','reservation.view','reservation.view.all','table.open','table.view_all','table.transfer']){
      const permission=(await admin.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id',[tenantId,storeId,code])).rows[0].id
      for(const id of [employee,other])await admin.query("INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) VALUES($1,$2,$3,$4,'grant','Integration fixture',$3)",[tenantId,storeId,id,permission])
    }
    transactions=new ScopedPostgresTransactionRunner(runtime)
    const commands=new NormalizedCommandExecutor(transactions),reservations=new ReservationCommandService(commands)
    app=Fastify()
    const resolveStaffContext=()=>({scope:scope(),employeeId:actor,businessDate})
    await app.register(reservationReceptionApiPlugin,{get reservationReceptionCreateEnabled(){return creationEnabled},transactions,commands,resolveStaffContext,protectContact:protect,now:()=>now})
    await app.register(reservationPerformanceApiPlugin,{get reservationReceptionCreateEnabled(){return creationEnabled},transactions,reservations:{create:input=>reservations.create(legacyFixture?{...input,retireTableBoundCreate:false,holdExpiresAt:new Date(Date.now()+20*60000).toISOString()}:input),confirm:input=>reservations.confirm(input),arrive:input=>reservations.arrive(input),complete:input=>reservations.complete(input),cancel:input=>reservations.cancel(input)},performance:new PerformanceCommandService(commands),resolveStaffContext,resolveGuestContext:()=>({scope:scope(),customerId:customer,tableSessionId:null,businessDate,actorRef:`guest:${customer}`}),now:()=>now.toISOString()})
    await app.register(publicReservationApiPlugin,{get reservationReceptionCreateEnabled(){return creationEnabled},transactions,commands,waitlists:new WaitlistCommandService(commands),reservationSessions:{issue:async()=>{throw Error('not used')}},resolveTrustedScope:scope,resolveGuest:()=>({scope:scope(),sessionId:'test-session',customerId:customer,actorRef:`customer:${customer}`,businessDate,capabilities:['guest.reservation.read','guest.reservation.update','guest.waitlist.manage']}),resolveStaff:()=>{throw Error('not used')},protectContact:protect,currentBusinessDate:()=>businessDate,now:()=>now})
    await app.ready()
    payload={protocol:1,publicId:`reception-${randomUUID()}`,customerName:'Reception customer',contact:'13800138000',guestCount:4,arrivalAt:new Date(now.getTime()+86400000).toISOString(),expectedEndAt:new Date(now.getTime()+86400000+7200000).toISOString(),source:'phone',initialStatus:'confirmed',note:null,seatPreference:'no_preference',reservationPolicyVersion:1,preferredScheduleId:null}
  })
  const create=(key=randomUUID(),body=payload)=>app.inject({method:'POST',url:'/staff/reservation-receptions',headers:{'idempotency-key':key},payload:body})
  const query=(sql:string,values:unknown[]=[])=>admin.query(sql,[tenantId,storeId,...values])
  async function reservation(guestCount=4){const response=await create(randomUUID(),{...payload,publicId:`reception-${randomUUID()}`,guestCount});expect(response.statusCode,response.body).toBe(201);const row=response.json().data.reservation;await query("UPDATE mbox.reservations SET status='arrived' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[row.id]);return row}
  async function session(table=tables[0]!,guests=4){const id=randomUUID();await query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,opened_by_employee_id) VALUES($3::uuid,$1,$2,$4,$3::text,$5::date,$6,$7)",[id,table,businessDate,guests,employee]);return {tableSessionId:id,expectedTableId:table,expectedLocationVersion:0,expectedGuestCount:guests}}
  const seat=(id:string,sessions:unknown[],key=randomUUID(),version=1)=>app.inject({method:'POST',url:`/staff/reservation-receptions/${id}/seat`,headers:{'idempotency-key':key},payload:{protocol:1,reservationVersion:version,sessions,reason:'已核对本组全部实际桌位'}})
  const counts=async()=> (await query(`SELECT (SELECT count(*)::integer FROM mbox.reservations WHERE tenant_id=$1 AND store_id=$2) reservations,(SELECT count(*)::integer FROM mbox.reservation_seating_batches WHERE tenant_id=$1 AND store_id=$2) batches,(SELECT count(*)::integer FROM mbox.reservation_seating_sessions WHERE tenant_id=$1 AND store_id=$2) sessions,(SELECT count(*)::integer FROM mbox.reservation_table_locks WHERE tenant_id=$1 AND store_id=$2) locks`)).rows[0]
  async function revoke(code:string,id=employee){await query('DELETE FROM mbox.employee_permission_overrides o USING mbox.staff_permission_definitions p WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.employee_id=$3 AND p.id=o.permission_id AND p.code=$4',[id,code])}

  const nativeBody=(overrides:Record<string,unknown>={})=>({publicId:`NRES-${randomUUID()}`,customerName:'Build nine customer',contactToken:'13800138000',guestCount:4,arrivalAt:payload.arrivalAt,expectedEndAt:payload.expectedEndAt,source:'phone',seatPreference:'no_preference',initialStatus:'pending',note:'Original build9 request',tableIds:[tables[0]],...overrides})
  const nativeCreate=(body=nativeBody(),key=`native-business-${randomUUID()}`)=>app.inject({method:'POST',url:'/staff/native-reservations',headers:{'idempotency-key':key},payload:body})
  const nativeAction=(id:string,action:string,key=`native-business-${randomUUID()}`)=>app.inject({method:'POST',url:`/staff/native-reservations/${id}/${action}`,headers:{'idempotency-key':key},payload:{}})
  const publicCreate=(key=randomUUID(),overrides:Record<string,unknown>={})=>app.inject({method:'POST',url:'/public/reservations',headers:{'idempotency-key':key},payload:{mode:'direct',publicId:`public-${randomUUID()}`,customerName:'Public customer',contact:'13900139000',guestCount:4,arrivalAt:payload.arrivalAt,expectedEndAt:payload.expectedEndAt,reservationPolicyVersion:1,...overrides}})

  it('runs the unchanged build9 create/confirm/arrive/complete contract without invented protocol or table sessions',async()=>{
    creationEnabled=false
    const caps=await app.inject('/staff/native-reservation-capabilities');expect(caps.json().data).toMatchObject({durableCreate:true,tableBoundCreate:true,admissionCreateV1:false,receptionSeatV1:true})
    const body=nativeBody({guestCount:6,tableIds:[tables[0],tables[1]]}),key=`native-business-${randomUUID()}`
    const created=await nativeCreate(body,key);expect(created.statusCode,created.body).toBe(201)
    const row=created.json().data;expect(created.json().meta.replayed).toBe(false)
    expect(row).toMatchObject({publicId:body.publicId,status:body.initialStatus,customerName:body.customerName,guestCount:body.guestCount})
    expect(Date.parse(row.arrivalAt)).toBe(Date.parse(String(body.arrivalAt)));expect(Date.parse(row.expectedEndAt)).toBe(Date.parse(String(body.expectedEndAt)))
    expect(row.tableLocks.map((lock:{tableId:string})=>lock.tableId).sort()).toEqual([...body.tableIds].sort())
    expect(row.reservationSnapshot.receptionProtocol).toBeUndefined()
    for(const [action,status] of [['confirm','confirmed'],['arrive','arrived'],['complete','completed']]){
      const result=await nativeAction(row.id,action!);expect(result.statusCode,result.body).toBe(200);expect(result.json().data.status).toBe(status)
    }
    expect(await counts()).toMatchObject({reservations:1,batches:0,sessions:0,locks:2})
    expect((await query('SELECT count(*)::int n FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2')).rows[0].n).toBe(0)
    await query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3",[key])
    now=new Date(now.getTime()+86400000*4);await query("UPDATE mbox.tables SET status='paused' WHERE tenant_id=$1 AND store_id=$2")
    const originalSnapshot=(await query('SELECT response_snapshot FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3',[key])).rows[0].response_snapshot
    // Assert the fixed build9 reply contract. Its durable codec predates four
    // optional later metadata fields; do not mistake omitted metadata for a new command.
    const contractKeys=['id','publicId','status','customerName','guestCount','arrivalAt','expectedEndAt','tableLocks','ownerEmployeeId','reservationSnapshot']
    const contract=(value:Record<string,unknown>)=>Object.fromEntries(contractKeys.map(field=>[field,value[field]]))
    for(const gate of [false,true,false]){creationEnabled=gate;const replay=await nativeCreate(body,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true);expect(contract(replay.json().data)).toEqual(contract(created.json().data))}
    expect((await query('SELECT response_snapshot FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3',[key])).rows[0].response_snapshot).toEqual(originalSnapshot)
    expect(await counts()).toMatchObject({reservations:1,batches:0,sessions:0,locks:2})
    expect((await query("SELECT expires_at='infinity'::timestamptz retained FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3",[key])).rows[0].retained).toBe(true)
  })
  it('keeps build9 original actor, payload and live permission checks on recovery',async()=>{
    creationEnabled=false
    const body=nativeBody({initialStatus:'confirmed'}),key=`native-business-${randomUUID()}`,first=await nativeCreate(body,key);expect(first.statusCode,first.body).toBe(201)
    expect((await nativeCreate({...body,guestCount:3},key)).statusCode).toBe(409)
    actor=other;expect((await nativeCreate(body,key)).statusCode).toBe(409);actor=employee
    await revoke('reservation.manage');expect((await nativeCreate(body,key)).statusCode).toBe(403)
    expect((await counts()).reservations).toBe(1)
  })
  it('rejects build9 forged authority, invalid times and excessive selected-table capacity without writes',async()=>{
    creationEnabled=false
    for(const extra of [{tableBoundCreateMode:'legacy-native-v1'},{retireTableBoundCreate:false},{protocol:1},{ownerEmployeeId:other},{customerId:customer},{reservationSnapshot:{receptionProtocol:1}},{allowUnassignedTable:true}]){
      const reply=await nativeCreate(nativeBody(extra));expect(reply.statusCode,reply.body).toBe(400)
    }
    for(const extra of [{guestCount:5},{guestCount:201},{guestCount:0},{tableIds:[]},{tableIds:Array.from({length:21},()=>randomUUID())},{tableIds:[randomUUID()]},{arrivalAt:new Date(now.getTime()-60000).toISOString()},{arrivalAt:new Date(now.getTime()+86400000*400).toISOString(),expectedEndAt:new Date(now.getTime()+86400000*401).toISOString()},{expectedEndAt:now.toISOString()}]){
      const reply=await nativeCreate(nativeBody(extra));expect([400,409],reply.body).toContain(reply.statusCode)
    }
    await query("UPDATE mbox.tables SET status='paused' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[tables[0]])
    expect((await nativeCreate()).statusCode).toBe(409);expect(await counts()).toEqual({reservations:0,batches:0,sessions:0,locks:0})
  })
  it('shares the policy-locked capacity budget between public and build9 new requests',async()=>{
    creationEnabled=false
    const first=await publicCreate(randomUUID(),{guestCount:8});expect(first.statusCode,first.body).toBe(201)
    const replies=await Promise.all([publicCreate(),nativeCreate(nativeBody({initialStatus:'confirmed'}))])
    expect(replies.map(r=>r.statusCode).sort()).toEqual([201,409])
    expect((await query("SELECT sum(guest_count)::int total FROM mbox.reservations WHERE tenant_id=$1 AND store_id=$2 AND status IN('pending','confirmed','arrived','seated')")).rows[0].total).toBe(12)
    const rejected=await nativeCreate(nativeBody({tableIds:[tables[2]],initialStatus:'confirmed'}));expect(rejected.statusCode,rejected.body).toBe(409)
    expect((await counts()).reservations).toBe(2)
  })
  it('reclaims expired native pending capacity without waiting for a worker or discarding live unassigned claims',async()=>{
    creationEnabled=false
    const original=await nativeCreate(nativeBody({guestCount:12,tableIds:[...tables]}));expect(original.statusCode,original.body).toBe(201)
    const originalId=original.json().data.id
    await query("UPDATE mbox.reservation_table_locks SET hold_expires_at=clock_timestamp()-interval '1 minute' WHERE tenant_id=$1 AND store_id=$2 AND reservation_id=$3",[originalId])
    const replacement=await nativeCreate(nativeBody({initialStatus:'confirmed'}));expect(replacement.statusCode,replacement.body).toBe(201)
    expect((await query('SELECT status FROM mbox.reservations WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[originalId])).rows[0].status).toBe('cancelled')
    expect((await query("SELECT count(*)::int n FROM mbox.audit_events WHERE tenant_id=$1 AND store_id=$2 AND object_id=$3 AND action='reservation.hold_expired'",[originalId])).rows[0].n).toBe(1)
    creationEnabled=true
    const pending=await create(randomUUID(),{...payload,publicId:`reception-${randomUUID()}`,guestCount:8,initialStatus:'pending'});expect(pending.statusCode,pending.body).toBe(201)
    creationEnabled=false
    expect((await nativeCreate(nativeBody({tableIds:[tables[1]],initialStatus:'confirmed'}))).statusCode).toBe(409)
  })
  it('retains physical-table exclusion for concurrent build9 commands after the shared capacity lock',async()=>{
    creationEnabled=false
    const replies=await Promise.all([nativeCreate(nativeBody({initialStatus:'confirmed'})),nativeCreate(nativeBody({initialStatus:'confirmed'}))])
    expect(replies.map(r=>r.statusCode).sort()).toEqual([201,409]);expect((await counts()).locks).toBe(1)
  })
  it('rolls back a gate race as definitely uncommitted and preserves the same key across a later rollout',async()=>{
    const key=randomUUID()
    const options=await app.inject(`/staff/reservation-receptions/options?arrivalAt=${encodeURIComponent(String(payload.arrivalAt))}&expectedEndAt=${encodeURIComponent(String(payload.expectedEndAt))}`)
    expect(options.json().data.creationEnabled).toBe(true)
    creationEnabled=false
    const denied=await create(key);expect(denied.statusCode,denied.body).toBe(409)
    expect(denied.json().error).toMatchObject({code:'RESERVATION_RECEPTION_CREATE_DISABLED',commitDisposition:'not_committed'})
    expect(await counts()).toEqual({reservations:0,batches:0,sessions:0,locks:0})
    expect((await query('SELECT count(*)::int n FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3',[key])).rows[0].n).toBe(0)
    creationEnabled=true
    const created=await create(key);expect(created.statusCode,created.body).toBe(201)
    creationEnabled=false
    const replay=await create(key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual({...created.json(),meta:{replayed:true}})
    expect((await counts()).reservations).toBe(1)
  })
  it('turns off only new reception creation, preserving original receipts, public-id recovery, reads and actual seating',async()=>{
    const key=randomUUID(),created=await create(key);expect(created.statusCode,created.body).toBe(201)
    const row=created.json().data.reservation
    creationEnabled=false
    const options=await app.inject(`/staff/reservation-receptions/options?arrivalAt=${encodeURIComponent(String(payload.arrivalAt))}&expectedEndAt=${encodeURIComponent(String(payload.expectedEndAt))}`);expect(options.json().data.creationEnabled).toBe(false)
    const refused=await create(randomUUID(),{...payload,publicId:`reception-${randomUUID()}`});expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error).toMatchObject({code:'RESERVATION_RECEPTION_CREATE_DISABLED',commitDisposition:'not_committed'});expect((await counts()).reservations).toBe(1)
    expect((await create(key)).json()).toEqual({...created.json(),meta:{replayed:true}})
    expect((await app.inject(`/staff/reservation-receptions/by-public-id/${row.publicId}?requestKey=${key}`)).statusCode).toBe(200)
    expect((await app.inject(`/staff/reservation-receptions/${row.id}`)).statusCode).toBe(200)
    await query('DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3',[key])
    const recovered=await create(key);expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().data.reservation.id).toBe(row.id)
    actor=other;expect((await create(key)).statusCode).toBe(409);actor=employee
    await query("UPDATE mbox.reservations SET status='arrived' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[row.id])
    const denied=await nativeAction(row.id,'complete');expect(denied.statusCode,denied.body).toBe(409)
    expect((await seat(row.id,[await session()])).statusCode).toBe(200)
    expect((await nativeAction(row.id,'complete')).statusCode).toBe(200)
    expect(await counts()).toMatchObject({reservations:1,batches:1,sessions:1})
  })
  it('keeps public legacy creation and original protocol snapshots stable across rollout changes',async()=>{
    creationEnabled=false
    const key=randomUUID(),publicId=`public-${randomUUID()}`,created=await publicCreate(key,{publicId});expect(created.statusCode,created.body).toBe(201)
    const legacy=(await query('SELECT id,reservation_snapshot FROM mbox.reservations WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3',[publicId])).rows[0]
    expect(legacy.reservation_snapshot.receptionProtocol).toBeUndefined()
    creationEnabled=true;const replay=await publicCreate(key,{publicId});expect(replay.statusCode,replay.body).toBe(200)
    expect((await query('SELECT reservation_snapshot FROM mbox.reservations WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[legacy.id])).rows[0].reservation_snapshot).toEqual(legacy.reservation_snapshot)
    const key2=randomUUID(),id2=`public-${randomUUID()}`,modern=await publicCreate(key2,{publicId:id2});expect(modern.statusCode,modern.body).toBe(201)
    const marked=(await query('SELECT id,reservation_snapshot FROM mbox.reservations WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3',[id2])).rows[0];expect(marked.reservation_snapshot.receptionProtocol).toBe(1)
    creationEnabled=false;expect((await publicCreate(key2,{publicId:id2})).statusCode).toBe(200)
    for(const id of [legacy.id,marked.id])expect((await nativeAction(id,'arrive')).statusCode).toBe(200)
    expect((await nativeAction(legacy.id,'complete')).statusCode).toBe(200)
    expect((await nativeAction(marked.id,'complete')).statusCode).toBe(409)
    await expect(query("UPDATE mbox.reservations SET reservation_snapshot=reservation_snapshot-'receptionProtocol' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[marked.id])).rejects.toThrow('cannot be removed')
  })

  it('uses an actual restricted login, never preassigns physical tables, and retains one actor-bound original request',async()=>{
    const role=(await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];expect(role).toEqual({rolsuper:false,rolbypassrls:false})
    const key=randomUUID(),first=await create(key),again=await create(key)
    expect(first.statusCode,first.body).toBe(201);expect(again.statusCode,again.body).toBe(200);expect(again.json().data).toEqual(first.json().data)
    expect(first.json().data.reservation.tableLocks).toEqual([]);expect(JSON.stringify(first.json())).not.toContain(payload.contact)
    expect(await counts()).toEqual({reservations:1,batches:0,sessions:0,locks:0})
    expect((await query("SELECT expires_at::text FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3",[key])).rows[0].expires_at).toBe('infinity')
    const changed=await create(key,{...payload,guestCount:5});expect(changed.statusCode).toBe(409)
    actor=other;expect((await create(key)).statusCode).toBe(409)
    actor=employee;await revoke('reservation.manage');expect((await create(key)).statusCode).toBe(403)
  })
  it('permits same-public-ID recovery without a second customer or capacity claim, rejecting changed payload',async()=>{
    const results=await Promise.all([create(),create()]);expect(results.map(row=>row.statusCode).sort()).toEqual([200,201]);expect(results[0].json().data.reservation.id).toBe(results[1].json().data.reservation.id)
    expect((await counts()).reservations).toBe(1)
    expect((await create(randomUUID(),{...payload,contact:'13900139000'})).statusCode).toBe(409)
    now=new Date(now.getTime()+86400000*4);expect((await create()).statusCode).toBe(200)
  })
  it('recovers by original key and public ID for only the original employee without exposing contact',async()=>{
    const key=randomUUID(),first=await create(key);expect(first.statusCode,first.body).toBe(201)
    const url=`/staff/reservation-receptions/by-public-id/${payload.publicId}?requestKey=${key}`
    const response=await app.inject(url);expect(response.statusCode,response.body).toBe(200);expect(response.json().data).toEqual(first.json().data)
    expect((await app.inject(url.replace(String(payload.publicId),`other-${randomUUID()}`))).statusCode).toBe(404)
    actor=other;expect((await app.inject(url)).statusCode).toBe(404)
  })
  it('serializes staff and public reservations against one admission capacity',async()=>{
    await query('UPDATE mbox.tables SET capacity=1 WHERE tenant_id=$1 AND store_id=$2')
    const guest={mode:'direct',publicId:`public-${randomUUID()}`,customerName:'Public',contact:'13900139000',guestCount:3,arrivalAt:payload.arrivalAt,expectedEndAt:payload.expectedEndAt,reservationPolicyVersion:1}
    const responses=await Promise.all([create(randomUUID(),{...payload,guestCount:3}),app.inject({method:'POST',url:'/public/reservations',headers:{'idempotency-key':randomUUID()},payload:guest})])
    expect(responses.map(row=>row.statusCode).sort(),responses.map(row=>row.body)).toEqual([201,409]);expect((await counts()).reservations).toBe(1)
  })
  it('atomically links multiple actual sessions, preserves original quantities and replays after completion/closure',async()=>{
    const row=await reservation(7),sessions=[await session(tables[0],4),await session(tables[1],3)],key=randomUUID()
    const selected=await app.inject(`/staff/reservation-receptions/${row.id}/table-sessions`);expect(selected.statusCode,selected.body).toBe(200);expect(selected.json().data.sessions).toHaveLength(2)
    const first=await seat(row.id,sessions,key);expect(first.statusCode,first.body).toBe(200);expect(first.json().data.reservation.status).toBe('seated');expect(first.json().data.seating.seatedGuestCount).toBe(7)
    expect(await counts()).toEqual({reservations:1,batches:1,sessions:2,locks:0})
    await query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2")
    const completed=await app.inject({method:'POST',url:`/staff/native-reservations/${row.id}/complete`,headers:{'idempotency-key':`native-business-${randomUUID()}`},payload:{}});expect(completed.statusCode,completed.body).toBe(200)
    const replay=await seat(row.id,sessions,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data)
    expect((await seat(row.id,sessions)).statusCode).toBe(409)
  })
  it.each(['location','guests','closed','businessDate','version'] as const)('rolls back the entire session set on changed %s',async change=>{
    const row=await reservation(7),sessions=[await session(tables[0],4),await session(tables[1],3)]
    if(change==='location')sessions[1]!.expectedLocationVersion=1
    if(change==='guests')sessions[1]!.expectedGuestCount=2
    if(change==='closed')await query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[sessions[1]!.tableSessionId])
    if(change==='businessDate')await query("UPDATE mbox.table_sessions SET business_date=business_date-1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[sessions[1]!.tableSessionId])
    const result=await seat(row.id,sessions,randomUUID(),change==='version'?2:1);expect(result.statusCode,result.body).toBe(409);expect(result.json().error.commitDisposition).toBe('not_committed');expect((await counts()).sessions).toBe(0)
  })
  it('serializes competing reservations for one session without duplicate associations',async()=>{
    const a=await reservation(),b=await reservation(),target=await session()
    const responses=await Promise.all([seat(a.id,[target]),seat(b.id,[target])]);expect(responses.map(row=>row.statusCode).sort(),responses.map(row=>row.body)).toEqual([200,409]);expect((await counts()).batches).toBe(1)
  })
  it('serializes a real whole-table transfer with reception without associating a stale location',async()=>{
    const row=await reservation(),target=await session(),key=randomUUID()
    const commands=new TableManagementCommandService(new NormalizedCommandExecutor(transactions))
    const [seated,moved]=await Promise.all([seat(row.id,[target],key),commands.transfer({scope:scope(),actor:{type:'employee',employeeId:employee},businessDate,idempotencyKey:randomUUID(),requestFingerprint:randomUUID(),tableSessionId:target.tableSessionId,targetTableId:tables[2]!,expectedSourceTableId:tables[0]!,expectedLocationVersion:0,reason:'真实并发调整到空闲桌台'})])
    expect(moved.value.targetTableId).toBe(tables[2]);expect([200,409]).toContain(seated.statusCode)
    if(seated.statusCode===200){const current=await app.inject(`/staff/reservation-receptions/${row.id}`);expect(current.json().data.seating.sessions[0]).toMatchObject({tableIdAtSeating:tables[0],currentTableId:tables[2]});expect((await seat(row.id,[target],key)).json().data).toEqual(seated.json().data)}
    else {expect(seated.json().error.commitDisposition).toBe('not_committed');expect((await counts()).batches).toBe(0)}
  })
  it('serializes two session sets for one reservation and preserves the winning immutable batch',async()=>{
    const row=await reservation(),a=await session(),b=await session(tables[1])
    const responses=await Promise.all([seat(row.id,[a]),seat(row.id,[b])]);expect(responses.map(row=>row.statusCode).sort()).toEqual([200,409]);expect((await counts()).sessions).toBe(1)
    await expect(transactions.run(scope(),tx=>tx.query('DELETE FROM mbox.reservation_seating_sessions WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId]))).rejects.toThrow()
  })
  it('enforces current employee table scope independently of the supplied list and on original-key replay',async()=>{
    const row=await reservation(),target=await session(),key=randomUUID();await revoke('table.view_all')
    const options=await app.inject(`/staff/reservation-receptions/${row.id}/table-sessions`);expect(options.json().data.sessions).toEqual([])
    const denied=await seat(row.id,[target],key);expect(denied.statusCode,denied.body).toBe(403);expect((await counts()).batches).toBe(0)
    actor=other;const accepted=await seat(row.id,[target],key);expect(accepted.statusCode,accepted.body).toBe(200)
    await revoke('table.open',other);expect((await seat(row.id,[target],key)).statusCode).toBe(403)
  })
  it('rejects foreign-store session IDs without leaking or partially linking same-store sessions',async()=>{
    const row=await reservation(),target=await session(),foreignStore=randomUUID(),foreignArea=randomUUID(),foreignTable=randomUUID(),foreignSession=randomUUID()
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'foreign','Foreign')",[foreignStore,tenantId])
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'FOREIGN','Foreign','indoor')",[foreignArea,tenantId,foreignStore])
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'F01','F01',4)",[foreignTable,tenantId,foreignStore,foreignArea])
    await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5::date,4)",[foreignSession,tenantId,foreignStore,foreignTable,businessDate])
    const foreign={...target,tableSessionId:foreignSession,expectedTableId:foreignTable}
    const result=await seat(row.id,[target,foreign]);expect(result.statusCode,result.body).toBe(409);expect((await counts()).sessions).toBe(0)
  })
  it('requires actual seating for new staff and public bookings, while keeping completed historical rows intact',async()=>{
    const row=await reservation()
    const refused=await app.inject({method:'POST',url:`/staff/native-reservations/${row.id}/complete`,headers:{'idempotency-key':`native-business-${randomUUID()}`},payload:{}})
    expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error.commitDisposition).toBe('not_committed')
    await expect(query("UPDATE mbox.reservations SET status='completed' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[row.id])).rejects.toThrow('must be linked')
    await expect(query("UPDATE mbox.reservations SET reservation_snapshot=reservation_snapshot-'receptionProtocol' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[row.id])).rejects.toThrow('cannot be removed')
    const guest=await app.inject({method:'POST',url:'/public/reservations',headers:{'idempotency-key':randomUUID()},payload:{mode:'direct',publicId:`public-${randomUUID()}`,customerName:'Public',contact:'13900139000',guestCount:2,arrivalAt:payload.arrivalAt,expectedEndAt:payload.expectedEndAt,reservationPolicyVersion:1}})
    expect(guest.statusCode,guest.body).toBe(201)
    const guestRow=(await query('SELECT id,reservation_snapshot FROM mbox.reservations WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3',[guest.json().data.publicId])).rows[0]
    expect(guestRow.reservation_snapshot.receptionProtocol).toBe(1)
    await expect(query("UPDATE mbox.reservations SET status='completed' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[guestRow.id])).rejects.toThrow('must be linked')
  })
  it('retains original table position when the actual session moves and only exposes the scoped current record',async()=>{
    const row=await reservation(),target=await session(),first=await seat(row.id,[target]);expect(first.statusCode,first.body).toBe(200)
    await new TableManagementCommandService(new NormalizedCommandExecutor(transactions)).transfer({scope:scope(),actor:{type:'employee',employeeId:employee},businessDate,idempotencyKey:randomUUID(),requestFingerprint:randomUUID(),tableSessionId:target.tableSessionId,targetTableId:tables[2]!,expectedSourceTableId:tables[0]!,expectedLocationVersion:0,reason:'顾客希望换到同区空闲桌台'})
    const read=await app.inject(`/staff/reservation-receptions/${row.id}`);expect(read.statusCode,read.body).toBe(200)
    expect(read.json().data.seating.sessions[0]).toMatchObject({tableIdAtSeating:tables[0],currentTableId:tables[2],locationVersionAtSeating:0,currentLocationVersion:1})
    const role=randomUUID();await query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($3,$1,$2,'AREA','Area role')",[role])
    await query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[other,role])
    await query("INSERT INTO mbox.role_data_scopes(tenant_id,store_id,role_id,scope_key,scope_value,value_kind,text_value) VALUES($1,$2,$3,'reservation.area_id',to_jsonb($4::text),'text',$4::text)",[role,area])
    await revoke('reservation.view.all',other);actor=other
    expect((await app.inject(`/staff/reservation-receptions/${row.id}`)).statusCode).toBe(200)
    const listing=await app.inject(`/staff/reservations?range=history&from=${encodeURIComponent(String(payload.arrivalAt))}&to=${encodeURIComponent(String(payload.expectedEndAt))}`);expect(listing.statusCode,listing.body).toBe(200);expect(listing.json().data.some((item:{id:string})=>item.id===row.id)).toBe(true)
    const complete=await app.inject({method:'POST',url:`/staff/native-reservations/${row.id}/complete`,headers:{'idempotency-key':`native-business-${randomUUID()}`},payload:{}});expect(complete.statusCode,complete.body).toBe(200)
  })
  it('has database enforcement for complete batches and scoped child links',async()=>{
    const row=await reservation(),target=await session()
    await expect(transactions.run(scope(),async tx=>{await tx.query(`INSERT INTO mbox.reservation_seating_batches(tenant_id,store_id,reservation_id,customer_id,reservation_version,reservation_guest_count,seated_guest_count,seated_by_employee_id,business_date,reason) VALUES($1,$2,$3,$4,1,4,4,$5,$6::date,'missing child rows')`,[tenantId,storeId,row.id,row.customerId,employee,businessDate]);await tx.query("UPDATE mbox.reservations SET status='seated' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[tenantId,storeId,row.id])})).rejects.toThrow('complete confirmed session set')
    expect((await counts()).batches).toBe(0)
    const accepted=await seat(row.id,[target]);expect(accepted.statusCode,accepted.body).toBe(200)
    const otherStore=randomUUID();await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'other','Other')",[otherStore,tenantId])
    const otherScope={tenantId,storeId:otherStore}
    expect((await transactions.run(otherScope,tx=>tx.query('SELECT id FROM mbox.reservation_seating_batches'))).rows).toEqual([])
    await expect(transactions.run(scope(),tx=>tx.query("UPDATE mbox.reservation_seating_batches SET reason='changed reason'"))).rejects.toThrow()
  })
  it.each(['staff','guest','native'] as const)('rejects new legacy %s table-bound writes but recovers matching expired original receipts',async channel=>{
    const oldBody:Record<string,unknown>={customerName:'Old customer',contactToken:'old-protected-token',guestCount:4,arrivalAt:payload.arrivalAt,expectedEndAt:payload.expectedEndAt,tableIds:[tables[0]]}
    if(channel!=='guest')Object.assign(oldBody,{publicId:channel==='native'?`NRES-${randomUUID()}`:`legacy-${randomUUID()}`,source:'phone',initialStatus:'confirmed'})
    const url=channel==='native'?'/staff/native-reservations':`/${channel}/reservations`,key=channel==='native'?`native-business-${randomUUID()}`:randomUUID(),request=()=>app.inject({method:'POST',url,headers:{'idempotency-key':key},payload:oldBody})
    const refused=await request();expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error.commitDisposition).toBe('not_committed');expect((await counts()).reservations).toBe(0)
    legacyFixture=true;const original=await request();expect(original.statusCode,original.body).toBe(201);legacyFixture=false
    await query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '3 days',expires_at=clock_timestamp()-interval '2 days' WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3",[key]);now=new Date(now.getTime()+86400000*4)
    const before=(await query('SELECT response_snapshot FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3',[key])).rows[0].response_snapshot;const replay=await request();expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toMatchObject({publicId:original.json().data.publicId,status:original.json().data.status,guestCount:4});expect((await query('SELECT response_snapshot FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3',[key])).rows[0].response_snapshot).toEqual(before);expect((await counts()).reservations).toBe(1)
    oldBody.guestCount=3;expect((await request()).statusCode).toBe(409)
  })
})
