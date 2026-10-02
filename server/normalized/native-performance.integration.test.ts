import {randomUUID} from 'node:crypto'
import Fastify,{type FastifyInstance} from 'fastify'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {CustomerCommandService} from './customer-repository.js'
import {nativePerformanceApiPlugin} from './native-performance-api.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('native performance complete command workflows',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),role=randomUUID();let admin:Pool,runtime:Pool,app:FastifyInstance,performer:string,schedule:string
 const root='/staff/native-performances';const send=(action:string,payload:object,key=`native-business-${randomUUID()}`)=>app.inject({method:'POST',url:root+'/commands/'+action,headers:{'idempotency-key':key},payload})
 const get=async(suffix='?month=2026-10')=>{const r=await app.inject({method:'GET',url:root+suffix});expect(r.statusCode,r.body).toBe(200);return r.json().data}
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!);const transactions=new ScopedPostgresTransactionRunner(runtime),commands=new NormalizedCommandExecutor(transactions)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Native shows')",[scope.tenantId]);await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Native shows')",[scope.storeId,scope.tenantId]);await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'SHOWS','演出管理员')",[employee,scope.tenantId,scope.storeId]);await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'SHOWS','演出管理员')",[role,scope.tenantId,scope.storeId]);await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,employee,role]);await admin.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4)",[scope.tenantId,scope.storeId,role,['song.view','song.manage','performance.phase.manage','performance.schedule.revise','reservation.view']]);app=Fastify();await app.register(nativePerformanceApiPlugin,{transactions,commands,customers:new CustomerCommandService(commands),resolveContext:()=>({scope,employeeId:employee,businessDate:'2026-10-01'})});await app.ready()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 it('maintains performers and complete active/inactive catalog with stale snapshot guards',async()=>{
  const created=await send('performer-create',{code:'NATIVE_SINGER',stageName:'原生测试歌手',status:'active',profileSnapshot:{genres:['爵士']}});expect(created.statusCode,created.body).toBe(200);performer=created.json().data.result.id
  const original=(await get()).performers[0];expect(original.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/)
  const songs=await get('/performers/'+performer+'/songs');const body={performerId:performer,expected:songs.catalogFingerprint,sourceName:'原生测试清单',mode:'upsert',songs:[{code:'TEST001',title:'测试曲目一',aliases:['第一首'],status:'active'},{code:'TEST002',title:'测试曲目二',aliases:[],status:'inactive'}]};const key=`native-business-${randomUUID()}`,imported=await send('songs-import',body,key);expect(imported.statusCode,imported.body).toBe(200);expect((await send('songs-import',body,key)).json().meta.replayed).toBe(true)
  const catalog=await get('/performers/'+performer+'/songs');expect(catalog.songs).toHaveLength(2);expect((await get('/performers/'+performer+'/songs?search='+encodeURIComponent('第一首'))).songs).toHaveLength(1)
  expect((await send('songs-import',{...body,mode:'replace'})).statusCode).toBe(409)
  const row=catalog.songs.find((x:any)=>x.code==='TEST002');const update=await send('song-update',{songId:row.id,expected:row.configurationFingerprint,changes:{code:row.code,title:'测试曲目二已启用',aliases:[],status:'active'}});expect(update.statusCode,update.body).toBe(200)
  const p=(await get()).performers[0];expect((await send('performer-update',{performerId:performer,expected:p.configurationFingerprint,stageName:'已改艺名',profileSnapshot:{genres:['爵士','流行']},status:'active'})).statusCode).toBe(200)
  expect((await send('performer-update',{performerId:performer,expected:p.configurationFingerprint,stageName:'旧页面覆盖',profileSnapshot:{},status:'active'})).statusCode).toBe(409)
 })
 it('previews, publishes once, rejects overlap, revises with original snapshot and reauthorizes replay',async()=>{
  const body={month:'2026-10',slots:[{performerId:performer,startsAt:'2026-10-02T12:00:00Z',endsAt:'2026-10-02T14:00:00Z'}]},key=`native-business-${randomUUID()}`
  const preview=await app.inject({method:'POST',url:root+'/preview',payload:body});expect(preview.statusCode,preview.body).toBe(200);expect(preview.json().data.slots[0].reasons).toHaveLength(0)
  const published=await send('publish',body,key);expect(published.statusCode,published.body).toBe(200);schedule=published.json().data.result.scheduleIds[0];expect((await send('publish',body,key)).json().meta.replayed).toBe(true);expect((await send('publish',body)).json().data.result).toMatchObject({createdCount:0,existingCount:1})
  const overlap=await send('publish',{...body,slots:[{...body.slots[0],endsAt:'2026-10-02T15:00:00Z'}]});expect(overlap.statusCode).toBe(409);expect((await get()).schedules).toHaveLength(1)
  let current=(await get()).schedules[0];const revision={scheduleId:schedule,expected:current.configurationFingerprint,kind:'rescheduled',startsAt:'2026-10-03T12:00:00Z',endsAt:'2026-10-03T14:00:00Z',replacementScheduleId:null,replacementExpected:null,reason:'调整测试排班'};const revised=await send('revision',revision);expect(revised.statusCode,revised.body).toBe(200)
  expect((await get('/revisions/'+revised.json().data.result.publicId+'/impacts')).impacts).toEqual([])
  expect((await send('revision',{...revision,kind:'cancelled',reason:'旧页面不得取消'})).statusCode).toBe(409)
  current=(await get()).schedules[0];expect(current.startsAt).toContain('2026-10-03')
  await admin.query("UPDATE mbox.employee_roles SET ends_at=clock_timestamp()-interval '1 second' WHERE employee_id=$1",[employee]);expect((await send('publish',body,key)).statusCode).toBe(403);await admin.query('UPDATE mbox.employee_roles SET ends_at=NULL WHERE employee_id=$1',[employee])
 })
 it('verifies the replacement snapshot across months before cancelling the source',async()=>{
  const slot=(startsAt:string,endsAt:string)=>({performerId:performer,startsAt,endsAt})
  await send('publish',{month:'2026-10',slots:[slot('2026-10-10T12:00:00Z','2026-10-10T14:00:00Z')]})
  await send('publish',{month:'2026-11',slots:[slot('2026-11-01T12:00:00Z','2026-11-01T14:00:00Z')]})
  const source=(await get()).schedules.find((x:any)=>x.startsAt.startsWith('2026-10-10')),target=(await get('?month=2026-11')).schedules[0]
  const body={scheduleId:source.id,expected:source.configurationFingerprint,kind:'replaced',startsAt:null,endsAt:null,replacementScheduleId:target.id,replacementExpected:'0'.repeat(64),reason:'跨月替换演出'}
  expect((await send('revision',body)).statusCode).toBe(409)
  const result=await send('revision',{...body,replacementExpected:target.configurationFingerprint});expect(result.statusCode,result.body).toBe(200);expect(result.json().data.result.resultingScheduleId).toBe(target.id)
  expect((await get()).schedules.find((x:any)=>x.id===source.id).status).toBe('cancelled')
 })
 it('starts and ends actual phase and completes the original schedule with durable reply',async()=>{
  let row=(await get()).schedules.find((x:any)=>x.id===schedule)
  const start=await send('schedule-status',{scheduleId:schedule,expected:row.configurationFingerprint,targetStatus:'performing'});expect(start.statusCode,start.body).toBe(200)
  row=(await get()).schedules.find((x:any)=>x.id===schedule)
  const body={scheduleId:schedule,expected:row.configurationFingerprint,phaseCode:'band_live',reason:'现场确认乐队开演'},key=`native-business-${randomUUID()}`,phase=await send('phase-start',body,key);expect(phase.statusCode,phase.body).toBe(200);expect((await send('phase-start',body,key)).json().meta.replayed).toBe(true);expect((await get()).phases).toHaveLength(1)
  expect((await send('phase-start',{...body,phaseCode:'acoustic'})).statusCode).toBe(409)
  expect((await send('schedule-status',{scheduleId:schedule,expected:(await get()).schedules.find((r:any)=>r.id===schedule).configurationFingerprint,targetStatus:'completed'})).json().error.message).toContain('先结束当前现场阶段')
  const ended=await send('phase-end',{publicId:phase.json().data.result.publicId,reason:'现场确认结束本阶段'});expect(ended.statusCode,ended.body).toBe(200);expect((await get()).phases).toHaveLength(0)
  const complete=await send('schedule-status',{scheduleId:schedule,expected:row.configurationFingerprint,targetStatus:'completed'});expect(complete.statusCode,complete.body).toBe(200);expect(complete.json().data.result.status).toBe('completed')
 })
})
