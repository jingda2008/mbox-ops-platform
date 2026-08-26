import type {
  CashierPaymentMethod as PaymentMethod,
  CashierPaymentProvider as PaymentProvider,
  CashierPaymentStatus as PaymentStatus,
  CashierRefundStatus as RefundStatus,
  CashierWorkbenchItem,
  CashierWorkbenchActivityRegistration,
  CashierWorkbenchKdsStatus,
  CashierWorkbenchKdsTask,
  CashierWorkbenchOrder,
  CashierWorkbenchPayment,
  CashierWorkbenchRefund,
  CashierWorkbenchView,
} from '../../src/shared/cashier-workbench-contracts.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export interface CashierWorkbenchQueryInput {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
  capabilities: readonly string[]
  query?: string
  limit: number
}

interface OrderRow extends Record<string, unknown> {
  id: string
  public_id: string
  table_code: string
  table_session_id: string
  table_session_status: CashierWorkbenchOrder['tableSessionStatus']
  channel: string
  status: string
  payment_status: string
  total_amount_minor: string | number
  currency: string
  submitted_at: string | null
  created_at: string
  business_date: string
}

interface ItemRow extends Record<string, unknown> {
  id: string
  order_id: string
  product_name: string
  quantity: number
  total_amount_minor: string | number
  status: string
}

interface PaymentRow extends Record<string, unknown> {
  id: string
  order_id: string
  public_id: string
  provider: PaymentProvider
  method: PaymentMethod
  provider_transaction_id: string | null
  provider_action_state: CashierWorkbenchPayment['providerActionState']
  retry_released_at: string | null
  retry_release_reason: string | null
  amount_minor: string | number
  currency: string
  status: PaymentStatus
  succeeded_at: string | null
  created_at: string
}

interface RefundRow extends Record<string, unknown> {
  id: string
  payment_id: string
  public_id: string
  provider_refund_id: string | null
  amount_minor: string | number
  currency: string
  status: RefundStatus
  provider_submission_state: 'not_started' | 'submitting' | 'submitted' | 'manual_review'
  reason: string
  requested_by_employee_id: string
  requested_by_employee_name: string
  approved_by_employee_id: string | null
  approved_by_employee_name: string | null
  decision_reason: string | null
  receipt_reference: string | null
  completed_at: string | null
  created_at: string
}

interface RefundAllocationRow extends Record<string, unknown> {
  refund_id: string
  order_item_id: string
  amount_minor: string | number
}

interface KdsTaskRow extends Record<string, unknown> {
  id: string
  order_item_id: string
  refundable_order_item_id: string
  station_code: 'bar' | 'kitchen'
  status: CashierWorkbenchKdsStatus
  quantity: number
}

interface SettlementExceptionRow extends Record<string, unknown> {
  order_id: string
  reason_code: 'manager_comp' | 'uncollectible' | 'test_cleanup'
  settled_amount_minor: string | number
  occurred_at: string
}

interface RecollectionAuthorizationRow extends Record<string, unknown> {
  id: string
  order_id: string
  amount_minor: string | number
  expires_at: string
}

interface ActivityRegistrationRow extends Record<string, unknown> {
  id: string
  public_id: string
  activity_public_id: string
  activity_title: string
  starts_at: string
  party_size: number
  status: string
  payment_status: string
  amount_due_minor: string | number
  paid_amount_minor: string | number
  currency: string
  payment_id: string | null
  payment_public_id: string | null
  payment_provider: PaymentProvider | null
  payment_method: PaymentMethod | null
  payment_provider_transaction_id: string | null
  payment_provider_action_state: CashierWorkbenchPayment['providerActionState']
  payment_retry_released_at: string | null
  payment_retry_release_reason: string | null
  payment_amount_minor: string | number | null
  payment_currency: string | null
  payment_status_value: PaymentStatus | null
  payment_succeeded_at: string | null
  payment_created_at: string | null
  refund_id: string | null
  refund_public_id: string | null
  refund_provider_refund_id: string | null
  refund_amount_minor: string | number | null
  refund_currency: string | null
  refund_status: RefundStatus | null
  refund_provider_submission_state: CashierWorkbenchRefund['providerSubmissionState'] | null
  refund_reason: string | null
  refund_requested_by_employee_id: string | null
  refund_requested_by_employee_name: string | null
  refund_approved_by_employee_id: string | null
  refund_approved_by_employee_name: string | null
  refund_decision_reason: string | null
  refund_receipt_reference: string | null
  refund_completed_at: string | null
  refund_created_at: string | null
  recollection_authorization_id: string | null
  recollection_authorization_amount_minor: string | number | null
  recollection_authorization_expires_at: string | null
}

