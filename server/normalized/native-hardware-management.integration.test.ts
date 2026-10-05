import { randomUUID } from 'node:crypto'
import Fastify, {type FastifyInstance} from 'fastify'
import { Pool } from 'pg'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {printBridgeApiPlugin} from './print-bridge-api.js'
import {registerNativeHardware} from './native-hardware-management.js'
import {HardwareRepository} from './hardware-repository.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(databaseUrl&&runtimeUrl?describe:describe.skip)('native printer configuration with restricted PostgreSQL login',()=>{
  let admin:Pool,runtime:Pool,app:FastifyInstance,runner:ScopedPostgresTransactionRunner
  const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID(),scope={tenantId,storeId}
  let capabilities=['printer.manage']
  const device={code:'native-printer',name:'原生收银打印机',stationCode:'cashier',status:'active',printBridgeId:null,windowsQueueName:null,printProfile:null}
  const send=(body:unknown,key=`native-business-${randomUUID()}`)=>app.inject({method:'POST',url:'/hardware/native-management/commands',headers:{'idempotency-key':key},payload:body as object})
  const read=async()=>{const result=await app.inject({method:'GET',url:'/hardware/native-management'});expect(result.statusCode,result.body).toBe(200);return result.json().data}
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    admin=new Pool({connectionString:databaseUrl});runtime=new Pool({connectionString:runtimeUrl})
    await assertRuntimeDatabasePool(runtime,runtimeUrl!)
    runner=new ScopedPostgresTransactionRunner(runtime)
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Native devices')",[tenantId,tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Native devices')",[storeId,tenantId,storeId])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'NATIVE','设备管理员')",[employeeId,tenantId,storeId])
    app=Fastify()
    await registerNativeHardware(app,{transactions:runner,commands:new NormalizedCommandExecutor(runner),
      resolveContext:()=>({scope,employeeId,businessDate:'2026-09-30',capabilities})})
    await app.register(printBridgeApiPlugin,{scope,transactions:runner,commands:new NormalizedCommandExecutor(runner),hashSecret:'isolated-native-bridge-test-secret-not-production',requireHttps:false,
      resolveStaffContext:()=>({scope,employeeId,businessDate:'2026-09-30',capabilities})})
    await app.ready()
  })
  afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
  it('creates once, guards edits, ignores heartbeat changes and rechecks replay authority',async()=>{
    const key=`native-business-${randomUUID()}`,body={kind:'device-create',device,reason:'新增收银打印机'}
    const first=await send(body,key);expect(first.statusCode,first.body).toBe(200)
    const id=first.json().data.row.id
    expect((await send(body,key)).json()).toMatchObject({data:first.json().data,meta:{replayed:true}})
    const before=(await read()).devices.find((d:{id:string})=>d.id===id)
    await runner.run(scope,tx=>new HardwareRepository(tx).recordConnectivity(id,'online'))
    const update={kind:'device-update',id,expected:before.configurationFingerprint,device:{...device,name:'收银新名称'},reason:'调整设备名称'}
    const changed=await send(update);expect(changed.statusCode,changed.body).toBe(200)
    const stale=await send({...update,device:{...device,name:'覆盖新名称'}})
    expect(stale.statusCode).toBe(409);expect(stale.json().error.code).toBe('NATIVE_BUSINESS_NOT_COMMITTED')
    expect((await read()).devices[0].name).toBe('收银新名称')
    capabilities=[]
    expect((await send(body,key)).statusCode).toBe(403)
    expect((await app.inject({method:'GET',url:'/hardware/native-management'})).statusCode).toBe(403)
    capabilities=['printer.manage']
    expect((await send(body,key)).json().meta.replayed).toBe(true)
  })
  it('guards route creation and changes without overwriting an existing route',async()=>{
    const printer=(await read()).devices[0]
    const route={code:'native-route',name:'收银路由',stationCode:'cashier',productCategoryCode:null,printerDeviceId:printer.id,copies:1,priority:100,status:'active'}
    const key=`native-business-${randomUUID()}`,body={kind:'route-save',route,expected:null,reason:'新建收银路由'}
    const created=await send(body,key);expect(created.statusCode,created.body).toBe(200)
    expect((await send(body,key)).json().meta.replayed).toBe(true)
    expect((await send({...body,route:{...route,name:'不应覆盖'}})).statusCode).toBe(409)
    await expect(runner.run(scope,tx=>new HardwareRepository(tx).upsertPrinterRoute({...route,stationCode:'cashier',status:'active',name:'并发新建不应覆盖',createOnly:true}))).rejects.toThrow('刚被创建')
    const old=(await read()).routes[0]
    const changed=await send({...body,expected:old.configurationFingerprint,route:{...route,copies:2}})
    expect(changed.statusCode,changed.body).toBe(200)
    expect((await read()).routes[0]).toMatchObject({name:'收银路由',copies:2})
  })
  it('changes independent ticket policies and queues exactly one device test',async()=>{
    let board=await read()
    const policy=board.policies.find((p:{ticketKind:string})=>p.ticketKind==='cashier_payment')
    const payload={kind:'policy-save',expected:policy.configurationFingerprint,policy:{ticketKind:'cashier_payment',enabled:false,copies:2},reason:'调整支付凭证打印'}
    const changed=await send(payload);expect(changed.statusCode,changed.body).toBe(200)
    expect((await send({...payload,policy:{...payload.policy,enabled:true}})).statusCode).toBe(409)
    board=await read()
    expect(board.policies.find((p:{ticketKind:string})=>p.ticketKind==='cashier_payment')).toMatchObject({enabled:false,copies:2})
    expect(board.policies.find((p:{ticketKind:string})=>p.ticketKind==='cashier_refund')).toMatchObject({enabled:true,copies:null})
    for(const enabled of [false,true]) {
      const current=(await read()).policies.find((p:{ticketKind:string})=>p.ticketKind==='cashier_payment')
      const inherited=await send({kind:'policy-save',expected:current.configurationFingerprint,
        policy:{ticketKind:'cashier_payment',enabled,copies:null},reason:'恢复路由份数'})
      expect(inherited.statusCode,inherited.body).toBe(200)
      expect((await read()).policies.find((p:{ticketKind:string})=>p.ticketKind==='cashier_payment')).toMatchObject({enabled,copies:null})
    }
    const printer=board.devices[0],key=`native-business-${randomUUID()}`
    const command={kind:'device-test',id:printer.id,expected:printer.configurationFingerprint,command:'ping',reason:'核对打印机连接'}
    const queued=await send(command,key);expect(queued.statusCode,queued.body).toBe(200)
    expect(queued.json().data.row.status).toBe('requested')
    expect((await send(command,key)).json().meta.replayed).toBe(true)
    expect((await read()).commands).toHaveLength(1)
    for(const body of [{...command,command:'open_cash_drawer'},{...payload,policy:{...payload.policy,copies:6}},{...command,employeeId:randomUUID()}])expect((await send(body)).statusCode).toBe(400)
  })
  it('pairs a test bridge, binds a verified queue and revokes it once with durable replay',async()=>{
    const pairing=await app.inject({method:'POST',url:'/hardware/print-bridges/pairing-code',payload:{reason:'隔离测试打印桥配对',ttlSeconds:600}})
    expect(pairing.statusCode).toBe(201)
    const code=pairing.json().data.pairingCode
    const paired=await app.inject({method:'POST',url:'/print-bridge/pair',payload:{pairingCode:code,name:'测试桥接器',hostname:'test-print-host',softwareVersion:'1.0.0'}})
    expect(paired.statusCode).toBe(201)
    const identity=paired.json().data
    const headers={'x-mbox-print-bridge-id':identity.publicId,authorization:`Bearer ${identity.credential}`}
    expect((await app.inject({method:'POST',url:'/print-bridge/heartbeat',headers,payload:{hostname:'test-print-host',softwareVersion:'1.0.0',queues:['TEST_QUEUE']}})).statusCode).toBe(200)
    const printer=(await read()).devices[0]
    const updated=await send({kind:'device-update',id:printer.id,expected:printer.configurationFingerprint,
      device:{...device,name:printer.name,printBridgeId:identity.bridgeId,windowsQueueName:'TEST_QUEUE',printProfile:'escpos_80'},reason:'绑定核对过的打印队列'})
    expect(updated.statusCode,updated.body).toBe(200)
    const key=`native-business-${randomUUID()}`,payload={kind:'bridge-revoke',id:identity.bridgeId,reason:'现场已确认更换打印电脑'}
    const revoke=()=>app.inject({method:'POST',url:`/hardware/native-print-bridges/${identity.bridgeId}/revoke`,headers:{'idempotency-key':key},payload})
    const first=await revoke();expect(first.statusCode,first.body).toBe(200)
    expect((await revoke()).json()).toMatchObject({data:first.json().data,meta:{replayed:true}})
    expect((await app.inject({method:'POST',url:'/print-bridge/work/claim',headers,payload:{limit:5}})).statusCode).toBe(401)
    capabilities=[];expect((await revoke()).statusCode).toBe(403);capabilities=['printer.manage']
    const audits=await admin.query("SELECT count(*)::int AS count FROM mbox.audit_events WHERE object_id=$1 AND action='print.bridge.revoked'",[identity.bridgeId])
    expect(audits.rows[0].count).toBe(1)
  })

})
