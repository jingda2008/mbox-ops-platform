import type { RuntimeState } from '../src/shared/contracts.js'
import type { PostgresPoolClient, PostgresTenantContext } from './postgres-repository.js'
import { runtimeStateChecksum, serializeRuntimeState } from './postgres-repository.js'
import { tableSessionBusinessDate } from './table-sessions.js'

type ProjectionValue = string | number | null
type ProjectionRow = Record<string, ProjectionValue>

export interface OperationalProjectionHealth {
  ready: boolean
  runtimeRevision: number | null
  projectedRevision: number | null
  countsMatch: boolean
  error?: string
}

export interface RuntimeStateProjector {
  project(
    client: PostgresPoolClient,
    context: PostgresTenantContext,
    previous: RuntimeState | null,
    current: RuntimeState,
  ): Promise<void>
  healthCheck(
    client: PostgresPoolClient,
    context: PostgresTenantContext,
    runtimeRevision: number,
  ): Promise<OperationalProjectionHealth>
}

interface ProjectionSet {
  table: string
  keyColumns: string[]
  rows: ProjectionRow[]
}

function tableRows(state: RuntimeState): ProjectionRow[] {
  return state.tables.map((table) => ({
    source_id: table.id,
    table_code: table.code,
    area_id: table.areaId,
    status: table.status,
    primary_employee_id: table.primaryEmployeeId,
    guest_count: table.guestCount,
    opened_at: table.openedAt,
    payload: JSON.stringify(table),
    snapshot_revision: state.revision,
  }))
}

function tableSessionRows(state: RuntimeState): ProjectionRow[] {
  return state.songState.tableSessions.map((session) => {
    const table = state.tables.find((candidate) => candidate.id === session.tableId)
    const operation = state.tableSessionOperations?.find((candidate) => candidate.tableSessionId === session.id)
    return {
      source_id: session.id,
      table_id: session.tableId,
      table_code: session.tableCode,
      business_date: tableSessionBusinessDate(state, session),
      status: session.status,
      guest_count: operation?.guestCount ?? (session.status === 'open' ? table?.guestCount ?? 0 : 0),
      opened_at: session.openedAt,
      closed_at: session.closedAt,
      payload: JSON.stringify(session),
      snapshot_revision: state.revision,
    }
  })
}

function serviceTaskRows(state: RuntimeState): ProjectionRow[] {
  return state.tasks.map((task) => ({
    source_id: task.id,
    table_id: task.tableId,
    table_session_id: task.tableSessionId,
    service_type_id: task.serviceTypeId,
    source: task.source,
    status: task.status,
    priority: task.priority,
    owner_id: task.ownerId,
    escalation_level: task.escalationLevel,
    created_at: task.createdAt,
    accepted_at: task.acceptedAt,
    arrived_at: task.arrivedAt,
    completed_at: task.completedAt,
    archived_at: task.archivedAt,
    payload: JSON.stringify(task),
    snapshot_revision: state.revision,
  }))
}

function orderRows(state: RuntimeState): ProjectionRow[] {
  return state.orderDomain.orders.map((order) => ({
    source_id: order.id,
    table_session_id: order.tableSessionId,
    status: order.status,
    gross_amount_minor: order.amounts.grossAmount,
    discount_amount_minor: order.amounts.discountAmount,
    gift_amount_minor: order.amounts.giftAmount,
    payable_amount_minor: order.amounts.payableAmount,
    cost_amount_minor: order.items.reduce((total, item) => total + item.unitCostAmount * item.quantity, 0),
    sales_employee_id: (state.salesAttributionRecords ?? [])
      .findLast((record) => record.subjectType === 'table_session' && record.subjectId === order.tableSessionId)
      ?.salesEmployeeId ?? null,
    created_by: order.createdBy,
    created_at: order.createdAt,
    submitted_at: order.submittedAt,
    fulfilled_at: order.fulfilledAt,
    payload: JSON.stringify(order),
    snapshot_revision: state.revision,
  }))
}

function orderItemRows(state: RuntimeState): ProjectionRow[] {
  return state.orderDomain.orders.flatMap((order) => order.items.map((item) => ({
    source_id: item.id,
    order_id: order.id,
    product_id: item.skuId,
    item_name: item.name,
    category_id: state.products.find((product) => product.id === item.skuId)?.categoryId ?? null,
    station_id: item.stationId,
    quantity: item.quantity,
    unit_sale_amount_minor: item.unitSalePriceAmount,
    unit_cost_amount_minor: item.unitCostAmount,
    fulfillment_status: item.fulfillmentStatus,
    added_by: item.addedBy,
    added_at: item.addedAt,
    payload: JSON.stringify(item),
    snapshot_revision: state.revision,
  })))
}