const CAPTURED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'succeeded',
  'partially_refunded',
  'refunded',
]
const RESERVING_REFUND_STATUSES: readonly RefundStatus[] = [
  'requested',
  'approved',
  'processing',
  'succeeded',
]
const WORKBENCH_CAPABILITIES = [
  'reconciliation.view',
  'reconciliation.manage',
  'payment.settlement.view',
  'payment.manual.cash.record',
  'payment.manual.pos.record',
  'payment.manual.external.record',
  'refund.request',
  'refund.approve',
  'refund.execute',
  'payment.recollect.authorize',
  'community.activity.cashier',
  'business_day.close',
] as const

const STORE_WIDE_WORKBENCH_CAPABILITIES = [
  'reconciliation.view',
  'reconciliation.manage',
  'payment.settlement.view',
  'payment.collect.all_tables',
  'refund.approve',
  'refund.execute',
  'business_day.close',
] as const

export class PostgresCashierWorkbenchQuery {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  get(input: Readonly<CashierWorkbenchQueryInput>): Promise<CashierWorkbenchView> {
    validateInput(input)
    const normalizedQuery = input.query?.trim() ?? ''
    const canViewStoreWide = STORE_WIDE_WORKBENCH_CAPABILITIES.some((capability) =>
      input.capabilities.includes(capability),
    )
    const canUseActivityCashier = input.capabilities.includes('community.activity.cashier')
    return this.transactions.run(input.scope, async (transaction) => {
      const orderResult = await transaction.query<OrderRow>(`
        SELECT orders.id, orders.public_id, table_row.code AS table_code,
          session.id AS table_session_id, session.status AS table_session_status,
          orders.channel, orders.status, orders.payment_status,
          orders.total_amount_minor, orders.currency,
          orders.submitted_at::text, orders.created_at::text,
          session.business_date::text
        FROM mbox.orders AS orders
        JOIN mbox.table_sessions AS session
          ON session.tenant_id = orders.tenant_id
         AND session.store_id = orders.store_id
         AND session.id = orders.table_session_id
        JOIN mbox.tables AS table_row
          ON table_row.tenant_id = session.tenant_id
         AND table_row.store_id = session.store_id
         AND table_row.id = session.table_id
        WHERE orders.tenant_id = $1::uuid
          AND orders.store_id = $2::uuid
          AND (
            session.business_date = $3::date
            OR (session.business_date < $3::date AND (
              (orders.payment_status='unpaid' AND orders.status<>'cancelled')
              OR EXISTS (
                SELECT 1 FROM mbox.order_settlement_exception_events carryover_settlement_exception
                WHERE carryover_settlement_exception.tenant_id=orders.tenant_id
                  AND carryover_settlement_exception.store_id=orders.store_id
                  AND carryover_settlement_exception.order_id=orders.id
              )
              OR EXISTS (
                SELECT 1 FROM mbox.payments AS carryover_payment
                WHERE carryover_payment.tenant_id=orders.tenant_id
                  AND carryover_payment.store_id=orders.store_id
                  AND carryover_payment.order_id=orders.id
                  AND carryover_payment.status IN ('created','pending')
              )
              OR EXISTS (
                SELECT 1 FROM mbox.payments AS carryover_payment
                JOIN mbox.refunds AS carryover_refund
                  ON carryover_refund.tenant_id=carryover_payment.tenant_id
                 AND carryover_refund.store_id=carryover_payment.store_id
                 AND carryover_refund.payment_id=carryover_payment.id
                WHERE carryover_payment.tenant_id=orders.tenant_id
                  AND carryover_payment.store_id=orders.store_id
                  AND carryover_payment.order_id=orders.id
                  AND carryover_refund.status IN ('requested','approved','processing')
              )
            ))
          )
          AND orders.status <> 'draft'
          AND EXISTS (
            SELECT 1 FROM mbox.employees AS workbench_employee
            WHERE workbench_employee.tenant_id=orders.tenant_id
              AND workbench_employee.store_id=orders.store_id
              AND workbench_employee.id=$6::uuid
              AND workbench_employee.status='active'
              AND (
                $7::boolean
                OR EXISTS (
                  SELECT 1 FROM mbox.table_assignments AS workbench_assignment
                  WHERE workbench_assignment.tenant_id=session.tenant_id
                    AND workbench_assignment.store_id=session.store_id
                    AND workbench_assignment.table_id=session.table_id
                    AND workbench_assignment.employee_id=workbench_employee.id
                    AND workbench_assignment.assignment_type IN ('primary','backup')
                    AND workbench_assignment.starts_at<=clock_timestamp()
                    AND (workbench_assignment.ends_at IS NULL
                      OR workbench_assignment.ends_at>clock_timestamp())
                )
              )
          )
          AND (
            $4::text = ''
            OR orders.public_id ILIKE '%' || $4 || '%'
            OR table_row.code ILIKE '%' || $4 || '%'
            OR EXISTS (
              SELECT 1 FROM mbox.payments AS searched_payment
              WHERE searched_payment.tenant_id = orders.tenant_id
                AND searched_payment.store_id = orders.store_id
                AND searched_payment.order_id = orders.id
                AND (
                  searched_payment.public_id ILIKE '%' || $4 || '%'
                  OR searched_payment.provider_transaction_id ILIKE '%' || $4 || '%'
                )
            )
            OR EXISTS (
              SELECT 1
              FROM mbox.refunds AS searched_refund
              JOIN mbox.payments AS searched_refund_payment
                ON searched_refund_payment.tenant_id = searched_refund.tenant_id
               AND searched_refund_payment.store_id = searched_refund.store_id
               AND searched_refund_payment.id = searched_refund.payment_id
              WHERE searched_refund.tenant_id = orders.tenant_id
                AND searched_refund.store_id = orders.store_id
                AND searched_refund_payment.order_id = orders.id
                AND (
                  searched_refund.public_id ILIKE '%' || $4 || '%'
                  OR searched_refund.provider_refund_id ILIKE '%' || $4 || '%'
                )
            )
          )
        ORDER BY (session.business_date < $3::date) DESC,
          COALESCE(orders.submitted_at, orders.created_at) DESC, orders.id DESC
        LIMIT $5
      `, [
        input.scope.tenantId,
        input.scope.storeId,
        input.businessDate,
        normalizedQuery,
        input.limit,
        input.employeeId,
        canViewStoreWide,
      ])
      const activityResult = canUseActivityCashier
        ? await transaction.query<ActivityRegistrationRow>(`
            SELECT registration.id,registration.public_id,
              activity.public_id AS activity_public_id,activity.title AS activity_title,
              activity.starts_at::text,registration.party_size,registration.status,registration.payment_status,
              registration.amount_due_minor,registration.paid_amount_minor,registration.currency,
              payment.id AS payment_id,payment.public_id AS payment_public_id,
              payment.provider AS payment_provider,payment.method AS payment_method,
              payment.provider_transaction_id AS payment_provider_transaction_id,
              provider_action.state AS payment_provider_action_state,
              payment.retry_released_at::text AS payment_retry_released_at,
              payment.retry_release_reason AS payment_retry_release_reason,
              payment.amount_minor AS payment_amount_minor,payment.currency AS payment_currency,
              payment.status AS payment_status_value,payment.succeeded_at::text AS payment_succeeded_at,
              payment.created_at::text AS payment_created_at,
              refund.id AS refund_id,refund.public_id AS refund_public_id,
              refund.provider_refund_id AS refund_provider_refund_id,refund.amount_minor AS refund_amount_minor,
              refund.currency AS refund_currency,refund.status AS refund_status,
              refund.provider_submission_state AS refund_provider_submission_state,refund.reason AS refund_reason,
              refund.requested_by_employee_id AS refund_requested_by_employee_id,
              requester.display_name AS refund_requested_by_employee_name,
              refund.approved_by_employee_id AS refund_approved_by_employee_id,
              approver.display_name AS refund_approved_by_employee_name,
              refund.decision_reason AS refund_decision_reason,
              NULLIF(refund.provider_snapshot ->> 'receiptReference','') AS refund_receipt_reference,
              refund.completed_at::text AS refund_completed_at,refund.created_at::text AS refund_created_at,
              recollection.id AS recollection_authorization_id,
              recollection.amount_minor AS recollection_authorization_amount_minor,
              recollection.expires_at::text AS recollection_authorization_expires_at
            FROM mbox.community_activity_registrations registration
            JOIN mbox.community_activities activity
              ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
             AND activity.id=registration.activity_id
            LEFT JOIN mbox.payments payment
              ON payment.tenant_id=registration.tenant_id AND payment.store_id=registration.store_id
             AND payment.id=registration.payment_id
            LEFT JOIN mbox.payment_provider_actions provider_action
              ON provider_action.tenant_id=payment.tenant_id AND provider_action.store_id=payment.store_id
             AND provider_action.payment_id=payment.id
            LEFT JOIN LATERAL (
              SELECT candidate.* FROM mbox.refunds candidate
              WHERE candidate.tenant_id=registration.tenant_id AND candidate.store_id=registration.store_id
                AND candidate.payment_id=registration.payment_id
              ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1
            ) refund ON true
            LEFT JOIN mbox.employees requester
              ON requester.tenant_id=refund.tenant_id AND requester.store_id=refund.store_id
             AND requester.id=refund.requested_by_employee_id
            LEFT JOIN mbox.employees approver
              ON approver.tenant_id=refund.tenant_id AND approver.store_id=refund.store_id
             AND approver.id=refund.approved_by_employee_id
            LEFT JOIN LATERAL (
              SELECT recollection_authorization.*
              FROM mbox.activity_registration_recollection_authorizations recollection_authorization
              WHERE recollection_authorization.tenant_id=registration.tenant_id
                AND recollection_authorization.store_id=registration.store_id
                AND recollection_authorization.activity_registration_id=registration.id
                AND recollection_authorization.status='active'
                AND recollection_authorization.expires_at>clock_timestamp()
              ORDER BY recollection_authorization.created_at DESC,recollection_authorization.id DESC LIMIT 1
            ) recollection ON true
            WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
              AND (
                EXISTS (
                  SELECT 1 FROM mbox.reconciliation_entries activity_reconciliation
                  WHERE activity_reconciliation.tenant_id=registration.tenant_id
                    AND activity_reconciliation.store_id=registration.store_id
                    AND activity_reconciliation.payment_id=registration.payment_id
                    AND activity_reconciliation.business_date=$3::date
                )
                OR registration.status='payment_pending'
                OR registration.payment_status IN ('pending','refunded')
                OR refund.status IN ('requested','approved','processing')
                OR recollection.id IS NOT NULL
                -- A deliberate cashier lookup may retrieve an older completed
                -- activity payment for refund handling; routine loads remain
                -- constrained to daily reconciliation and unresolved facts.
                OR $4::text <> ''
              )
              AND (
                $4::text=''
                OR registration.public_id ILIKE '%' || $4 || '%'
                OR activity.public_id ILIKE '%' || $4 || '%'
                OR activity.title ILIKE '%' || $4 || '%'
                OR payment.public_id ILIKE '%' || $4 || '%'
                OR refund.public_id ILIKE '%' || $4 || '%'
                OR refund.provider_refund_id ILIKE '%' || $4 || '%'
              )
            ORDER BY (registration.status='payment_pending') DESC,
              COALESCE(payment.succeeded_at,registration.created_at) DESC,registration.id DESC
            LIMIT $5
          `, [
            input.scope.tenantId,
            input.scope.storeId,
            input.businessDate,
            normalizedQuery,
            input.limit,
          ])
        : { rows: [] as ActivityRegistrationRow[] }
      const orderIds = orderResult.rows.map((row) => row.id)
      if (orderIds.length === 0) {
        return assembleView(
          input, normalizedQuery, [], [], [], [], [], [], [], [], activityResult.rows,
        )
      }

      const itemResult = await transaction.query<ItemRow>(`
          SELECT item.id, item.order_id,
            COALESCE(NULLIF(item.product_snapshot ->> 'name', ''), product.name) AS product_name,
            item.quantity, item.total_amount_minor, item.status
          FROM mbox.order_items AS item
          JOIN mbox.products AS product
            ON product.tenant_id = item.tenant_id
           AND product.store_id = item.store_id
           AND product.id = item.product_id
          WHERE item.tenant_id = $1::uuid
            AND item.store_id = $2::uuid
            AND item.order_id = ANY($3::uuid[])
            AND item.parent_order_item_id IS NULL
          ORDER BY item.created_at, item.id
        `, [input.scope.tenantId, input.scope.storeId, orderIds])
      const paymentResult = await transaction.query<PaymentRow>(`
          SELECT payment.id, payment.order_id, payment.public_id, payment.provider,
            payment.method, payment.provider_transaction_id,
            provider_action.state AS provider_action_state,
            payment.retry_released_at::text AS retry_released_at,
            payment.retry_release_reason,
            payment.amount_minor, payment.currency, payment.status,
            payment.succeeded_at::text, payment.created_at::text
          FROM mbox.payments payment
          LEFT JOIN mbox.payment_provider_actions provider_action
            ON provider_action.tenant_id = payment.tenant_id
           AND provider_action.store_id = payment.store_id
           AND provider_action.payment_id = payment.id
          WHERE payment.tenant_id = $1::uuid
            AND payment.store_id = $2::uuid
            AND payment.order_id = ANY($3::uuid[])
          ORDER BY payment.created_at DESC, payment.id DESC
        `, [input.scope.tenantId, input.scope.storeId, orderIds])
      const refundResult = await transaction.query<RefundRow>(`
          SELECT refund.id, refund.payment_id, refund.public_id, refund.provider_refund_id,
            refund.amount_minor, refund.currency, refund.status, refund.provider_submission_state,
            refund.reason,
            refund.requested_by_employee_id,
            requester.display_name AS requested_by_employee_name,
            refund.approved_by_employee_id,
            approver.display_name AS approved_by_employee_name,
            refund.decision_reason,
            NULLIF(refund.provider_snapshot ->> 'receiptReference', '') AS receipt_reference,
            refund.completed_at::text, refund.created_at::text
          FROM mbox.refunds AS refund
          JOIN mbox.payments AS payment
            ON payment.tenant_id = refund.tenant_id
           AND payment.store_id = refund.store_id
           AND payment.id = refund.payment_id
          JOIN mbox.employees AS requester
            ON requester.tenant_id = refund.tenant_id
           AND requester.store_id = refund.store_id
           AND requester.id = refund.requested_by_employee_id
          LEFT JOIN mbox.employees AS approver
            ON approver.tenant_id = refund.tenant_id
           AND approver.store_id = refund.store_id
           AND approver.id = refund.approved_by_employee_id
          WHERE refund.tenant_id = $1::uuid
            AND refund.store_id = $2::uuid
            AND payment.order_id = ANY($3::uuid[])
          ORDER BY refund.created_at DESC, refund.id DESC
        `, [input.scope.tenantId, input.scope.storeId, orderIds])
      const refundIds = refundResult.rows.map((row) => row.id)
      const allocationResult = refundIds.length === 0
        ? { rows: [] as RefundAllocationRow[] }
        : await transaction.query<RefundAllocationRow>(`
            SELECT refund_id, order_item_id, amount_minor
            FROM mbox.refund_items
            WHERE tenant_id = $1::uuid
              AND store_id = $2::uuid
              AND refund_id = ANY($3::uuid[])
            ORDER BY created_at, id
          `, [input.scope.tenantId, input.scope.storeId, refundIds])
      const kdsResult = await transaction.query<KdsTaskRow>(`
          SELECT task.id, task.order_item_id,
            COALESCE(item.parent_order_item_id, item.id) AS refundable_order_item_id,
            task.station_code, task.status, task.quantity
          FROM mbox.kds_tasks AS task
          JOIN mbox.order_items AS item
            ON item.tenant_id = task.tenant_id
           AND item.store_id = task.store_id
           AND item.id = task.order_item_id
          WHERE task.tenant_id = $1::uuid
            AND task.store_id = $2::uuid
            AND item.order_id = ANY($3::uuid[])
          ORDER BY task.created_at, task.id
        `, [input.scope.tenantId, input.scope.storeId, orderIds])
      const settlementExceptionResult = await transaction.query<SettlementExceptionRow>(`
          SELECT order_id,reason_code,settled_amount_minor,occurred_at::text
          FROM mbox.order_settlement_exception_events
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=ANY($3::uuid[])
          ORDER BY occurred_at,id
        `, [input.scope.tenantId, input.scope.storeId, orderIds])
      const recollectionResult = await transaction.query<RecollectionAuthorizationRow>(`
          SELECT id,order_id,amount_minor,expires_at::text
          FROM mbox.order_recollection_authorizations
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=ANY($3::uuid[])
            AND status='active' AND expires_at>clock_timestamp()
          ORDER BY created_at DESC,id DESC
        `, [input.scope.tenantId, input.scope.storeId, orderIds])

      return assembleView(
        input,
        normalizedQuery,
        orderResult.rows,
        itemResult.rows,
        paymentResult.rows,
        refundResult.rows,
        allocationResult.rows,
        kdsResult.rows,
        settlementExceptionResult.rows,
        recollectionResult.rows,
        activityResult.rows,
      )
    }, { readOnly: true })
  }
}

