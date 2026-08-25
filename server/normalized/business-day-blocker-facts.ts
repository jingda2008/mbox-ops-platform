import type { BusinessDayBlockerFact } from '../../src/shared/business-day-closure-contracts.js'
import type { TableSessionClosureBlockerCode } from './table-session-closure-blockers.js'
import type { ScopedTransaction } from './transaction-runner.js'

interface FactRow extends Record<string, unknown> {
  entity_type: BusinessDayBlockerFact['type']
  entity_id: string
  reference: string
  title: string
  status: string
  amount_minor: string | number | null
  quantity_text: string | null
  order_id: string | null
  order_public_id: string | null
  responsible_employee_name: string | null
}

export async function readBusinessDayBlockerFacts(
  transaction: ScopedTransaction,
  tableSessionId: string,
  code: TableSessionClosureBlockerCode,
): Promise<BusinessDayBlockerFact[]> {
  const result = await transaction.query<FactRow>(factQuery(code), [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    tableSessionId,
  ])
  return result.rows.map((row) => ({
    type: row.entity_type,
    id: row.entity_id,
    reference: row.reference,
    title: row.title,
    status: row.status,
    statusLabel: statusLabel(row.status),
    amountMinor: row.amount_minor === null ? null : safeInteger(row.amount_minor, 'blocker amount'),
    quantityText: row.quantity_text,
    orderId: row.order_id,
    orderPublicId: row.order_public_id,
    employeeRelationLabel: employeeRelationLabel(row.entity_type),
    relatedEmployeeName: row.responsible_employee_name,
    actionRoute: actionRoute(code, tableSessionId, row),
  }))
}

