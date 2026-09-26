import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner, type ScopedTransaction } from './transaction-runner.js'
import { MemberGiftCampaignRepository } from './member-gift-campaign-repository.js'
import { CouponCalendarRepository } from './coupon-calendar-repository.js'
import { MemberVisitRepository } from './member-visit-repository.js'
import { MemberVisitRewardRepository } from './member-visit-reward-repository.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL
;(url?describe:describe.skip)('attendance reward approvals PostgreSQL',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),editor=randomUUID(),approver=randomUUID(),publisher=randomUUID(),denied=randomUUID(),role=randomUUID(),productId=randomUUID()
  const scope={tenantId,storeId},businessDate='2026-09-09'

  let pool:Pool,runner:ScopedPostgresTransactionRunner,calendarId:string
  const run=<T>(action:(repo:MemberGiftCampaignRepository)=>Promise<T>)=>runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return action(new MemberGiftCampaignRepository(tx))})
  beforeAll(async()=>{
    await runNormalizedMigrations(url!);pool=new Pool({connectionString:url,max:8});runner=new ScopedPostgresTransactionRunner(pool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Gift test')",[tenantId,`gift-${tenantId.slice(0,8)}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'gift-test','Gift test')",[storeId,tenantId])
    for(const [id,code] of [[editor,'EDITOR'],[approver,'APPROVER'],[publisher,'PUBLISHER'],[denied,'DENIED']])await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,tenantId,storeId,code])
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'GIFT_REVIEW','Gift review')",[role,tenantId,storeId])
    for(const employeeId of [editor,approver,publisher])await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 minute')",[tenantId,storeId,employeeId,role])
    for(const code of ['loyalty.configuration.edit','loyalty.configuration.view','loyalty.configuration.approve','loyalty.policy.publish','member.card.manage','member.card.review']){
      await pool.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT(tenant_id,store_id,code) DO NOTHING',[tenantId,storeId,code])
      await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4',[tenantId,storeId,role,code])
    }
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,cost_amount_minor) VALUES($1,$2,$3,'GIFT_SNACK','Test snack','snack','kitchen',100)",[productId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1000,'CNY',clock_timestamp()-interval '1 day')",[tenantId,storeId,productId])
    const from=new Date(Date.now()-86400000).toISOString(),until=new Date(Date.now()+30*86400000).toISOString()
    const saved=await runner.run(scope,tx=>new CouponCalendarRepository(tx).save({code:'GIFT_CAL',rule:{timezone:'Asia/Shanghai',dateBasis:'natural',businessDayStartMinute:0,dateFrom:from.slice(0,10),dateThrough:until.slice(0,10),validFrom:from,validUntil:until,weekdays:[1,2,3,4,5,6,7],weekStartsOn:1,windows:[{startMinute:0,endMinute:1440}],excludedDates:[],relativeValidity:{days:3,basis:'elapsed'}},limits:{perCustomerDay:null,perCustomerWeek:null,perCustomerCampaign:null},employeeId:editor,businessDate,reason:'隔离发券测试',requestKey:randomUUID(),expectedVersion:0}))
    calendarId=saved.id
    for(const [action,employeeId] of [['approve',approver],['publish',publisher]] as const)await runner.run(scope,tx=>new CouponCalendarRepository(tx).decide({versionId:calendarId,action,employeeId,businessDate,reason:'隔离发券测试'}))
  })
  afterAll(async()=>{await pool?.end()})
  async function customer(){const id=randomUUID();await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[id,tenantId,storeId,`gift-${id}`]);await pool.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no,level) VALUES($1,$2,$3,$4,'gold')",[tenantId,storeId,id,`MBX-${id.slice(0,18).toUpperCase()}`]);return id}
  async function campaign(overrides:Record<string,unknown>={}){
    const rule={trigger:'targeted',cardProjectId:null,audience:{minimumTier:'member',cardCodes:[],cardMatch:'any',tierAndCards:'and'},quantityPerCustomer:1,maximumQuantity:2,maximumDailyQuantity:2,maximumCostMinor:200,maximumDailyCostMinor:200,maximumUnitCostMinor:100,budgetDateBasis:'natural',budgetDayStartMinute:0,currency:'CNY',availableFrom:new Date(Date.now()-3600000).toISOString(),availableUntil:new Date(Date.now()+86400000).toISOString(),couponCalendarVersionId:calendarId,productIds:[productId],...overrides}
    const input={code:`GIFT_${randomUUID().slice(0,8).toUpperCase()}`,name:'测试赠品',rule,employeeId:editor,businessDate,reason:'隔离测试规则',requestKey:randomUUID()}
    const created=await run(repo=>repo.create(input))
    expect(await run(repo=>repo.create(input))).toEqual({...created,replayed:true})
    for(const [action,employeeId] of [['approve',approver],['publish',publisher]] as const)await run(repo=>repo.decide({versionId:created.versionId,action,employeeId,businessDate,reason:'核实预算规则'}))
    return created.versionId
  }
  beforeEach(async()=>{await pool.query("UPDATE mbox.member_visit_reward_rules SET status='stopped' WHERE tenant_id=$1 AND store_id=$2 AND status='active'",[tenantId,storeId])})
  const reward=<T>(action:(repo:MemberVisitRewardRepository,tx:ScopedTransaction)=>Promise<T>)=>runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return action(new MemberVisitRewardRepository(tx),tx)})
  const member=(id:string)=>`MBX-${id.slice(0,18).toUpperCase()}`
  async function setup(requiredVisits=3,overrides:Record<string,unknown>={}){
    const versionId=await campaign(overrides),customerId=await customer()
    const rule=await reward(repo=>repo.create({campaignVersionId:versionId,requiredVisits,employeeId:publisher,businessDate,reason:'测试循环签到规则'}))
    return {versionId,customerId,ruleId:rule.id}
  }
  async function visit(id:string,day:number){return reward((_repo,tx)=>new MemberVisitRepository(tx).checkIn(member(id),`2026-09-${String(day).padStart(2,'0')}`,editor))}
  async function cancel(id:string,day:number,visitId:string){return reward((_repo,tx)=>new MemberVisitRepository(tx).cancel(member(id),`2026-09-${String(day).padStart(2,'0')}`,visitId,editor,'测试撤回误签到'))}
  async function requests(ruleId:string){return (await pool.query('SELECT * FROM mbox.member_visit_reward_requests WHERE tenant_id=$1 AND store_id=$2 AND rule_id=$3 ORDER BY earned_business_date,created_at',[tenantId,storeId,ruleId])).rows}
  const approve=(ids:string[])=>reward(repo=>repo.decide(ids,'approve',publisher,businessDate,'管理核实同意发券'))
  it('counts attendance alone, queues each threshold, issues only after approval and never on duplicate scans',async()=>{
    const {customerId,ruleId}=await setup()
    for(let d=1;d<=6;d++)await visit(customerId,d)
    await visit(customerId,6)
    const pending=await requests(ruleId);expect(pending).toHaveLength(2);expect(pending.every(q=>q.status==='pending')).toBe(true)
    expect((await pool.query('SELECT id FROM mbox.member_gift_delivery_jobs WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])).rowCount).toBe(0)
    expect(await reward(repo=>repo.progress(customerId))).toMatchObject([{requiredVisits:3,remainingVisits:3,pending:2,issued:0}])
    await approve([pending[0].id]);await approve([pending[1].id])
    await expect(approve([pending[0].id])).rejects.toThrow('状态已变化')
    expect((await requests(ruleId)).map(q=>q.status)).toEqual(['issued','issued'])
    const rows=await reward(repo=>repo.list('2026-09-03','issued',null));expect(rows.items).toHaveLength(1);expect(rows.items[0]).toMatchObject({required_visits:3,quantity:1,quantity_redeemed:0,visit_dates:['2026-09-01','2026-09-02','2026-09-03']})
    expect((await pool.query('SELECT id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])).rowCount).toBe(0)
  })
  it('invalidates an unapproved cycle on cancellation and reuses only remaining valid dates',async()=>{
    const {customerId,ruleId}=await setup()
    await visit(customerId,1);await visit(customerId,2);const third=await visit(customerId,3)
    const original=(await requests(ruleId))[0]
    await cancel(customerId,3,third.visit.id)
    expect((await requests(ruleId))[0].status).toBe('invalid')
    await expect(approve([original.id])).rejects.toThrow('状态已变化')
    await visit(customerId,4)
    const next=(await requests(ruleId)).find(q=>q.status==='pending')!
    await approve([next.id])
    const row=(await reward(repo=>repo.list(null,'issued',null))).items.find(q=>q.id===next.id)!
    expect(row.visit_dates).toEqual(['2026-09-01','2026-09-02','2026-09-04'])
  })
  it('retains issued rights and flags a cancelled source without reusing the same business day',async()=>{
    const {customerId,ruleId}=await setup(1)
    const original=await visit(customerId,1),q=(await requests(ruleId))[0]
    await approve([q.id]);await cancel(customerId,1,original.visit.id);await visit(customerId,1)
    expect(await requests(ruleId)).toHaveLength(1)
    const row=(await reward(repo=>repo.list(null,'issued',null))).items.find(r=>r.id===q.id)!
    expect(row).toMatchObject({cancelled_sources:1,benefit_status:'issued'})
    await visit(customerId,2);expect(await requests(ruleId)).toHaveLength(2)
  })
  it('atomically rolls back an entire daily batch if its second gift exceeds budget; no worker job escapes',async()=>{
    const {customerId,ruleId,versionId}=await setup(1,{maximumQuantity:1,maximumDailyQuantity:1,maximumCostMinor:100,maximumDailyCostMinor:100})
    await visit(customerId,1);await visit(customerId,2)
    const rows=await requests(ruleId)
    await expect(approve(rows.map(q=>q.id))).rejects.toThrow('全部回滚')
    expect((await requests(ruleId)).every(q=>q.status==='pending')).toBe(true)
    expect((await pool.query('SELECT id FROM mbox.member_gift_delivery_jobs WHERE campaign_version_id=$1',[versionId])).rowCount).toBe(0)
    await approve([rows[0].id]);expect((await requests(ruleId)).map(q=>q.status)).toEqual(['issued','pending'])
  })
  it('serializes competing approvals and produces exactly one benefit',async()=>{
    const {customerId,ruleId,versionId}=await setup(1)
    await visit(customerId,1);const q=(await requests(ruleId))[0]
    const outcomes=await Promise.allSettled([approve([q.id]),approve([q.id])])
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((await pool.query("SELECT id FROM mbox.member_gift_delivery_jobs WHERE campaign_version_id=$1 AND status='issued'",[versionId])).rowCount).toBe(1)
  })
  it('preserves rejected cycle provenance instead of automatically reapplying',async()=>{
    const {customerId,ruleId}=await setup(1)
    await visit(customerId,1);const q=(await requests(ruleId))[0]
    await reward(repo=>repo.decide([q.id],'reject',publisher,businessDate,'测试管理驳回'))
    await visit(customerId,1);expect(await requests(ruleId)).toHaveLength(1)
    await visit(customerId,2);expect((await requests(ruleId)).map(q=>q.status)).toEqual(['rejected','pending'])
  })
  it('does not count visits before enabling the rule and refuses to reset the same campaign code',async()=>{
    const customerId=await customer();await visit(customerId,1)
    const versionId=await campaign(),input={campaignVersionId:versionId,requiredVisits:2,employeeId:publisher,businessDate,reason:'明确启用起点'}
    const {id:ruleId}=await reward(repo=>repo.create(input))
    await expect(reward(repo=>repo.create({...input,requiredVisits:1}))).rejects.toThrow('不能重置')
    await visit(customerId,2);expect(await requests(ruleId)).toHaveLength(0)
    await visit(customerId,3);expect(await requests(ruleId)).toHaveLength(1)
    await reward(repo=>repo.stop(ruleId,publisher,businessDate,'测试停用规则'))
    await expect(approve([(await requests(ruleId))[0].id])).rejects.toThrow('已停用')
  })
  it('requires management permissions and keeps another store invisible',async()=>{
    const {customerId,ruleId}=await setup(1);await visit(customerId,1);const q=(await requests(ruleId))[0]
    await expect(reward(repo=>repo.decide([q.id],'approve',denied,businessDate,'无权限不允许'))).rejects.toThrow()
    const rows=await runner.run({tenantId,storeId:randomUUID()},async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return tx.query('SELECT id FROM mbox.member_visit_reward_requests')})
    expect(rows.rowCount).toBe(0)
    await expect(reward((_repo,tx)=>tx.query('UPDATE mbox.member_visit_reward_rules SET required_visits=1 WHERE id=$1',[ruleId]))).rejects.toMatchObject({code:'42501'})
    await expect(reward((_repo,tx)=>tx.query('DELETE FROM mbox.member_visit_reward_sources WHERE request_id=$1',[q.id]))).rejects.toMatchObject({code:'42501'})
  })
  it('counts a merged family date once and rejects a second same-date entitlement after merge',async()=>{
    const {customerId,ruleId}=await setup(1),other=await customer()
    await visit(customerId,1);await visit(other,1)
    await pool.query("UPDATE mbox.customers SET merged_into_customer_id=$1,status='merged' WHERE id=$2",[customerId,other])
    const rows=await requests(ruleId);await approve([rows[0].id]);await expect(approve([rows[1].id])).rejects.toThrow('重复计次')
    await visit(customerId,1);expect(await requests(ruleId)).toHaveLength(2)
  })
})