function assembleView(
  input: Readonly<CashierWorkbenchQueryInput>,
  query: string,
  orderRows: readonly OrderRow[],
  itemRows: readonly ItemRow[],
  paymentRows: readonly PaymentRow[],
  refundRows: readonly RefundRow[],
  allocationRows: readonly RefundAllocationRow[],
  kdsTaskRows: readonly KdsTaskRow[],
  settlementExceptionRows: readonly SettlementExceptionRow[],
  recollectionRows: readonly RecollectionAuthorizationRow[],
  activityRows: readonly ActivityRegistrationRow[],
): CashierWorkbenchView {
  const orderById = new Map(orderRows.map((order) => [order.id, order]))
  const itemsByOrder = group(itemRows, (row) => row.order_id)
  const paymentsByOrder = group(paymentRows, (row) => row.order_id)
  const refundsByPayment = group(refundRows, (row) => row.payment_id)
  const allocationsByRefund = group(allocationRows, (row) => row.refund_id)
  const kdsByOrderItem = group(kdsTaskRows, (row) => row.refundable_order_item_id)
  const settlementExceptionByOrder = new Map(settlementExceptionRows.map((row) => [row.order_id, row]))
  const recollectionByOrder = new Map(recollectionRows.map((row) => [row.order_id, row]))
  const succeededRefundAmountByItem = new Map<string, number>()
  const succeededRefundIds = new Set(refundRows.filter((refund) => refund.status === 'succeeded').map((refund) => refund.id))
  for (const allocation of allocationRows) {
    if (!succeededRefundIds.has(allocation.refund_id)) continue
    succeededRefundAmountByItem.set(
      allocation.order_item_id,
      (succeededRefundAmountByItem.get(allocation.order_item_id) ?? 0) + asSafeMinor(allocation.amount_minor, 'succeeded refund allocation'),
    )
  }
  const orders = orderRows.map((order): CashierWorkbenchOrder => {
    const items = (itemsByOrder.get(order.id) ?? []).map(mapItem)
    const payments = (paymentsByOrder.get(order.id) ?? []).map((payment) => {
      const refunds = (refundsByPayment.get(payment.id) ?? []).map((refund) => mapRefund(
        refund,
        allocationsByRefund.get(refund.id) ?? [],
      ))
      const reservingRefunds = refunds.filter((refund) => RESERVING_REFUND_STATUSES.includes(refund.status))
      const reservedRefundAmountMinor = sumMinor(reservingRefunds.map((refund) => refund.amountMinor))
      const reservedByItem = new Map<string, number>()
      for (const refund of reservingRefunds) {
        for (const allocation of refund.allocations) {
          reservedByItem.set(
            allocation.orderItemId,
            (reservedByItem.get(allocation.orderItemId) ?? 0) + allocation.amountMinor,
          )
        }
      }
      const captured = CAPTURED_PAYMENT_STATUSES.includes(payment.status)
      const paymentRemaining = captured
        ? Math.max(0, asSafeMinor(payment.amount_minor, 'payment amount') - reservedRefundAmountMinor)
        : 0
      return {
        id: payment.id,
        publicId: payment.public_id,
        provider: payment.provider,
        method: payment.method,
        providerTransactionId: payment.provider_transaction_id,
        providerActionState: payment.provider_action_state,
        retryReleasedAt: payment.retry_released_at,
        retryReleaseReason: payment.retry_release_reason,
        amountMinor: asSafeMinor(payment.amount_minor, 'payment amount'),
        currency: payment.currency,
        status: payment.status,
        succeededAt: payment.succeeded_at,
        createdAt: payment.created_at,
        reservedRefundAmountMinor,
        remainingRefundableMinor: paymentRemaining,
        refundableItems: items.map((item) => {
          const reserved = reservedByItem.get(item.id) ?? 0
          return {
            ...item,
            reservedRefundAmountMinor: reserved,
            remainingRefundableMinor: captured && item.status !== 'cancelled'
              ? Math.min(Math.max(0, item.totalAmountMinor - reserved), paymentRemaining)
              : 0,
          }
        }),
        refunds,
      }
    })
    const grossPaidMinor = payments
      .filter((payment) => CAPTURED_PAYMENT_STATUSES.includes(payment.status))
      .reduce((sum, payment) => sum + payment.amountMinor, 0)
    const refundedMinor = payments.reduce((sum, payment) => sum + payment.refunds
      .filter((refund) => refund.status === 'succeeded')
      .reduce((refundSum, refund) => refundSum + refund.amountMinor, 0), 0)
    const totalAmountMinor = asSafeMinor(order.total_amount_minor, 'order total')
    const netCollectedMinor = grossPaidMinor - refundedMinor
    return {
      id: order.id,
      publicId: order.public_id,
      tableCode: order.table_code,
      tableSessionId: order.table_session_id,
      tableSessionStatus: order.table_session_status,
      channel: order.channel,
      status: order.status,
      paymentStatus: order.payment_status,
      totalAmountMinor,
      outstandingAmountMinor: Math.max(0, totalAmountMinor - netCollectedMinor),
      overCollectedAmountMinor: Math.max(0, netCollectedMinor - totalAmountMinor),
      currency: order.currency,
      submittedAt: order.submitted_at,
      createdAt: order.created_at,
      businessDate: order.business_date,
      carryover: order.business_date < input.businessDate,
      settlementException: settlementExceptionByOrder.has(order.id)
        ? {
            reasonCode: settlementExceptionByOrder.get(order.id)!.reason_code,
            settledAmountMinor: asSafeMinor(
              settlementExceptionByOrder.get(order.id)!.settled_amount_minor,
              'settlement exception amount',
            ),
            occurredAt: settlementExceptionByOrder.get(order.id)!.occurred_at,
          }
        : null,
      recollectionAuthorization: recollectionByOrder.has(order.id)
        ? {
            id: recollectionByOrder.get(order.id)!.id,
            amountMinor: asSafeMinor(recollectionByOrder.get(order.id)!.amount_minor, 'recollection authorization amount'),
            expiresAt: recollectionByOrder.get(order.id)!.expires_at,
          }
        : null,
      items,
      kdsTasks: items.flatMap((item): CashierWorkbenchKdsTask[] => (
        (kdsByOrderItem.get(item.id) ?? []).map((task) => ({
          id: task.id,
          orderItemId: task.order_item_id,
          stationCode: task.station_code,
          status: task.status,
          quantity: task.quantity,
          succeededRefundAmountMinor: succeededRefundAmountByItem.get(task.refundable_order_item_id) ?? 0,
        }))
      )),
      payments,
    }
  })
  const activityRegistrations = activityRows.map(mapActivityRegistration)
  return {
    businessDate: input.businessDate,
    query,
    actions: actions(input.capabilities),
    summary: {
      orderCount: orders.length,
      capturedPaymentCount: paymentRows.filter((payment) => CAPTURED_PAYMENT_STATUSES.includes(payment.status)).length,
      requestedRefundCount: refundRows.filter((refund) => refund.status === 'requested').length,
      processingRefundCount: refundRows.filter((refund) => refund.status === 'approved' || refund.status === 'processing').length,
      carryoverOrderCount: orders.filter((order) => order.carryover === true).length,
      carryoverPendingPaymentCount: paymentRows.filter((payment) => (
        payment.status === 'created' || payment.status === 'pending'
      ) && (orderById.get(payment.order_id)?.business_date ?? input.businessDate) < input.businessDate).length,
      activityPendingPaymentCount: activityRegistrations.filter((registration) => (
        registration.status === 'payment_pending' || registration.paymentStatus === 'pending'
      )).length,
      activityRequestedRefundCount: activityRegistrations.filter((registration) => (
        registration.payment?.refunds.some((refund) => refund.status === 'requested')
      )).length,
      activityProcessingRefundCount: activityRegistrations.filter((registration) => (
        registration.payment?.refunds.some((refund) => (
          refund.status === 'approved' || refund.status === 'processing'
        ))
      )).length,
    },
    orders,
    activityRegistrations,
  }
}

