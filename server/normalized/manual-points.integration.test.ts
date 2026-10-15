import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {registerManualPointsRoutes} from './manual-points-api.js'
import {ManualPointsService} from './manual-points-service.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {LoyaltyOperationalControlService} from './loyalty-operational-control-service.js'
const adminUrl=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=adminUrl&&runtimeUrl?describe:describe.skip
const id={tenant:randomUUID(),store:randomUUID(),requester:randomUUID(),reviewer:randomUUID(),third:randomUUID(),role:randomUUID(),policy:randomUUID()}
const scope={tenantId:id.tenant,storeId:id.store}
integration('manual points independent review with real restricted PostgreSQL LOGIN',()=>{
 let pool:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,service:ManualPointsService,actor=id.requester
 const app=Fastify(),ctx=(employeeId=actor)=>({scope,employeeId,actorRef:`employee:${employeeId}`,businessDate:'2026-10-15'})
 beforeAll(async()=>{
  await runNormalizedMigrations(adminUrl!);pool=new Pool({connectionString:adminUrl});runtime=new Pool({connectionString:runtimeUrl});runner=new ScopedPostgresTransactionRunner(runtime);service=new ManualPointsService(runner)
  expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
  await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Manual points test')",[id.tenant,'manual-'+id.tenant])
  await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'manual-store','Manual points store')",[id.store,id.tenant])
  for(const e of [id.requester,id.reviewer,id.third])await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES($1,$2,$3,$4,'Synthetic reviewer','active')",[e,id.tenant,id.store,e])
  await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'MANUAL_TEST','Review')",[id.role,id.tenant,id.store])
  for(const e of [id.requester,id.reviewer,id.third])await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')",[id.tenant,id.store,e,id.role])
  for(const code of ['loyalty.adjust.manual','loyalty.accrual.approve']){
   const p=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'finance') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[id.tenant,id.store,code])).rows[0].id
   await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[id.tenant,id.store,id.role,p])
  }
  await pool.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'loyalty.adjust.manual',10000,'CNY')",[id.tenant,id.store,id.role])
  await pool.query(`INSERT INTO mbox.loyalty_policy_versions(id,tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason) VALUES($1,$2,$3,'BASE',1,'published',1,1000,1,100,'floor',18,'2026-08-01',$4,$5,'2026-08-01',$6,'2026-08-02','separated','人工积分审核测试规则')`,[id.policy,id.tenant,id.store,id.requester,id.reviewer,id.third])
  await app.register(async a=>registerManualPointsRoutes(a,{transactions:runner,resolveStaffContext:()=>ctx()}),{prefix:'/api'});await app.ready()
 })
 afterAll(async()=>{await app.close();await runtime?.end();await pool?.end()})
 const post=(kind:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/staff/loyalty/manual-points/'+kind,headers:{'idempotency-key':key},payload})
 async function member(debt=0){const customer=randomUUID(),membership=randomUUID(),account=randomUUID(),memberNo='MBX'+membership.replaceAll('-','').slice(0,16).toUpperCase()
  await pool.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1,$2,$3,$4,'active')",[customer,id.tenant,id.store,customer])
  await pool.query("INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status) VALUES($1,$2,$3,$4,$5,'member','active')",[membership,id.tenant,id.store,customer,memberNo])
  await pool.query('INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id,pending_recovery_points) VALUES($1,$2,$3,$4,$5,$6)',[account,id.tenant,id.store,membership,customer,debt]);return {customer,membership,account,memberNo}
 }
 async function request(memberNo:string,pointsDelta=10){actor=id.requester;const body={memberNo,pointsDelta,reason:'经核对的人工补发依据'},response=await post('requests',body);expect(response.statusCode).toBe(200);return response.json().data.requestId as string}
 const decision=(requestId:string,decision:'approve'|'reject'='approve')=>({requestId,decision,reason:'复核原会员与补发依据'})
 it('does not credit before review; rejects self-review; commits one ledger under concurrent approvals and retains permanent replay',async()=>{
  const m=await member(),requestId=await request(m.memberNo)
  expect((await pool.query('SELECT available_points FROM mbox.loyalty_accounts WHERE id=$1',[m.account])).rows[0].available_points).toBe(0)
  const self=await post('decisions',decision(requestId));expect(self.statusCode).toBe(409);expect(self.json().error.code).toBe('MANUAL_POINTS_SELF_APPROVAL')
  const key=randomUUID(),input=decision(requestId)
  const outcomes=await Promise.allSettled([service.decide(ctx(id.reviewer),input,key),service.decide(ctx(id.third),input,randomUUID())]);expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1)
  const ledger=await pool.query("SELECT points_delta,created_by_employee_id FROM mbox.loyalty_point_ledger WHERE source_id=$1",[requestId]);expect(ledger.rows).toHaveLength(1);expect(ledger.rows[0].points_delta).toBe(10)
  if(outcomes[0].status==='fulfilled')expect((await service.decide(ctx(id.reviewer),input,key)).replayed).toBe(true)
  expect((await pool.query('SELECT available_points FROM mbox.loyalty_accounts WHERE id=$1',[m.account])).rows[0].available_points).toBe(10)
 })
 it('binds request replay to employee and payload; rejects revoked replay without duplicating the request',async()=>{
  const m=await member(),input={memberNo:m.memberNo,pointsDelta:5,reason:'原消费以外关怀补偿'},key=randomUUID();actor=id.requester
  const first=await post('requests',input,key);expect(first.statusCode).toBe(200);expect((await post('requests',input,key)).json().meta.replayed).toBe(true)
  expect((await post('requests',{...input,pointsDelta:6},key)).statusCode).toBe(409)
  actor=id.reviewer;expect((await post('requests',input,key)).statusCode).toBe(409)
  await pool.query("UPDATE mbox.employee_roles SET ends_at=clock_timestamp()-interval '1 second' WHERE employee_id=$1",[id.requester]);actor=id.requester
  expect((await post('requests',input,key)).statusCode).toBe(403)
  await pool.query('UPDATE mbox.employee_roles SET ends_at=NULL WHERE employee_id=$1',[id.requester])
 })
 it('uses approved amount authority and permits rejection without credit',async()=>{
  const m=await member(),requestId=await request(m.memberNo,101);actor=id.reviewer
  const result=await post('decisions',decision(requestId));expect(result.statusCode).toBe(409);expect(result.json().error.code).toBe('MANUAL_POINTS_LIMIT')
  expect((await post('decisions',decision(requestId,'reject'))).json().data.status).toBe('rejected')
  expect((await pool.query('SELECT count(*)::int AS n FROM mbox.loyalty_point_ledger WHERE source_id=$1',[requestId])).rows[0].n).toBe(0)
 })
 it('repays old debt first and reports the actual available delta with the original policy expiry',async()=>{
  const m=await member(4),requestId=await request(m.memberNo,10);actor=id.reviewer
  const r=await post('decisions',decision(requestId));expect(r.statusCode).toBe(200);expect(r.json().data).toMatchObject({pointsDelta:10,availableDelta:6,balance:6,pendingRecoveryPoints:0})
  const lots=await pool.query('SELECT original_points,remaining_points,expires_at IS NOT NULL AS expires FROM mbox.loyalty_point_lots WHERE membership_id=$1',[m.membership]);expect(lots.rows).toEqual([{original_points:6,remaining_points:6,expires:true}])
  const board=await app.inject('/api/staff/loyalty/manual-points');expect(board.statusCode).toBe(200);expect(board.headers['cache-control']).toContain('no-store');expect(board.json().data.items.find((r:{id:string})=>r.id===requestId)).toMatchObject({status:'approved',availableDelta:6})
 })
 it('deducts only existing lots and rolls back an insufficient debit',async()=>{
  const m=await member(),credit=await request(m.memberNo,10);actor=id.reviewer;expect((await post('decisions',decision(credit))).statusCode).toBe(200)
  const debit=await request(m.memberNo,-11);actor=id.reviewer;expect((await post('decisions',decision(debit))).json().error.code).toBe('MANUAL_POINTS_BALANCE')
  const valid=await request(m.memberNo,-4);actor=id.reviewer;expect((await post('decisions',decision(valid))).json().data).toMatchObject({balance:6,availableDelta:-4})
 })
 it('requires an active member, validates strict bodies and isolates another store',async()=>{
  actor=id.requester;expect((await post('requests',{memberNo:'missing',pointsDelta:3,reason:'有效申请原因'})).json().error.code).toBe('MANUAL_POINTS_MEMBER')
  expect((await post('requests',{memberNo:'x',pointsDelta:0,reason:'有效申请原因'})).statusCode).toBe(400)
  expect((await post('requests',{memberNo:'x',pointsDelta:3,reason:'有效申请原因',approved:true})).statusCode).toBe(400)
  const foreign=await runner.run({tenantId:randomUUID(),storeId:randomUUID()},tx=>tx.query('SELECT id FROM mbox.loyalty_manual_requests'));expect(foreign.rowCount).toBe(0)
 })
 it('prevents mutation or deletion of the original request by the runtime role',async()=>{
  await expect(runner.run(scope,tx=>tx.query('UPDATE mbox.loyalty_manual_requests SET points_delta=99'))).rejects.toMatchObject({code:'42501'})
  await expect(runner.run(scope,tx=>tx.query('DELETE FROM mbox.loyalty_manual_receipts'))).rejects.toMatchObject({code:'42501'})
 })
 it('enforces independent review even on direct inserts and rolls back a failure after ledger creation',async()=>{
  const m=await member(),requestId=await request(m.memberNo),input=decision(requestId),key=randomUUID()
  await expect(runner.run(scope,tx=>tx.query("INSERT INTO mbox.loyalty_manual_decisions(tenant_id,store_id,request_id,decision,decided_by_employee_id,reason) VALUES($1,$2,$3,'rejected',$4,'不能自行驳回审核')",[id.tenant,id.store,requestId,id.requester]))).rejects.toMatchObject({code:'23514'})
  const faulty=new ManualPointsService({run:(s,work,options)=>runner.run(s,tx=>work({...tx,query:(sql,values)=>{if(sql.startsWith('INSERT INTO mbox.loyalty_manual_receipts'))throw new Error('injected receipt failure');return tx.query(sql,values)}}),options)})
  await expect(faulty.decide(ctx(id.reviewer),input,key)).rejects.toThrow('injected receipt failure')
  expect((await pool.query('SELECT available_points FROM mbox.loyalty_accounts WHERE id=$1',[m.account])).rows[0].available_points).toBe(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM mbox.loyalty_point_ledger WHERE source_id=$1',[requestId])).rows[0].n).toBe(0)
  expect((await service.decide(ctx(id.reviewer),input,key)).value.balance).toBe(10)
 })
 it('fails closed on missing authority, paused accrual and a deactivated member',async()=>{
  const m=await member(),requestId=await request(m.memberNo);actor=id.reviewer
  await pool.query("UPDATE mbox.role_approval_limits SET enabled=false WHERE tenant_id=$1 AND approval_code='loyalty.adjust.manual'",[id.tenant])
  expect((await post('decisions',decision(requestId))).json().error.code).toBe('MANUAL_POINTS_LIMIT')
  await pool.query("UPDATE mbox.role_approval_limits SET enabled=true WHERE tenant_id=$1 AND approval_code='loyalty.adjust.manual'",[id.tenant])
  const controls=new LoyaltyOperationalControlService(runner,new NormalizedCommandExecutor(runner))
  await controls.set(ctx(),{capability:'points_accrual',operation:'pause',reason:'隔离应急暂停测试',reviewAt:null,expectedVersion:0,idempotencyKey:randomUUID()})
  expect((await post('decisions',decision(requestId))).json().error.code).toBe('MANUAL_POINTS_PAUSED')
  actor=id.requester;expect((await post('requests',{memberNo:m.memberNo,pointsDelta:5,reason:'暂停期间新申请'})).json().error.code).toBe('MANUAL_POINTS_PAUSED')
  await controls.set(ctx(id.reviewer),{capability:'points_accrual',operation:'resume',reason:'隔离应急恢复测试',reviewAt:null,expectedVersion:1,idempotencyKey:randomUUID()})
  await pool.query("UPDATE mbox.customer_memberships SET status='suspended' WHERE id=$1",[m.membership]);actor=id.reviewer
  expect((await post('decisions',decision(requestId))).json().error.code).toBe('MANUAL_POINTS_MEMBER')
  expect((await post('decisions',decision(requestId,'reject'))).json().data.status).toBe('rejected')
 })
 it('does not approve an old request under newly published points rules',async()=>{
  const m=await member(),requestId=await request(m.memberNo)
  const next=randomUUID(),effective=new Date().toISOString()
  const publisher=await pool.connect()
  try{
  await publisher.query('BEGIN');await publisher.query('SET CONSTRAINTS mbox.loyalty_policy_versions_no_published_overlap_excl DEFERRED')
  await publisher.query(`INSERT INTO mbox.loyalty_policy_versions(id,tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason)
   SELECT $1,tenant_id,store_id,policy_code,2,status,points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,rounding_mode,12,$2,drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,clock_timestamp(),publication_mode,'隔离新版有效期规则' FROM mbox.loyalty_policy_versions WHERE id=$3`,[next,effective,id.policy])
  await publisher.query('UPDATE mbox.loyalty_policy_versions SET effective_until=$2 WHERE id=$1',[id.policy,effective])
  await publisher.query('COMMIT')
  }catch(e){await publisher.query('ROLLBACK');throw e}finally{publisher.release()}
  actor=id.reviewer;const rejected=await post('decisions',decision(requestId))
  expect(rejected.json().error).toMatchObject({code:'MANUAL_POINTS_POLICY_CHANGED',commitDisposition:'not_committed'})
  expect((await pool.query('SELECT available_points FROM mbox.loyalty_accounts WHERE id=$1',[m.account])).rows[0].available_points).toBe(0)
 })
})
