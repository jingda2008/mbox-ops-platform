import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { MemberContentCardRepository } from './member-content-card-repository.js'
import { ScopedPostgresTransactionRunner,type PostgresPool } from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl ? describe : describe.skip

integration('member home content PostgreSQL contract',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID()
  let pool:Pool
  let transactions:ScopedPostgresTransactionRunner

  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:2})
    transactions=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Home content tenant')`,[
      tenantId,`home-${tenantId.slice(0,8)}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Home content store')`,[
      storeId,tenantId,`home-${storeId.slice(0,8)}`,
    ])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,$4,'首页内容管理员')`,[
      employeeId,tenantId,storeId,`HOME_${employeeId.slice(0,8)}`,
    ])
  },30_000)

  afterAll(async()=>pool?.end())

  it('creates, publishes, lists and pauses a typed home card without JSON decisions',async()=>{
    const draft={
      code:`story-${randomUUID().slice(0,8)}`,type:'article' as const,title:'从1999开始',
      summary:'关于上海、现场与M-BOX的真实故事。',imageUrl:'/assets/brand/mbox-logo-badge.png',
      ctaLabel:'阅读故事',targetPath:'/pages/home/index',priority:80,displayMode:'pinned' as const,visibility:'segment' as const,
      audienceMemberLevels:['gold','member','gold'],audienceLifecycleStages:['active'],
      validFrom:'2026-08-20T12:00:00.000Z',validUntil:'2027-08-20T12:00:00.000Z',
    }
    const scope={tenantId,storeId}
    const created=await transactions.run(scope,(transaction)=>new MemberContentCardRepository(transaction).create(draft))
    expect(created).toMatchObject({
      code:draft.code,status:'draft',displayMode:'pinned',visibility:'segment',
      audienceMemberLevels:['gold','member'],audienceLifecycleStages:['active'],
      publishedByEmployeeId:null,
    })

    const published=await transactions.run(scope,(transaction)=>(
      new MemberContentCardRepository(transaction).publish(draft.code,employeeId)
    ))
    expect(published).toMatchObject({status:'published',publishedByEmployeeId:employeeId})

    const listed=await transactions.run(scope,(transaction)=>(
      new MemberContentCardRepository(transaction).list()
    ),{readOnly:true})
    expect(listed).toEqual([expect.objectContaining({code:draft.code,status:'published'})])

    const paused=await transactions.run(scope,(transaction)=>(
      new MemberContentCardRepository(transaction).pause(draft.code)
    ))
    expect(paused.status).toBe('paused')
  })
})