function actions(capabilities: readonly string[]) {
  const set = new Set(capabilities)
  return {
    canInitiateOnlinePayment: set.has('payment.initiate.staff'),
    canQueryOnlinePayment: set.has('payment.query'),
    onlinePaymentProvider: null,
    canRecordManualCash: set.has('payment.manual.cash.record'),
    canRecordManualPos: set.has('payment.manual.pos.record'),
    canRecordManualExternal: set.has('payment.manual.external.record'),
    canRequestRefund: set.has('refund.request'),
    canApproveRefund: set.has('refund.approve'),
    canExecuteRefund: set.has('refund.execute'),
    canAuthorizeRecollection: set.has('payment.recollect.authorize'),
    canUseActivityCashier: set.has('community.activity.cashier'),
    canViewReconciliation: set.has('reconciliation.view'),
    canManageKdsException: set.has('kds.exception.manage'),
  }
}

function mapItem(row: ItemRow): CashierWorkbenchItem {
  return {
    id: row.id,
    productName: row.product_name,
    quantity: row.quantity,
    totalAmountMinor: asSafeMinor(row.total_amount_minor, 'order item total'),
    status: row.status,
  }
}

function mapRefund(
  row: RefundRow,
  allocations: readonly RefundAllocationRow[],
): CashierWorkbenchRefund {
  return {
    id: row.id,
    publicId: row.public_id,
    paymentId: row.payment_id,
    providerRefundId: row.provider_refund_id,
    amountMinor: asSafeMinor(row.amount_minor, 'refund amount'),
    currency: row.currency,
    status: row.status,
    providerSubmissionState: row.provider_submission_state,
    reason: row.reason,
    requestedByEmployeeId: row.requested_by_employee_id,
    requestedByEmployeeName: row.requested_by_employee_name,
    approvedByEmployeeId: row.approved_by_employee_id,
    approvedByEmployeeName: row.approved_by_employee_name,
    decisionReason: row.decision_reason,
    receiptReference: row.receipt_reference,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    allocations: allocations.map((allocation) => ({
      orderItemId: allocation.order_item_id,
      amountMinor: asSafeMinor(allocation.amount_minor, 'refund allocation amount'),
    })),
  }
}