function kdsTaskRows(state: RuntimeState): ProjectionRow[] {
  return state.orderDomain.kdsTasks.map((task) => ({
    source_id: task.id,
    order_id: task.orderId,
    order_item_id: task.orderItemId,
    table_session_id: task.tableSessionId,
    table_code: task.tableCode ?? null,
    station_id: task.stationId,
    item_name: task.itemName,
    quantity: task.quantity,
    status: task.status,
    queued_at: task.queuedAt,
    completed_at: task.completedAt,
    delivered_at: task.deliveredAt,
    payload: JSON.stringify(task),
    snapshot_revision: state.revision,
  }))
}

function paymentRows(state: RuntimeState): ProjectionRow[] {
  return state.paymentDomain.paymentIntents.map((intent) => ({
    source_id: intent.id,
    table_session_id: intent.tableSessionId,
    status: intent.status,
    channel: intent.settlementChannel ?? intent.channel,
    amount_minor: intent.amount,
    currency: intent.currency,
    created_by: intent.createdBy,
    created_at: intent.createdAt,
    paid_at: intent.paidAt,
    failed_at: intent.failedAt,
    payload: JSON.stringify(intent),
    snapshot_revision: state.revision,
  }))
}

function inventoryRows(state: RuntimeState): ProjectionRow[] {
  return (state.inventoryDomain?.balances ?? []).map((balance) => ({
    product_id: balance.productId,
    unit_code: balance.unitCode,
    on_hand_quantity: balance.onHandQuantity,
    source_revision: balance.revision,
    source_updated_at: balance.updatedAt,
    payload: JSON.stringify(balance),
    snapshot_revision: state.revision,
  }))
}

export function buildOperationalProjection(state: RuntimeState): ProjectionSet[] {
  return [
    { table: 'operational_tables', keyColumns: ['source_id'], rows: tableRows(state) },
    { table: 'operational_table_sessions', keyColumns: ['source_id'], rows: tableSessionRows(state) },
    { table: 'operational_service_tasks', keyColumns: ['source_id'], rows: serviceTaskRows(state) },
    { table: 'operational_orders', keyColumns: ['source_id'], rows: orderRows(state) },
    { table: 'operational_order_items', keyColumns: ['source_id'], rows: orderItemRows(state) },
    { table: 'operational_kds_tasks', keyColumns: ['source_id'], rows: kdsTaskRows(state) },
    { table: 'operational_payment_intents', keyColumns: ['source_id'], rows: paymentRows(state) },
    { table: 'operational_inventory_balances', keyColumns: ['product_id', 'unit_code'], rows: inventoryRows(state) },
  ]
}

function keyFor(row: ProjectionRow, keyColumns: string[]) {
  return keyColumns.map((column) => String(row[column] ?? '')).join('\u001f')
}

function comparable(row: ProjectionRow) {
  const copy = { ...row }
  delete copy.snapshot_revision
  return JSON.stringify(copy)
}

async function upsertRow(
  client: PostgresPoolClient,
  context: PostgresTenantContext,
  set: ProjectionSet,
  row: ProjectionRow,
) {
  const columns = Object.keys(row)
  const allColumns = ['tenant_id', 'store_id', ...columns]
  const values = [context.tenantId, context.storeId, ...columns.map((column) => row[column])]
  const conflictColumns = ['tenant_id', 'store_id', ...set.keyColumns]
  const updateColumns = columns.filter((column) => !set.keyColumns.includes(column))
  const assignments = [...updateColumns.map((column) => `${column} = EXCLUDED.${column}`), 'projected_at = clock_timestamp()']
  await client.query(
    `INSERT INTO mbox.${set.table} (${allColumns.join(', ')})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})
     ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${assignments.join(', ')}`,
    values,
  )
}

async function deleteRow(
  client: PostgresPoolClient,
  context: PostgresTenantContext,
  set: ProjectionSet,
  row: ProjectionRow,
) {
  const predicates = set.keyColumns.map((column, index) => `${column} = $${index + 3}`)
  await client.query(
    `DELETE FROM mbox.${set.table}
     WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND ${predicates.join(' AND ')}`,
    [context.tenantId, context.storeId, ...set.keyColumns.map((column) => row[column])],
  )
}

async function synchronizeSet(
  client: PostgresPoolClient,
  context: PostgresTenantContext,
  previous: ProjectionSet | undefined,
  current: ProjectionSet,
) {
  const before = new Map((previous?.rows ?? []).map((row) => [keyFor(row, current.keyColumns), row]))
  const after = new Map(current.rows.map((row) => [keyFor(row, current.keyColumns), row]))
  for (const [key, row] of after) {
    const prior = before.get(key)
    if (!prior || comparable(prior) !== comparable(row)) await upsertRow(client, context, current, row)
  }
  for (const [key, row] of before) {
    if (!after.has(key)) await deleteRow(client, context, current, row)
  }
}

