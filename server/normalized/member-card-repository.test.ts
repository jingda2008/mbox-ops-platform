import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {Pool} from 'pg'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {MemberCardRepository} from './member-card-repository.js'
import {CustomerRepository} from './customer-repository.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=url?describe:describe.skip
integration('member card ordinary approval persistence',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),editor=randomUUID(),reviewer=randomUUID(),denied=randomUUID(),role=randomUUID(),customerId=randomUUID()
  const scope={tenantId,storeId},businessDate='2026-09-09'
  let pool:Pool,runner:ScopedPostgresTransactionRunner
  beforeAll(async()=>{
    await runNormalizedMigrations(url!)
    pool=new Pool({connectionString:url,max:8})
    runner=new ScopedPostgresTransactionRunner({connect:()=>pool.connect(),end:()=>pool.end()} as PostgresPool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Card test')",[tenantId,`card-${tenantId.slice(0,8)}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'card-test','Card test')",[storeId,tenantId])
    for(const [id,code] of [[editor,'EDITOR'],[reviewer,'REVIEWER'],[denied,'DENIED']])await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,tenantId,storeId,code])
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'CARD_REVIEW','Card review')",[role,tenantId,storeId])
    await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$5,clock_timestamp()-interval '1 minute'),($1,$2,$4,$5,clock_timestamp()-interval '1 minute')",[tenantId,storeId,editor,reviewer,role])
    for(const code of ['member.card.manage','member.card.review','loyalty.policy.publish']){
      await pool.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT(tenant_id,store_id,code) DO NOTHING',[tenantId,storeId,code])
      await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4',[tenantId,storeId,role,code])
    }
    await pool.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,'card-customer')",[customerId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no,level) VALUES($1,$2,$3,'MBX-CARD0001','gold')",[tenantId,storeId,customerId])
  })
  afterAll(async()=>pool?.end())
  const run=<T>(action:(repo:MemberCardRepository)=>Promise<T>)=>runner.run(scope,tx=>action(new MemberCardRepository(tx)))
  async function create(open=true){
    const result=await run(repo=>repo.createProject({code:`FAN_${randomUUID().slice(0,8).toUpperCase()}`,name:'音乐兴趣卡',terms:'免费兴趣卡，营销许可另外选择，已发券按原规则兑现。',kind:'interest',availableFrom:new Date(Date.now()-3600000).toISOString(),availableUntil:new Date(Date.now()+86400000).toISOString(),cooperationConfirmed:false,cooperationValidUntil:null,cooperationReference:null,employeeId:editor,businessDate}))
    if(open)await run(repo=>repo.setProjectState({projectId:result.projectId,state:'open',employeeId:reviewer,businessDate,reason:'确认免费兴趣项目'}))
    return result.projectId
  }
  it('creates one pending application and one active card under concurrent one-person approvals without changing grade',async()=>{
    const projectId=await create()
    const applications=await Promise.all([1,2].map(()=>run(repo=>repo.apply({projectId,customerId,acceptedProjectVersion:1,businessDate}))))
    expect(new Set(applications.map(row=>row.applicationId)).size).toBe(1)
    const applicationId=applications[0]!.applicationId
    const results=await Promise.all([editor,reviewer].map(employeeId=>run(repo=>repo.review({applicationId,decision:'approve',employeeId,businessDate,reason:'符合申请条件'}))))
    expect(results.filter(result=>!result.replayed)).toHaveLength(1)
    expect((await pool.query('SELECT status FROM mbox.member_cards WHERE project_id=$1',[projectId])).rows).toEqual([{status:'active'}])
    expect((await pool.query('SELECT level FROM mbox.customer_memberships WHERE customer_id=$1',[customerId])).rows[0]?.level).toBe('gold')
    expect((await pool.query('SELECT count(*)::int AS count FROM mbox.benefits WHERE customer_id=$1',[customerId])).rows[0]?.count).toBe(0)
  })
  it('rejects unauthorized review and closed projects, without silently changing an application',async()=>{
    const projectId=await create()
    const application=await run(repo=>repo.apply({projectId,customerId,acceptedProjectVersion:1,businessDate}))
    await expect(run(repo=>repo.review({applicationId:application.applicationId,decision:'approve',employeeId:denied,businessDate,reason:'无权限测试'}))).rejects.toThrow()
    await run(repo=>repo.setProjectState({projectId,state:'closed',employeeId:reviewer,businessDate,reason:'关闭项目测试'}))
    await expect(run(repo=>repo.review({applicationId:application.applicationId,decision:'approve',employeeId:reviewer,businessDate,reason:'不能发出过期卡'}))).rejects.toThrow('当前不接受')
    expect((await pool.query('SELECT status FROM mbox.member_card_applications WHERE id=$1',[application.applicationId])).rows[0]?.status).toBe('pending')
  })
  it('keeps card withdrawal distinct from project closure and rejects another customer',async()=>{
    const projectId=await create(),application=await run(repo=>repo.apply({projectId,customerId,acceptedProjectVersion:1,businessDate}))
    const approved=await run(repo=>repo.review({applicationId:application.applicationId,decision:'approve',employeeId:reviewer,businessDate,reason:'普通审核通过'}))
    const cardId=approved.cardId!
    const stranger=randomUUID()
    await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[stranger,tenantId,storeId,`stranger-${stranger}`])
    await expect(run(repo=>repo.changeCard({cardId,action:'withdraw',customerId:stranger,businessDate,reason:'其他客户越权测试'}))).rejects.toThrow('其他客户')
    await run(repo=>repo.setProjectState({projectId,state:'closed',employeeId:reviewer,businessDate,reason:'停止新发卡'}))
    expect((await pool.query('SELECT status FROM mbox.member_cards WHERE id=$1',[cardId])).rows[0]?.status).toBe('active')
    expect(await run(repo=>repo.changeCard({cardId,action:'withdraw',customerId,businessDate,reason:'客户自主退出'}))).toEqual({cardId,status:'withdrawn'})
    await expect(run(repo=>repo.changeCard({cardId,action:'resume',employeeId:reviewer,businessDate,reason:'不能恢复退出卡'}))).rejects.toThrow('当前持卡状态')
  })
  it('does not allow the editor to self-publish and preserves immutable terms',async()=>{
    const projectId=await create(false)
    await expect(run(repo=>repo.setProjectState({projectId,state:'open',employeeId:editor,businessDate,reason:'禁止自开项目'}))).rejects.toThrow('不能自行')
    await expect(pool.query("UPDATE mbox.member_card_projects SET terms='改掉既有申请条款' WHERE id=$1",[projectId])).rejects.toThrow('immutable')
  })
  it('enforces management authority across suspend, resume and irreversible revocation',async()=>{
    const projectId=await create(),application=await run(repo=>repo.apply({projectId,customerId,acceptedProjectVersion:1,businessDate}))
    const approved=await run(repo=>repo.review({applicationId:application.applicationId,decision:'approve',employeeId:reviewer,businessDate,reason:'审核通过'}))
    const cardId=approved.cardId!
    await expect(run(repo=>repo.changeCard({cardId,action:'suspend',employeeId:denied,businessDate,reason:'越权冻结'}))).rejects.toThrow()
    expect((await run(repo=>repo.changeCard({cardId,action:'suspend',employeeId:reviewer,businessDate,reason:'待核实资料'}))).status).toBe('suspended')
    expect((await run(repo=>repo.changeCard({cardId,action:'resume',employeeId:reviewer,businessDate,reason:'资料核实完成'}))).status).toBe('active')
    expect((await run(repo=>repo.changeCard({cardId,action:'revoke',employeeId:reviewer,businessDate,reason:'撤销测试持卡'}))).status).toBe('revoked')
    await expect(pool.query("UPDATE mbox.member_cards SET status='active' WHERE id=$1",[cardId])).rejects.toThrow('Invalid member card state transition')
    await expect(pool.query("UPDATE mbox.member_cards SET valid_until=valid_until+interval '1 day' WHERE id=$1",[cardId])).rejects.toThrow('immutable')
    await expect(pool.query("UPDATE mbox.member_card_applications SET review_reason='事后改写结果' WHERE id=$1",[application.applicationId])).rejects.toThrow('immutable')
    await expect(run(repo=>repo.changeCard({cardId,action:'resume',employeeId:reviewer,businessDate,reason:'非法恢复测试'}))).rejects.toThrow('当前持卡状态')
    const list=await run(repo=>repo.holdings(reviewer))
    expect(list.items.find(row=>row.id===cardId)).toMatchObject({status:'revoked',project_name:'音乐兴趣卡',customer_reference:'card-customer'})
    expect(JSON.stringify(list)).not.toMatch(/cooperation_reference|phone|contact/)
    await expect(run(repo=>repo.holdings(denied))).rejects.toThrow()
  })
  it('paginates full personal application and card history without exposing other customers',async()=>{
    const projectId=await create()
    await runner.run(scope,async tx=>{
      const applications=await tx.query<{id:string}>(`INSERT INTO mbox.member_card_applications(tenant_id,store_id,project_id,customer_id,accepted_project_version,status,reviewed_by_employee_id,review_reason,resolved_at)
        SELECT $1,$2,$3,$4,1,'approved',$5,'分页历史夹具',clock_timestamp() FROM generate_series(1,53) RETURNING id`,[tenantId,storeId,projectId,customerId,reviewer])
      await tx.query(`INSERT INTO mbox.member_cards(tenant_id,store_id,project_id,customer_id,application_id,status,valid_until)
        SELECT $1,$2,$3,$4,id,'withdrawn',clock_timestamp()+interval '1 day' FROM unnest($5::uuid[]) id`,[tenantId,storeId,projectId,customerId,applications.rows.map(row=>row.id)])
    })
    for(const kind of ['cards','applications'] as const){
      const seen:string[]=[];let cursor:string|null=null
      do{
        const page=await run(repo=>repo.selfView(customerId,cursor?{[kind]:cursor}:{}))
        expect(page[kind].length).toBeLessThanOrEqual(50)
        seen.push(...page[kind].map(row=>row.id));cursor=page.nextCursors[kind]
      }while(cursor)
      expect(seen.length).toBeGreaterThanOrEqual(53)
      expect(new Set(seen).size).toBe(seen.length)
      const table=kind==='cards'?'member_cards':'member_card_applications'
      expect(seen.length).toBe(Number((await pool.query(`SELECT count(*) AS count FROM mbox.${table} WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3`,[tenantId,storeId,customerId])).rows[0].count))
    }
    await expect(run(repo=>repo.selfView(customerId,{cards:'invalid-cursor'}))).rejects.toThrow('编号')
  })
  it('preserves old identity facts while merged customers withdraw and reapply without duplicate active cards',async()=>{
    const source=randomUUID(),target=randomUUID(),projectId=await create()
    for(const id of [source,target]){
      await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[id,tenantId,storeId,`card-merge-${id}`])
      await pool.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no,level) VALUES($1,$2,$3,$4,'gold')",[tenantId,storeId,id,`MBX-${id.slice(0,18).toUpperCase()}`])
    }
    const application=await run(repo=>repo.apply({projectId,customerId:source,acceptedProjectVersion:1,businessDate}))
    const approved=await run(repo=>repo.review({applicationId:application.applicationId,decision:'approve',employeeId:reviewer,businessDate,reason:'同身份迁移测试'}))
    await runner.run(scope,tx=>new CustomerRepository(tx).merge(source,target))
    const view=await run(repo=>repo.selfView(target))
    expect(view.cards.map(row=>row.id)).toContain(approved.cardId)
    await expect(run(repo=>repo.apply({projectId,customerId:target,acceptedProjectVersion:1,businessDate}))).rejects.toThrow('已有此卡')
    await run(repo=>repo.changeCard({cardId:approved.cardId!,customerId:target,action:'withdraw',businessDate,reason:'合并身份自主退出'}))
    const reapplied=await run(repo=>repo.apply({projectId,customerId:target,acceptedProjectVersion:1,businessDate}))
    await run(repo=>repo.review({applicationId:reapplied.applicationId,decision:'approve',employeeId:reviewer,businessDate,reason:'重新普通审批'}))
    const records=(await pool.query('SELECT customer_id,status FROM mbox.member_cards WHERE project_id=$1',[projectId])).rows
    expect(records).toEqual(expect.arrayContaining([{customer_id:source,status:'withdrawn'},{customer_id:target,status:'active'}]))
    expect(records).toHaveLength(2)
  })
})
