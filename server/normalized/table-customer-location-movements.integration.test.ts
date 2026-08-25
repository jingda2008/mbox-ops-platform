import { createHash, randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { tableManagementApiPlugin } from './table-management-api.js'
import { TableManagementCommandService } from './table-management-repository.js'
import { ScopedPostgresTransactionRunner,type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('table customer location movements', () => {
  const tenantId=randomUUID()
  const storeId=randomUUID()
  const areaId=randomUUID()
  const employeeId=randomUUID()
  const unauthorizedEmployeeId=randomUUID()
  const roleId=randomUUID()
  const tables=Array.from({ length: 43 }, () => randomUUID())
  let pool: Pool

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({ connectionString: databaseUrl, max: 8 })
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Location Tenant')`,
      [tenantId,`location-${tenantId.slice(0,8)}`])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Location Store')`,
      [storeId,tenantId,`location-${storeId.slice(0,8)}`])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type,sort_order)
      VALUES($1,$2,$3,'MAIN','主区','indoor',1)`,[areaId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,'manager','李艳')`,[employeeId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,'unassigned','未授权员工')`,[unauthorizedEmployeeId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name)
      VALUES($1,$2,$3,'STORE_MANAGER','店长')`,[roleId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at)
      VALUES($1,$2,$3,$4,'2026-01-01T00:00:00Z')`,[tenantId,storeId,employeeId,roleId])
    await pool.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name)
      VALUES($1,$2,'table.transfer','转桌'),($1,$2,'table.participation.manage','跨桌顾客管理')
      ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name`,[tenantId,storeId])
    await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
      SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions
      WHERE tenant_id=$1 AND store_id=$2 AND code IN ('table.transfer','table.participation.manage')
      ON CONFLICT DO NOTHING`,[tenantId,storeId,roleId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      SELECT id,$4,$5,$6,code,code,capacity FROM unnest(
        $1::uuid[],$2::text[],$3::integer[]
      ) AS seeded(id,code,capacity)`,[
      tables,tables.map((_,index) => `T${String(index+1).padStart(2,'0')}`),
      tables.map((_,index) => index===14 ? 1 : 8),tenantId,storeId,areaId,
    ])
  })

  afterAll(async () => { await pool?.end() })

  it('moves an unscanned whole table and rejects direct runtime evidence or location writes', async () => {
    const source=await createSession(tables[0]!,2)
    const result=await runtimeMovement({
      kind:'whole_table_transfer',sourceSessionId:source,targetSessionId:null,targetTableId:tables[1]!,
      movedGuestCount:2,participantIds:[],roles:[],confirmations:[],key:`whole-${randomUUID()}`,
    })
    expect(result.moved_participant_count).toBe(0)
    const current=await pool.query(`SELECT table_id,location_version,current_location_movement_event_id
      FROM mbox.table_sessions WHERE id=$1`,[source])
    expect(current.rows[0]).toMatchObject({
      table_id:tables[1],location_version:'1',current_location_movement_event_id:result.movement_event_id,
    })
    const client=await runtimeClient()
    try {
      await expect(client.query(`UPDATE mbox.table_sessions SET table_id=$1 WHERE id=$2`,[tables[0],source]))
        .rejects.toMatchObject({ code:'42501' })
    } finally { await rollback(client) }
    const evidenceClient=await runtimeClient()
    try {
      await expect(evidenceClient.query(`INSERT INTO mbox.table_customer_movement_events(
        tenant_id,store_id,public_id,movement_kind,source_table_session_id,source_table_id,
        target_table_session_id,target_table_id,moved_guest_count,moved_participant_count,
        moved_by_employee_id,reason,idempotency_key,request_fingerprint,location_version
      ) VALUES($1,$2,'forged-movement','whole_table_transfer',$3,$4,$3,$5,2,0,$6,'伪造换桌',
        'forged-key-123',repeat('a',64),2)`,[tenantId,storeId,source,tables[1],tables[0],employeeId]))
        .rejects.toMatchObject({ code:'42501' })
    } finally { await rollback(evidenceClient) }
  })

  it('splits explicit participants into a newly opened real-count session and revokes their old token', async () => {
    const source=await createSession(tables[2]!,3)
    const customer=await createCustomer('split')
    const credential=await createCredential(tables[2]!)
    const participation=await ensurePosition(credential,source,customer)
    const guestSession=await createGuestSession(source,customer,tables[2]!)
    const result=await runtimeMovement({
      kind:'participant_split',sourceSessionId:source,targetSessionId:null,targetTableId:tables[3]!,
      movedGuestCount:1,participantIds:[participation],roles:['companion'],confirmations:['confirmed'],
      key:`split-${randomUUID()}`,splitPublicId:`split-${randomUUID()}`,
    })
    const state=await pool.query(`SELECT id,table_id,guest_count,status FROM mbox.table_sessions
      WHERE id=ANY($1::uuid[]) ORDER BY id`,[[source,result.target_table_session_id]])
    expect(state.rows.find((row) => row.id===source)).toMatchObject({ guest_count:2,status:'open' })
    expect(state.rows.find((row) => row.id===result.target_table_session_id))
      .toMatchObject({ table_id:tables[3],guest_count:1,status:'open' })
    const token=await pool.query(`SELECT revoked_at,revoke_reason FROM mbox.guest_sessions WHERE id=$1`,[guestSession])
    expect(token.rows[0]?.revoked_at).not.toBeNull()
    expect(token.rows[0]?.revoke_reason).toBe('table_location_changed')
    const segments=await pool.query(`SELECT table_id,left_reason_code,left_at FROM mbox.table_session_customer_participations
      WHERE customer_id=$1 ORDER BY location_started_at`,[customer])
    expect(segments.rows).toHaveLength(2)
    expect(segments.rows[0]).toMatchObject({ table_id:tables[2],left_reason_code:'participant_split' })
    expect(segments.rows[1]).toMatchObject({ table_id:tables[3],left_at:null })
  })

  it('fully merges an unscanned source group, preserves historical guest count, and releases its table', async () => {
    const source=await createSession(tables[4]!,2)
    const target=await createSession(tables[5]!,3)
    await runtimeMovement({
      kind:'participant_merge',sourceSessionId:source,targetSessionId:target,targetTableId:tables[5]!,
      movedGuestCount:2,participantIds:[],roles:[],confirmations:[],key:`merge-${randomUUID()}`,
    })
    const sessions=await pool.query(`SELECT id,guest_count,status FROM mbox.table_sessions
      WHERE id=ANY($1::uuid[])`,[[source,target]])
    expect(sessions.rows.find((row) => row.id===source)).toMatchObject({ guest_count:2,status:'closed' })
    expect(sessions.rows.find((row) => row.id===target)).toMatchObject({ guest_count:5,status:'open' })
    const replacement=await createSession(tables[4]!,1)
    expect(replacement).toMatch(/[0-9a-f-]{36}/)
  })

  it('keeps the target organizer when identified participants fully or partially merge', async () => {
    const source=await createSession(tables[20]!,2)
    const target=await createSession(tables[21]!,1)
    const sourceOrganizer=await createCustomer('merge-source-organizer')
    const sourceCompanion=await createCustomer('merge-source-companion')
    const targetOrganizer=await createCustomer('merge-target-organizer')
    const sourceOrganizerPosition=await linkParticipant(source,sourceOrganizer,'primary')
    const sourceCompanionPosition=await linkParticipant(source,sourceCompanion,'guest')
    await linkParticipant(target,targetOrganizer,'primary')
    await expect(runtimeMovement({
      kind:'participant_merge',sourceSessionId:source,targetSessionId:target,
      targetTableId:tables[21]!,movedGuestCount:2,participantIds:[sourceOrganizerPosition],
      roles:['organizer'],confirmations:['confirmed'],key:`identified-incomplete-${randomUUID()}`,
    })).rejects.toMatchObject({ code:'22023' })
    const before=await pool.query(`SELECT id,status,guest_count FROM mbox.table_sessions
      WHERE id=ANY($1::uuid[])`,[[source,target]])
    expect(before.rows.find((row) => row.id===source)).toMatchObject({ status:'open',guest_count:2 })
    expect(before.rows.find((row) => row.id===target)).toMatchObject({ status:'open',guest_count:1 })

    const merged=await runtimeMovement({
      kind:'participant_merge',sourceSessionId:source,targetSessionId:target,
      targetTableId:tables[21]!,movedGuestCount:2,
      participantIds:[sourceOrganizerPosition,sourceCompanionPosition],
      roles:['organizer','companion'],confirmations:['confirmed','confirmed'],
      key:`identified-complete-${randomUUID()}`,
    })
    const targetRoles=await pool.query(`SELECT customer_id,participation_role
      FROM mbox.table_session_customer_participations
      WHERE table_session_id=$1 AND table_id=$2 AND left_at IS NULL ORDER BY customer_id`,
    [target,tables[21]])
    expect(targetRoles.rows.filter((row) => row.participation_role==='organizer')).toHaveLength(1)
    expect(targetRoles.rows.find((row) => row.customer_id===sourceOrganizer))
      .toMatchObject({ participation_role:'companion' })
    const roleEvidence=await pool.query(`SELECT source_role,target_role
      FROM mbox.table_customer_movement_members WHERE movement_event_id=$1
        AND source_participation_id=$2`,[merged.movement_event_id,sourceOrganizerPosition])
    expect(roleEvidence.rows[0]).toEqual({ source_role:'organizer',target_role:'companion' })

    const partialSource=await createSession(tables[22]!,2)
    const partialTarget=await createSession(tables[23]!,1)
    const partialOrganizer=await createCustomer('partial-source-organizer')
    const partialTargetOrganizer=await createCustomer('partial-target-organizer')
    const partialPosition=await linkParticipant(partialSource,partialOrganizer,'primary')
    await linkParticipant(partialTarget,partialTargetOrganizer,'primary')
    const forgedConfirmationKey=`forged-confirmation-${randomUUID()}`
    await expect(runtimeMovement({
      kind:'participant_merge',sourceSessionId:partialSource,targetSessionId:partialTarget,
      targetTableId:tables[23]!,movedGuestCount:1,participantIds:[partialPosition],
      roles:['organizer'],confirmations:['corrected'],key:forgedConfirmationKey,
    })).rejects.toMatchObject({ code:'22023' })
    const forgedEvidence=await pool.query(`SELECT count(*)::integer AS count
      FROM mbox.table_customer_movement_events WHERE tenant_id=$1 AND store_id=$2
        AND idempotency_key=$3`,[tenantId,storeId,forgedConfirmationKey])
    expect(forgedEvidence.rows[0]?.count).toBe(0)
    const partial=await runtimeMovement({
      kind:'participant_merge',sourceSessionId:partialSource,targetSessionId:partialTarget,
      targetTableId:tables[23]!,movedGuestCount:1,participantIds:[partialPosition],
      roles:['organizer'],confirmations:['confirmed'],key:`partial-organizer-${randomUUID()}`,
    })
    const partialRole=await pool.query(`SELECT target_role FROM mbox.table_customer_movement_members
      WHERE movement_event_id=$1 AND source_participation_id=$2`,
    [partial.movement_event_id,partialPosition])
    expect(partialRole.rows[0]?.target_role).toBe('companion')
  })

  it('splits identified participants with additional unscanned companions while leaving the source open', async () => {
    const source=await createSession(tables[24]!,3)
    const customer=await createCustomer('split-unscanned-companions')
    const participation=await linkParticipant(source,customer,'guest')
    const moved=await runtimeMovement({
      kind:'participant_split',sourceSessionId:source,targetSessionId:null,targetTableId:tables[25]!,
      movedGuestCount:2,participantIds:[participation],roles:['companion'],confirmations:['confirmed'],
      key:`split-unscanned-${randomUUID()}`,splitPublicId:`split-unscanned-${randomUUID()}`,
    })
    const sessions=await pool.query(`SELECT id,status,guest_count FROM mbox.table_sessions
      WHERE id=ANY($1::uuid[])`,[[source,moved.target_table_session_id]])
    expect(sessions.rows.find((row) => row.id===source)).toMatchObject({ status:'open',guest_count:1 })
    expect(sessions.rows.find((row) => row.id===moved.target_table_session_id))
      .toMatchObject({ status:'open',guest_count:2 })
    expect(moved.moved_participant_count).toBe(1)
  })

  it('blocks full merge on unfinished KDS work and never migrates historical commerce references', async () => {
    const source=await createSession(tables[26]!,1)
    const target=await createSession(tables[27]!,1)
    const productId=randomUUID(),nonPhysicalProductId=randomUUID(),orderId=randomUUID()
    const itemId=randomUUID(),nonPhysicalItemId=randomUUID(),taskId=randomUUID(),paymentId=randomUUID()
    const inventoryItemId=randomUUID(),reservationId=randomUUID()
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot
    ) VALUES($1,$2,$3,$4,'待出品饮品','drink','bar','{}')`,
    [productId,tenantId,storeId,`KDS-${randomUUID().slice(0,8)}`])
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot
    ) VALUES($1,$2,$3,$4,'无物理出品服务','service','none','{}')`,
    [nonPhysicalProductId,tenantId,storeId,`NONE-${randomUUID().slice(0,8)}`])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','paid',100,0,100)`,
    [orderId,tenantId,storeId,source,`order-${randomUUID()}`])
    await pool.query(`INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,
      discount_amount_minor,total_amount_minor,fulfillment_station,product_snapshot,status
    ) VALUES($1,$2,$3,$4,$5,1,100,0,100,'bar','{}','submitted')`,
    [itemId,tenantId,storeId,orderId,productId])
    await pool.query(`INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,
      discount_amount_minor,total_amount_minor,fulfillment_station,product_snapshot,status
    ) VALUES($1,$2,$3,$4,$5,1,0,0,0,'none','{}','submitted')`,
    [nonPhysicalItemId,tenantId,storeId,orderId,nonPhysicalProductId])
    await pool.query(`INSERT INTO mbox.kds_tasks(
      id,tenant_id,store_id,order_item_id,station_code,status,quantity
    ) VALUES($1,$2,$3,$4,'bar','pending',1)`,[taskId,tenantId,storeId,itemId])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,
      method,amount_minor,status,succeeded_at
    ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',100,'succeeded',clock_timestamp())`,
    [paymentId,tenantId,storeId,orderId,`payment-${randomUUID()}`,`cash-${randomUUID()}`])
    const command={ kind:'participant_merge',sourceSessionId:source,targetSessionId:target,
      targetTableId:tables[27]!,movedGuestCount:1,participantIds:[] as string[],
      roles:[] as string[],confirmations:[] as string[] }
    await expect(runtimeMovement({ ...command,key:`kds-blocked-${randomUUID()}` }))
      .rejects.toMatchObject({ code:'55000' })
    const blockedState=await pool.query(`SELECT id,status,guest_count FROM mbox.table_sessions
      WHERE id=ANY($1::uuid[])`,[[source,target]])
    expect(blockedState.rows.find((row) => row.id===source)).toMatchObject({ status:'open',guest_count:1 })
    expect(blockedState.rows.find((row) => row.id===target)).toMatchObject({ status:'open',guest_count:1 })
    await pool.query(`UPDATE mbox.order_items SET status='delivered' WHERE id=$1`,[itemId])
    await pool.query(`UPDATE mbox.kds_tasks SET status='ready',ready_at=clock_timestamp() WHERE id=$1`,[taskId])
    await pool.query(`INSERT INTO mbox.inventory_items(
      id,tenant_id,store_id,sku,name,item_type,base_unit
    ) VALUES($1,$2,$3,$4,'并桌库存占用','ingredient','g')`,
    [inventoryItemId,tenantId,storeId,`MOVE-${randomUUID().slice(0,8)}`])
    await pool.query(`INSERT INTO mbox.inventory_order_reservations(
      id,tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,status,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6,1,'reserved',clock_timestamp()+interval '10 minutes')`,
    [reservationId,tenantId,storeId,orderId,itemId,inventoryItemId])
    await expect(runtimeMovement({ ...command,key:`inventory-blocked-${randomUUID()}` }))
      .rejects.toMatchObject({ code:'55000' })
    await pool.query(`UPDATE mbox.inventory_order_reservations
      SET status='released',expires_at=NULL,released_at=clock_timestamp(),release_reason='并桌前已取消占用'
      WHERE id=$1`,[reservationId])
    await runtimeMovement({ ...command,key:`kds-resolved-${randomUUID()}` })
    const immutableReferences=await pool.query(`SELECT
      (SELECT table_session_id FROM mbox.orders WHERE id=$1) AS order_session_id,
      (SELECT order_id FROM mbox.order_items WHERE id=$2) AS item_order_id,
      (SELECT order_item_id FROM mbox.kds_tasks WHERE id=$3) AS task_item_id,
      (SELECT order_id FROM mbox.payments WHERE id=$4) AS payment_order_id`,
    [orderId,itemId,taskId,paymentId])
    expect(immutableReferences.rows[0]).toEqual({
      order_session_id:source,item_order_id:orderId,task_item_id:itemId,payment_order_id:orderId,
    })
  })

  it('allows a settled partial refund but blocks while the refund is still processing', async () => {
    const source=await createSession(tables[28]!,1)
    const target=await createSession(tables[29]!,1)
    const productId=randomUUID(),orderId=randomUUID(),itemId=randomUUID(),taskId=randomUUID()
    const paymentId=randomUUID(),refundId=randomUUID()
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot
    ) VALUES($1,$2,$3,$4,'部分退款饮品','drink','bar','{}')`,
    [productId,tenantId,storeId,`REF-${randomUUID().slice(0,8)}`])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','partially_refunded',100,0,100)`,
    [orderId,tenantId,storeId,source,`order-${randomUUID()}`])
    await pool.query(`INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,
      discount_amount_minor,total_amount_minor,fulfillment_station,product_snapshot,status
    ) VALUES($1,$2,$3,$4,$5,1,100,0,100,'bar','{}','delivered')`,
    [itemId,tenantId,storeId,orderId,productId])
    await pool.query(`INSERT INTO mbox.kds_tasks(
      id,tenant_id,store_id,order_item_id,station_code,status,quantity,ready_at
    ) VALUES($1,$2,$3,$4,'bar','ready',1,clock_timestamp())`,[taskId,tenantId,storeId,itemId])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,
      method,amount_minor,status,succeeded_at
    ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',100,'partially_refunded',clock_timestamp())`,
    [paymentId,tenantId,storeId,orderId,`payment-${randomUUID()}`,`cash-${randomUUID()}`])
    await pool.query(`INSERT INTO mbox.refunds(
      id,tenant_id,store_id,payment_id,public_id,amount_minor,status,reason,
      requested_by_employee_id,approved_by_employee_id,decision_reason
    ) VALUES($1,$2,$3,$4,$5,40,'processing','顾客确认部分退款',$6,$7,'领班审核通过')`,
    [refundId,tenantId,storeId,paymentId,`refund-${randomUUID()}`,employeeId,unauthorizedEmployeeId])
    const command={ kind:'participant_merge',sourceSessionId:source,targetSessionId:target,
      targetTableId:tables[29]!,movedGuestCount:1,participantIds:[] as string[],
      roles:[] as string[],confirmations:[] as string[] }
    await expect(runtimeMovement({ ...command,key:`refund-processing-${randomUUID()}` }))
      .rejects.toMatchObject({ code:'55000' })
    await pool.query(`UPDATE mbox.refunds SET status='succeeded',provider_refund_id=$2,
      completed_at=clock_timestamp() WHERE id=$1`,[refundId,`refund-provider-${randomUUID()}`])
    await runtimeMovement({ ...command,key:`refund-settled-${randomUUID()}` })
    const references=await pool.query(`SELECT
      (SELECT table_session_id FROM mbox.orders WHERE id=$1) AS order_session_id,
      (SELECT order_id FROM mbox.payments WHERE id=$2) AS payment_order_id,
      (SELECT payment_id FROM mbox.refunds WHERE id=$3) AS refund_payment_id`,
    [orderId,paymentId,refundId])
    expect(references.rows[0]).toEqual({
      order_session_id:source,payment_order_id:orderId,refund_payment_id:paymentId,
    })
  })

  it('rejects unauthorized actors and serializes identical idempotent movements', async () => {
    const unauthorizedSource=await createSession(tables[7]!,1)
    await expect(runtimeMovement({
      kind:'whole_table_transfer',sourceSessionId:unauthorizedSource,targetSessionId:null,
      targetTableId:tables[8]!,movedGuestCount:1,participantIds:[],roles:[],confirmations:[],
      key:`unauthorized-${randomUUID()}`,actorEmployeeId:unauthorizedEmployeeId,
    })).rejects.toMatchObject({ code:'42501' })
    const unchanged=await pool.query(`SELECT table_id,location_version FROM mbox.table_sessions WHERE id=$1`,
      [unauthorizedSource])
    expect(unchanged.rows[0]).toMatchObject({ table_id:tables[7],location_version:'0' })

    const source=await createSession(tables[9]!,1)
    const command={
      kind:'whole_table_transfer',sourceSessionId:source,targetSessionId:null,targetTableId:tables[10]!,
      movedGuestCount:1,participantIds:[] as string[],roles:[] as string[],confirmations:[] as string[],
      key:`concurrent-${randomUUID()}`,
    }
    const [first,second]=await Promise.all([runtimeMovement(command),runtimeMovement(command)])
    expect(second.movement_event_id).toBe(first.movement_event_id)
    const events=await pool.query(`SELECT count(*)::integer AS count FROM mbox.table_customer_movement_events
      WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3`,[tenantId,storeId,command.key])
    expect(events.rows[0]?.count).toBe(1)

    const originalEvent=first.movement_event_id
    await runtimeMovement({ ...command,targetTableId:tables[18]!,key:`second-${randomUUID()}` })
    await expect(pool.query(`UPDATE mbox.table_sessions SET location_version=1 WHERE id=$1`,[source]))
      .rejects.toMatchObject({ code:'23514' })
    await expect(pool.query(`UPDATE mbox.table_sessions
      SET table_id=$1,current_location_movement_event_id=$2,location_version=1 WHERE id=$3`,
    [tables[10],originalEvent,source])).rejects.toMatchObject({ code:'23514' })
  })

  it('blocks selected customers with unsettled orders and requires an explicit capacity override', async () => {
    const blockedSource=await createSession(tables[11]!,2)
    const blockedCustomer=await createCustomer('blocked-order')
    const blockedCredential=await createCredential(tables[11]!)
    const blockedParticipation=await ensurePosition(blockedCredential,blockedSource,blockedCustomer)
    await pool.query(`INSERT INTO mbox.orders(
      tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,created_by_customer_id
    ) VALUES($1,$2,$3,$4,'guest_qr','completed','unpaid',100,0,100,$5)`,
    [tenantId,storeId,blockedSource,`order-${randomUUID()}`,blockedCustomer])
    await expect(runtimeMovement({
      kind:'participant_split',sourceSessionId:blockedSource,targetSessionId:null,
      targetTableId:tables[12]!,movedGuestCount:1,participantIds:[blockedParticipation],
      roles:['companion'],confirmations:['confirmed'],key:`blocked-${randomUUID()}`,
      splitPublicId:`blocked-split-${randomUUID()}`,
    })).rejects.toMatchObject({ code:'55000' })

    const capacitySource=await createSession(tables[13]!,3)
    const capacityCustomer=await createCustomer('capacity')
    const capacityCredential=await createCredential(tables[13]!)
    const capacityParticipation=await ensurePosition(capacityCredential,capacitySource,capacityCustomer)
    const base={
      kind:'participant_split',sourceSessionId:capacitySource,targetSessionId:null,
      targetTableId:tables[14]!,movedGuestCount:2,participantIds:[capacityParticipation],
      roles:['companion'],confirmations:['confirmed'],splitPublicId:`capacity-${randomUUID()}`,
    }
    await expect(runtimeMovement({ ...base,key:`capacity-denied-${randomUUID()}` }))
      .rejects.toMatchObject({ code:'23514' })
    const accepted=await runtimeMovement({
      ...base,key:`capacity-accepted-${randomUUID()}`,capacityOverrideReason:'顾客确认临时加座',
    })
    const target=await pool.query(`SELECT guest_count,capacity_at_open,capacity_override_reason
      FROM mbox.table_sessions WHERE id=$1`,[accepted.target_table_session_id])
    expect(target.rows[0]).toMatchObject({
      guest_count:2,capacity_at_open:1,capacity_override_reason:'顾客确认临时加座',
    })
  })

  it('prevents canonical customers from holding two table positions, including concurrent scans', async () => {
    const firstSession=await createSession(tables[15]!,2)
    const secondSession=await createSession(tables[16]!,2)
    const firstCredential=await createCredential(tables[15]!)
    const secondCredential=await createCredential(tables[16]!)
    const customer=await createCustomer('double-position')
    await ensurePosition(firstCredential,firstSession,customer)
    await expect(ensurePosition(secondCredential,secondSession,customer)).rejects.toMatchObject({ code:'55000' })

    const racingCustomer=await createCustomer('racing-position')
    const attempts=await Promise.allSettled([
      ensurePosition(firstCredential,firstSession,racingCustomer),
      ensurePosition(secondCredential,secondSession,racingCustomer),
    ])
    expect(attempts.filter((attempt) => attempt.status==='fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status==='rejected')).toHaveLength(1)
    const active=await pool.query(`SELECT count(*)::integer AS count
      FROM mbox.table_session_customer_participations
      WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND left_at IS NULL`,
    [tenantId,storeId,racingCustomer])
    expect(active.rows[0]?.count).toBe(1)

    const aliasSource=await createCustomer('alias-source')
    const aliasTarget=await createCustomer('alias-target')
    await pool.query(`UPDATE mbox.customers SET status='merged',merged_into_customer_id=$1 WHERE id=$2`,
      [aliasTarget,aliasSource])
    const aliasAttempts=await Promise.allSettled([
      ensurePosition(firstCredential,firstSession,aliasSource),
      ensurePosition(secondCredential,secondSession,aliasTarget),
    ])
    expect(aliasAttempts.filter((attempt) => attempt.status==='fulfilled')).toHaveLength(1)
    expect(aliasAttempts.filter((attempt) => attempt.status==='rejected')).toHaveLength(1)
    const aliasActive=await pool.query(`SELECT count(*)::integer AS count
      FROM mbox.table_session_customer_participations participation
      WHERE participation.tenant_id=$1 AND participation.store_id=$2 AND participation.left_at IS NULL
        AND mbox.canonical_customer_id(
          participation.tenant_id,participation.store_id,participation.customer_id
        )=$3`,[tenantId,storeId,aliasTarget])
    expect(aliasActive.rows[0]?.count).toBe(1)

    const sameTableSource=await createCustomer('same-table-source')
    const sameTableTarget=await createCustomer('same-table-target')
    await ensurePosition(firstCredential,firstSession,sameTableSource)
    await ensurePosition(firstCredential,firstSession,sameTableTarget)
    await pool.query(`UPDATE mbox.customers SET status='merged',merged_into_customer_id=$1 WHERE id=$2`,
      [sameTableTarget,sameTableSource])
    const consolidated=await pool.query(`SELECT customer_id,left_at,left_reason_code
      FROM mbox.table_session_customer_participations
      WHERE customer_id=ANY($1::uuid[]) ORDER BY customer_id`,[[sameTableSource,sameTableTarget]])
    expect(consolidated.rows.filter((row) => row.left_at===null)).toHaveLength(1)
    expect(consolidated.rows.find((row) => row.customer_id===sameTableSource))
      .toMatchObject({ left_reason_code:'identity_merged' })
    await ensurePosition(firstCredential,firstSession,sameTableSource)
    const stableAliases=await pool.query(`SELECT count(*)::integer AS count
      FROM mbox.table_session_customers
      WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3
        AND customer_id=ANY($4::uuid[])`,[tenantId,storeId,firstSession,[sameTableSource,sameTableTarget]])
    expect(stableAliases.rows[0]?.count).toBe(2)

    const differentSource=await createCustomer('different-source')
    const differentTarget=await createCustomer('different-target')
    await ensurePosition(firstCredential,firstSession,differentSource)
    await ensurePosition(secondCredential,secondSession,differentTarget)
    await expect(pool.query(`UPDATE mbox.customers
      SET status='merged',merged_into_customer_id=$1 WHERE id=$2`,[differentTarget,differentSource]))
      .rejects.toMatchObject({ code:'55000' })
  })

  it('serializes a bound guest write guard with whole-table movement and rejects an old token afterwards', async () => {
    const source=await createSession(tables[17]!,1)
    const customer=await createCustomer('guest-write')
    const credential=await createCredential(tables[17]!)
    await ensurePosition(credential,source,customer)
    const guestSession=await createGuestSession(source,customer,tables[17]!)
    const guardClient=await runtimeClient()
    const guard=await guardClient.query<{ participation_id: string | null }>(`
      SELECT mbox.lock_active_table_guest_session_position($1,$2,$3) AS participation_id
    `,[source,customer,guestSession])
    expect(guard.rows[0]?.participation_id).not.toBeNull()
    let moved=false
    const moving=runtimeMovement({
      kind:'whole_table_transfer',sourceSessionId:source,targetSessionId:null,
      targetTableId:tables[19]!,movedGuestCount:1,participantIds:[],roles:[],confirmations:[],
      key:`guarded-move-${randomUUID()}`,
    }).then((value) => { moved=true; return value })
    await pause(40)
    expect(moved).toBe(false)
    await guardClient.query('COMMIT')
    guardClient.release()
    await moving
    const staleClient=await runtimeClient()
    try {
      const stale=await staleClient.query<{ participation_id: string | null }>(`
        SELECT mbox.lock_active_table_guest_session_position($1,$2,$3) AS participation_id
      `,[source,customer,guestSession])
      expect(stale.rows[0]?.participation_id).toBeNull()
      await staleClient.query('COMMIT')
    } finally { staleClient.release() }
  })

  it('serializes customer-family merges with partial movement blocker evaluation', async () => {
    const source=await createSession(tables[30]!,2)
    const target=await createSession(tables[31]!,1)
    const sourceCustomer=await createCustomer('movement-identity-source')
    const mergedTarget=await createCustomer('movement-identity-target')
    const participation=await linkParticipant(source,sourceCustomer,'guest')
    await pool.query(`INSERT INTO mbox.orders(
      tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,created_by_customer_id
    ) VALUES($1,$2,$3,$4,'guest_qr','completed','unpaid',100,0,100,$5)`,
    [tenantId,storeId,source,`order-${randomUUID()}`,sourceCustomer])

    const identityClient=await pool.connect()
    await identityClient.query('BEGIN')
    await identityClient.query(`SELECT pg_advisory_xact_lock(hashtextextended(
      'table-customer-movement:'||$1::text||':'||$2::text,0
    ))`,[tenantId,storeId])
    await identityClient.query(`UPDATE mbox.customers SET status='merged',merged_into_customer_id=$1
      WHERE tenant_id=$2 AND store_id=$3 AND id=$4`,
    [mergedTarget,tenantId,storeId,sourceCustomer])
    let movementSettled=false
    const moving=runtimeMovement({
      kind:'participant_merge',sourceSessionId:source,targetSessionId:target,
      targetTableId:tables[31]!,movedGuestCount:1,participantIds:[participation],
      roles:['companion'],confirmations:['confirmed'],key:`identity-race-${randomUUID()}`,
    }).finally(() => { movementSettled=true })
    await pause(50)
    expect(movementSettled).toBe(false)
    await identityClient.query('COMMIT')
    identityClient.release()
    await expect(moving).rejects.toMatchObject({ code:'55000' })
    const state=await pool.query(`SELECT
      (SELECT count(*)::integer FROM mbox.table_customer_movement_events
       WHERE source_table_session_id=$1) AS event_count,
      (SELECT guest_count FROM mbox.table_sessions WHERE id=$1) AS source_guest_count,
      (SELECT guest_count FROM mbox.table_sessions WHERE id=$2) AS target_guest_count`,[source,target])
    expect(state.rows[0]).toEqual({ event_count:0,source_guest_count:2,target_guest_count:1 })
  })

  it('keeps merge preview capacity aligned with capacity_at_open and rejects inactive target areas', async () => {
    const runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    const app=Fastify()
    await app.register(tableManagementApiPlugin,{
      transactions:runner,
      commands:{} as never,
      resolveContext:() => ({ scope:{ tenantId,storeId },employeeId,businessDate:'2026-08-16',
        capabilities:['table.participation.manage'] }),
    })
    try {
      await pool.query(`UPDATE mbox.tables SET capacity=1 WHERE id=$1`,[tables[33]])
      const highSource=await createSession(tables[32]!,1)
      const lowSnapshotTarget=await createSession(tables[33]!,1)
      await pool.query(`UPDATE mbox.tables SET capacity=8 WHERE id=$1`,[tables[33]])
      const missingReason=await app.inject({ method:'POST',
        url:`/table-management/sessions/${highSource}/participant-movements/preview`,payload:{
          movementKind:'participant_merge',targetTableId:tables[33],
          targetTableSessionId:lowSnapshotTarget,movedGuestCount:1,participantPublicIds:[],
        } })
      expect(missingReason.statusCode).toBe(422)
      const withReason=await app.inject({ method:'POST',
        url:`/table-management/sessions/${highSource}/participant-movements/preview`,payload:{
          movementKind:'participant_merge',targetTableId:tables[33],
          targetTableSessionId:lowSnapshotTarget,movedGuestCount:1,participantPublicIds:[],
          capacityOverrideReason:'顾客确认加座并检查通道',
        } })
      expect(withReason.statusCode).toBe(200)
      expect(withReason.json().data).toMatchObject({
        targetCapacity:1,projectedGuestCount:2,requiresCapacityOverride:true,
      })

      await pool.query(`UPDATE mbox.tables SET capacity=8 WHERE id=$1`,[tables[35]])
      const lowSource=await createSession(tables[34]!,1)
      const highSnapshotTarget=await createSession(tables[35]!,1)
      await pool.query(`UPDATE mbox.tables SET capacity=1 WHERE id=$1`,[tables[35]])
      const noReason=await app.inject({ method:'POST',
        url:`/table-management/sessions/${lowSource}/participant-movements/preview`,payload:{
          movementKind:'participant_merge',targetTableId:tables[35],
          targetTableSessionId:highSnapshotTarget,movedGuestCount:1,participantPublicIds:[],
        } })
      expect(noReason.statusCode).toBe(200)
      expect(noReason.json().data).toMatchObject({
        targetCapacity:8,projectedGuestCount:2,requiresCapacityOverride:false,
      })

      await pool.query(`UPDATE mbox.areas SET status='paused' WHERE id=$1`,[areaId])
      const inactiveArea=await app.inject({ method:'POST',
        url:`/table-management/sessions/${lowSource}/participant-movements/preview`,payload:{
          movementKind:'participant_merge',targetTableId:tables[35],
          targetTableSessionId:highSnapshotTarget,movedGuestCount:1,participantPublicIds:[],
        } })
      expect(inactiveArea.statusCode).toBe(409)
      await pool.query(`UPDATE mbox.areas SET status='active' WHERE id=$1`,[areaId])
    } finally {
      await app.close()
      await pool.query(`UPDATE mbox.areas SET status='active' WHERE id=$1`,[areaId])
    }
  })

  it('replays the complete permanent movement result after outer idempotency expiry without duplicate facts', async () => {
    const source=await createSession(tables[36]!,2)
    const customer=await createCustomer('delayed-replay')
    const participation=await linkParticipant(source,customer,'guest')
    await createGuestSession(source,customer,tables[36]!)
    const commandService=new TableManagementCommandService(new NormalizedCommandExecutor(
      new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool),
    ))
    const idempotencyKey=`delayed-replay-${randomUUID()}`
    const command={ scope:{ tenantId,storeId },actor:{ type:'employee' as const,employeeId },
      businessDate:'2026-08-16',idempotencyKey,requestFingerprint:`fingerprint-${idempotencyKey}`,
      reason:'顾客确认拆桌',movementKind:'participant_split' as const,
      sourceTableSessionId:source,targetTableSessionId:null,targetTableId:tables[37]!,
      movedGuestCount:1,participantPublicIds:[
        (await pool.query<{ public_id:string }>(`SELECT public_id FROM mbox.table_session_customer_participations
          WHERE id=$1`,[participation])).rows[0]!.public_id,
      ],capacityOverrideReason:null }
    const first=await commandService.moveParticipants(command)
    expect(first.value.revokedGuestSessionCount).toBe(1)
    await pool.query(`UPDATE mbox.idempotency_records
      SET created_at=clock_timestamp()-interval '2 days',
          expires_at=clock_timestamp()-interval '1 day'
      WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='table.participation.move'
        AND idempotency_key=$3`,[tenantId,storeId,idempotencyKey])
    const delayed=await commandService.moveParticipants(command)
    expect(delayed.value).toEqual(first.value)
    const facts=await pool.query(`SELECT
      (SELECT count(*)::integer FROM mbox.table_customer_movement_events
       WHERE id=$3::uuid) AS movement_count,
      (SELECT revoked_guest_session_count FROM mbox.table_customer_movement_events
       WHERE id=$3::uuid) AS revoked_count,
      (SELECT count(*)::integer FROM mbox.audit_events
       WHERE tenant_id=$1 AND store_id=$2 AND object_id=$3::text
         AND action='table.participation.moved') AS audit_count,
      (SELECT count(*)::integer FROM mbox.outbox_messages
       WHERE tenant_id=$1 AND store_id=$2 AND aggregate_id=$3::uuid
         AND message_type='table.participation.moved.v1') AS outbox_count`,
    [tenantId,storeId,first.value.eventId])
    expect(facts.rows[0]).toEqual({ movement_count:1,revoked_count:1,audit_count:1,outbox_count:1 })
  })

  it('namespaces cross-route movement keys and preserves every over-capacity event snapshot', async () => {
    const commandService=new TableManagementCommandService(new NormalizedCommandExecutor(
      new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool),
    ))
    const sharedKey=`shared-route-${randomUUID()}`
    const transferSource=await createSession(tables[38]!,1)
    const transferCommand={ scope:{ tenantId,storeId },
      actor:{ type:'employee',employeeId },businessDate:'2026-08-16',
      idempotencyKey:sharedKey,requestFingerprint:`transfer-${sharedKey}`,
      reason:'顾客确认整桌换桌',tableSessionId:transferSource,targetTableId:tables[39]!,
      capacityOverrideReason:null }
    const originalTransfer=await commandService.transfer(transferCommand)
    await pool.query(`UPDATE mbox.tables SET code=CASE id WHEN $1 THEN 'RENAMED_SOURCE'
      WHEN $2 THEN 'RENAMED_TARGET' END WHERE id=ANY($3::uuid[])`,
    [tables[38],tables[39],[tables[38],tables[39]]])
    await pool.query(`UPDATE mbox.idempotency_records
      SET created_at=clock_timestamp()-interval '2 days',
          expires_at=clock_timestamp()-interval '1 day'
      WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='table.transfer'
        AND idempotency_key=$3`,[tenantId,storeId,sharedKey])
    const replayedTransfer=await commandService.transfer(transferCommand)
    expect(replayedTransfer.value).toEqual(originalTransfer.value)
    const transferFacts=await pool.query(`SELECT
      (SELECT count(*)::integer FROM mbox.audit_events
       WHERE tenant_id=$1 AND store_id=$2 AND object_id=$3::text
         AND action='table.session.transferred') AS audit_count,
      (SELECT count(*)::integer FROM mbox.outbox_messages
       WHERE tenant_id=$1 AND store_id=$2 AND aggregate_id=$3::uuid
         AND message_type='table.session.transferred.v1') AS outbox_count`,
    [tenantId,storeId,originalTransfer.value.eventId])
    expect(transferFacts.rows[0]).toEqual({ audit_count:1,outbox_count:1 })
    await pool.query(`UPDATE mbox.tables SET capacity=1 WHERE id=$1`,[tables[40]])
    const target=await createSession(tables[40]!,1)
    const sourceOne=await createSession(tables[41]!,1)
    const sourceTwo=await createSession(tables[42]!,1)
    const first=await commandService.moveParticipants({ scope:{ tenantId,storeId },
      actor:{ type:'employee',employeeId },businessDate:'2026-08-16',
      idempotencyKey:sharedKey,requestFingerprint:`participant-${sharedKey}`,
      reason:'顾客确认全员并桌',movementKind:'participant_merge',
      sourceTableSessionId:sourceOne,targetTableSessionId:target,targetTableId:tables[40]!,
      movedGuestCount:1,participantPublicIds:[],capacityOverrideReason:'第一次加座并检查通道' })
    const second=await runtimeMovement({
      kind:'participant_merge',sourceSessionId:sourceTwo,targetSessionId:target,
      targetTableId:tables[40]!,movedGuestCount:1,participantIds:[],roles:[],confirmations:[],
      key:`participant_merge:${sharedKey}-second`,capacityOverrideReason:'第二次加座并再次检查通道',
    })
    const evidence=await pool.query(`SELECT id,target_capacity_at_movement,
      target_guest_count_before,target_guest_count_after,capacity_override_reason
      FROM mbox.table_customer_movement_events WHERE id=ANY($1::uuid[]) ORDER BY occurred_at,id`,
    [[first.value.eventId,second.movement_event_id]])
    expect(evidence.rows).toEqual([
      { id:first.value.eventId,target_capacity_at_movement:1,target_guest_count_before:1,
        target_guest_count_after:2,capacity_override_reason:'第一次加座并检查通道' },
      { id:second.movement_event_id,target_capacity_at_movement:1,target_guest_count_before:2,
        target_guest_count_after:3,capacity_override_reason:'第二次加座并再次检查通道' },
    ])
    const namespaced=await pool.query<{ idempotency_key:string }>(`SELECT idempotency_key
      FROM mbox.table_customer_movement_events
      WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key IN ($3,$4) ORDER BY idempotency_key`,
    [tenantId,storeId,`participant_merge:${sharedKey}`,`whole_table_transfer:${sharedKey}`])
    expect(namespaced.rows.map((row) => row.idempotency_key)).toEqual([
      `participant_merge:${sharedKey}`,`whole_table_transfer:${sharedKey}`,
    ])
  })

  async function createSession(tableId: string,guestCount: number) {
    const id=randomUUID()
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,
      guest_profile_snapshot,status,opened_by_employee_id
    ) SELECT $1,$2,$3,venue_table.id,$4,'2026-08-16',$5,venue_table.capacity,'{}','open',$6
      FROM mbox.tables venue_table WHERE venue_table.id=$7`,
    [id,tenantId,storeId,`session-${randomUUID()}`,guestCount,employeeId,tableId])
    return id
  }

  async function createCustomer(label: string) {
    const id=randomUUID()
    await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id)
      VALUES($1,$2,$3,$4)`,[id,tenantId,storeId,`${label}-${randomUUID()}`])
    return id
  }

  async function createCredential(tableId: string) {
    const hash=createHash('sha256').update(randomUUID()).digest('hex')
    await pool.query(`INSERT INTO mbox.table_qr_credentials(
      tenant_id,store_id,table_id,qr_version,credential_hash,status
    ) SELECT $1,$2,venue_table.id,venue_table.qr_version,$3,'active'
      FROM mbox.tables venue_table WHERE venue_table.id=$4`,[tenantId,storeId,hash,tableId])
    return hash
  }

  async function ensurePosition(credentialHash: string,tableSessionId: string,customerId: string) {
    const client=await runtimeClient()
    try {
      const result=await client.query<{ id: string }>(`
        SELECT mbox.ensure_scanned_table_customer_position($1::char(64),$2::uuid,$3::uuid) AS id
      `,[credentialHash,tableSessionId,customerId])
      await client.query('COMMIT')
      return result.rows[0]!.id
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async function createGuestSession(tableSessionId: string,customerId: string,tableId: string) {
    const id=randomUUID()
    await pool.query(`INSERT INTO mbox.guest_sessions(
      id,tenant_id,store_id,session_kind,customer_id,table_session_id,token_hash,device_hash,
      scopes,issued_at,expires_at
    ) VALUES($1,$2,$3,'table',$4,$5,$6,$7,ARRAY['guest.session.read'],clock_timestamp(),clock_timestamp()+interval '1 hour')`,
    [id,tenantId,storeId,customerId,tableSessionId,digest(`token-${id}`),digest(`device-${id}`)])
    await pool.query(`INSERT INTO mbox.guest_session_events(
      tenant_id,store_id,guest_session_id,table_id,table_session_id,event_type,outcome
    ) VALUES($1,$2,$3,$4,$5,'guest_session.issued','succeeded')`,
    [tenantId,storeId,id,tableId,tableSessionId])
    return id
  }

  async function linkParticipant(tableSessionId:string,customerId:string,relationship:'primary'|'guest') {
    await pool.query(`INSERT INTO mbox.table_session_customers(
      tenant_id,store_id,table_session_id,customer_id,relationship,linked_by_employee_id
    ) VALUES($1,$2,$3,$4,$5,$6)`,
    [tenantId,storeId,tableSessionId,customerId,relationship,employeeId])
    const result=await pool.query<{ id:string }>(`SELECT participation.id
      FROM mbox.table_session_customer_participations participation
      JOIN mbox.table_sessions session ON session.tenant_id=participation.tenant_id
        AND session.store_id=participation.store_id AND session.id=participation.table_session_id
      WHERE participation.tenant_id=$1 AND participation.store_id=$2
        AND participation.table_session_id=$3 AND participation.customer_id=$4
        AND participation.table_id=session.table_id AND participation.left_at IS NULL`,
    [tenantId,storeId,tableSessionId,customerId])
    return result.rows[0]!.id
  }

  async function runtimeMovement(input: {
    kind: string; sourceSessionId: string; targetSessionId: string | null; targetTableId: string
    movedGuestCount: number; participantIds: string[]; roles: string[]; confirmations: string[]
    key: string; splitPublicId?: string; capacityOverrideReason?: string
    actorEmployeeId?: string
  }) {
    const client=await runtimeClient()
    try {
      const fingerprint=digest(JSON.stringify(input))
      const result=await client.query<{
        movement_event_id: string; target_table_session_id: string
        moved_participant_count: number; revoked_guest_session_count: number
      }>(`SELECT * FROM mbox.execute_table_customer_movement(
        $1,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid[],$7::text[],$8::text[],$9::uuid,
        '现场顾客换桌确认',$10,$11::char(64),$12,$13,'{}'
      )`,[input.kind,input.sourceSessionId,input.targetSessionId,input.targetTableId,input.movedGuestCount,
        input.participantIds,input.roles,input.confirmations,input.actorEmployeeId??employeeId,
        input.key,fingerprint,input.splitPublicId??null,input.capacityOverrideReason??null])
      await client.query('COMMIT')
      return result.rows[0]!
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async function runtimeClient() {
    const client=await pool.connect()
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE mbox_runtime')
    await client.query(`SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)`,
      [tenantId,storeId])
    return client
  }
})

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function rollback(client: PoolClient) {
  try { await client.query('ROLLBACK') } finally { client.release() }
}

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve,milliseconds))
}
