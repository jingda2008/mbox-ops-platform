import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { CheckoutUpgradeManagementRepository } from './checkout-upgrade-management-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('checkout upgrade and capacity release management PostgreSQL integration', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const otherStoreId = randomUUID()
  const employees = [randomUUID(), randomUUID(), randomUUID()]
  const sourceProductId = randomUUID()
  const targetProductId = randomUUID()
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    runner = new ScopedPostgresTransactionRunner(asPool(pool))
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES ($1,$2,'Checkout management tenant')`, [
      tenantId, `checkout-management-${tenantId.slice(0,8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES
        ($1,$3,$4,'Checkout management store'),($2,$3,$5,'Other checkout management store')
    `, [storeId,otherStoreId,tenantId,`checkout-${storeId.slice(0,8)}`,`checkout-${otherStoreId.slice(0,8)}`])
    await pool.query(`
      INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
        ($1,$4,$5,'CHECKOUT_MAKER','Checkout Maker','active'),
        ($2,$4,$5,'CHECKOUT_CHECKER','Checkout Checker','active'),
        ($3,$4,$5,'CHECKOUT_PUBLISHER','Checkout Publisher','active')
    `, [...employees,tenantId,storeId])
    await pool.query(`
      INSERT INTO mbox.products(
        id,tenant_id,store_id,code,name,category_code,product_kind,
        fulfillment_station,cost_amount_minor,guest_visible,allowed_channels
      ) VALUES
        ($1,$3,$4,'CHECKOUT-SOURCE','Checkout Source','drink','single','bar',1000,true,ARRAY['guest_qr']),
        ($2,$3,$4,'CHECKOUT-TARGET','Checkout Target','bundle','bundle','none',3000,true,ARRAY['guest_qr'])
    `, [sourceProductId,targetProductId,tenantId,storeId])
  })

  afterAll(async () => pool?.end())

  it('requires three distinct people and keeps released rule facts immutable', async () => {
    const draft = await run((repository) => repository.insertRuleDraft({
      code:'CHECKOUT_MANAGED',name:'Managed checkout upgrade',sourceProductId,targetProductId,
      minimumPartySize:2,maximumPartySize:8,occasionTags:['friends'],alcoholPreferenceTags:['mixed'],
      promptTitle:'升级今晚体验',promptBody:'将当前单品升级为完整套餐',callToAction:'查看升级',
      priority:120,offerValidMinutes:10,minimumGrossMarginBasisPoints:100,employeeId:employees[0]!,
    }))
    expect(draft).toMatchObject({ revision:1,status:'draft',draftedByEmployeeId:employees[0] })

    await expect(run((repository) => repository.approveRule(
      draft.id,employees[0]!,'制单人不能自行审批',
    ))).rejects.toMatchObject({ code:'CHECKOUT_UPGRADE_RULE_APPROVAL_DENIED' })
    const approved = await run((repository) => repository.approveRule(
      draft.id,employees[1]!,'商品价格和毛利已复核',
    ))
    expect(approved).toMatchObject({ status:'approved',approvedByEmployeeId:employees[1] })

    await expect(run((repository) => repository.publishRule(
      draft.id,employees[1]!,'审批人不能自行发布',
    ))).rejects.toMatchObject({ code:'CHECKOUT_UPGRADE_RULE_PUBLICATION_DENIED' })
    const published = await run((repository) => repository.publishRule(
      draft.id,employees[2]!,'发布受控升级规则',
    ))
    expect(published).toMatchObject({ status:'active',publishedByEmployeeId:employees[2] })
    expect(await run((repository) => repository.listRules())).toEqual([
      expect.objectContaining({ id:draft.id,revision:1,status:'active' }),
    ])

    await expect(pool.query(`
      UPDATE mbox.checkout_upgrade_rules SET prompt_body='绕过版本直接修改'
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3
    `, [tenantId,storeId,draft.id])).rejects.toMatchObject({ code:'23514' })
    const rollback = await run((repository) => repository.cloneRuleForRollback(draft.id,employees[0]!))
    expect(rollback).toMatchObject({ revision:2,status:'draft',code:'CHECKOUT_MANAGED' })
  })

  it('publishes typed non-overlapping capacity windows through the same separation', async () => {
    const now = Date.now()
    const draft = await run((repository) => repository.draftCapacity({
      stationCode:'bar',reason:'周末酒吧产能测试',employeeId:employees[0]!,windows:[{
        startsAt:new Date(now+60_000).toISOString(),endsAt:new Date(now+3_660_000).toISOString(),
        capacityLimitUnits:40,
      }],
    }))
    expect(draft).toMatchObject({ stationCode:'bar',policyVersion:1,status:'draft' })
    await expect(run((repository) => repository.approveCapacity(draft.id,employees[0]!)))
      .rejects.toMatchObject({ code:'FULFILLMENT_CAPACITY_APPROVAL_DENIED' })
    expect(await run((repository) => repository.approveCapacity(draft.id,employees[1]!)))
      .toMatchObject({ status:'approved' })
    await expect(run((repository) => repository.publishCapacity(draft.id,employees[1]!)))
      .rejects.toMatchObject({ code:'FULFILLMENT_CAPACITY_PUBLICATION_DENIED' })
    const published = await run((repository) => repository.publishCapacity(draft.id,employees[2]!))
    expect(published).toMatchObject({ status:'published',windows:[expect.objectContaining({ capacityLimitUnits:40 })] })

    const isolated = await runner.run({ tenantId,storeId:otherStoreId }, (transaction) => (
      new CheckoutUpgradeManagementRepository(transaction).listCapacityPolicies()
    ), { readOnly:true })
    expect(isolated).toEqual([])
  })

  function run<Result>(operation: (repository: CheckoutUpgradeManagementRepository) => Promise<Result>) {
    return runner.run({ tenantId,storeId }, (transaction) => operation(new CheckoutUpgradeManagementRepository(transaction)))
  }
})

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