function factQuery(code: TableSessionClosureBlockerCode): string {
  const prefix = `
    WITH scoped_orders AS (
      SELECT ordering.*,
        EXISTS (SELECT 1 FROM mbox.order_settlement_exception_events exception
          WHERE exception.tenant_id=ordering.tenant_id AND exception.store_id=ordering.store_id
            AND exception.order_id=ordering.id) AS has_settlement_exception
      FROM mbox.orders ordering
      WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid
        AND ordering.table_session_id=$3::uuid
    ), order_facts AS (
      SELECT ordering.*,GREATEST(
        CASE
          WHEN ordering.has_settlement_exception THEN 0::bigint
          WHEN ordering.status='cancelled' THEN COALESCE((
            SELECT sum(item.total_amount_minor) FROM mbox.order_items item
            WHERE item.tenant_id=ordering.tenant_id AND item.store_id=ordering.store_id
              AND item.order_id=ordering.id AND item.status='delivered'
          ),0)::bigint
          ELSE ordering.total_amount_minor
        END-COALESCE((
          SELECT sum(payment.amount_minor) FROM mbox.payments payment
          WHERE payment.tenant_id=ordering.tenant_id AND payment.store_id=ordering.store_id
            AND payment.order_id=ordering.id
            AND payment.status IN ('succeeded','partially_refunded','refunded')
        ),0)::bigint,0::bigint) AS outstanding_amount_minor
      FROM scoped_orders ordering
    )`
  if (code === 'ORDER_UNSETTLED') return `${prefix}
    SELECT 'order'::text AS entity_type,ordering.id AS entity_id,ordering.public_id AS reference,
      '订单待结清'::text AS title,ordering.payment_status AS status,
      ordering.outstanding_amount_minor::text AS amount_minor,
      NULL::text AS quantity_text,ordering.id AS order_id,ordering.public_id AS order_public_id,
      employee.display_name AS responsible_employee_name
    FROM order_facts ordering
    LEFT JOIN mbox.employees employee ON employee.tenant_id=ordering.tenant_id
      AND employee.store_id=ordering.store_id AND employee.id=ordering.created_by_employee_id
    WHERE NOT ((ordering.status<>'cancelled' AND ordering.payment_status IN ('paid','partially_refunded','refunded'))
      OR (ordering.status='cancelled' AND ordering.payment_status='refunded')
      OR (ordering.status='cancelled' AND ordering.payment_status='unpaid' AND NOT EXISTS (
        SELECT 1 FROM mbox.order_items item WHERE item.tenant_id=ordering.tenant_id
          AND item.store_id=ordering.store_id AND item.order_id=ordering.id AND item.status='delivered'))
      OR (ordering.status='cancelled' AND ordering.payment_status='unpaid' AND ordering.has_settlement_exception))
    ORDER BY ordering.created_at,ordering.id LIMIT 25`
  if (code === 'ORDER_ITEM_UNRESOLVED') return `${prefix}
    SELECT 'order_item'::text AS entity_type,item.id AS entity_id,ordering.public_id AS reference,
      COALESCE(NULLIF(item.product_snapshot->>'name',''),product.name)||' ×'||item.quantity::text AS title,
      item.status,NULL::text AS amount_minor,
      item.quantity::text AS quantity_text,ordering.id AS order_id,ordering.public_id AS order_public_id,
      employee.display_name AS responsible_employee_name
    FROM scoped_orders ordering JOIN mbox.order_items item ON item.tenant_id=ordering.tenant_id
      AND item.store_id=ordering.store_id AND item.order_id=ordering.id
    JOIN mbox.products product ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id
      AND product.id=item.product_id
    LEFT JOIN mbox.employees employee ON employee.tenant_id=ordering.tenant_id
      AND employee.store_id=ordering.store_id AND employee.id=ordering.created_by_employee_id
    WHERE item.fulfillment_station IN ('bar','kitchen') AND item.status NOT IN ('delivered','cancelled')
    ORDER BY ordering.created_at,item.created_at,item.id LIMIT 25`
  if (code === 'KDS_ACTIVE') return `${prefix}
    SELECT 'kds_task'::text AS entity_type,task.id AS entity_id,ordering.public_id AS reference,
      COALESCE(NULLIF(item.product_snapshot->>'name',''),product.name)||' · '
        ||CASE task.station_code WHEN 'bar' THEN '吧台' ELSE '后厨' END AS title,
      task.status,NULL::text AS amount_minor,task.quantity::text AS quantity_text,
      ordering.id AS order_id,ordering.public_id AS order_public_id,employee.display_name AS responsible_employee_name
    FROM scoped_orders ordering JOIN mbox.order_items item ON item.tenant_id=ordering.tenant_id
      AND item.store_id=ordering.store_id AND item.order_id=ordering.id
    JOIN mbox.kds_tasks task ON task.tenant_id=item.tenant_id AND task.store_id=item.store_id
      AND task.order_item_id=item.id
    JOIN mbox.products product ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id
      AND product.id=item.product_id
    LEFT JOIN mbox.employees employee ON employee.tenant_id=task.tenant_id
      AND employee.store_id=task.store_id AND employee.id=task.assigned_employee_id
    WHERE task.status IN ('pending','accepted','preparing')
      OR (task.status='ready' AND item.status<>'delivered')
      OR (task.status='failed' AND item.status<>'cancelled')
    ORDER BY task.created_at,task.id LIMIT 25`
  if (code === 'PAYMENT_PENDING') return `${prefix}
    SELECT 'payment'::text AS entity_type,payment.id AS entity_id,payment.public_id AS reference,
      '付款结果待确认'::text AS title,payment.status,payment.amount_minor::text AS amount_minor,
      NULL::text AS quantity_text,ordering.id AS order_id,ordering.public_id AS order_public_id,
      employee.display_name AS responsible_employee_name
    FROM scoped_orders ordering JOIN mbox.payments payment ON payment.tenant_id=ordering.tenant_id
      AND payment.store_id=ordering.store_id AND payment.order_id=ordering.id
    LEFT JOIN mbox.payment_provider_actions action ON action.tenant_id=payment.tenant_id
      AND action.store_id=payment.store_id AND action.payment_id=payment.id
    LEFT JOIN mbox.employees employee ON employee.tenant_id=payment.tenant_id
      AND employee.store_id=payment.store_id
      AND employee.id::text=COALESCE(
        CASE WHEN action.initiated_by_type='employee' THEN action.initiated_by_ref::text END,
        payment.provider_snapshot->>'collectedByEmployeeId'
      )
    WHERE payment.status IN ('created','pending') ORDER BY payment.created_at,payment.id LIMIT 25`
  if (code === 'INVENTORY_RESERVED') return `${prefix}
    SELECT 'inventory_reservation'::text AS entity_type,reservation.id AS entity_id,
      ordering.public_id AS reference,inventory.name AS title,reservation.status,
      NULL::text AS amount_minor,reservation.quantity::text||' '||inventory.base_unit AS quantity_text,
      ordering.id AS order_id,ordering.public_id AS order_public_id,NULL::text AS responsible_employee_name
    FROM scoped_orders ordering JOIN mbox.inventory_order_reservations reservation
      ON reservation.tenant_id=ordering.tenant_id AND reservation.store_id=ordering.store_id
     AND reservation.order_id=ordering.id
    JOIN mbox.inventory_items inventory ON inventory.tenant_id=reservation.tenant_id
      AND inventory.store_id=reservation.store_id AND inventory.id=reservation.inventory_item_id
    WHERE reservation.status='reserved' ORDER BY reservation.reserved_at,reservation.id LIMIT 25`
  if (code === 'REFUND_PENDING') return `${prefix}
    SELECT 'refund'::text AS entity_type,refund.id AS entity_id,refund.public_id AS reference,
      '退款处理中'::text AS title,refund.status,refund.amount_minor::text AS amount_minor,
      NULL::text AS quantity_text,ordering.id AS order_id,ordering.public_id AS order_public_id,
      employee.display_name AS responsible_employee_name
    FROM scoped_orders ordering JOIN mbox.payments payment ON payment.tenant_id=ordering.tenant_id
      AND payment.store_id=ordering.store_id AND payment.order_id=ordering.id
    JOIN mbox.refunds refund ON refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id
      AND refund.payment_id=payment.id
    LEFT JOIN mbox.employees employee ON employee.tenant_id=refund.tenant_id
      AND employee.store_id=refund.store_id AND employee.id=refund.requested_by_employee_id
    WHERE refund.status IN ('requested','approved','processing') ORDER BY refund.created_at,refund.id LIMIT 25`
  if (code === 'SERVICE_ACTIVE') return `
    SELECT 'service_task'::text AS entity_type,task.id AS entity_id,task.public_id AS reference,
      task.title,task.status,NULL::text AS amount_minor,NULL::text AS quantity_text,
      NULL::uuid AS order_id,NULL::text AS order_public_id,employee.display_name AS responsible_employee_name
    FROM mbox.service_tasks task LEFT JOIN mbox.employees employee ON employee.tenant_id=task.tenant_id
      AND employee.store_id=task.store_id AND employee.id=task.assigned_employee_id
    WHERE task.tenant_id=$1::uuid AND task.store_id=$2::uuid AND task.table_session_id=$3::uuid
      AND task.status IN ('pending','acknowledged','in_progress') ORDER BY task.created_at,task.id LIMIT 25`
  if (code === 'PRICING_RESERVED') return `
    SELECT 'pricing_authorization'::text AS entity_type,pricing.id AS entity_id,
      pricing.id::text AS reference,CASE pricing.kind WHEN 'gift' THEN '赠送授权' ELSE '折扣授权' END AS title,
      pricing.status,pricing.amount_minor::text AS amount_minor,NULL::text AS quantity_text,
      pricing.order_id,NULL::text AS order_public_id,employee.display_name AS responsible_employee_name
    FROM mbox.pricing_authorizations pricing LEFT JOIN mbox.employees employee
      ON employee.tenant_id=pricing.tenant_id AND employee.store_id=pricing.store_id
     AND employee.id=pricing.authorized_by_employee_id
    WHERE pricing.tenant_id=$1::uuid AND pricing.store_id=$2::uuid AND pricing.table_session_id=$3::uuid
      AND pricing.status='reserved' ORDER BY pricing.created_at,pricing.id LIMIT 25`
  if (code === 'SONG_ACTIVE') return `
    SELECT 'song_request'::text AS entity_type,song.id AS entity_id,song.id::text AS reference,
      song.song_title AS title,song.status,song.quoted_amount_minor::text AS amount_minor,
      NULL::text AS quantity_text,NULL::uuid AS order_id,NULL::text AS order_public_id,
      NULL::text AS responsible_employee_name
    FROM mbox.song_requests song WHERE song.tenant_id=$1::uuid AND song.store_id=$2::uuid
      AND song.table_session_id=$3::uuid AND song.status IN ('requested','confirming','accepted','paid')
    ORDER BY song.created_at,song.id LIMIT 25`
  if (code === 'BENEFIT_RESERVED') return `
    SELECT 'benefit_reservation'::text AS entity_type,reservation.id AS entity_id,
      benefit.benefit_code AS reference,'会员权益暂留'::text AS title,reservation.status,
      benefit.value_amount_minor::text AS amount_minor,reservation.quantity::text AS quantity_text,
      NULL::uuid AS order_id,NULL::text AS order_public_id,NULL::text AS responsible_employee_name
    FROM mbox.benefit_reservations reservation JOIN mbox.benefits benefit
      ON benefit.tenant_id=reservation.tenant_id AND benefit.store_id=reservation.store_id
     AND benefit.id=reservation.benefit_id
    WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
      AND reservation.table_session_id=$3::uuid AND reservation.status='reserved'
    ORDER BY reservation.reserved_at,reservation.id LIMIT 25`
  if (code === 'EXPERIENCE_ACTIVE') return `
    SELECT 'experience_plan'::text AS entity_type,plan.id AS entity_id,plan.public_id AS reference,
      plan.promise_summary AS title,plan.plan_state AS status,NULL::text AS amount_minor,
      NULL::text AS quantity_text,NULL::uuid AS order_id,NULL::text AS order_public_id,
      NULL::text AS responsible_employee_name
    FROM mbox.customer_experience_plans plan WHERE plan.tenant_id=$1::uuid AND plan.store_id=$2::uuid
      AND plan.table_session_id=$3::uuid AND plan.plan_state IN ('planned','active','paused')
    ORDER BY plan.created_at,plan.id LIMIT 25`
  if (code === 'REDEMPTION_PENDING') return `
    SELECT 'member_redemption'::text AS entity_type,redemption.id AS entity_id,
      redemption.public_id AS reference,'积分兑换待履约'::text AS title,redemption.status,
      NULL::text AS amount_minor,redemption.quantity::text AS quantity_text,
      redemption.order_id,ordering.public_id AS order_public_id,employee.display_name AS responsible_employee_name
    FROM mbox.member_redemptions redemption LEFT JOIN mbox.orders ordering
      ON ordering.tenant_id=redemption.tenant_id AND ordering.store_id=redemption.store_id
     AND ordering.id=redemption.order_id
    LEFT JOIN mbox.employees employee ON employee.tenant_id=redemption.tenant_id
      AND employee.store_id=redemption.store_id AND employee.id=redemption.fulfilled_by_employee_id
    WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid
      AND redemption.table_session_id=$3::uuid AND redemption.status IN ('authorizing','awaiting_fulfillment')
    ORDER BY redemption.created_at,redemption.id LIMIT 25`
  return `
    SELECT 'checkout_offer'::text AS entity_type,offer.id AS entity_id,offer.public_id AS reference,
      '结账加单报价'::text AS title,offer.status,offer.amount_to_add_minor::text AS amount_minor,
      NULL::text AS quantity_text,offer.converted_order_id AS order_id,ordering.public_id AS order_public_id,
      NULL::text AS responsible_employee_name
    FROM mbox.checkout_upgrade_offers offer LEFT JOIN mbox.orders ordering
      ON ordering.tenant_id=offer.tenant_id AND ordering.store_id=offer.store_id
     AND ordering.id=offer.converted_order_id
    WHERE offer.tenant_id=$1::uuid AND offer.store_id=$2::uuid AND offer.table_session_id=$3::uuid
      AND offer.status IN ('offered','selected') ORDER BY offer.created_at,offer.id LIMIT 25`
}