function mapActivityRegistration(row: ActivityRegistrationRow): CashierWorkbenchActivityRegistration {
  return {
    id: row.id,
    publicId: row.public_id,
    activityPublicId: row.activity_public_id,
    activityTitle: row.activity_title,
    startsAt: row.starts_at,
    partySize: row.party_size,
    status: row.status,
    paymentStatus: row.payment_status,
    amountDueMinor: asSafeMinor(row.amount_due_minor, 'activity amount due'),
    paidAmountMinor: asSafeMinor(row.paid_amount_minor, 'activity paid amount'),
    currency: row.currency,
    payment: row.payment_id === null ? null : mapActivityPayment(row),
    recollectionAuthorization: row.recollection_authorization_id === null
      ? null
      : {
          id: row.recollection_authorization_id,
          amountMinor: asSafeMinor(
            requireMinor(row.recollection_authorization_amount_minor, 'activity recollection authorization amount'),
            'activity recollection authorization amount',
          ),
          expiresAt: requireText(row.recollection_authorization_expires_at, 'activity recollection authorization expiry'),
        },
  }
}

function mapActivityPayment(row: ActivityRegistrationRow): CashierWorkbenchPayment {
  const id = requireText(row.payment_id, 'activity payment id')
  const amountMinor = asSafeMinor(requireMinor(row.payment_amount_minor, 'activity payment amount'), 'activity payment amount')
  const status = requireValue(row.payment_status_value, 'activity payment status')
  const refunds: CashierWorkbenchRefund[] = row.refund_id === null
    ? []
    : [{
        id: row.refund_id,
        publicId: requireText(row.refund_public_id, 'activity refund public id'),
        paymentId: id,
        providerRefundId: row.refund_provider_refund_id,
        amountMinor: asSafeMinor(requireMinor(row.refund_amount_minor, 'activity refund amount'), 'activity refund amount'),
        currency: requireText(row.refund_currency, 'activity refund currency'),
        status: requireValue(row.refund_status, 'activity refund status'),
        providerSubmissionState: requireValue(
          row.refund_provider_submission_state,
          'activity refund provider submission state',
        ),
        reason: requireText(row.refund_reason, 'activity refund reason'),
        requestedByEmployeeId: requireText(row.refund_requested_by_employee_id, 'activity refund requester'),
        requestedByEmployeeName: row.refund_requested_by_employee_name ?? '已离职员工',
        approvedByEmployeeId: row.refund_approved_by_employee_id,
        approvedByEmployeeName: row.refund_approved_by_employee_name,
        decisionReason: row.refund_decision_reason,
        receiptReference: row.refund_receipt_reference,
        completedAt: row.refund_completed_at,
        createdAt: requireText(row.refund_created_at, 'activity refund created time'),
        allocations: [],
      }]
  const reservedRefundAmountMinor = sumMinor(refunds
    .filter((refund) => RESERVING_REFUND_STATUSES.includes(refund.status))
    .map((refund) => refund.amountMinor))
  return {
    id,
    publicId: requireText(row.payment_public_id, 'activity payment public id'),
    provider: requireValue(row.payment_provider, 'activity payment provider'),
    method: requireValue(row.payment_method, 'activity payment method'),
    providerTransactionId: row.payment_provider_transaction_id,
    providerActionState: row.payment_provider_action_state,
    retryReleasedAt: row.payment_retry_released_at,
    retryReleaseReason: row.payment_retry_release_reason,
    amountMinor,
    currency: requireText(row.payment_currency, 'activity payment currency'),
    status,
    succeededAt: row.payment_succeeded_at,
    createdAt: requireText(row.payment_created_at, 'activity payment created time'),
    reservedRefundAmountMinor,
    remainingRefundableMinor: CAPTURED_PAYMENT_STATUSES.includes(status)
      ? Math.max(0, amountMinor - reservedRefundAmountMinor)
      : 0,
    refundableItems: [],
    refunds,
  }
}

