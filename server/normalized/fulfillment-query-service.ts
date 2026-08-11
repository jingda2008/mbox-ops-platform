import type { JsonValue } from './command-executor.js'
import {
  StaffAccessRepository,
  type EffectiveDataScope,
  type EffectiveStaffAccess,
} from './staff-access-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type ScopedTransaction,
  type StoreScope,
} from './transaction-runner.js'

export const FULFILLMENT_VIEW_ALL_PERMISSION = 'fulfillment.view_all'
export const KDS_PREPARE_PERMISSION = 'kds.prepare'
export const KDS_DELIVER_PERMISSION = 'kds.deliver'
export const KDS_STATION_SCOPE = 'kds.station_codes'

export type FulfillmentStation = 'bar' | 'kitchen' | 'cashier'
export type FulfillmentKdsStatus = 'pending' | 'accepted' | 'preparing' | 'ready'

export interface FulfillmentWorkItem {
  taskId: string
  stationCode: FulfillmentStation
  kdsStatus: FulfillmentKdsStatus
  priority: number
  overdue: boolean
  readyForDelivery: boolean
  canPrepare: boolean
  canDeliver: boolean
  dueAt: string | null
  nextActionAt: string
  createdAt: string
  order: {
    id: string
    publicId: string
    channel: 'guest_qr' | 'staff_assisted' | 'cashier' | 'reservation' | 'integration'
    status: 'submitted' | 'confirmed' | 'fulfilling'
    note: string | null
  }
  item: {
    id: string
    productId: string
    productName: string
    quantity: number
    status: 'submitted' | 'accepted' | 'preparing' | 'ready'
    note: string | null
  }
  table: {
    id: string
    code: string
    assignmentType: 'primary' | 'backup' | null
  }
  attentionMessages: string[]
}

export interface FulfillmentStaffView {
  actor: {
    employeeId: string
    employeeCode: string
    displayName: string
    roleCodes: string[]
    permissions: string[]
    allowedStations: FulfillmentStation[]
    canViewAll: boolean
  }
  generatedAt: string
  workItems: FulfillmentWorkItem[]
}

interface FulfillmentRow extends Record<string, unknown> {
  task_id: string
  station_code: FulfillmentStation
  kds_status: FulfillmentKdsStatus
  priority: number
  overdue: boolean
  ready_for_delivery: boolean
  can_prepare: boolean
  can_deliver: boolean
  due_at: string | null
  next_action_at: string
  task_created_at: string
  order_id: string
  order_public_id: string
  order_channel: FulfillmentWorkItem['order']['channel']
  order_status: FulfillmentWorkItem['order']['status']
  order_note: string | null
  order_item_id: string
  product_id: string
  product_name: string
  quantity: number
  item_status: FulfillmentWorkItem['item']['status']
  item_note: string | null
  table_id: string
  table_code: string
  assignment_type: FulfillmentWorkItem['table']['assignmentType']
  generated_at: string
}

export class FulfillmentQueryService {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  getStaffWorkQueue(
    scope: Readonly<StoreScope>,
    employeeId: string,
  ): Promise<FulfillmentStaffView> {
    if (employeeId.trim().length === 0) throw new TypeError('employeeId must not be blank')

    return this.transactions.run(scope, async (transaction) => {
      const access = await new StaffAccessRepository(transaction).resolve(employeeId)
      const canViewAll = access.permissions.includes(FULFILLMENT_VIEW_ALL_PERMISSION)
      const canPrepare = access.permissions.includes(KDS_PREPARE_PERMISSION)
      const canDeliver = access.permissions.includes(KDS_DELIVER_PERMISSION)
      const allowedStations = canPrepare
        ? resolveAllowedStations(access.dataScopes)
        : []
      const rows = await readFulfillmentRows(transaction, {
        employeeId,
        canViewAll,
        canPrepare,
        canDeliver,
        allowedStations,
      })

      return {
        actor: mapActor(access, allowedStations, canViewAll),
        generatedAt: rows[0]?.generated_at ?? new Date().toISOString(),
        workItems: rows.map(mapWorkItem),
      }
    }, { isolation: 'repeatable-read', readOnly: true })
  }
}