function actionRoute(code: TableSessionClosureBlockerCode, tableSessionId: string, row: FactRow): string {
  const params = new URLSearchParams({ tableSessionId, focus: code, factId: row.entity_id })
  if (row.order_id !== null) params.set('orderId', row.order_id)
  if (row.order_public_id !== null) params.set('query', row.order_public_id)
  const route = ['ORDER_UNSETTLED','PAYMENT_PENDING','REFUND_PENDING'].includes(code) ? '/staff/payments'
    : ['ORDER_ITEM_UNRESOLVED','KDS_ACTIVE'].includes(code) ? '/staff/fulfillment'
      : code === 'INVENTORY_RESERVED' ? '/staff/inventory'
        : code === 'SERVICE_ACTIVE' ? '/staff/tasks'
          : code === 'SONG_ACTIVE' ? '/staff/performance'
            : ['BENEFIT_RESERVED','REDEMPTION_PENDING'].includes(code) ? '/staff/member-fulfillment'
              : ['EXPERIENCE_ACTIVE','CHECKOUT_OFFER_ACTIVE'].includes(code) ? '/staff/customer-experience'
                : '/staff/live'
  return `${route}?${params.toString()}`
}

function statusLabel(status: string): string {
  const labels: Record<string,string> = {
    unpaid:'未付款',pending:'待处理',partially_paid:'部分已付',created:'已创建',requested:'待复核',
    approved:'已审批',processing:'处理中',reserved:'已预留',submitted:'已提交',accepted:'已接单',
    preparing:'制作中',ready:'待送达',failed:'处理失败',acknowledged:'已确认',in_progress:'处理中',
    confirming:'结果确认中',paid:'已付款',planned:'已计划',active:'进行中',paused:'已暂停',
    authorizing:'授权确认中',awaiting_fulfillment:'待履约',offered:'待选择',selected:'已选择',
  }
  return labels[status] ?? '状态待确认'
}

function employeeRelationLabel(type: BusinessDayBlockerFact['type']): string {
  const labels: Partial<Record<BusinessDayBlockerFact['type'],string>> = {
    order:'订单录入人',order_item:'订单录入人',kds_task:'出品负责人',payment:'收款发起人',
    refund:'退款申请人',service_task:'服务任务负责人',pricing_authorization:'授权人',
    member_redemption:'核销员工',
  }
  return labels[type] ?? '处理分派'
}

function safeInteger(value: string | number, field: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${field} is invalid`)
  return number
}
