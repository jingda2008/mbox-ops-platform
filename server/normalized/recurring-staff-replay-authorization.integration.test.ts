import { NormalizedApiClient } from '../../src/normalized-api.js'
import { StaffEmployeeRecovery, type EmployeeOperation, type EmployeeOperationResult, type EmployeeOperationIntent } from '../../src/normalized-ui/staff-employee-recovery.js'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest, type InjectOptions } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { hashRequestFingerprint, NormalizedCommandExecutor } from './command-executor.js'
import { StaffAccessManagementService } from './staff-access-management-service.js'
import { staffAccessManagementApiPlugin } from './staff-access-management-api.js'
import { nativeStaffAdministrationApiPlugin } from './native-staff-administration-api.js'
import { ScryptCredentialHasher, StaffAuthCommandService } from './staff-auth-command-service.js'
import { ownerFinanceApiPlugin } from './owner-finance-api.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = databaseUrl && runtimeUrl ? describe : describe.skip
const scope = { tenantId: randomUUID(), storeId: randomUUID() }
const otherStoreId = randomUUID()
const employeeId = randomUUID(), otherEmployeeId = randomUUID(), roleId = randomUUID()
const permissions = ['commercial.cost.manage','commercial.payroll.manage','commercial.payroll.post','inventory.receive','staff.access.configure','order.create']