async function readFulfillmentRows(
  transaction: ScopedTransaction,
  access: Readonly<{
    employeeId: string
    canViewAll: boolean
    canPrepare: boolean
    canDeliver: boolean
    allowedStations: readonly FulfillmentStation[]
  }>,
): Promise<FulfillmentRow[]> {
  const result = await transaction.query<FulfillmentRow>(`
    SELECT
      task.id AS task_id,
      task.station_code,
      task.status AS kds_status,
      task.priority,
      (task.due_at IS NOT NULL AND task.due_at < transaction_timestamp()) AS overdue,
      (task.status = 'ready') AS ready_for_delivery,
      (
        $6::boolean
        AND task.station_code = ANY($5::text[])
        AND task.status IN ('pending', 'accepted', 'preparing')
      ) AS can_prepare,
      (
        $7::boolean
        AND task.status = 'ready'
        AND assignment.assignment_type IN ('primary', 'backup')
      ) AS can_deliver,
      task.due_at::text,
      task.next_action_at::text,
      task.created_at::text AS task_created_at,
      customer_order.id AS order_id,
      customer_order.public_id AS order_public_id,
      customer_order.channel AS order_channel,
      customer_order.status AS order_status,
      customer_order.note AS order_note,
      item.id AS order_item_id,
      item.product_id,
      product.name AS product_name,
      item.quantity,
      item.status AS item_status,
      item.note AS item_note,
      venue_table.id AS table_id,
      venue_table.code AS table_code,
      assignment.assignment_type,
      transaction_timestamp()::text AS generated_at
    FROM mbox.kds_tasks AS task
    JOIN mbox.order_items AS item
      ON item.tenant_id = task.tenant_id
      AND item.store_id = task.store_id
      AND item.id = task.order_item_id
    JOIN mbox.orders AS customer_order
      ON customer_order.tenant_id = item.tenant_id
      AND customer_order.store_id = item.store_id
      AND customer_order.id = item.order_id
    JOIN mbox.table_sessions AS session
      ON session.tenant_id = customer_order.tenant_id
      AND session.store_id = customer_order.store_id
      AND session.id = customer_order.table_session_id
    JOIN mbox.tables AS venue_table
      ON venue_table.tenant_id = session.tenant_id
      AND venue_table.store_id = session.store_id
      AND venue_table.id = session.table_id
    JOIN mbox.products AS product
      ON product.tenant_id = item.tenant_id
      AND product.store_id = item.store_id
      AND product.id = item.product_id
    LEFT JOIN LATERAL (
      SELECT table_assignment.assignment_type
      FROM mbox.table_assignments AS table_assignment
      WHERE table_assignment.tenant_id = venue_table.tenant_id
        AND table_assignment.store_id = venue_table.store_id
        AND table_assignment.table_id = venue_table.id
        AND table_assignment.employee_id = $3::uuid
        AND table_assignment.assignment_type IN ('primary', 'backup')
        AND table_assignment.starts_at <= transaction_timestamp()
        AND (
          table_assignment.ends_at IS NULL
          OR table_assignment.ends_at > transaction_timestamp()
        )
      ORDER BY CASE table_assignment.assignment_type WHEN 'primary' THEN 0 ELSE 1 END,
        table_assignment.starts_at DESC,
        table_assignment.id
      LIMIT 1
    ) AS assignment ON true
    WHERE task.tenant_id = $1::uuid
      AND task.store_id = $2::uuid
      AND task.status IN ('pending', 'accepted', 'preparing', 'ready')
      AND item.status IN ('submitted', 'accepted', 'preparing', 'ready')
      AND customer_order.status IN ('submitted', 'confirmed', 'fulfilling')
      AND (
        $4::boolean
        OR task.station_code = ANY($5::text[])
        OR (
          $7::boolean
          AND task.status = 'ready'
          AND assignment.assignment_type IN ('primary', 'backup')
        )
      )
    ORDER BY
      (task.due_at IS NOT NULL AND task.due_at < transaction_timestamp()) DESC,
      (task.status = 'ready') DESC,
      task.priority DESC,
      COALESCE(task.due_at, task.next_action_at, task.created_at),
      task.created_at,
      task.id
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    access.employeeId,
    access.canViewAll,
    [...access.allowedStations],
    access.canPrepare,
    access.canDeliver,
  ])
  return result.rows
}

function resolveAllowedStations(scopes: readonly EffectiveDataScope[]): FulfillmentStation[] {
  const relevant = scopes.filter((scope) => scope.key === KDS_STATION_SCOPE)
  const included = new Set<FulfillmentStation>()
  const excluded = new Set<FulfillmentStation>()

  for (const scope of relevant) {
    const target = scope.effect === 'include' ? included : excluded
    for (const station of readStations(scope.value)) target.add(station)
  }

  return [...included].filter((station) => !excluded.has(station)).toSorted()
}

function readStations(value: JsonValue): FulfillmentStation[] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value.stationCodes
        : []
  if (!Array.isArray(candidates)) return []
  return candidates.filter((candidate): candidate is FulfillmentStation => (
    candidate === 'bar' || candidate === 'kitchen'
  ))
}

function mapActor(
  access: EffectiveStaffAccess,
  allowedStations: readonly FulfillmentStation[],
  canViewAll: boolean,
): FulfillmentStaffView['actor'] {
  return {
    employeeId: access.employeeId,
    employeeCode: access.employeeCode,
    displayName: access.displayName,
    roleCodes: [...access.roleCodes],
    permissions: [...access.permissions],
    allowedStations: [...allowedStations],
    canViewAll,
  }
}

function mapWorkItem(row: FulfillmentRow): FulfillmentWorkItem {
  const attentionMessages = [row.order_note, row.item_note]
    .filter((note): note is string => note !== null && note.trim().length > 0)
  return {
    taskId: row.task_id,
    stationCode: row.station_code,
    kdsStatus: row.kds_status,
    priority: row.priority,
    overdue: row.overdue,
    readyForDelivery: row.ready_for_delivery,
    canPrepare: row.can_prepare,
    canDeliver: row.can_deliver,
    dueAt: row.due_at,
    nextActionAt: row.next_action_at,
    createdAt: row.task_created_at,
    order: {
      id: row.order_id,
      publicId: row.order_public_id,
      channel: row.order_channel,
      status: row.order_status,
      note: row.order_note,
    },
    item: {
      id: row.order_item_id,
      productId: row.product_id,
      productName: row.product_name,
      quantity: row.quantity,
      status: row.item_status,
      note: row.item_note,
    },
    table: {
      id: row.table_id,
      code: row.table_code,
      assignmentType: row.assignment_type,
    },
    attentionMessages,
  }
}
