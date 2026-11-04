import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {membershipConfigurationApiPlugin} from './membership-configuration-api.js'
import {MembershipConfigurationDraftService} from './membership-configuration-draft-service.js'
import {PostgresMembershipConfigurationDraftRepository} from './membership-configuration-draft-repository.js'
import {nativeMembershipConfigurationApiPlugin} from './native-membership-configuration-api.js'

import {normalizedNotificationApiPlugin} from './notification-api.js'
import {NotificationQueryService} from './notification-query-service.js'
import {LoyaltyOperationalControlService} from './loyalty-operational-control-service.js'
import {loyaltyOperationalControlApiPlugin} from './loyalty-operational-control-api.js'
import {NotificationRepository} from './notification-repository.js'

const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('notification configuration and operations authorization with restricted LOGIN',()=>{
 let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,transactions:Pick<ScopedPostgresTransactionRunner,'run'>,app:ReturnType<typeof Fastify>
 let scope:{tenantId:string;storeId:string},actor:string,approver:string,publisher:string,role:string
 let beforeExecute:(()=>Promise<void>)|undefined,beforeRun:(()=>Promise<void>)|undefined,runsUntilHook=0
 const permissions=['loyalty.operations.view','notification.view','notification.view_all','notification.retry','loyalty.policy.view','loyalty.policy.manage','loyalty.policy.approve','loyalty.policy.publish','loyalty.configuration.view','loyalty.configuration.edit','loyalty.configuration.preview','loyalty.configuration.approve']
 const grant=async(codes=permissions)=>{
  await admin.query('DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1 AND role_id=$2',[scope.tenantId,role])
  await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4::text[])',[scope.tenantId,scope.storeId,role,codes])
 }
 const snapshot=async()=>{
  const result:Record<string,unknown>={}
  for(const table of ['loyalty_operational_control_states','loyalty_operational_control_events','wechat_notification_policies','wechat_notification_policy_fields','notifications','membership_configuration_draft_contributors','membership_configuration_impact_fulfillment_facts','membership_configuration_impact_previews','membership_configuration_approval_facts','audit_events','outbox_messages','idempotency_records'])result[table]=(await admin.query(`SELECT to_jsonb(t) row FROM mbox.${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[scope.tenantId])).rows
  return result
 }
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!);runner=new ScopedPostgresTransactionRunner(runtime)
  transactions={run:async(s,work,settings)=>{if(runsUntilHook>0&&--runsUntilHook===0){const hook=beforeRun;beforeRun=undefined;await hook?.()}return runner.run(s,work,settings)}}
  const executor=new NormalizedCommandExecutor(transactions)
  const commands={execute:((...args:Parameters<NormalizedCommandExecutor['execute']>)=>{const hook=beforeExecute;beforeExecute=undefined;return (async()=>{await hook?.();return executor.execute(...args)})()}) as NormalizedCommandExecutor['execute']}
  const resolveContext=(request:{headers:Record<string,unknown>})=>({scope,employeeId:String(request.headers['x-test-employee']??actor),businessDate:'2026-11-03'})
  app=Fastify()
  await app.register(membershipConfigurationApiPlugin,{transactions,commands,resolveStaffContext:resolveContext})
  await app.register(nativeMembershipConfigurationApiPlugin,{transactions,resolveContext})
  await app.register(normalizedNotificationApiPlugin,{commandExecutor:commands,notificationQuery:new NotificationQueryService(transactions),resolveContext:request=>({...resolveContext(request),capabilities:permissions}),createNotificationRepository:tx=>new NotificationRepository(tx)})
  await app.register(loyaltyOperationalControlApiPlugin,{transactions,service:new LoyaltyOperationalControlService(transactions,commands),resolveStaffContext:resolveContext})
  await app.ready()
 })
 beforeEach(async()=>{
  beforeExecute=undefined;beforeRun=undefined;runsUntilHook=0;scope={tenantId:randomUUID(),storeId:randomUUID()};actor=randomUUID();approver=randomUUID();publisher=randomUUID();role=randomUUID()
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Notification audit')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Notification audit')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'AUDITOR','Audit')",[role,scope.tenantId,scope.storeId])
  for(const id of [actor,approver,publisher]){
   await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,$1::text)',[id,scope.tenantId,scope.storeId])
   await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,id,role])
  }
  for(const code of permissions)await admin.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,code])
  await grant()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 const send=(url:string,body:object,key=randomUUID(),employee=actor,method:'POST'|'PUT'='POST')=>app.inject({method,url,headers:{'idempotency-key':key,'x-test-employee':employee},payload:body})
 const content={domain:'wechat_notifications' as const,notificationType:'loyalty_points_credited' as const,authorizationPurpose:'loyalty_balance_change',authorizationContext:'loyalty_accrual',templateId:'test-template-credited',pagePath:'pages/points/index',pointsDataKey:'points_value',balanceDataKey:'balance_value',occurredAtDataKey:'occurred_at',expiresAtDataKey:null,expiryLeadDays:null,maxPerCustomerPer24h:2,minimumIntervalMinutes:30,quietHoursStart:'22:00:00',quietHoursEnd:'08:00:00'}
 const base='/staff/loyalty/configuration-center/wechat_notifications'
 const native='/staff/native-membership-config/commands'
 const create=async()=>{const r=await send(base,{content,reason:'隔离通知草稿'});expect(r.statusCode,r.body).toBe(200);return r.json().data.publicId as string}
 const approved=async()=>{
  const id=await create(),service=new MembershipConfigurationDraftService(new PostgresMembershipConfigurationDraftRepository(transactions,scope))
  const draft=await service.get('wechat_notifications',id),preview=await service.preview('wechat_notifications',id,approver)
  await service.approve({domain:'wechat_notifications',publicId:id,expectedRevision:draft.revision,approverEmployeeId:approver,reason:'隔离独立审批',impactPreviewPublicId:preview.publicId})
  return {id,body:{expectedRevision:draft.revision,effectiveFrom:'2090-01-01T00:00:00Z',effectiveUntil:null,reason:'隔离第三人发布'}}
 }
 const revoke=(permission:string)=>grant(permissions.filter(p=>p!==permission))
 const suspend=async(employee:string)=>{await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[employee])}
 it.each(['all','edit-only','suspended'])('web draft rejects %s revocation before any write',async mode=>{
  const before=await snapshot();runsUntilHook=2;beforeRun=()=>mode==='suspended'?suspend(actor):mode==='all'?grant([]):revoke('loyalty.configuration.edit')
  const r=await send(base,{content,reason:'隔离不可创建'})
  // Also inspect effects: an error response alone does not prove rollback.
  expect(await snapshot()).toEqual(before);expect(r.statusCode,r.body).toBe(403)
 })
 it('web draft accepts edit-only authority without requiring policy management or view',async()=>{
  await grant(['loyalty.configuration.edit']);const id=await create();expect(id).toBeTruthy()
 })
 it.each(['fresh','receipt'])('web publication %s rechecks permission before receipt lookup',async mode=>{
  const f=await approved(),url=`${base}/${f.id}/publish`,key=randomUUID(),first=mode==='receipt'?await send(url,f.body,key,publisher):null
  if(first)expect(first.statusCode,first.body).toBe(200)
  const before=await snapshot();beforeExecute=()=>revoke('loyalty.policy.publish')
  const denied=await send(url,f.body,key,publisher);expect(denied.statusCode,denied.body).toBe(403);expect(await snapshot()).toEqual(before)
  await grant();const recovered=await send(url,f.body,key,publisher);expect(recovered.statusCode,recovered.body).toBe(200)
  if(first){expect(recovered.json().data).toEqual(first.json().data);expect(await snapshot()).toEqual(before)}
 })
 it('web publication receipt rejects suspension and preserves actor, payload and target binding',async()=>{
  const f=await approved(),url=`${base}/${f.id}/publish`,key=randomUUID(),first=await send(url,f.body,key,publisher);expect(first.statusCode,first.body).toBe(200)
  const before=await snapshot()
  expect((await send(url,f.body,key,approver)).statusCode).toBe(409)
  expect((await send(url,{...f.body,reason:'更改原请求'},key,publisher)).statusCode).toBe(409)
  expect((await send(`${base}/${randomUUID()}/publish`,f.body,key,publisher)).statusCode).toBe(409)
  beforeExecute=()=>suspend(publisher);expect((await send(url,f.body,key,publisher)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
 })
 it('web publication recovers committed receipt after policy retirement without republishing it',async()=>{
  const f=await approved(),url=`${base}/${f.id}/publish`,key=randomUUID(),first=await send(url,f.body,key,publisher);expect(first.statusCode,first.body).toBe(200)
  await admin.query("UPDATE mbox.wechat_notification_policies SET status='retired' WHERE id=$1",[f.id]);const before=await snapshot()
  const replay=await send(url,f.body,key,publisher);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data)
  expect((await send(url,f.body,randomUUID(),publisher)).statusCode).toBe(409);expect(await snapshot()).toEqual(before)
 })
 it.each(['list','detail'])('native configuration %s rechecks current read authority',async mode=>{
  const id=await create(),url=mode==='list'?'/staff/native-membership-config':`/staff/native-membership-config/wechat_notifications/${id}`
  const before=await snapshot();runsUntilHook=2;beforeRun=()=>revoke('loyalty.configuration.view')
  const denied=await app.inject(url);expect(denied.statusCode,denied.body).toBe(403);expect(await snapshot()).toEqual(before)
  await grant();expect((await app.inject(url)).statusCode).toBe(200);expect(await snapshot()).toEqual(before)
 })
 it.each(['/staff/native-membership-config?section=controls','/staff/loyalty/operational-controls'])('control state read %s rejects in-flight revocation',async url=>{
  const initial=await app.inject(url);expect(initial.statusCode,initial.body).toBe(200);const before=await snapshot()
  runsUntilHook=2;beforeRun=()=>revoke('loyalty.operations.view')
  const denied=await app.inject(url);expect(denied.statusCode,denied.body).toBe(403);expect(await snapshot()).toEqual(before)
  await grant();const recovered=await app.inject(url);expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json()).toEqual(initial.json());expect(await snapshot()).toEqual(before)
 })
 for(const action of ['create','publish'] as const)it.each(['fresh','receipt'])(`native notification ${action} %s already enforces current permission`,async mode=>{
  const f=action==='publish'?await approved():null,input=f?{action:'publish',domain:'wechat_notifications',configurationId:f.id,...f.body}:{action:'create',content,reason:'隔离原生通知草稿'},employee=f?publisher:actor,key=`native-business-${randomUUID()}`
  const first=mode==='receipt'?await send(native,input,key,employee):null;if(first)expect(first.statusCode,first.body).toBe(200)
  const before=await snapshot();runsUntilHook=2;beforeRun=()=>revoke(action==='create'?'loyalty.policy.manage':'loyalty.policy.publish')
  const denied=await send(native,input,key,employee);expect(denied.statusCode,denied.body).toBe(403);expect(await snapshot()).toEqual(before)
  await grant();const recovered=await send(native,input,key,employee);expect(recovered.statusCode,recovered.body).toBe(200)
  if(first){expect(recovered.json().data).toEqual(first.json().data);expect(await snapshot()).toEqual(before)}
  if(action==='create')expect(recovered.json().data.configurationId).toBe(recovered.json().data.result.publicId)
 })
 for(const action of ['edit','preview','approve'] as const)it.each(['fresh','receipt'])(`native notification ${action} %s preserves the existing guard`,async mode=>{
  const id=await create(),service=new MembershipConfigurationDraftService(new PostgresMembershipConfigurationDraftRepository(transactions,scope))
  const draft=await service.get('wechat_notifications',id),preview=action==='approve'?await service.preview('wechat_notifications',id,approver):null
  const target={domain:'wechat_notifications',configurationId:id,expectedRevision:draft.revision}
  const input=action==='edit'?{action,...target,content:{...content,maxPerCustomerPer24h:3},reason:'隔离编辑通知'}:action==='approve'?{action,...target,impactPreviewPublicId:preview!.publicId,reason:'隔离审批通知'}:{action,...target}
  const key=`native-business-${randomUUID()}`,first=mode==='receipt'?await send(native,input,key,approver):null;if(first)expect(first.statusCode,first.body).toBe(200)
  const before=await snapshot();runsUntilHook=2;beforeRun=()=>revoke(`loyalty.configuration.${action}`)
  const denied=await send(native,input,key,approver);expect(denied.statusCode,denied.body).toBe(403);expect(await snapshot()).toEqual(before)
  await grant();const recovered=await send(native,input,key,approver);expect(recovered.statusCode,recovered.body).toBe(200)
  if(first){expect(recovered.json().data).toEqual(first.json().data);expect(await snapshot()).toEqual(before)}
 })
 it('native create returns an auditable target and recovers its receipt after editing without creating a new draft',async()=>{
  const input={action:'create',content,reason:'隔离持久回执'},key=`native-business-${randomUUID()}`,first=await send(native,input,key)
  expect(first.statusCode,first.body).toBe(200);const data=first.json().data,id=data.result.publicId as string;expect(data.configurationId).toBe(id)
  const audit=(await admin.query("SELECT object_id FROM mbox.audit_events WHERE tenant_id=$1 AND action='membership.configuration.native.create'",[scope.tenantId])).rows
  expect(audit).toEqual([{object_id:id}])
  const service=new MembershipConfigurationDraftService(new PostgresMembershipConfigurationDraftRepository(transactions,scope))
  await service.edit({domain:'wechat_notifications',publicId:id,expectedRevision:1,employeeId:actor,reason:'隔离后续修改',content:{...content,maxPerCustomerPer24h:3}})
  const before=await snapshot(),replay=await send(native,input,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(data)
  expect((await send(native,input,key,approver)).statusCode).toBe(409)
  expect((await send(native,{...input,content:{...content,maxPerCustomerPer24h:4}},key)).statusCode).toBe(409);expect(await snapshot()).toEqual(before)
 })
 const notification=async(employee=actor)=>{
  const n=await runner.run(scope,tx=>new NotificationRepository(tx).create({businessKey:`audit:${randomUUID()}`,channel:'in_app',recipient:{type:'employee',id:employee},templateCode:'audit.test',payload:{fixture:'synthetic'}}))
  await admin.query("UPDATE mbox.notifications SET status='sending' WHERE id=$1",[n.id])
  await admin.query("UPDATE mbox.notifications SET status='failed',last_error='synthetic_failure',available_at='2090-01-01' WHERE id=$1",[n.id]);return n.id
 }
 it.each(['fresh','receipt'])('operational retry %s rejects revoked authority despite cached capabilities',async mode=>{
  const id=await notification(),url=`/notifications/${id}/retry`,body={reason:'隔离人工重试'},key=randomUUID(),first=mode==='receipt'?await send(url,body,key):null
  if(first)expect(first.statusCode,first.body).toBe(200)
  const before=await snapshot();beforeExecute=()=>revoke('notification.retry')
  const r=await send(url,body,key);expect(r.statusCode,r.body).toBe(403);expect(await snapshot()).toEqual(before)
  await grant();const recovered=await send(url,body,key);expect(recovered.statusCode,recovered.body).toBe(200)
  if(first){expect(recovered.json().data).toEqual(first.json().data);expect(await snapshot()).toEqual(before)}
 })
 it.each(['fresh','receipt'])('operational retry %s rejects a suspended operator',async mode=>{
  const id=await notification(),url=`/notifications/${id}/retry`,body={reason:'隔离人工重试'},key=randomUUID()
  if(mode==='receipt')expect((await send(url,body,key)).statusCode).toBe(200)
  const before=await snapshot();beforeExecute=()=>suspend(actor);expect((await send(url,body,key)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
 })
 it('operational receipt stays bound to actor, target and reason and recovers after delivery',async()=>{
  const id=await notification(),url=`/notifications/${id}/retry`,body={reason:'隔离人工重试'},key=randomUUID(),first=await send(url,body,key);expect(first.statusCode,first.body).toBe(200)
  await admin.query("UPDATE mbox.notifications SET status='sending' WHERE id=$1",[id])
  await admin.query("UPDATE mbox.notifications SET status='delivered',delivered_at=clock_timestamp() WHERE id=$1",[id]);const before=await snapshot()
  expect((await send(url,body,key,approver)).statusCode).toBe(409);expect((await send(url,{reason:'另一个重试原因'},key)).statusCode).toBe(409)
  expect((await send(`/notifications/${randomUUID()}/retry`,body,key)).statusCode).toBe(409)
  const replay=await send(url,body,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data)
  expect((await send(url,body,randomUUID())).statusCode).toBe(409);expect(await snapshot()).toEqual(before)
 })
 it('operational list rejects revoked view permission despite cached capabilities',async()=>{
  await notification();const before=await snapshot();runsUntilHook=1;beforeRun=()=>revoke('notification.view')
  const r=await app.inject('/notifications');expect(r.statusCode,r.body).toBe(403);expect(await snapshot()).toEqual(before)
 })
 it('operational list recomputes self-only scope after view-all revocation',async()=>{
  const own=await notification(),other=await notification(approver);await revoke('notification.view_all');const before=await snapshot()
  const r=await app.inject('/notifications');expect(r.statusCode,r.body).toBe(200);expect(r.json().data.map((n:{id:string})=>n.id)).toEqual([own]);expect(r.body).not.toContain(other)
  expect((await app.inject(`/notifications?recipientType=employee&recipientId=${approver}`)).statusCode).toBe(403)
  expect((await app.inject(`/notifications?recipientType=employee&recipientId=${actor}`)).statusCode).toBe(200);expect(await snapshot()).toEqual(before)
  await grant();const all=await app.inject('/notifications');expect(all.statusCode,all.body).toBe(200);expect(all.json().data).toHaveLength(2)
 })
})