function requireText(value: string | null, label: string): string {
  if (value === null || value.length === 0) throw new RangeError(`${label} is missing`)
  return value
}

function requireMinor(value: string | number | null, label: string): string | number {
  if (value === null) throw new RangeError(`${label} is missing`)
  return value
}

function requireValue<T>(value: T | null, label: string): T {
  if (value === null) throw new RangeError(`${label} is missing`)
  return value
}

function group<Row>(rows: readonly Row[], key: (row: Row) => string): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>()
  for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row])
  return grouped
}

function validateInput(input: Readonly<CashierWorkbenchQueryInput>): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuid.test(input.scope.tenantId) || !uuid.test(input.scope.storeId) || !uuid.test(input.employeeId)) {
    throw new TypeError('cashier workbench scope or employee is invalid')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw new TypeError('cashier workbench businessDate is invalid')
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new TypeError('cashier workbench limit must be between 1 and 100')
  }
  if ((input.query?.trim().length ?? 0) > 64) throw new TypeError('cashier workbench query is too long')
  if (!input.capabilities.some((capability) => WORKBENCH_CAPABILITIES.includes(
    capability as typeof WORKBENCH_CAPABILITIES[number],
  ))) {
    throw new TypeError('cashier workbench requires a financial capability')
  }
}

function asSafeMinor(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} exceeds safe integer range`)
  return parsed
}

function sumMinor(values: readonly number[]): number {
  return values.reduce((sum, value) => {
    const next = sum + value
    if (!Number.isSafeInteger(next)) throw new RangeError('cashier workbench amount exceeds safe integer range')
    return next
  }, 0)
}
