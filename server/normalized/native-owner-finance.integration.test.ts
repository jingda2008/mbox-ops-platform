import {randomUUID} from 'node:crypto'
import Fastify,{type FastifyInstance} from 'fastify'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {ownerFinanceApiPlugin} from './owner-finance-api.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('native owner finance permission and immutable commands',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},owner=randomUUID(),employee=randomUUID(),role=randomUUID()
 let admin:Pool,runtime:Pool,app:FastifyInstance,board:any
 const root='/native/commercial-ops'
 const send=(path:string,payload:object,key=`native-business-${randomUUID()}`,headers:Record<string,string>={})=>app.inject({method:'POST',url:root+path,headers:{'idempotency-key':key,...headers},payload})
 const get=async()=>{const r=await app.inject({method:'GET',url:root+'/owner-finance'});expect(r.statusCode,r.body).toBe(200);return r.json().data}
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Owner native')",[scope.tenantId]);await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Owner native')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'OWNER','老板'),($4,$2,$3,'STAFF','员工')",[owner,scope.tenantId,scope.storeId,employee]);await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'OWNER','老板')",[role,scope.tenantId,scope.storeId]);await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,owner,role]);await admin.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4)",[scope.tenantId,scope.storeId,role,['commercial.cost.view','commercial.cost.manage','commercial.payroll.view','commercial.payroll.manage','commercial.payroll.post']])
  const transactions=new ScopedPostgresTransactionRunner(runtime);const common={transactions,commandExecutor:new NormalizedCommandExecutor(transactions),resolveContext:()=>({scope,employeeId:owner,businessDate:'2026-09-30',capabilities:[]})}
  app=Fastify();await app.register(ownerFinanceApiPlugin,{...common,prefix:'/native',nativeReceipts:true});await app.register(ownerFinanceApiPlugin,{...common,prefix:'/legacy'});await app.ready();board=await get()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 it('records and corrects costs once with original durable replies and no legacy shape change',async()=>{
  const body={displayName:'测试租金',category:'rent',recognitionState:'actual',allocationPeriod:'day',serviceStartDate:'2026-09-30',serviceEndDate:'2026-09-30',netAmountMinor:10000,taxAmountMinor:100,currency:'CNY',sourceType:'lease'};const key=`native-business-${randomUUID()}`
  const first=await send('/costs',body,key);expect(first.statusCode,first.body).toBe(201);const cost=first.json().data.result
  expect((await send('/costs',body,key)).json()).toMatchObject({data:first.json().data,meta:{replayed:true,protocol:1}})
  const corrected=await send('/costs/'+cost.id+'/corrections',{...body,netAmountMinor:12000,correctionReason:'核对原票据后更正'});expect(corrected.statusCode,corrected.body).toBe(201);expect(corrected.json().data.result.correctsCostEntryId).toBe(cost.id)
  expect((await send('/costs/'+cost.id+'/corrections',{...body,correctionReason:'旧页面不能重复更正'})).json().error.commitDisposition).toBe('not_committed')
  expect((await get()).costs).toHaveLength(2)
  await admin.query("UPDATE mbox.employee_roles SET ends_at=clock_timestamp()-interval '1 second' WHERE employee_id=$1",[owner]);expect((await send('/costs',body,key)).statusCode).toBe(403);await admin.query('UPDATE mbox.employee_roles SET ends_at=NULL WHERE employee_id=$1',[owner])
  const legacy=await app.inject({method:'GET',url:'/legacy/commercial-ops/owner-finance'});expect(legacy.statusCode).toBe(200);expect(legacy.json().data).toHaveProperty('costs');expect(legacy.json().data).not.toHaveProperty('result')
 })
 it('guards recurring status and materializes each occurrence only once',async()=>{
  const rule=await send('/recurring-costs',{name:'每日测试租金',categoryDefinitionId:board.categories.find((x:any)=>x.code==='rent').id,costCenterId:board.costCenters.find((x:any)=>x.code==='venue').id,recurrence:'day',allocationPeriod:'day',recognitionState:'accrual',startsOn:'2026-09-29',netAmountMinor:100,taxAmountMinor:0,sourceType:'lease'});expect(rule.statusCode,rule.body).toBe(201)
  const id=rule.json().data.result.id;expect((await get()).recurringRules.find((x:any)=>x.id===id).version).toBe(1)
  const mat=await send('/recurring-costs/materialize',{throughDate:'2026-09-30'});expect(mat.statusCode,mat.body).toBe(201);expect(mat.json().data.result.createdCount).toBe(2)
  expect((await send('/recurring-costs/materialize',{throughDate:'2026-09-30'})).json().data.result.createdCount).toBe(0)
  expect((await send('/recurring-costs/'+id+'/status',{status:'paused',reason:'暂停测试规则'},undefined,{'x-owner-version':'1'})).statusCode).toBe(201)
  expect((await send('/recurring-costs/'+id+'/status',{status:'ended',reason:'不允许旧版本修改'},undefined,{'x-owner-version':'1'})).json().error.commitDisposition).toBe('not_committed')
 })
 it('requires original payroll version for approval and posts each employee cost exactly once',async()=>{
  const rule=await send('/compensation-rules',{employeeId:employee,costCenterId:board.costCenters[0].id,payBasis:'monthly',baseRateMinor:500000,effectiveFrom:'2026-09-01',reason:'设定测试月薪'},undefined,{'x-owner-compensation':'none'});expect(rule.statusCode,rule.body).toBe(201)
  expect((await send('/compensation-rules',{employeeId:employee,costCenterId:board.costCenters[0].id,payBasis:'monthly',baseRateMinor:600000,effectiveFrom:'2026-10-01',reason:'旧标准不能覆盖'},undefined,{'x-owner-compensation':'none'})).statusCode).toBe(409)
  const body={periodStart:'2026-09-01',periodEnd:'2026-09-30',lines:[{employeeId:employee,compensationRuleId:rule.json().data.result.id,units:'1',bonusMinor:10000,deductionMinor:1000,employerContributionMinor:20000}]}
  const draft=await send('/payroll-runs',body);expect(draft.statusCode,draft.body).toBe(201);const id=draft.json().data.result.id;let run=(await get()).payrollRuns.find((x:any)=>x.id===id)
  expect(run).toMatchObject({grossPayMinor:510000,netPayMinor:509000,employerCostMinor:530000})
  const oldVersion=run.version;const change=await send('/payroll-runs',{...body,draftRunId:id,expectedVersion:oldVersion,replaceEmployeeLine:true});expect(change.statusCode,change.body).toBe(201)
  expect((await send('/payroll-runs/'+id+'/approve',{reason:'旧版本不得确认'},undefined,{'x-owner-version':String(oldVersion)})).statusCode).toBe(409)
  run=(await get()).payrollRuns.find((x:any)=>x.id===id);const approved=await send('/payroll-runs/'+id+'/approve',{reason:'核对工资明细'},undefined,{'x-owner-version':String(run.version)});expect(approved.statusCode,approved.body).toBe(201)
  run=(await get()).payrollRuns.find((x:any)=>x.id===id);const key=`native-business-${randomUUID()}`,posted=await send('/payroll-runs/'+id+'/post',{reason:'核对后费用入账'},key,{'x-owner-version':String(run.version)});expect(posted.statusCode,posted.body).toBe(201)
  expect((await send('/payroll-runs/'+id+'/post',{reason:'核对后费用入账'},key,{'x-owner-version':String(run.version)})).json().meta.replayed).toBe(true)
  expect((await get()).costs.filter((x:any)=>x.payrollRunId===id)).toHaveLength(1)
  const transactions=new ScopedPostgresTransactionRunner(runtime)
  const deleted=await transactions.run(scope,tx=>tx.query("DELETE FROM mbox.payroll_lines WHERE tenant_id=$1 AND store_id=$2 AND payroll_run_id=$3",[scope.tenantId,scope.storeId,id]));expect(deleted.rowCount).toBe(0)
  expect((await get()).payrollLines.filter((x:any)=>x.payrollRunId===id)).toHaveLength(1)
 })
})
