import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import { CustomerExperienceService } from './customer-experience-service.js'
import { LoyaltyAccrualDeferredWorker } from './loyalty-accrual-deferred-worker.js'
import { LoyaltyAccrualRepository } from './loyalty-accrual-repository.js'
import { LoyaltyOperationalControlService } from './loyalty-operational-control-service.js'
import { LoyaltyRedemptionRepository } from './loyalty-redemption-repository.js'
import { ScopedPostgresTransactionRunner,type PostgresPool } from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
const id={
  tenant:randomUUID(),store:randomUUID(),owner:randomUUID(),ops:randomUUID(),publisher:randomUUID(),ownerRole:randomUUID(),opsRole:randomUUID(),
  area:randomUUID(),table:randomUUID(),session:randomUUID(),customer:randomUUID(),membership:randomUUID(),account:randomUUID(),
  policy:randomUUID(),product:randomUUID(),order:randomUUID(),item:randomUUID(),payment:randomUUID(),
} as const
const scope={tenantId:id.tenant,storeId:id.store}

integration('loyalty operational emergency controls PostgreSQL integration',()=>{
  let pool:Pool
  let runner:ScopedPostgresTransactionRunner
  let service:LoyaltyOperationalControlService
  let customerExperience:CustomerExperienceService
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:6})
    runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    service=new LoyaltyOperationalControlService(runner,new NormalizedCommandExecutor(runner))
    customerExperience=new CustomerExperienceService(
      runner,
      new NormalizedCommandExecutor(runner),
      {updateProfile:async()=>{throw new Error('not used')}},
    )
    await seed(pool)
  })
  afterAll(async()=>pool?.end())

  it('defaults all gates active and grants control only to OWNER by default',async()=>{
    const states=await service.list(staff())
    expect(states.map((item)=>[item.capability,item.state,item.version])).toEqual([
      ['points_accrual','active',0],['points_redemption','active',0],['wechat_notification','active',0],
    ])
    const assigned=await pool.query(`
      SELECT role.code AS role_code,permission.code AS permission_code
      FROM mbox.role_permission_assignments assignment
      JOIN mbox.roles role ON role.id=assignment.role_id
      JOIN mbox.staff_permission_definitions permission ON permission.id=assignment.permission_id
      WHERE assignment.tenant_id=$1 AND assignment.store_id=$2
        AND permission.code IN ('loyalty.operations.view','loyalty.operations.control')
      ORDER BY role.code,permission.code
    `,[id.tenant,id.store])
    expect(assigned.rows).toEqual([
      {role_code:'OWNER',permission_code:'loyalty.operations.control'},
      {role_code:'OWNER',permission_code:'loyalty.operations.view'},
    ])
  })

  it('defers a paid order during accrual pause and replays the pause command without duplicate events',async()=>{
    const input={
      capability:'points_accrual' as const,operation:'pause' as const,
      reason:'积分规则异常，暂停新增积分等待复核',reviewAt:'2099-08-17T10:00:00Z',expectedVersion:0,
      idempotencyKey:'loyalty-accrual-pause-integration-001',
    }
    const paused=await service.set(staff(),input)
    const replay=await service.set(staff(),input)
    expect(paused).toMatchObject({replayed:false,value:{state:'paused',version:1}})
    expect(replay).toMatchObject({replayed:true,value:{state:'paused',version:1}})

    const award=await runner.run(scope,(transaction)=>new LoyaltyAccrualRepository(transaction).recordPaidOrder({
      orderId:id.order,paymentId:id.payment,occurredAt:'2026-08-16T08:00:00Z',
    }))
    expect(award.applied).toBe(false)
    const facts=await pool.query(`
      SELECT ordering.payment_status,payment.status AS payment_status_fact,deferred.status,
        deferred.pause_control_version,deferred.payment_succeeded_at::text,
        (SELECT count(*)::integer FROM mbox.loyalty_order_awards WHERE order_id=$3) AS awards
      FROM mbox.orders ordering
      JOIN mbox.payments payment ON payment.id=$4
      JOIN mbox.loyalty_accrual_deferred_orders deferred ON deferred.order_id=ordering.id
      WHERE ordering.tenant_id=$1 AND ordering.store_id=$2 AND ordering.id=$3
    `,[id.tenant,id.store,id.order,id.payment])
    expect(facts.rows[0]).toMatchObject({
      payment_status:'paid',payment_status_fact:'succeeded',status:'pending',pause_control_version:1,awards:0,
    })
    expect((await pool.query(`SELECT count(*)::integer AS count FROM mbox.loyalty_operational_control_events
      WHERE tenant_id=$1 AND store_id=$2 AND capability='points_accrual'`,[id.tenant,id.store])).rows[0]?.count).toBe(1)
  })

  it('shows the signed-in member a safe pending-accrual projection without operational details',async()=>{
    const loyalty=await customerExperience.loyalty({
      scope,customerId:id.customer,actorRef:`customer:${id.customer}`,businessDate:'2026-08-16',
    })
    expect(loyalty.points).toEqual([])
    expect(loyalty.processing).toEqual([
      expect.objectContaining({
        kind:'accrual',state:'pending',active:true,
        sourceReference:expect.stringMatching(/^ec-order-/),
      }),
    ])
    const serialized=JSON.stringify(loyalty)
    expect(serialized).not.toContain('积分规则异常')
    expect(serialized).not.toContain('pause_control_version')
    expect(serialized).not.toContain('worker_id')
    expect(serialized).not.toContain('resolution_code')
  })

  it('resumes and applies every deferred paid order exactly once without changing payment',async()=>{
    await service.set(staff(),{
      capability:'points_accrual',operation:'resume',reason:'复核积分规则无误，恢复新增积分',reviewAt:null,expectedVersion:1,
      idempotencyKey:'loyalty-accrual-resume-integration-001',
    })
    const worker=new LoyaltyAccrualDeferredWorker(runner)
    const first=await worker.runBatch(scope,'loyalty-deferred-integration-worker')
    const replay=await worker.runBatch(scope,'loyalty-deferred-integration-worker')
    expect(first).toMatchObject({claimed:1,paused:false})
    expect(first.applied).toHaveLength(1)
    expect(replay).toMatchObject({claimed:0,applied:[]})
    const facts=await pool.query(`
      SELECT account.available_points,account.growth_value,deferred.status,deferred.resolution_code,
        ordering.payment_status,payment.status AS payment_status_fact,
        (SELECT count(*)::integer FROM mbox.loyalty_order_awards WHERE order_id=$1) AS awards
      FROM mbox.loyalty_accounts account
      JOIN mbox.loyalty_accrual_deferred_orders deferred ON deferred.order_id=$1
      JOIN mbox.orders ordering ON ordering.id=$1
      JOIN mbox.payments payment ON payment.id=$2
      WHERE account.id=$3
    `,[id.order,id.payment,id.account])
    expect(facts.rows[0]).toEqual({
      available_points:80,growth_value:80,status:'applied',resolution_code:'award_applied',
      payment_status:'paid',payment_status_fact:'succeeded',awards:1,
    })
    const loyalty=await customerExperience.loyalty({
      scope,customerId:id.customer,actorRef:`customer:${id.customer}`,businessDate:'2026-08-16',
    })
    expect(loyalty.points[0]).toMatchObject({
      entryType:'earn',pointsDelta:80,balanceAfter:80,sourceKind:'order',
      sourceReference:expect.stringMatching(/^ec-order-/),
      description:'已按付款订单和锁定规则入账',policyVersion:1,
    })
    expect(loyalty.processing[0]).toMatchObject({kind:'accrual',state:'resolved',active:false})
    expect(JSON.stringify(loyalty)).not.toContain('权威付款确认后的消费积分')
  })

  it('makes redemption pause independent and preserves existing points and history',async()=>{
    await service.set(staff(),{
      capability:'points_redemption',operation:'pause',reason:'兑换库存需要现场复核',reviewAt:null,expectedVersion:0,
      idempotencyKey:'loyalty-redemption-pause-integration-001',
    })
    const catalog=await runner.run(scope,(transaction)=>new LoyaltyRedemptionRepository(transaction).catalog(
      id.customer,'2026-08-16','2026-08-16T09:00:00Z',
    ))
    expect(catalog).toMatchObject({controlState:'paused',availablePoints:80,items:[]})
    expect((await pool.query(`SELECT available_points FROM mbox.loyalty_accounts WHERE id=$1`,[id.account])).rows[0]?.available_points).toBe(80)
  })

  it('retries a transient deferred-accrual failure after resume without duplicating the original award',async()=>{
    const second=await insertPaidOrder(pool,5_000,'retry')
    await service.set(staff(),{
      capability:'points_accrual',operation:'pause',reason:'积分补算服务临时异常，暂停确认',reviewAt:null,expectedVersion:2,
      idempotencyKey:'loyalty-accrual-retry-pause-001',
    })
    const refundId=randomUUID(),refundItemId=randomUUID()
    await pool.query(`INSERT INTO mbox.refunds(
      id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,status,reason,
      requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at
    ) VALUES($1,$2,$3,$4,$5,$6,1000,'CNY','succeeded','暂停期间正常退款',$7,$8,'复核通过','2026-08-16T09:30:00Z')`,
      [refundId,id.tenant,id.store,id.payment,`ec-refund-${refundId.slice(0,8)}`,`ec-provider-refund-${refundId.slice(0,8)}`,id.owner,id.ops])
    await pool.query(`INSERT INTO mbox.refund_items(id,tenant_id,store_id,refund_id,order_item_id,amount_minor,currency)
      VALUES($1,$2,$3,$4,$5,1000,'CNY')`,[refundItemId,id.tenant,id.store,refundId,id.item])
    const reversal=await runner.run(scope,(transaction)=>new LoyaltyAccrualRepository(transaction).reverseSucceededRefund({
      orderId:id.order,paymentId:id.payment,refundId,occurredAt:'2026-08-16T09:30:00Z',
    }))
    expect(reversal).toMatchObject({applied:true,pointsDelta:-10,growthDelta:-10})
    await runner.run(scope,(transaction)=>new LoyaltyAccrualRepository(transaction).recordPaidOrder({
      orderId:second.orderId,paymentId:second.paymentId,occurredAt:'2026-08-16T10:00:00Z',
    }))
    await pool.query(`UPDATE mbox.loyalty_accrual_deferred_orders
      SET status='processing',worker_id='failed-worker',claimed_at='2020-08-16T10:01:00Z',updated_at='2020-08-16T10:01:00Z'
      WHERE order_id=$1`,[second.orderId])
    await pool.query(`UPDATE mbox.loyalty_accrual_deferred_orders
      SET status='review_required',worker_id=NULL,claimed_at=NULL,resolved_at='2020-08-16T10:02:00Z',
        resolution_code='processing_failed',updated_at='2020-08-16T10:02:00Z'
      WHERE order_id=$1`,[second.orderId])
    await service.set(staff(),{
      capability:'points_accrual',operation:'resume',reason:'补算依赖恢复，继续按权威订单重算',reviewAt:null,expectedVersion:3,
      idempotencyKey:'loyalty-accrual-retry-resume-001',
    })
    const first=await new LoyaltyAccrualDeferredWorker(runner).runBatch(scope,'loyalty-deferred-retry-worker')
    const secondRun=await new LoyaltyAccrualDeferredWorker(runner).runBatch(scope,'loyalty-deferred-retry-worker')
    expect(first.applied).toHaveLength(1)
    expect(secondRun.claimed).toBe(0)
    expect((await pool.query(`SELECT count(*)::integer AS count FROM mbox.loyalty_order_awards WHERE order_id=$1`,[second.orderId])).rows[0]?.count).toBe(1)
  })

  it('blocks OWNER and OPS positive manual accrual while paused but permits correction, refund and restored accrual',async()=>{
    const supplementOrder=await insertPaidOrder(pool,6_000,'supplement-gate')
    const supplementId=randomUUID(),supplementPublicId=`LSP-${randomUUID()}`
    await pool.query(`INSERT INTO mbox.loyalty_supplement_requests(
      id,tenant_id,store_id,public_id,membership_id,customer_id,order_id,policy_version_id,
      expected_points,existing_points,requested_points,expected_growth,existing_growth,requested_growth,
      status,reason,requested_by_employee_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,60,0,60,60,0,60,'requested','权威付款漏积分复核',$9)`,[
      supplementId,id.tenant,id.store,supplementPublicId,id.membership,id.customer,
      supplementOrder.orderId,id.policy,id.owner,
    ])
    await service.set(staff(),{
      capability:'points_accrual',operation:'pause',reason:'人工补发和关怀积分统一暂停复核',reviewAt:null,expectedVersion:4,
      idempotencyKey:'loyalty-manual-accrual-pause-001',
    })
    const before=(await pool.query(`SELECT available_points,growth_value FROM mbox.loyalty_accounts WHERE id=$1`,[id.account])).rows[0]
    const positive=(employeeId:string,key:string)=>customerExperience.adjustPoints(staffAs(employeeId),{
      customerId:id.customer,pointsDelta:5,reason:'特权岗位也不得绕过紧急总闸',sourceType:'manual',sourceId:key,idempotencyKey:key,
    })
    await expect(positive(id.owner,'owner-positive-paused-001')).rejects
      .toMatchObject<CustomerExperienceRequestError>({code:'LOYALTY_POINTS_ACCRUAL_PAUSED'})
    await expect(positive(id.ops,'ops-positive-paused-001')).rejects
      .toMatchObject<CustomerExperienceRequestError>({code:'LOYALTY_POINTS_ACCRUAL_PAUSED'})

    const correction=await customerExperience.adjustPoints(staffAs(id.owner),{
      customerId:id.customer,pointsDelta:-5,reason:'暂停时仍允许扣回错误发放的积分',sourceType:'manual',sourceId:'negative-correction-paused-001',
      idempotencyKey:'negative-correction-paused-001',
    })
    expect(correction.value).toMatchObject({delta:-5,balance:before.available_points-5})

    await expect(customerExperience.decideLoyaltySupplement(staffAs(id.ops),{
      publicId:supplementPublicId,decision:'approve',reason:'复核通过但总闸暂停时不得执行',
      idempotencyKey:'supplement-positive-paused-001',
    })).rejects.toMatchObject<CustomerExperienceRequestError>({code:'LOYALTY_POINTS_ACCRUAL_PAUSED'})
    expect((await pool.query(`SELECT status FROM mbox.loyalty_supplement_requests WHERE id=$1`,[supplementId])).rows[0]?.status).toBe('requested')
    expect((await pool.query(`SELECT count(*)::integer AS count FROM mbox.loyalty_order_awards WHERE order_id=$1`,[supplementOrder.orderId])).rows[0]?.count).toBe(0)

    await service.set(staff(),{
      capability:'points_accrual',operation:'resume',reason:'积分和成长值复核完成，恢复新发放',reviewAt:null,expectedVersion:5,
      idempotencyKey:'loyalty-manual-accrual-resume-001',
    })
    const restored=await positive(id.owner,'owner-positive-restored-001')
    expect(restored.value).toMatchObject({delta:5,balance:before.available_points})
    const supplemented=await customerExperience.decideLoyaltySupplement(staffAs(id.ops),{
      publicId:supplementPublicId,decision:'approve',reason:'总闸恢复后按权威订单重算补发',
      idempotencyKey:'supplement-positive-restored-001',
    })
    expect(supplemented.value).toMatchObject({status:'executed',pointsDelta:60,growthDelta:60})
    const after=(await pool.query(`SELECT available_points,growth_value FROM mbox.loyalty_accounts WHERE id=$1`,[id.account])).rows[0]
    expect(after).toEqual({available_points:before.available_points+60,growth_value:before.growth_value+60})
  })

  it('serializes concurrent commands and records one winning event',async()=>{
    const attempt=(key:string)=>service.set(staff(),{
      capability:'wechat_notification' as const,operation:'pause' as const,
      reason:'微信通知通道异常，暂停发送',reviewAt:null,expectedVersion:0,idempotencyKey:key,
    })
    const results=await Promise.allSettled([
      attempt('loyalty-wechat-pause-concurrent-001'),attempt('loyalty-wechat-pause-concurrent-002'),
    ])
    expect(results.filter((item)=>item.status==='fulfilled')).toHaveLength(1)
    expect(results.filter((item)=>item.status==='rejected')).toHaveLength(1)
    const facts=await pool.query(`SELECT state,control_version,
      (SELECT count(*)::integer FROM mbox.loyalty_operational_control_events event
        WHERE event.tenant_id=state.tenant_id AND event.store_id=state.store_id
          AND event.capability=state.capability) AS event_count
      FROM mbox.loyalty_operational_control_states state
      WHERE tenant_id=$1 AND store_id=$2 AND capability='wechat_notification'`,[id.tenant,id.store])
    expect(facts.rows[0]).toEqual({state:'paused',control_version:1,event_count:1})
  })

  it('keeps control events and deferred source facts immutable',async()=>{
    await expect(pool.query(`UPDATE mbox.loyalty_operational_control_events SET reason='tampered'
      WHERE id=(SELECT id FROM mbox.loyalty_operational_control_events
        WHERE tenant_id=$1 AND store_id=$2 ORDER BY occurred_at,id LIMIT 1)`,[id.tenant,id.store])).rejects.toThrow()
    await expect(pool.query(`DELETE FROM mbox.loyalty_operational_control_states
      WHERE tenant_id=$1 AND store_id=$2 AND capability='wechat_notification'`,[id.tenant,id.store])).rejects.toThrow()
    await expect(pool.query(`UPDATE mbox.loyalty_accrual_deferred_orders SET pause_control_version=99
      WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3`,[id.tenant,id.store,id.order])).rejects.toThrow()
  })
})

