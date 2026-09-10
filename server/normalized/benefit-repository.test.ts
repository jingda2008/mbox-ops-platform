import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { BenefitCommandService, BenefitRepository, BenefitUnavailableError } from './benefit-repository.js'
import { parseBenefitWalletCursor } from './benefit-wallet.js'
import { CouponCalendarRepository } from './coupon-calendar-repository.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  ComplimentaryFulfillmentResolutionError,
  ComplimentaryFulfillmentResolutionService,
} from './complimentary-fulfillment-resolution-service.js'
import { CustomerCommandService } from './customer-repository.js'
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from './transaction-runner.js'
import { readTableSessionClosureState } from './table-session-closure-blockers.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('BenefitRepository normalized grant and redemption integrity', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const tableSessionId = randomUUID()
  const employeeId = randomUUID()
  const roleId = randomUUID()
  const approvalLimitId = randomUUID()
  const productId = randomUUID()
  let pool: Pool
  let customers: CustomerCommandService
  let benefits: BenefitCommandService
  let transactions: ScopedPostgresTransactionRunner
  let resolutions: ComplimentaryFulfillmentResolutionService
  let customerId: string
  let guestActorRef: string
  const giftOrder = vi.fn(async (transaction, input) => {
    const orderId = randomUUID()
    const orderItemId = randomUUID()
    const reference = `benefit-gift-${input.benefitReservationId}`
    await transaction.query(`
      INSERT INTO mbox.orders(
        id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
        subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,
        created_by_employee_id,submitted_at,settlement_mode,fulfillment_state
      ) VALUES($1,$2,$3,$4,$5,'cashier','submitted','paid',0,0,0,'CNY',$6,
        clock_timestamp(),'immediate_payment','active')
    `, [orderId, transaction.scope.tenantId, transaction.scope.storeId,
      input.tableSessionId, reference, input.redeemedByEmployeeId])
    await transaction.query(`
      INSERT INTO mbox.order_items(
        id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,
        discount_amount_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,status
      ) VALUES($1,$2,$3,$4,$5,$6,0,0,0,'CNY','bar','{"source":"benefit_test"}'::jsonb,'submitted')
    `, [orderItemId, transaction.scope.tenantId, transaction.scope.storeId,
      orderId, input.selectedProductId ?? productId, input.quantity])
    return { reference }
  })

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    const commands = new NormalizedCommandExecutor(transactions)
    customers = new CustomerCommandService(commands)
    benefits = new BenefitCommandService(commands, { createGiftOrder: giftOrder })
    resolutions = new ComplimentaryFulfillmentResolutionService(transactions)
    await seedStore()
    const customer = await customers.createAnonymous({
      scope: { tenantId, storeId }, actor: { type: 'system', ref: 'seed' },
      businessDate: '2026-08-11', publicId: 'benefit-customer-public-0001',
      identityHash: 'f'.repeat(64), idempotencyKey: 'benefit-customer-create-0001',
      requestFingerprint: 'benefit-customer-create-fingerprint',
    })
    customerId = customer.value.customer.id
    await pool.query(`
      INSERT INTO mbox.table_sessions (
        id, tenant_id, store_id, table_id, public_id, business_date, guest_count
      ) VALUES ($1, $2, $3, $4, 'benefit-table-session-0001', '2026-08-11', 2)
    `, [tableSessionId, tenantId, storeId, tableId])
    await pool.query(`
      INSERT INTO mbox.table_session_customers (
        tenant_id, store_id, table_session_id, customer_id, relationship
      ) VALUES ($1, $2, $3, $4, 'primary')
    `, [tenantId, storeId, tableSessionId, customerId])
    guestActorRef=await seedActiveGuestTableAuthority(pool,{
      tenantId,storeId,tableSessionId,customerId,
    })
  })

  afterAll(async () => pool?.end())

  it('requires live permission, approval source, reason and integer approval limit for manual grants', async () => {
    const command = issueCommand('manual-ok', 400, 2)
    const issued = await benefits.issue(command)
    const replay = await benefits.issue(command)
    expect(issued.value).toMatchObject({
      customerId,
      valueAmountMinor: 400,
      quantityTotal: 2,
      quantityAvailable: 2,
      issuanceReason: '客户生日现场关怀',
    })
    expect(replay.replayed).toBe(true)
    await expect(benefits.issue(issueCommand('manual-over-limit', 1_001, 1)))
      .rejects.toThrow('exceeds the employee approval limit')

    const evidence = await pool.query<{ benefits: string; audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.benefits WHERE tenant_id = $1 AND store_id = $2
          AND issuance_idempotency_key LIKE 'benefit-issue-manual-%') AS benefits,
        (SELECT count(*)::text FROM mbox.audit_events WHERE tenant_id = $1 AND store_id = $2
          AND action = 'benefit.issued') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE tenant_id = $1 AND store_id = $2
          AND message_type = 'benefit.issued.v1') AS outbox
    `, [tenantId, storeId])
    expect(evidence.rows[0]).toEqual({ benefits: '1', audits: '1', outbox: '1' })
  })

  it('allows only one concurrent reservation when one unit remains', async () => {
    const issued = await benefits.issue(issueCommand('race', 500, 1))
    const reserve = (suffix: string) => benefits.reserve({
      scope: { tenantId, storeId },
      actor: { type: 'guest' as const, ref: guestActorRef },
      businessDate: '2026-08-11',
      benefitId: issued.value.id,
      customerId,
      tableSessionId,
      quantity: 1,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      reservationIdempotencyKey: `benefit-reserve-race-${suffix}-0001`,
      reservationFingerprint: `benefit-reserve-race-${suffix}`,
    })
    const outcomes = await Promise.allSettled([reserve('one'), reserve('two')])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(BenefitUnavailableError)
    const balance = await pool.query<{ quantity_reserved: number; quantity_redeemed: number }>(`
      SELECT quantity_reserved, quantity_redeemed FROM mbox.benefits WHERE id = $1
    `, [issued.value.id])
    expect(balance.rows[0]).toEqual({ quantity_reserved: 1, quantity_redeemed: 0 })
  })

  it('binds redemption to the current customer/table, invokes gift order port, and replays safely', async () => {
    const issued = await benefits.issue(issueCommand('redeem', 300, 1))
    const reserved = await benefits.reserve({
      scope: { tenantId, storeId }, actor: { type: 'guest', ref: guestActorRef },
      businessDate: '2026-08-11', benefitId: issued.value.id, customerId, tableSessionId,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      reservationIdempotencyKey: 'benefit-reserve-redeem-0001',
      reservationFingerprint: 'benefit-reserve-redeem-fingerprint',
    })
    const command = {
      scope: { tenantId, storeId }, actor: { type: 'employee' as const, employeeId },
      businessDate: '2026-08-11', benefitId: issued.value.id,
      benefitReservationId: reserved.value.id, customerId, tableSessionId,
      redeemedByEmployeeId: employeeId,
      authorizationSource: { kind: 'employee', permission: 'benefit.redeem' },
      redemptionIdempotencyKey: 'benefit-redeem-bound-0001',
      redemptionFingerprint: 'benefit-redeem-bound-fingerprint',
    }
    const redeemed = await benefits.redeem(command)
    const replay = await benefits.redeem(command)
    expect(redeemed.value).toMatchObject({ customerId, tableSessionId, quantity: 1 })
    expect(replay.replayed).toBe(true)
    expect(giftOrder).toHaveBeenCalledTimes(1)
    expect(giftOrder).toHaveBeenCalledWith(expect.objectContaining({ scope: { tenantId, storeId } }),
      expect.objectContaining({ customerId, tableSessionId, benefitId: issued.value.id }))
    await expect(benefits.redeem({
      ...command,
      redemptionIdempotencyKey: 'benefit-redeem-bound-second-0001',
      redemptionFingerprint: 'benefit-redeem-bound-second-fingerprint',
    })).rejects.toThrow('already redeemed by another request')

    const evidence = await pool.query<{
      redemptions: string; reserved: number; redeemed: number; gift_orders: string; gift_order_items: string
    }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.benefit_redemptions WHERE benefit_id = $1) AS redemptions,
        (SELECT count(*)::text FROM mbox.orders orders JOIN mbox.benefit_redemptions redemption
          ON redemption.tenant_id=orders.tenant_id AND redemption.store_id=orders.store_id
          AND redemption.gift_order_reference=orders.public_id WHERE redemption.benefit_id=$1) AS gift_orders,
        (SELECT count(*)::text FROM mbox.order_items item JOIN mbox.orders orders ON orders.id=item.order_id
          JOIN mbox.benefit_redemptions redemption ON redemption.tenant_id=orders.tenant_id
          AND redemption.store_id=orders.store_id AND redemption.gift_order_reference=orders.public_id
          WHERE redemption.benefit_id=$1) AS gift_order_items,
        quantity_reserved AS reserved,
        quantity_redeemed AS redeemed
      FROM mbox.benefits WHERE id = $1
    `, [issued.value.id])
    expect(evidence.rows[0]).toEqual({
      redemptions: '1', reserved: 0, redeemed: 1, gift_orders: '1', gift_order_items: '1',
    })
  })

  it('cancels a reservation idempotently and restores available quantity', async () => {
    const issued = await benefits.issue(issueCommand('cancel', 200, 1))
    const reserved = await benefits.reserve({
      scope: { tenantId, storeId }, actor: { type: 'guest', ref: guestActorRef },
      businessDate: '2026-08-11', benefitId: issued.value.id, customerId, tableSessionId,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      reservationIdempotencyKey: 'benefit-reserve-cancel-0001',
      reservationFingerprint: 'benefit-reserve-cancel-fingerprint',
    })
    const command = {
      scope: { tenantId, storeId }, actor: { type: 'guest' as const, ref: guestActorRef },
      businessDate: '2026-08-11', benefitReservationId: reserved.value.id,
      customerId, tableSessionId, reason: '客人改变选择',
      cancellationIdempotencyKey: 'benefit-cancel-reservation-0001',
      cancellationFingerprint: 'benefit-cancel-reservation-fingerprint',
    }
    const cancelled = await benefits.cancelReservation(command)
    const replay = await benefits.cancelReservation(command)
    expect(cancelled.value.status).toBe('cancelled')
    expect(replay.replayed).toBe(true)
    const balance = await pool.query<{ quantity_reserved: number }>(`
      SELECT quantity_reserved FROM mbox.benefits WHERE id = $1
    `, [issued.value.id])
    expect(balance.rows[0]?.quantity_reserved).toBe(0)
  })

  it('terminates a permanently failed complimentary order, replays safely and removes close blockers', async () => {
    const resolutionTableId=randomUUID()
    const resolutionSessionId=randomUUID()
    const resolutionCustomer=await customers.createAnonymous({
      scope:{tenantId,storeId},actor:{type:'system',ref:'resolution-seed'},
      businessDate:'2026-08-11',publicId:`benefit-resolution-customer-${randomUUID()}`,
      identityHash:randomUUID().replaceAll('-','').repeat(2),
      idempotencyKey:`benefit-resolution-customer-${randomUUID()}`,
      requestFingerprint:`benefit-resolution-customer-fingerprint-${randomUUID()}`,
    })
    const resolutionCustomerId=resolutionCustomer.value.customer.id
    await pool.query(`
      INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,$5,'Resolution Table',4)
    `,[resolutionTableId,tenantId,storeId,areaId,`R${resolutionTableId.slice(0,4)}`])
    await pool.query(`
      INSERT INTO mbox.table_sessions(
        id,tenant_id,store_id,table_id,public_id,business_date,guest_count
      ) VALUES($1,$2,$3,$4,$5,'2026-08-11',1)
    `,[resolutionSessionId,tenantId,storeId,resolutionTableId,
      `benefit-resolution-session-${resolutionSessionId}`])
    await pool.query(`
      INSERT INTO mbox.table_session_customers(
        tenant_id,store_id,table_session_id,customer_id,relationship
      ) VALUES($1,$2,$3,$4,'primary')
    `,[tenantId,storeId,resolutionSessionId,resolutionCustomerId])
    const issued=await benefits.issue({
      ...issueCommand('resolution',300,1),customerId:resolutionCustomerId,
    })
    const reserved=await benefits.reserve({
      scope:{tenantId,storeId},actor:{type:'employee',employeeId},businessDate:'2026-08-11',
      benefitId:issued.value.id,customerId:resolutionCustomerId,tableSessionId:resolutionSessionId,quantity:1,
      expiresAt:new Date(Date.now()+10*60_000).toISOString(),
      reservationIdempotencyKey:'benefit-reserve-resolution-0001',
      reservationFingerprint:'benefit-reserve-resolution-fingerprint',
    })
    await benefits.redeem({
      scope:{tenantId,storeId},actor:{type:'employee',employeeId},businessDate:'2026-08-11',
      benefitId:issued.value.id,benefitReservationId:reserved.value.id,customerId:resolutionCustomerId,
      tableSessionId:resolutionSessionId,redeemedByEmployeeId:employeeId,
      authorizationSource:{kind:'employee',permission:'loyalty.redemption.fulfill'},
      redemptionIdempotencyKey:'benefit-redeem-resolution-0001',
      redemptionFingerprint:'benefit-redeem-resolution-fingerprint',
    })
    const order=await pool.query<{id:string;order_item_id:string}>(`
      SELECT orders.id,item.id AS order_item_id FROM mbox.orders orders
      JOIN mbox.benefit_redemptions redemption
        ON redemption.tenant_id=orders.tenant_id AND redemption.store_id=orders.store_id
       AND redemption.gift_order_reference=orders.public_id
      JOIN mbox.order_items item
        ON item.tenant_id=orders.tenant_id AND item.store_id=orders.store_id
       AND item.order_id=orders.id
      WHERE redemption.benefit_id=$1
    `,[issued.value.id])
    const orderId=order.rows[0]!.id
    const orderItemId=order.rows[0]!.order_item_id
    const inventoryItemId=randomUUID()
    await pool.query(`
      INSERT INTO mbox.inventory_items(
        id,tenant_id,store_id,sku,name,item_type,base_unit
      ) VALUES($1,$2,$3,$4,'Resolution Ingredient','ingredient','ml')
    `,[inventoryItemId,tenantId,storeId,`RES-${inventoryItemId.slice(0,8)}`])
    await pool.query(`
      INSERT INTO mbox.inventory_balances(
        tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity
      ) VALUES($1,$2,$3,10,1)
    `,[tenantId,storeId,inventoryItemId])
    await pool.query(`
      INSERT INTO mbox.inventory_order_reservations(
        tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,status,expires_at
      ) VALUES($1,$2,$3,$4,$5,1,'reserved',clock_timestamp()+interval '15 minutes')
    `,[tenantId,storeId,orderId,orderItemId,inventoryItemId])
    const intent=await pool.query<{id:string}>(`
      INSERT INTO mbox.complimentary_fulfillment_intents(
        tenant_id,store_id,order_id,benefit_id,status,attempt_count,next_attempt_at,
        last_error_code,last_error_at
      ) VALUES($1,$2,$3,$4,'failed',10,clock_timestamp(),
        'physical_fulfillment_lines_missing',clock_timestamp()) RETURNING id
    `,[tenantId,storeId,orderId,issued.value.id])
    const intentId=intent.rows[0]!.id
    const command={
      scope:{tenantId,storeId},employeeId,businessDate:'2026-08-11',intentId,
      action:'cancel_release' as const,reason:'现场确认尚未制作，取消系统出品',
      compensationReference:null,idempotencyKey:'benefit-resolution-cancel-0001',
    }
    const resolved=await resolutions.resolve(command)
    const replay=await resolutions.resolve(command)
    expect(resolved).toMatchObject({
      intentId,orderId,status:'cancelled',action:'cancel_release',
      releasedInventoryReservationCount:1,cancelledOrderItemCount:1,replayed:false,
    })
    expect(replay).toMatchObject({id:resolved.id,replayed:true})
    const facts=await pool.query<{
      order_status:string;payment_status:string;fulfillment_state:string;item_status:string
      intent_status:string;reservation_status:string;reserved_quantity:string
      events:string;audits:string;outbox:string
    }>(`
      SELECT
        (SELECT status FROM mbox.orders WHERE id=$1) AS order_status,
        (SELECT payment_status FROM mbox.orders WHERE id=$1) AS payment_status,
        (SELECT fulfillment_state FROM mbox.orders WHERE id=$1) AS fulfillment_state,
        (SELECT status FROM mbox.order_items WHERE order_id=$1 LIMIT 1) AS item_status,
        (SELECT status FROM mbox.complimentary_fulfillment_intents WHERE id=$2) AS intent_status,
        (SELECT status FROM mbox.inventory_order_reservations WHERE order_id=$1) AS reservation_status,
        (SELECT reserved_quantity::text FROM mbox.inventory_balances
          WHERE inventory_item_id=$3) AS reserved_quantity,
        (SELECT count(*)::text FROM mbox.complimentary_fulfillment_resolution_events
          WHERE intent_id=$2) AS events,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE object_id=$2::text AND action='loyalty.complimentary-fulfillment.cancelled') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE aggregate_id=$1 AND message_type='benefit.gift.fulfillment-resolved.v1') AS outbox
    `,[orderId,intentId,inventoryItemId])
    expect(facts.rows[0]).toEqual({
      order_status:'cancelled',payment_status:'unpaid',fulfillment_state:'cancelled',
      item_status:'cancelled',intent_status:'cancelled',reservation_status:'released',
      reserved_quantity:'0.000000',events:'1',audits:'1',outbox:'1',
    })
    const closure=await transactions.run({tenantId,storeId},(transaction) => (
      readTableSessionClosureState(transaction,resolutionSessionId)
    ),{readOnly:true})
    expect(closure.blockers).toEqual([])
    expect(closure.outstandingAmountMinor).toBe(0)
  })

  it('refuses to cancel a failed complimentary order when an item is already preparing without a KDS task', async () => {
    const preparingTableId=randomUUID()
    const preparingSessionId=randomUUID()
    const preparingCustomer=await customers.createAnonymous({
      scope:{tenantId,storeId},actor:{type:'system',ref:'preparing-seed'},
      businessDate:'2026-08-11',publicId:`benefit-preparing-customer-${randomUUID()}`,
      identityHash:randomUUID().replaceAll('-','').repeat(2),
      idempotencyKey:`benefit-preparing-customer-${randomUUID()}`,
      requestFingerprint:`benefit-preparing-customer-fingerprint-${randomUUID()}`,
    })
    const preparingCustomerId=preparingCustomer.value.customer.id
    await pool.query(`
      INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,$5,'Preparing Table',4)
    `,[preparingTableId,tenantId,storeId,areaId,`P${preparingTableId.slice(0,4)}`])
    await pool.query(`
      INSERT INTO mbox.table_sessions(
        id,tenant_id,store_id,table_id,public_id,business_date,guest_count
      ) VALUES($1,$2,$3,$4,$5,'2026-08-11',1)
    `,[preparingSessionId,tenantId,storeId,preparingTableId,
      `benefit-preparing-session-${preparingSessionId}`])
    await pool.query(`
      INSERT INTO mbox.table_session_customers(
        tenant_id,store_id,table_session_id,customer_id,relationship
      ) VALUES($1,$2,$3,$4,'primary')
    `,[tenantId,storeId,preparingSessionId,preparingCustomerId])
    const issued=await benefits.issue({
      ...issueCommand(`preparing-${preparingTableId.slice(0,8)}`,300,1),
      customerId:preparingCustomerId,
    })
    const reserved=await benefits.reserve({
      scope:{tenantId,storeId},actor:{type:'employee',employeeId},businessDate:'2026-08-11',
      benefitId:issued.value.id,customerId:preparingCustomerId,tableSessionId:preparingSessionId,quantity:1,
      expiresAt:new Date(Date.now()+10*60_000).toISOString(),
      reservationIdempotencyKey:`benefit-reserve-preparing-${preparingTableId}`,
      reservationFingerprint:`benefit-reserve-preparing-fingerprint-${preparingTableId}`,
    })
    await benefits.redeem({
      scope:{tenantId,storeId},actor:{type:'employee',employeeId},businessDate:'2026-08-11',
      benefitId:issued.value.id,benefitReservationId:reserved.value.id,customerId:preparingCustomerId,
      tableSessionId:preparingSessionId,redeemedByEmployeeId:employeeId,
      authorizationSource:{kind:'employee',permission:'loyalty.redemption.fulfill'},
      redemptionIdempotencyKey:`benefit-redeem-preparing-${preparingTableId}`,
      redemptionFingerprint:`benefit-redeem-preparing-fingerprint-${preparingTableId}`,
    })
    const order=await pool.query<{id:string;order_item_id:string}>(`
      SELECT orders.id,item.id AS order_item_id FROM mbox.orders orders
      JOIN mbox.benefit_redemptions redemption
        ON redemption.tenant_id=orders.tenant_id AND redemption.store_id=orders.store_id
       AND redemption.gift_order_reference=orders.public_id
      JOIN mbox.order_items item
        ON item.tenant_id=orders.tenant_id AND item.store_id=orders.store_id
       AND item.order_id=orders.id
      WHERE redemption.benefit_id=$1
    `,[issued.value.id])
    const orderId=order.rows[0]!.id
    const orderItemId=order.rows[0]!.order_item_id
    await pool.query(`UPDATE mbox.order_items SET status='preparing' WHERE id=$1`,[orderItemId])
    const intent=await pool.query<{id:string}>(`
      INSERT INTO mbox.complimentary_fulfillment_intents(
        tenant_id,store_id,order_id,benefit_id,status,attempt_count,next_attempt_at,
        last_error_code,last_error_at
      ) VALUES($1,$2,$3,$4,'failed',10,clock_timestamp(),
        'kds_task_missing',clock_timestamp()) RETURNING id
    `,[tenantId,storeId,orderId,issued.value.id])
    const intentId=intent.rows[0]!.id
    await expect(resolutions.resolve({
      scope:{tenantId,storeId},employeeId,businessDate:'2026-08-11',intentId,
      action:'cancel_release',reason:'测试制作中商品不能被取消',compensationReference:null,
      idempotencyKey:`benefit-preparing-resolution-${preparingTableId}`,
    })).rejects.toMatchObject<Partial<ComplimentaryFulfillmentResolutionError>>({
      code:'COMPLIMENTARY_FULFILLMENT_ALREADY_PREPARING',
    })
    const facts=await pool.query<{
      order_status:string;payment_status:string;fulfillment_state:string;item_status:string
      intent_status:string;events:string
    }>(`
      SELECT
        (SELECT status FROM mbox.orders WHERE id=$1) AS order_status,
        (SELECT payment_status FROM mbox.orders WHERE id=$1) AS payment_status,
        (SELECT fulfillment_state FROM mbox.orders WHERE id=$1) AS fulfillment_state,
        (SELECT status FROM mbox.order_items WHERE id=$2) AS item_status,
        (SELECT status FROM mbox.complimentary_fulfillment_intents WHERE id=$3) AS intent_status,
        (SELECT count(*)::text FROM mbox.complimentary_fulfillment_resolution_events
          WHERE intent_id=$3) AS events
    `,[orderId,orderItemId,intentId])
    expect(facts.rows[0]).toEqual({
      order_status:'submitted',payment_status:'paid',fulfillment_state:'active',
      item_status:'preparing',intent_status:'failed',events:'0',
    })
  })

  it('grants only least-privilege runtime access to immutable customer and redemption facts', async () => {
    const privileges = await pool.query<{
      event_update: boolean
      redemption_update: boolean
      tag_delete: boolean
    }>(`
      SELECT
        has_table_privilege('mbox_runtime', 'mbox.customer_events', 'UPDATE') AS event_update,
        has_table_privilege('mbox_runtime', 'mbox.benefit_redemptions', 'UPDATE') AS redemption_update,
        has_table_privilege('mbox_runtime', 'mbox.customer_tags', 'DELETE') AS tag_delete
    `)
    expect(privileges.rows[0]).toEqual({
      event_update: false,
      redemption_update: false,
      tag_delete: true,
    })
  })

  it('paginates complete wallet with microsecond cursors, no duplicate rows or other customer leakage', async () => {
    const isolated = await customers.createAnonymous({
      scope: { tenantId, storeId }, actor: { type: 'system', ref: 'wallet-test' }, businessDate: '2026-08-11',
      publicId: 'wallet-customer-public-0001', identityHash: 'a'.repeat(64),
      idempotencyKey: 'wallet-customer-create-0001', requestFingerprint: 'wallet-customer-fingerprint',
    })
    const walletCustomer = isolated.value.customer.id
    const ids: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const issued = await benefits.issue({ ...issueCommand(`wallet-${index}`, 100, 1), customerId: walletCustomer })
      ids.push(issued.value.id)
      await pool.query(`UPDATE mbox.benefits SET created_at = $2::timestamptz,
        valid_from = CASE WHEN $3 = 0 THEN '2099-01-01'::timestamptz ELSE valid_from END,
        valid_until = '2100-01-01'::timestamptz,
        status = CASE WHEN $3 = 1 THEN 'revoked' ELSE status END
        WHERE id = $1`, [issued.value.id, `2026-09-09 04:00:00.12345${index}+00`, index])
    }
    const read = (cursor: string | null) => transactions.run({ tenantId, storeId },
      (transaction) => new BenefitRepository(transaction).listWalletForCustomer(walletCustomer, parseBenefitWalletCursor(cursor ?? undefined), 1), { readOnly: true })
    const first = await read(null)
    const second = await read(first.nextCursor)
    const third = await read(second.nextCursor)
    expect([first.items[0]!.id, second.items[0]!.id, third.items[0]!.id]).toEqual(ids.toReversed())
    expect(second.items[0]!.status).toBe('revoked')
    expect(third.items[0]!.validFrom).toContain('2099-01-01')
    expect(third.nextCursor).toBeNull()
  })

  it('persists calendar versions and atomically caps multiple issued coupons of one customer', async () => {
    const scope = { tenantId, storeId }
    const rule = currentCalendar()
    const draftInput = { code: 'CALENDAR_SHARED', rule, limits: { perCustomerDay: 1, perCustomerWeek: 2, perCustomerCampaign: 3 },
      employeeId, businessDate: '2026-08-11', reason: '时间次数联动测试', requestKey: randomUUID(), expectedVersion: 0 }
    const draft = await transactions.run(scope, tx => new CouponCalendarRepository(tx).save(draftInput))
    const replay = await transactions.run(scope, tx => new CouponCalendarRepository(tx).save(draftInput))
    expect(replay.id).toBe(draft.id)
    expect(replay.replayed).toBe(true)
    const decisionGuard = await pool.connect()
    try {
      await decisionGuard.query('BEGIN')
      await decisionGuard.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`coupon-calendar:${tenantId}:${storeId}:decision:${draft.id}`])
      await expect(pool.query('INSERT INTO mbox.coupon_calendar_exclusions(tenant_id,store_id,version_id,excluded_date) VALUES($1,$2,$3,$4)', [tenantId, storeId, draft.id, rule.dateFrom])).rejects.toThrow('decision in progress')
    } finally {
      await decisionGuard.query('ROLLBACK')
      decisionGuard.release()
    }
    await expect(benefits.issue({ ...issueCommand('unpublished-calendar', 100, 1), couponCalendarVersionId: draft.id })).rejects.toThrow('规则未发布')
    const [approver, publisher] = await calendarReviewers()
    const decision = (action: 'approve' | 'publish' | 'stop_issuing', actor: string) => transactions.run(scope, tx => new CouponCalendarRepository(tx).decide({
      versionId: draft.id, action, employeeId: actor, businessDate: '2026-08-11', reason: '隔离测试审批发布',
    }))
    await decision('approve', approver)
    await expect(decision('publish', approver)).rejects.toThrow('审批人之外')
    await decision('publish', publisher)
    await expect(pool.query('INSERT INTO mbox.coupon_calendar_exclusions(tenant_id,store_id,version_id,excluded_date) VALUES($1,$2,$3,$4)', [tenantId, storeId, draft.id, rule.dateFrom])).rejects.toThrow('cannot acquire')
    const issued = await Promise.all(['calendar-a','calendar-b'].map(suffix => benefits.issue({ ...issueCommand(suffix, 100, 1), couponCalendarVersionId: draft.id })))
    const reserve = (benefitId: string, suffix: string) => benefits.reserve({ scope, actor: { type: 'guest', ref: guestActorRef }, businessDate: '2026-08-11',
      benefitId, customerId, tableSessionId, quantity: 1, expiresAt: new Date(Date.now() + 600000).toISOString(),
      reservationIdempotencyKey: `calendar-reserve-${suffix}`, reservationFingerprint: suffix })
    const attempts = await Promise.allSettled(issued.map((item, index) => reserve(item.value.id, String(index))))
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const failed = attempts.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(String(failed.reason)).toContain('当日使用上限')
    const successIndex = attempts.findIndex(result => result.status === 'fulfilled')
    const success = attempts[successIndex] as PromiseFulfilledResult<Awaited<ReturnType<typeof reserve>>>
    const original = await reserve(issued[successIndex]!.value.id, String(successIndex))
    expect(original.value.id).toBe(success.value.value.id)
    await benefits.cancelReservation({ scope, actor: { type: 'guest', ref: guestActorRef }, businessDate: '2026-08-11',
      benefitReservationId: original.value.id, customerId, tableSessionId, reason: '客户取消未履约占用', cancellationIdempotencyKey: randomUUID(), cancellationFingerprint: randomUUID() })
    await decision('stop_issuing', publisher)
    await expect(benefits.issue({ ...issueCommand('calendar-stopped', 100, 1), couponCalendarVersionId: draft.id })).rejects.toThrow('已停发')
    const preserved = await reserve(issued[1 - successIndex]!.value.id, 'after-cancel-and-stop')
    expect(preserved.value.status).toBe('reserved')
    await expect(transactions.run(scope, tx => new CouponCalendarRepository(tx).save({ ...draftInput, requestKey: randomUUID(), expectedVersion: 1,
      rule: { ...rule, weekStartsOn: 7 } }))).rejects.toThrow('周起点不可改写')
  })

  it('rejects an excluded current day without consuming quantity and does not affect an old unbound benefit', async () => {
    const scope = { tenantId, storeId }
    const rule = currentCalendar()
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10)
    const draft = await transactions.run(scope, tx => new CouponCalendarRepository(tx).save({ code: 'CALENDAR_EXCLUDED', rule: { ...rule, excludedDates: [today] },
      limits: { perCustomerDay: null, perCustomerWeek: null, perCustomerCampaign: null }, employeeId, businessDate: '2026-08-11',
      reason: '排除日期不占用测试', requestKey: randomUUID(), expectedVersion: 0 }))
    const [approver, publisher] = await calendarReviewers()
    for (const [action, actor] of [['approve', approver], ['publish', publisher]] as const) await transactions.run(scope, tx => new CouponCalendarRepository(tx).decide({ versionId: draft.id, action, employeeId: actor, businessDate: '2026-08-11', reason: '隔离规则测试批准' }))
    const issued = await benefits.issue({ ...issueCommand('calendar-excluded',100,1), couponCalendarVersionId: draft.id })
    await expect(benefits.reserve({ scope, actor: { type: 'guest', ref: guestActorRef }, businessDate: '2026-08-11', benefitId: issued.value.id, customerId, tableSessionId,
      expiresAt: new Date(Date.now()+600000).toISOString(), reservationIdempotencyKey: randomUUID(), reservationFingerprint: randomUUID() })).rejects.toThrow('不在此券可用时段')
    const saved = await transactions.run(scope, tx => new BenefitRepository(tx).findById(issued.value.id))
    expect(saved?.quantityAvailable).toBe(1)
    const wallet = await transactions.run(scope, tx => new BenefitRepository(tx).listWalletForCustomer(customerId, null, 50))
    expect(wallet.items.find(item => item.id === issued.value.id)?.calendar).toMatchObject({ available: false })
    const available = await transactions.run(scope, tx => new BenefitRepository(tx).listAvailableForCustomer(customerId))
    expect(available.some(item => item.id === issued.value.id)).toBe(false)
  })

  it.each([
    ['WEEK_CAP', { perCustomerDay: null, perCustomerWeek: 1, perCustomerCampaign: 2 }, '本周'],
    ['CAMPAIGN_CAP', { perCustomerDay: null, perCustomerWeek: null, perCustomerCampaign: 1 }, '本活动'],
  ] as const)('enforces independent %s across two issued coupons', async (code, limits, label) => {
    const scope = { tenantId,storeId }
    const draft = await transactions.run(scope, tx => new CouponCalendarRepository(tx).save({ code, rule: currentCalendar(), limits, employeeId,
      businessDate: '2026-08-11', reason: '独立次数上限测试', requestKey: randomUUID(), expectedVersion: 0 }))
    const [approver, publisher] = await calendarReviewers()
    for (const [action, actor] of [['approve',approver],['publish',publisher]] as const) await transactions.run(scope, tx => new CouponCalendarRepository(tx).decide({
      versionId: draft.id, action, employeeId: actor, businessDate: '2026-08-11', reason: '隔离次数验证审批' }))
    const reserve = async (suffix: string) => {
      const issued = await benefits.issue({ ...issueCommand(`${code}-${suffix}`,100,1), couponCalendarVersionId: draft.id })
      return benefits.reserve({ scope, actor: { type: 'guest', ref: guestActorRef }, businessDate: '2026-08-11', benefitId: issued.value.id, customerId, tableSessionId,
        expiresAt: new Date(Date.now()+600000).toISOString(), reservationIdempotencyKey: randomUUID(), reservationFingerprint: randomUUID() })
    }
    await reserve('first')
    await expect(reserve('second')).rejects.toThrow(`已达到${label}使用上限`)
  })

  it('keeps pre-merge reservations cancellable and redeemable only by the canonical customer family', async () => {
    const scope = { tenantId, storeId }
    const create = () => customers.createAnonymous({ scope, actor: { type: 'system', ref: 'merge-test' }, businessDate: '2026-08-11',
      publicId: `calendar-merge-${randomUUID()}`, identityHash: randomUUID().replaceAll('-','').repeat(2), idempotencyKey: randomUUID(), requestFingerprint: randomUUID() })
    const source = (await create()).value.customer.id, target = (await create()).value.customer.id
    const mergeTable = randomUUID(), mergeSession = randomUUID()
    await pool.query('INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)', [mergeTable,tenantId,storeId,areaId,`M${mergeTable.slice(0,6)}`])
    await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,'2026-08-11',1)`, [mergeSession,tenantId,storeId,mergeTable,`merge-${mergeSession}`])
    await pool.query(`INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship) VALUES($1,$2,$3,$4,'primary')`, [tenantId,storeId,mergeSession,source])
    const actorRef = await seedActiveGuestTableAuthority(pool,{tenantId,storeId,tableSessionId:mergeSession,customerId:source})
    const issued = await benefits.issue({ ...issueCommand('merge-reservations',100,2), customerId: source })
    const reserve = () => benefits.reserve({ scope, actor: { type: 'guest', ref: actorRef }, businessDate: '2026-08-11', benefitId: issued.value.id,
      customerId: source, tableSessionId: mergeSession, expiresAt: new Date(Date.now()+600000).toISOString(), reservationIdempotencyKey: randomUUID(), reservationFingerprint: randomUUID() })
    const first = await reserve(), second = await reserve()
    await customers.merge({ scope, actor: { type: 'system', ref: 'verified-merge-test' }, businessDate: '2026-08-11', sourceCustomerId: source, targetCustomerId: target,
      reason: '隔离库已核验身份合并', idempotencyKey: randomUUID(), requestFingerprint: randomUUID() })
    const cancelled = await benefits.cancelReservation({ scope, actor: { type: 'guest', ref: actorRef }, businessDate: '2026-08-11', benefitReservationId: first.value.id,
      customerId: target, tableSessionId: mergeSession, reason: '合并后取消原占用', cancellationIdempotencyKey: randomUUID(), cancellationFingerprint: randomUUID() })
    expect(cancelled.value.status).toBe('cancelled')
    const redeemed = await benefits.redeem({ scope, actor: { type: 'guest', ref: actorRef }, businessDate: '2026-08-11', benefitId: issued.value.id,
      benefitReservationId: second.value.id, customerId: target, tableSessionId: mergeSession, selectedProductId: productId, redeemedByEmployeeId: employeeId,
      authorizationSource: { kind: 'verified-merge-test' }, redemptionIdempotencyKey: randomUUID(), redemptionFingerprint: randomUUID() })
    expect(redeemed.value.benefitReservationId).toBe(second.value.id)
    expect(redeemed.value.customerId).toBe(source) // original financial provenance is retained
    const facts = await transactions.run(scope, tx => new BenefitRepository(tx).findById(issued.value.id))
    expect(facts).toMatchObject({ quantityReserved: 0, quantityRedeemed: 1, quantityAvailable: 1 })
  })

  function currentCalendar() {
    const date = (offset: number) => new Date(Date.now()+offset*86400000+8*3600000).toISOString().slice(0,10)
    return { timezone: 'Asia/Shanghai', dateBasis: 'natural', businessDayStartMinute: 0, dateFrom: date(-1), dateThrough: date(2),
      validFrom: `${date(-1)}T00:00:00+08:00`, validUntil: `${date(3)}T00:00:00+08:00`, weekdays: [1,2,3,4,5,6,7], weekStartsOn: 1,
      windows: [{ startMinute: 0, endMinute: 1440 }], excludedDates: [] as string[] }
  }
  it('freezes relative coupon expiry once and clips wallet calendar to this coupon instead of the campaign',async()=>{
    const scope={tenantId,storeId},rule={...currentCalendar(),relativeValidity:{days:1,basis:'elapsed'}}
    const draft=await transactions.run(scope,tx=>new CouponCalendarRepository(tx).save({code:'RELATIVE_VALIDITY',rule,limits:{perCustomerDay:null,perCustomerWeek:null,perCustomerCampaign:null},employeeId,businessDate:'2026-08-11',reason:'相对有效期测试',requestKey:randomUUID(),expectedVersion:0}))
    expect(draft.rule.relativeValidity).toEqual({days:1,basis:'elapsed'})
    const [approver,publisher]=await calendarReviewers()
    for(const [action,actor] of [['approve',approver],['publish',publisher]] as const)await transactions.run(scope,tx=>new CouponCalendarRepository(tx).decide({versionId:draft.id,action,employeeId:actor,businessDate:'2026-08-11',reason:'相对有效期批准'}))
    const input={...issueCommand('relative-validity',100,1),validUntil:new Date(Date.now()+10*86400000).toISOString(),couponCalendarVersionId:draft.id}
    const first=await benefits.issue(input),replay=await benefits.issue(input)
    expect(replay.value.id).toBe(first.value.id)
    expect(replay.value.validUntil).toBe(first.value.validUntil)
    expect(Date.parse(first.value.validUntil!)-Date.parse(first.value.validFrom)).toBe(86400000)
    const wallet=await transactions.run(scope,tx=>new CouponCalendarRepository(tx).walletViews([first.value.id],new Date(first.value.validUntil!)))
    expect(wallet.get(first.value.id)).toMatchObject({available:false,nextAvailableAt:null,lastAvailableUntil:new Date(first.value.validUntil!).toISOString()})
  })
  it('fails a benefit action promptly while identity movement owns the guard instead of waiting on table locks', async () => {
    const issued = await benefits.issue(issueCommand('identity-contention', 100, 1))
    const owner = await pool.connect()
    try {
      await owner.query('BEGIN')
      await owner.query(`SELECT pg_advisory_xact_lock(hashtextextended('table-customer-movement:' || $1::text || ':' || $2::text,0))`, [tenantId,storeId])
      await expect(benefits.reserve({ scope: { tenantId,storeId }, actor: { type: 'guest', ref: guestActorRef }, businessDate: '2026-08-11',
        benefitId: issued.value.id, customerId, tableSessionId, expiresAt: new Date(Date.now()+600000).toISOString(), reservationIdempotencyKey: randomUUID(), reservationFingerprint: randomUUID() })).rejects.toThrow('客户身份正在同步')
    } finally { await owner.query('ROLLBACK'); owner.release() }
  })
  async function calendarReviewers(): Promise<[string,string]> {
    const people: [string,string] = [randomUUID(),randomUUID()]
    const reviewRole = randomUUID()
    await pool.query('INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,$4)', [reviewRole,tenantId,storeId,`REVIEW_${reviewRole.slice(0,8).toUpperCase()}`])
    await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code IN ('loyalty.configuration.approve','loyalty.policy.publish')`, [tenantId,storeId,reviewRole])
    for (const person of people) {
      await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)', [person,tenantId,storeId,`person-${person}`])
      // This fixture means "already authorized", not a future-start boundary:
      // PostgreSQL defaults keep microseconds while the app clock keeps ms.
      await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 minute')", [tenantId,storeId,person,reviewRole])
    }
    return people
  }

  function issueCommand(suffix: string, valueAmountMinor: number, quantity: number) {
    return {
      scope: { tenantId, storeId },
      actor: { type: 'employee' as const, employeeId },
      businessDate: '2026-08-11', customerId,
      benefitCode: `gift.${suffix}`,
      benefitType: 'gift_product' as const,
      valueAmountMinor,
      currency: 'CNY',
      quantity,
      allowedProductIds: [productId],
      benefitSnapshot: { productCode: 'BEER-001', publicDisplay: { title: '生日赠饮' } },
      validUntil: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      issuedByEmployeeId: employeeId,
      authorizationLimitId: approvalLimitId,
      reason: '客户生日现场关怀',
      authorizationSource: { kind: 'role_approval_limit', approvalLimitId },
      issuanceIdempotencyKey: `benefit-issue-${suffix}-0001`,
      issuanceFingerprint: `benefit-issue-${suffix}-fingerprint`,
    }
  }

  async function seedStore(): Promise<void> {
    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Benefit Tenant')`,
      [tenantId, `benefit-${tenantId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.stores (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Benefit Store')`,
      [storeId, tenantId, `store-${storeId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.products (
      id, tenant_id, store_id, code, name, category_code, fulfillment_station
    ) VALUES ($1, $2, $3, 'BENEFIT-GIFT', 'Benefit Gift Product', 'drink', 'bar')`,
    [productId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
      VALUES ($1, $2, $3, 'BENEFIT', 'Benefit Area', 'indoor')`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1, $2, $3, $4, 'B01', 'Benefit Table', 4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1, $2, $3, 'MANAGER_BENEFIT', 'Benefit Manager')`, [employeeId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.roles (id, tenant_id, store_id, code, name)
      VALUES ($1, $2, $3, 'BENEFIT_MANAGER', 'Benefit Manager')`, [roleId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.employee_roles (tenant_id, store_id, employee_id, role_id)
      VALUES ($1, $2, $3, $4)`, [tenantId, storeId, employeeId, roleId])
    await pool.query(`INSERT INTO mbox.staff_permission_definitions (
      tenant_id, store_id, code, name, category
    ) VALUES
      ($1, $2, 'benefit.issue', 'Issue benefit', 'customer_benefit'),
      ($1, $2, 'loyalty.redemption.fulfill', 'Fulfill loyalty redemption', 'customer_benefit'),
      ($1, $2, 'benefit.cancel', 'Cancel benefit', 'customer_benefit'),
      ($1, $2, 'loyalty.redemption.exception', 'Resolve benefit exception', 'customer_benefit'),
      ($1, $2, 'table.view_all', 'View all tables', 'table')
      ON CONFLICT (tenant_id, store_id, code) DO NOTHING`, [tenantId, storeId])
    await pool.query(`INSERT INTO mbox.role_permission_assignments (tenant_id, store_id, role_id, permission_id)
      SELECT $1, $2, $3, id FROM mbox.staff_permission_definitions
      WHERE tenant_id = $1 AND store_id = $2
        AND code IN ('benefit.issue', 'loyalty.redemption.fulfill', 'loyalty.redemption.exception',
          'benefit.cancel', 'table.view_all')`,
    [tenantId, storeId, roleId])
    await pool.query(`INSERT INTO mbox.role_approval_limits (
      id, tenant_id, store_id, role_id, approval_code, amount_minor, currency
    ) VALUES ($1, $2, $3, $4, 'benefit.issue', 1000, 'CNY')`,
    [approvalLimitId, tenantId, storeId, roleId])
  }
})

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