integration('recurring history and staff receipt authorization with a restricted PostgreSQL login', () => {
  let admin: Pool, runtime: Pool, app: FastifyInstance
  let resolveViaDatabase = false, changeIdentity = false, resolveCount = 0
  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    admin = new Pool({ connectionString: databaseUrl })
    runtime = new Pool({ connectionString: runtimeUrl, max:1, connectionTimeoutMillis:1000 })
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES ($1,$2,'Replay audit')", [scope.tenantId, `replay-${scope.tenantId}`])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES ($1,$2,'replay','Replay audit')", [scope.storeId,scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES ($1,$2,'other','Other audit store')", [otherStoreId,scope.tenantId])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES ($1,$3,$4,'one','One'),($2,$3,$4,'two','Two')", [employeeId,otherEmployeeId,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES ($1,$2,$3,'REPLAY','Replay')", [roleId,scope.tenantId,scope.storeId])
    await admin.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES ($1,$2,$3,$5),($1,$2,$4,$5)', [scope.tenantId,scope.storeId,employeeId,otherEmployeeId,roleId])
    for (const code of permissions) {
      await admin.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES ($1,$2,$3,$3,'inventory') ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET status='active'", [scope.tenantId,scope.storeId,code])
      await grant(code)
    }
    const runner = new ScopedPostgresTransactionRunner(runtime as unknown as PostgresPool)
    app = Fastify()
    const resolveContext=async(request:FastifyRequest)=>{
      if(resolveViaDatabase)await runner.run(scope,tx=>tx.query('SELECT 1'))
      const actor=request.headers['x-employee-id']===otherEmployeeId?otherEmployeeId:employeeId
      return {scope:request.headers['x-other-store']?{...scope,storeId:otherStoreId}:scope,
        employeeId:changeIdentity&&++resolveCount>1?otherEmployeeId:actor,businessDate:'2026-11-02',capabilities:[]}
    }
    for(const native of [false,true])await app.register(ownerFinanceApiPlugin,{prefix:native?'/native':'/api',transactions:runner,commandExecutor:new NormalizedCommandExecutor(runner),resolveContext,nativeReceipts:native})
    await app.register(staffAccessManagementApiPlugin,{fingerprintSecret:'local-audit-fixture-key-not-for-production-20261102',prefix:'/api',service:new StaffAccessManagementService(runner,new NormalizedCommandExecutor(runner)),resolveContext})
    await app.register(nativeStaffAdministrationApiPlugin,{prefix:'/native',transactions:runner,commands:new NormalizedCommandExecutor(runner),resolveStaffContext:resolveContext,
      fingerprintSecret:'local-audit-fixture-key-not-for-production-20261102',authFactory:commands=>new StaffAuthCommandService(runner,commands,{consume:async()=>{}})})
    await app.ready()
  })
  afterAll(async () => { await app?.close(); await runtime?.end(); await admin?.end() })

  async function grant(code:string) {
    await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4 ON CONFLICT DO NOTHING', [scope.tenantId,scope.storeId,roleId,code])
  }
  async function without(code:string, run:()=>Promise<void>) {
    await admin.query('DELETE FROM mbox.role_permission_assignments a USING mbox.staff_permission_definitions p WHERE a.permission_id=p.id AND a.role_id=$1 AND p.code=$2', [roleId,code])
    try { await run() } finally { await grant(code) }
  }
  function request(url:string,payload:object,headers:Record<string,string>={}):InjectOptions{return{method:'POST',url,headers:{'idempotency-key':`native-business-${randomUUID()}`,...headers},payload}}
  const finance=(native:boolean,path:string,payload:object,version?:number)=>request(`${native?'/native':'/api'}/commercial-ops/${path}`,payload,version?{'x-owner-version':String(version)}:{})
  const value=(r:Awaited<ReturnType<FastifyInstance['inject']>>,native=false)=>native?r.json().data.result:r.json().data
  async function success(req:InjectOptions,native=false){const r=await app.inject(req);expect([200,201],r.body).toContain(r.statusCode);return value(r,native)}
  async function denied(req:InjectOptions,status=403){const r=await app.inject(req);expect(r.statusCode,r.body).toBe(status);expect(r.json().data).toBeUndefined()}
  async function snapshot(){
    const tables=['recurring_operating_cost_rules','operating_cost_entries','employees','employee_roles','staff_permission_deployment_receipts','audit_events','outbox_messages','idempotency_records']
    const result:Record<string,unknown>={}
    for(const table of tables)result[table]=(await admin.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM mbox.${table} t WHERE tenant_id=$1`,[scope.tenantId])).rows[0].rows
    return result
  }
  async function recurring(native:boolean){
    const categoryId=(await admin.query("SELECT id FROM mbox.operating_cost_category_definitions WHERE store_id=$1 AND code='rent'",[scope.storeId])).rows[0].id
    const centerId=(await admin.query("SELECT id FROM mbox.cost_centers WHERE store_id=$1 AND code='venue'",[scope.storeId])).rows[0].id
    const payload={name:'Audit rent',categoryDefinitionId:categoryId,costCenterId:centerId,recurrence:'day',allocationPeriod:'day',recognitionState:'accrual',startsOn:'2026-11-01',endsOn:'2026-11-01',netAmountMinor:100,taxAmountMinor:0,sourceType:'lease'}
    const req=finance(native,'recurring-costs',payload),rule=await success(req,native)
    return {payload,req,rule}
  }
  type Fixture=Awaited<ReturnType<typeof recurring>>
  async function seedSource(fixture:Fixture,sourceType:string,category:string){
    await admin.query("UPDATE mbox.recurring_operating_cost_rules SET source_type=$2,category_definition_id=(SELECT id FROM mbox.operating_cost_category_definitions WHERE store_id=$3 AND system_category=$4 LIMIT 1) WHERE id=$1",[fixture.rule.id,sourceType,scope.storeId,category])
  }
  const sourceCases=[
    {sourceType:'payroll',category:'rent',permission:'commercial.payroll.manage'},
    {sourceType:'manual',category:'personnel',permission:'commercial.payroll.manage'},
    {sourceType:'lease',category:'beverage_purchase',permission:'inventory.receive'},
    {sourceType:'payroll',category:'beverage_purchase',permission:'commercial.payroll.manage'},
    {sourceType:'payroll',category:'beverage_purchase',permission:'inventory.receive'},
  ]
  const actions=['status','update','materialize'] as const
  function operation(native:boolean,kind:string,f:Fixture){return kind==='status'?finance(native,`recurring-costs/${f.rule.id}/status`,{status:'paused',reason:'Audit pause'},1):kind==='update'?finance(native,'recurring-costs',{...f.payload,ruleId:f.rule.id,expectedVersion:1,changeReason:'Audit reclassification',netAmountMinor:200}):finance(native,'recurring-costs/materialize',{throughDate:'2026-11-01'})}
  async function retire(native:boolean,kind:string,f:Fixture){
    let version=kind==='materialize'?1:2
    if(kind!=='update'){
      await success(finance(native,'recurring-costs',{...f.payload,ruleId:f.rule.id,expectedVersion:version,changeReason:'Later ordinary reclassification'}),native)
      version++
    }
    await success(finance(native,`recurring-costs/${f.rule.id}/status`,{status:'ended',reason:'Later end'},version),native)
  }
  async function receipt(req:InjectOptions){return(await admin.query("SELECT response_snapshot,expires_at::text FROM mbox.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2",[scope.tenantId,(req.headers as Record<string,string>)['idempotency-key']])).rows[0]}
  async function rewriteAuthorization(req:InjectOptions,evidence:unknown,remove=false){
    await admin.query(remove?"UPDATE mbox.idempotency_records SET response_snapshot=response_snapshot-'replayAuthorization' WHERE tenant_id=$1 AND idempotency_key=$2":"UPDATE mbox.idempotency_records SET response_snapshot=jsonb_set(response_snapshot,'{replayAuthorization}',$3::jsonb) WHERE tenant_id=$1 AND idempotency_key=$2",[scope.tenantId,(req.headers as Record<string,string>)['idempotency-key'],...(remove?[]:[JSON.stringify(evidence)])])
  }
  it.each([false,true].flatMap(native=>actions.flatMap(kind=>sourceCases.map(source=>({native,kind,...source})))))('retains historical $sourceType/$category authority on $kind after reclassification/end, native=$native, revoke=$permission',async({native,kind,sourceType,category,permission})=>{
    const f=await recurring(native);await seedSource(f,sourceType,category)
    const req=operation(native,kind,f)
    await without(permission,()=>denied(req,native?409:403))
    const initial=await success(req,native)
    const stored=await receipt(req)
    expect(initial.replayAuthorization).toBeUndefined()
    if(kind==='materialize')expect(initial.createdCount).toBe(1)
    if(kind==='update')expect(initial.previousRule.source_type).toBe(sourceType)
    await retire(native,kind,f)
    if(native){
      await admin.query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '90 days' WHERE tenant_id=$1 AND idempotency_key=$2",[scope.tenantId,(req.headers as Record<string,string>)['idempotency-key']])
      expect((await receipt(req)).expires_at).toBe('infinity')
    }
    const before=await snapshot()
    await without(permission,async()=>{
      await denied(req)
      await denied({...req,payload:{...(req.payload as object),replayAuthorization:{version:1,sourcePermissions:[]}}})
    })
    expect(stored.response_snapshot.replayAuthorization).toEqual({version:1,sourcePermissions:[...(sourceType==='payroll'||category==='personnel'?['commercial.payroll.manage']:[]),...(category==='beverage_purchase'?['inventory.receive']:[])].sort()})
    const restored=await app.inject(req);expect(restored.statusCode,restored.body).toBe(200)
    expect(native?restored.json().meta.replayed:restored.json().replayed).toBe(true)
    expect(value(restored,native)).toEqual(initial)
    expect(await snapshot()).toEqual(before)
  })
  it.each([false,true].flatMap(native=>actions.map(kind=>({native,kind}))))('does not add later unrelated source authority to an ordinary $kind receipt, native=$native',async({native,kind})=>{
    const f=await recurring(native),req=operation(native,kind,f),initial=await success(req,native)
    await seedSource(f,'payroll','beverage_purchase')
    const before=await snapshot()
    await without('commercial.payroll.manage',()=>without('inventory.receive',async()=>{
      expect(await success(req,native)).toEqual(initial)
    }))
    expect(await snapshot()).toEqual(before)
    await admin.query("UPDATE mbox.recurring_operating_cost_rules SET status='ended' WHERE id=$1",[f.rule.id])
  })
  it.each([false,true].flatMap(native=>actions.map(kind=>({native,kind}))))('preserves a legacy $kind receipt without guessing missing historical authority, native=$native',async({native,kind})=>{
    const f=await recurring(native),req=operation(native,kind,f),initial=await success(req,native)
    await retire(native,kind,f);await rewriteAuthorization(req,undefined,true)
    const before=await snapshot()
    for(const permission of ['commercial.payroll.manage','inventory.receive'])await without(permission,()=>denied(req))
    expect(await success(req,native)).toEqual(initial)
    expect(await snapshot()).toEqual(before)
  })
  it.each([false,true])('records source requirements even when every occurrence already exists, native=%s',async native=>{
    const f=await recurring(native);await seedSource(f,'payroll','rent')
    await success(operation(native,'materialize',f),native)
    const req=operation(native,'materialize',f),initial=await success(req,native)
    expect(initial.createdCount).toBe(0)
    await retire(native,'materialize',f)
    const before=await snapshot()
    await without('commercial.payroll.manage',()=>denied(req))
    expect(await success(req,native)).toEqual(initial)
    expect(await snapshot()).toEqual(before)
  })
  it.each([false,true])('legacy creation needs no payroll or purchasing rights, native=%s',async native=>{
    const f=await recurring(native);await rewriteAuthorization(f.req,undefined,true)
    await without('commercial.payroll.manage',()=>without('inventory.receive',async()=>{expect(await success(f.req,native)).toEqual(f.rule)}))
    await admin.query("UPDATE mbox.recurring_operating_cost_rules SET status='ended' WHERE id=$1",[f.rule.id])
  })
  it.each([false,true].flatMap(native=>[null,{version:2,sourcePermissions:[]},{version:1,sourcePermissions:['unknown.permission']}].map(evidence=>({native,evidence}))))('fails closed on malformed historical requirements, native=$native evidence=$evidence',async({native,evidence})=>{
    const f=await recurring(native),req=operation(native,'status',f);await success(req,native)
    await rewriteAuthorization(req,evidence);const before=await snapshot()
    await denied(req);expect(await snapshot()).toEqual(before)
    await admin.query("UPDATE mbox.recurring_operating_cost_rules SET status='ended' WHERE id=$1",[f.rule.id])
  })
  async function staffRequest(native:boolean,kind:string){
    const target=randomUUID()
    if(kind==='status')await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,'Local staff')",[target,scope.tenantId,scope.storeId])
    const payload=kind==='create'?{employeeCode:`audit_${target}`,displayName:'Local new staff',pin:'4826',roleId,reason:'Local audit'}:{status:'suspended',reason:'Local audit'}
    if(native){
      const r=await app.inject({url:'/native/staff/native-administration'});expect(r.statusCode,r.body).toBe(200)
      return request(`/native/staff/native-administration/${kind}`,{...payload,...(kind==='status'?{employeeId:target}:{}),expectedVersion:r.json().data.overview.configurationVersion})
    }
    return request(kind==='create'?'/api/staff-access/employees':`/api/staff-access/employees/${target}/status`,payload)
  }
  async function employeeRecoveryFixture(kind:string, failure:'network'|'malformed'|'none'='network') {
    const req=await staffRequest(false,kind)
    const body=req.payload as Record<string,string>
    const operation:EmployeeOperation=kind==='create'?{action:'create',body:{employeeCode:body.employeeCode!,displayName:body.displayName!,roleId:body.roleId!,reason:body.reason!}}:
      {action:'status',employeeId:req.url!.split('/').at(-2)!,body:{status:'suspended',reason:body.reason!}}
    const records=new Map<string,string>()
    const storage={get length(){return records.size},key:(i:number)=>[...records.keys()][i]??null,getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{records.set(key,value)},removeItem:(key:string)=>{records.delete(key)}}
    const recovery=()=>new StaffEmployeeRecovery(`${scope.tenantId}:${scope.storeId}`,employeeId,storage)
    let responseFailure=failure
    const client=new NormalizedApiClient({fetch:async(url,init)=>{
      const response=await app.inject({method:'POST',url:String(url),headers:Object.fromEntries(new Headers(init?.headers)),payload:JSON.parse(String(init?.body))})
      if(response.statusCode<300&&responseFailure!=='none'){
        const mode=responseFailure;responseFailure='none'
        if(mode==='network')throw new TypeError('Injected loss after real commit')
        return new Response(JSON.stringify({data:{}}),{status:200,headers:{'content-type':'application/json'}})
      }
      return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}})
    }})
    const send=(intent:EmployeeOperationIntent,pin:string|undefined,receiptOnly:boolean)=>{
      const op=intent.operation
      return client.postEndpoint<EmployeeOperationResult>(`${op.action==='create'?'/api/staff-access/employees':`/api/staff-access/employees/${op.employeeId}/status`}${receiptOnly?'/recover':''}`,op.action==='create'?{...op.body,pin}:op.body,{idempotencyKey:intent.key})
    }
    return {req,operation,records,recovery,send}
  }
  it.each(['create','status'])('client recovers committed %s after loss, reload and revoked authority without extra facts',async kind=>{
    const f=await employeeRecoveryFixture(kind)
    await expect(f.recovery().execute(f.operation,'4826',f.send)).rejects.toThrow('网络连接失败')
    const pending=f.recovery().pending(),before=await snapshot()
    expect(JSON.stringify([...f.records.values()])).not.toContain('"pin"')
    expect(Object.values(JSON.parse([...f.records.values()][0]!).operation.body)).not.toContain('4826')
    await expect(f.recovery().execute(f.operation,'4826',f.send)).rejects.toThrow('先恢复')
    await without('staff.access.configure',async()=>{
      await expect(f.recovery().execute(null,'4826',f.send)).rejects.toMatchObject({status:403})
      expect(f.recovery().pending()).toEqual(pending)
    })
    expect((await f.recovery().execute(null,'4826',f.send)).replayed).toBe(true)
    expect(f.records.size).toBe(0);expect(await snapshot()).toEqual(before)
  })
  it('client retains original create intent after re-entering a different PIN',async()=>{
    const f=await employeeRecoveryFixture('create')
    await expect(f.recovery().execute(f.operation,'4826',f.send)).rejects.toThrow()
    const before=await snapshot(),pending=f.recovery().pending()
    await expect(f.recovery().execute(null,'7391',f.send)).rejects.toMatchObject({status:409})
    expect(f.recovery().pending()).toEqual(pending)
    expect((await f.recovery().execute(null,'4826',f.send)).replayed).toBe(true)
    expect(await snapshot()).toEqual(before)
  })
  it.each(['create','status'])('client releases only a definitively rejected first %s request',async kind=>{
    const f=await employeeRecoveryFixture(kind,'none');await success(f.req)
    const before=await snapshot()
    await expect(f.recovery().execute(f.operation,'4826',f.send)).rejects.toMatchObject({status:400,code:'PERMISSION_DEPLOYMENT_INVALID'})
    expect(f.records.size).toBe(0);expect(await snapshot()).toEqual(before)
  })
  it('client retains a committed command after malformed success and restores its verified receipt',async()=>{
    const f=await employeeRecoveryFixture('create','malformed')
    await expect(f.recovery().execute(f.operation,'4826',f.send)).rejects.toThrow('回执')
    const before=await snapshot()
    expect((await f.recovery().execute(null,'4826',f.send)).replayed).toBe(true)
    expect(await snapshot()).toEqual(before)
  })
  it.each(['create','status'].flatMap(kind=>['expired','deleted','never_committed'].map(state=>({kind,state}))))('recovery-only $kind never re-executes when receipt is $state',async({kind,state})=>{
    const f=await employeeRecoveryFixture(kind)
    await expect(f.recovery().execute(f.operation,'4826',state==='never_committed'?async()=>{throw new Error('request did not reach server')}:f.send)).rejects.toThrow()
    const pending=f.recovery().pending()!
    if(state==='expired')await admin.query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND idempotency_key=$2",[scope.tenantId,pending.key])
    if(state==='deleted')await admin.query('DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2',[scope.tenantId,pending.key])
    if(f.operation.action==='status')await admin.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[f.operation.employeeId])
    const before=await snapshot()
    await expect(f.recovery().execute(null,'4826',f.send)).rejects.toMatchObject({status:409,code:'STAFF_EMPLOYEE_RECEIPT_UNAVAILABLE'})
    expect(f.recovery().pending()).toEqual(pending);expect(await snapshot()).toEqual(before)
  })
  it.each([false,true])('binds create PIN and preserves the original credential and all facts, native=%s',async native=>{
    const req=await staffRequest(native,'create'),initial=await success(req,native)
    const before=await snapshot()
    const changed={...req,payload:{...(req.payload as object),pin:'7391'}}
    await denied(changed,409)
    await without('staff.access.configure',()=>denied(changed))
    expect(await success(req,native)).toEqual({...initial,replayed:true})
    const hash=(await admin.query('SELECT pin_hash FROM mbox.employees WHERE id=$1',[initial.employeeId])).rows[0].pin_hash
    const hasher=new ScryptCredentialHasher()
    expect(await hasher.verify('4826',hash)).toBe(true)
    expect(await hasher.verify('7391',hash)).toBe(false)
    expect(await snapshot()).toEqual(before)
    const stored=JSON.stringify(await receipt(req))
    expect(stored).not.toContain('"pin"')
    expect(stored).not.toContain('pin_hash')
    expect(stored).not.toContain('pinBinding')
  })
  it.each([false,true])('recovers the original creation after a later PIN reset without accepting the reset PIN, native=%s',async native=>{
    const req=await staffRequest(native,'create'),initial=await success(req,native)
    // Change only the local fixture credential: replay must use immutable request identity, not current PIN state.
    await admin.query('UPDATE mbox.employees SET pin_hash=$2 WHERE id=$1',[initial.employeeId,await new ScryptCredentialHasher().hash('7391')])
    const before=await snapshot()
    expect(await success(req,native)).toEqual({...initial,replayed:true})
    await denied({...req,payload:{...(req.payload as object),pin:'7391'}},409)
    expect(await snapshot()).toEqual(before)
  })
  it.each(['4826','7391'])('rejects unbound legacy receipts for PIN %s without changing their facts',async pin=>{
    const req=await staffRequest(false,'create');await success(req)
    const {employeeCode,displayName,roleId:createdRoleId,reason}=req.payload as Record<string,string>
    const legacy=hashRequestFingerprint(JSON.stringify({actorEmployeeId:employeeId,employeeCode,displayName,roleId:createdRoleId,reason,pinConfigured:true}))
    await admin.query('UPDATE mbox.idempotency_records SET request_sha256=$2 WHERE tenant_id=$1 AND idempotency_key=$3',[scope.tenantId,legacy,(req.headers as Record<string,string>)['idempotency-key']])
    const before=await snapshot()
    await denied({...req,payload:{...(req.payload as object),pin}},409)
    expect(await snapshot()).toEqual(before)
  })
  it.each([false,true].flatMap(native=>[false,true].map(changed=>({native,changed}))))('serializes concurrent create retries without a second account, native=$native changed=$changed',async({native,changed})=>{
    const req=await staffRequest(native,'create')
    const retry={...req,payload:{...(req.payload as object),pin:changed?'7391':'4826'}}
    const responses=await Promise.all([app.inject(req),app.inject(retry)])
    const successes=responses.filter(r=>[200,201].includes(r.statusCode))
    expect(successes).toHaveLength(changed?1:2)
    if(changed)expect(responses.some(r=>r.statusCode===409)).toBe(true)
    else expect(successes.map(r=>value(r,native).replayed).sort()).toEqual([false,true])
    const rows=(await admin.query('SELECT pin_hash FROM mbox.employees WHERE store_id=$1 AND employee_code=$2',[scope.storeId,(req.payload as Record<string,string>).employeeCode])).rows
    expect(rows).toHaveLength(1)
    const winner=responses.findIndex(r=>[200,201].includes(r.statusCode))
    expect(await new ScryptCredentialHasher().verify(changed&&winner===1?'7391':'4826',rows[0].pin_hash)).toBe(true)
    const before=await snapshot()
    await success(winner===0?req:retry,native)
    expect(await snapshot()).toEqual(before)
  })
  it.each([false,true].flatMap(native=>['create','status'].map(kind=>({native,kind}))))('authorizes $kind before old employee overview, native=$native',async({native,kind})=>{
    const req=await staffRequest(native,kind),initial=await success(req,native)
    const before=await snapshot()
    await without('staff.access.configure',async()=>{
      await denied(req)
      await denied({...req,headers:{...req.headers,'idempotency-key':`native-business-${randomUUID()}`}})
    })
    const restored=await success(req,native)
    expect({...restored,replayed:false}).toEqual({...initial,replayed:false})
    expect(await snapshot()).toEqual(before)
  })
  it.each([false,true].flatMap(native=>['create','status'].map(kind=>({native,kind}))))('protects actor/store and suspended actor for $kind, native=$native',async({native,kind})=>{
    const req=await staffRequest(native,kind);await success(req,native)
    const before=await snapshot()
    await denied({...req,headers:{...req.headers,'x-employee-id':otherEmployeeId}},409)
    await denied({...req,headers:{...req.headers,'x-other-store':'true'}},403)
    await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[employeeId])
    try{await denied(req)}finally{await admin.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[employeeId])}
    // Fixture status changes update timestamps, so compare command receipts and side effects separately.
    const after=await snapshot();delete before.employees;delete after.employees;expect(after).toEqual(before)
  })
  it.each([false,true])('does not nest identity lookup during recurring replay, native=%s',async native=>{
    resolveViaDatabase=true
    try{
      const f=await recurring(native),req=operation(native,'status',f);await success(req,native)
      await without('commercial.cost.manage',()=>denied(req))
      await success(req,native)
    }finally{resolveViaDatabase=false}
  })
  it('permission recovery with a missing receipt does not publish a fresh configuration',async()=>{
    const board=await app.inject({url:'/api/staff-access/overview'});expect(board.statusCode,board.body).toBe(200)
    const payload={expectedVersion:board.json().data.configurationVersion,reason:'Missing receipt recovery probe',changes:[{kind:'employee_override',employeeId:otherEmployeeId,permissionCode:'order.create',effect:'grant'}]}
    const req=request('/api/staff-access/deploy',payload),before=await snapshot()
    await denied({...req,payload:{...payload,receiptOnly:true}})
    expect(await snapshot()).toEqual(before)
    const current=await app.inject({url:'/api/staff-access/overview'})
    expect(current.json().data.configurationVersion).toBe(payload.expectedVersion)
    const result=await success(req);expect(result.changes).toMatchObject([{kind:'employee_override',targetId:otherEmployeeId,configurationCode:'order.create',applied:true}])
    const committed=await snapshot(),replay=await success({...req,payload:{...payload,receiptOnly:true}})
    expect(replay).toMatchObject({replayed:true,verifiedAt:result.verifiedAt,changes:result.changes})
    expect(await snapshot()).toEqual(committed)
  })
  it('keeps the original permission handoff receipt available with no management overview',async()=>{
    const board=await app.inject({url:'/api/staff-access/overview'});expect(board.statusCode,board.body).toBe(200)
    const req=request('/api/staff-access/deploy',{expectedVersion:board.json().data.configurationVersion,reason:'Audit handoff receipt',changes:[{kind:'employee_override',employeeId:otherEmployeeId,permissionCode:'order.create',effect:'grant'}]})
    await success(req)
    const before=await snapshot()
    await without('staff.access.configure',async()=>{
      const replay=await app.inject({...req,payload:{...(req.payload as object),receiptOnly:true}})
      expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toMatchObject({replayed:true,overview:null})
      await denied({...req,headers:{'idempotency-key':randomUUID()}})
    })
    expect(await snapshot()).toEqual(before)
  })
})