function staff(){return {scope,employeeId:id.owner,businessDate:'2026-08-16'}}
function staffAs(employeeId:string){return {...staff(),employeeId}}

async function seed(pool:Pool){
  const suffix=id.tenant.replaceAll('-','').slice(0,10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Emergency Control Tenant')`,[id.tenant,`ec-${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Emergency Control Store')`,[id.store,id.tenant,`ec-${suffix}`])
  await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES
    ($1,$3,$4,'OWNER','Owner'),($2,$3,$4,'OPS_LEAD','Operations Lead')`,[id.ownerRole,id.opsRole,id.tenant,id.store])
  await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
    ($1,$4,$5,$6,'Owner','active'),($2,$4,$5,$7,'Ops','active'),($3,$4,$5,$8,'Publisher','active')`,
    [id.owner,id.ops,id.publisher,id.tenant,id.store,`EO-${suffix}`,`EP-${suffix}`,`EU-${suffix}`])
  await pool.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,granted_by_employee_id) VALUES
    ($1,$2,$3,$4,$3),($1,$2,$5,$6,$3)`,[id.tenant,id.store,id.owner,id.ownerRole,id.ops,id.opsRole])
  await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,$4,'Area','bar')`,[id.area,id.tenant,id.store,`EA-${suffix}`])
  await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,status)
    VALUES($1,$2,$3,$4,$5,'Table',4,'available')`,[id.table,id.tenant,id.store,id.area,`ET-${suffix}`])
  await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)
    VALUES($1,$2,$3,$4,$5,'2026-08-16',2,'open')`,[id.session,id.tenant,id.store,id.table,`ec-session-${suffix}`])
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1,$2,$3,$4,'active')`,[id.customer,id.tenant,id.store,`ec-customer-${suffix}`])
  await pool.query(`INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status)
    VALUES($1,$2,$3,$4,$5,'member','active')`,[id.membership,id.tenant,id.store,id.customer,`MBX${suffix.toUpperCase()}`])
  await pool.query(`INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4,$5)`,[id.account,id.tenant,id.store,id.membership,id.customer])
  await pool.query(`INSERT INTO mbox.loyalty_policy_versions(
    id,tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,
    growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,
    drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason
  ) VALUES($1,$2,$3,'BASE',1,'published',1,100,1,100,'floor',18,'2026-08-01T00:00:00Z',
    $4,$5,'2026-08-01T00:00:00Z',$6,'2026-08-01T00:01:00Z','separated','紧急暂停测试政策')`,
    [id.policy,id.tenant,id.store,id.owner,id.ops,id.publisher])
  await pool.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,status,loyalty_eligible)
    VALUES($1,$2,$3,$4,'Eligible','drink','bar','active',true)`,[id.product,id.tenant,id.store,`ECP-${suffix}`])
  await pool.query(`INSERT INTO mbox.orders(
    id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,
    discount_amount_minor,total_amount_minor,currency,created_by_customer_id,submitted_at,settlement_mode,
    fulfillment_state,loyalty_policy_version_id
  ) VALUES($1,$2,$3,$4,$5,'guest_qr','submitted','paid',8000,0,8000,'CNY',$6,'2026-08-16T07:59:00Z',
    'immediate_payment','active',$7)`,[id.order,id.tenant,id.store,id.session,`ec-order-${suffix}`,id.customer,id.policy])
  await pool.query(`INSERT INTO mbox.order_items(
    id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,total_amount_minor,
    currency,fulfillment_station,product_snapshot,loyalty_eligible_at_submission,loyalty_eligibility_source,status
  ) VALUES($1,$2,$3,$4,$5,1,8000,0,8000,'CNY','bar','{}',true,'catalog_product','submitted')`,[id.item,id.tenant,id.store,id.order,id.product])
  await pool.query(`INSERT INTO mbox.payments(
    id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,succeeded_at
  ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',8000,'CNY','succeeded','2026-08-16T08:00:00Z')`,[id.payment,id.tenant,id.store,id.order,`ec-payment-${suffix}`,`cash-${suffix}`])
}

