import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { StaffAuthCommandService } from './staff-auth-command-service.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import { readOverview } from './staff-access-management-service.js'
import { grantFixtureStaffPermissions } from './staff-permission.test-helper.js'
import { channelDistributionApiPlugin } from './channel-distribution-api.js'
import { channelPermissionPresentation } from '../../src/shared/channel-permissions.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL, runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=databaseUrl&&runtimeUrl?describe:describe.skip
const profiles = [
 {code:'ADMIN_ONLY',permissions:['staff.access.configure'],read:false,settle:false},
 {code:'READER',permissions:['channel.view'],read:true,settle:false},
 {code:'MARKETER',permissions:['channel.view','channel.manage'],read:true,settle:false},
 {code:'CORRECTOR',permissions:['channel.view','channel.correct'],read:true,settle:false},
 {code:'FINANCE',permissions:['channel.view','channel.settle'],read:true,settle:true},
 {code:'SERVICE',permissions:['channel.activate','dashboard.view'],read:false,settle:false},
 {code:'MEMBER_ONLY',permissions:['loyalty.operations.view'],read:false,settle:false},
 {code:'MANAGE_ONLY',permissions:['channel.manage'],read:false,settle:false},
 {code:'PERSONAL_GRANT',permissions:[],read:true,settle:false},
 {code:'PERSONAL_DENY',permissions:['channel.view','channel.manage'],read:false,settle:false},
]
integration('cooperation account permissions and migration',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},adminId=randomUUID(),businessDate=new Date().toISOString().slice(0,10)
 let pool:Pool,runtime:Pool,tx:ScopedPostgresTransactionRunner,auth:StaffAuthCommandService,app:FastifyInstance,device:string
 const accounts=new Map<string,{id:string;token:string}>()
 const metadata=()=>({scope,actorEmployeeId:adminId,businessDate,idempotencyKey:`access-${randomUUID()}`,requestFingerprint:randomUUID(),reason:'隔离周边店合作权限回归'})
 beforeAll(async()=>{
  pool=new Pool({connectionString:databaseUrl,max:4});runtime=new Pool({connectionString:runtimeUrl,max:4});tx=new ScopedPostgresTransactionRunner(runtime as unknown as PostgresPool)
  await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'权限测试租户')",[scope.tenantId])
  await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'权限测试门店')",[scope.storeId,scope.tenantId])
  await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'FIXTURE_ADMIN','测试配置员')",[adminId,scope.tenantId,scope.storeId])
  await grantFixtureStaffPermissions(pool,scope,[adminId],['staff.access.configure'])
  const commands=new NormalizedCommandExecutor(tx);auth=new StaffAuthCommandService(tx,commands,{consume:async()=>{}})
  await auth.configureDailyStoreCredential({...metadata(),credential:'local-access-audit-only',validFrom:new Date(Date.now()-3600000).toISOString(),validUntil:new Date(Date.now()+3600000).toISOString()})
  device=(await auth.verifyDailyStoreCredential({scope,businessDate,credential:'local-access-audit-only',deviceKey:'isolated-channel-access-device'})).leaseToken
  for(const profile of profiles){
   const id=randomUUID();await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,scope.tenantId,scope.storeId,profile.code])
   await grantFixtureStaffPermissions(pool,scope,[id],profile.permissions)
   await auth.setEmployeePin({...metadata(),employeeId:id,pin:'6729'})
   if(profile.code==='PERSONAL_GRANT'||profile.code==='PERSONAL_DENY')await tx.run(scope,t=>new StaffAccessRepository(t).setEmployeePermissionOverride({employeeId:id,permissionCode:'channel.view',effect:profile.code==='PERSONAL_GRANT'?'grant':'deny',reason:'测试个人例外',configuredByEmployeeId:adminId}))
   const login=await auth.login({scope,deviceAccessToken:device,employeeCode:profile.code,pin:'6729'});accounts.set(profile.code,{id,token:login.sessionToken})
  }
  app=Fastify();await app.register(channelDistributionApiPlugin,{transactions:tx,commands,prefix:'/api',resolveStaffContext:async request=>{
   const session=await auth.authenticateSession(scope,String(request.headers.authorization??''));return {scope,employeeId:session.session.employeeId,businessDate}
  },resolveSelfContext:()=>{throw Error('No customer fixture')},resolveGuestContext:()=>{throw Error('No guest fixture')}});await app.ready()
 },30000)
 afterAll(async()=>{await app?.close();await runtime?.end();await pool?.end()})
 for(const profile of profiles)it(`logs in ${profile.code}, enforces directory and finance access with matching navigation`,async()=>{
  const account=accounts.get(profile.code)!,session=await auth.authenticateSession(scope,account.token)
  expect(session.access.navigation.some(n=>n.code==='channel-partners')).toBe(profile.read)
  if(profile.read)expect(session.access.navigation.find(n=>n.code==='channel-partners')).toMatchObject({label:'周边店合作',route:'/staff/channel-partners'})
  const directory=await app.inject({url:'/api/staff/channel/directory',headers:{authorization:account.token}})
  expect(directory.statusCode,directory.body).toBe(profile.read?200:403)
  const finance=await app.inject({url:'/api/staff/channel/finance',headers:{authorization:account.token}})
  expect(finance.statusCode,finance.body).toBe(profile.settle?200:403)
 })
 it('includes all five discoverable permissions and the menu configuration without auto-authorizing staff',async()=>{
  const overview=await tx.run(scope,t=>readOverview(t),{readOnly:true})
  expect((await pool.query("SELECT has_function_privilege('mbox_runtime','mbox.seed_channel_staff_definitions(uuid,uuid)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
  expect(overview.permissions.filter(p=>p.code.startsWith('channel.'))).toHaveLength(5)
  for(const [code,p] of Object.entries(channelPermissionPresentation))expect(overview.permissions.find(p=>p.code===code)).toMatchObject({name:p.name,category:'channel',description:p.description})
  expect(overview.configurationDefinitions.find(d=>d.code==='channel-partners')).toMatchObject({label:'周边店合作',requiredPermissionCodes:['channel.view'],config:{route:'/staff/channel-partners'}})
  expect((await auth.authenticateSession(scope,accounts.get('ADMIN_ONLY')!.token)).access.permissions).not.toContain('channel.view')
 })
 it('rejects read-only writes, permits a marketer, and immediately removes access after denial in the same session',async()=>{
  const send=(token:string)=>app.inject({method:'POST',url:'/api/staff/channel/partner',headers:{authorization:token,'idempotency-key':`channel-${randomUUID()}`},payload:{name:'测试合作店',settlementSubject:'测试主体',promoterName:'测试店长',reason:'仅隔离回归'}})
  expect((await send(accounts.get('READER')!.token)).statusCode).toBe(403)
  const marketer=accounts.get('MARKETER')!;const created=await send(marketer.token);expect(created.statusCode,created.body).toBe(200)
  for(const permissionCode of ['channel.view','channel.manage'])await tx.run(scope,t=>new StaffAccessRepository(t).setEmployeePermissionOverride({employeeId:marketer.id,permissionCode,effect:'deny',reason:'回归撤权即时生效',configuredByEmployeeId:adminId}))
  const next=await auth.heartbeat(scope,marketer.token);expect(next.access.navigation.some(n=>n.code==='channel-partners')).toBe(false)
  expect((await app.inject({url:'/api/staff/channel/directory',headers:{authorization:marketer.token}})).statusCode).toBe(403)
  expect((await send(marketer.token)).statusCode).toBe(403)
 })
 it('repairs old or missing catalog entries without reviving disabled permissions or changing grants and denies',async()=>{
  const otherStore=randomUUID();await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'迁移修复测试')",[otherStore,scope.tenantId])
  await pool.query("DELETE FROM mbox.staff_permission_definitions WHERE store_id=$1 AND code='channel.settle'",[otherStore])
  await pool.query("UPDATE mbox.staff_permission_definitions SET name='旧渠道名称',category='marketing',status='inactive' WHERE store_id=$1 AND code='channel.view'",[otherStore])
  const before=(await pool.query('SELECT role_id,permission_id FROM mbox.role_permission_assignments WHERE tenant_id=$1 ORDER BY role_id,permission_id',[scope.tenantId])).rows
  await pool.query('SELECT mbox.seed_channel_staff_definitions($1,$2)',[scope.tenantId,otherStore]);await pool.query('SELECT mbox.seed_channel_staff_definitions($1,$2)',[scope.tenantId,scope.storeId])
  const defs=(await pool.query("SELECT code,name,status FROM mbox.staff_permission_definitions WHERE store_id=$1 AND code LIKE 'channel.%'",[otherStore])).rows
  expect(defs).toHaveLength(5);expect(defs.find(d=>d.code==='channel.view')).toMatchObject({name:'查看周边店合作',status:'inactive'})
  expect((await pool.query('SELECT role_id,permission_id FROM mbox.role_permission_assignments WHERE tenant_id=$1 ORDER BY role_id,permission_id',[scope.tenantId])).rows).toEqual(before)
  expect((await auth.authenticateSession(scope,accounts.get('PERSONAL_DENY')!.token)).access.deniedPermissions).toContain('channel.view')
 })
})