function counts(projection: ProjectionSet[]) {
  return Object.fromEntries(projection.map((set) => [set.table, set.rows.length]))
}

function projectionCountsMatch(
  expected: Record<string, number>,
  actual: Record<string, number>,
) {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
  return [...keys].every((key) => Number(expected[key] ?? -1) === Number(actual[key] ?? -2))
}

async function clearProjection(
  client: PostgresPoolClient,
  context: PostgresTenantContext,
  projection: ProjectionSet[],
) {
  for (const set of projection) {
    await client.query(
      `DELETE FROM mbox.${set.table} WHERE tenant_id = $1::uuid AND store_id = $2::uuid`,
      [context.tenantId, context.storeId],
    )
  }
}

export class PostgresOperationalProjector implements RuntimeStateProjector {
  async project(
    client: PostgresPoolClient,
    context: PostgresTenantContext,
    previous: RuntimeState | null,
    current: RuntimeState,
  ) {
    const before = previous ? buildOperationalProjection(previous) : []
    const after = buildOperationalProjection(current)
    // Startup backfill is a deterministic rebuild. Clearing the scoped read
    // model also removes stale rows left by an interrupted older projector.
    if (!previous) await clearProjection(client, context, after)
    for (const currentSet of after) {
      await synchronizeSet(client, context, before.find((set) => set.table === currentSet.table), currentSet)
    }
    await client.query(
      `INSERT INTO mbox.operational_projection_checkpoints (
         tenant_id, store_id, runtime_revision, state_sha256, entity_counts, projected_at
       ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4, $5::jsonb, clock_timestamp())
       ON CONFLICT (tenant_id, store_id) DO UPDATE SET
         runtime_revision = EXCLUDED.runtime_revision,
         state_sha256 = EXCLUDED.state_sha256,
         entity_counts = EXCLUDED.entity_counts,
         projected_at = clock_timestamp()`,
      [
        context.tenantId,
        context.storeId,
        current.revision,
        runtimeStateChecksum(serializeRuntimeState(current)),
        JSON.stringify(counts(after)),
      ],
    )
  }

  async healthCheck(
    client: PostgresPoolClient,
    context: PostgresTenantContext,
    runtimeRevision: number,
  ): Promise<OperationalProjectionHealth> {
    try {
      const result = await client.query<{
        runtime_revision: number | string
        entity_counts: Record<string, number> | string
        actual_counts: Record<string, number> | string
      }>(`
        SELECT checkpoint.runtime_revision, checkpoint.entity_counts,
          jsonb_build_object(
            'operational_tables', (SELECT count(*) FROM mbox.operational_tables WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
            'operational_table_sessions', (SELECT count(*) FROM mbox.operational_table_sessions WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
            'operational_service_tasks', (SELECT count(*) FROM mbox.operational_service_tasks WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
            'operational_orders', (SELECT count(*) FROM mbox.operational_orders WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
            'operational_order_items', (SELECT count(*) FROM mbox.operational_order_items WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
            'operational_kds_tasks', (SELECT count(*) FROM mbox.operational_kds_tasks WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
            'operational_payment_intents', (SELECT count(*) FROM mbox.operational_payment_intents WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
            'operational_inventory_balances', (SELECT count(*) FROM mbox.operational_inventory_balances WHERE tenant_id = $1::uuid AND store_id = $2::uuid)
          ) AS actual_counts
        FROM mbox.operational_projection_checkpoints checkpoint
        WHERE checkpoint.tenant_id = $1::uuid AND checkpoint.store_id = $2::uuid
      `, [context.tenantId, context.storeId])
      const row = result.rows[0]
      if (!row) return { ready: false, runtimeRevision, projectedRevision: null, countsMatch: false, error: 'projection checkpoint missing' }
      const projectedRevision = Number(row.runtime_revision)
      const expected = typeof row.entity_counts === 'string' ? JSON.parse(row.entity_counts) : row.entity_counts
      const actual = typeof row.actual_counts === 'string' ? JSON.parse(row.actual_counts) : row.actual_counts
      const countsMatch = projectionCountsMatch(expected, actual)
      return {
        ready: projectedRevision === runtimeRevision && countsMatch,
        runtimeRevision,
        projectedRevision,
        countsMatch,
      }
    } catch (error) {
      return {
        ready: false,
        runtimeRevision,
        projectedRevision: null,
        countsMatch: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