async function insertPaidOrder(pool:Pool,amountMinor:number,label:string){
  const orderId=randomUUID(),itemId=randomUUID(),paymentId=randomUUID(),suffix=orderId.replaceAll('-','').slice(0,10)
  await pool.query(`INSERT INTO mbox.orders(
    id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,
    discount_amount_minor,total_amount_minor,currency,created_by_customer_id,submitted_at,settlement_mode,
    fulfillment_state,loyalty_policy_version_id
  ) VALUES($1,$2,$3,$4,$5,'guest_qr','submitted','paid',$6,0,$6,'CNY',$7,'2026-08-16T09:59:00Z',
    'immediate_payment','active',$8)`,[orderId,id.tenant,id.store,id.session,`ec-${label}-${suffix}`,amountMinor,id.customer,id.policy])
  await pool.query(`INSERT INTO mbox.order_items(
    id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,total_amount_minor,
    currency,fulfillment_station,product_snapshot,loyalty_eligible_at_submission,loyalty_eligibility_source,status
  ) VALUES($1,$2,$3,$4,$5,1,$6,0,$6,'CNY','bar','{}',true,'catalog_product','submitted')`,
    [itemId,id.tenant,id.store,orderId,id.product,amountMinor])
  await pool.query(`INSERT INTO mbox.payments(
    id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,succeeded_at
  ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',$7,'CNY','succeeded','2026-08-16T10:00:00Z')`,
    [paymentId,id.tenant,id.store,orderId,`ec-pay-${label}-${suffix}`,`cash-${label}-${suffix}`,amountMinor])
  return {orderId,paymentId}
}
