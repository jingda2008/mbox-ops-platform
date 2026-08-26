import { createHash } from 'node:crypto'
import type { AuditActor, JsonObject } from './command-executor.js'
import type { PublicCustomerExperienceContext, StaffCustomerExperienceContext } from './customer-experience-service.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import type { OnlinePaymentAction, OnlinePaymentService } from './online-payment-service.js'
import { OnlinePaymentUnavailableError, OnlinePaymentUnknownError } from './online-payment-service.js'
import { WechatPaymentIdentityRequiredError } from './payment-provider-action-repository.js'
import { PostarPaymentRejectedError } from '../postar-adapter.js'
import type { PaymentCommandService } from './payment-command-service.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'
import { PaymentRepository } from './payment-repository.js'

export type ActivityPaymentResolutionState =
  | 'not_required' | 'action_required' | 'pending' | 'unknown'
  | 'confirmed' | 'failed' | 'expired'
  | 'refund_requested' | 'refunding' | 'refunded'

export type ActivityPaymentAllowedAction =
  | 'start_payment' | 'query_payment' | 'cancel_registration'

export interface PublicActivityPaymentState {
  registrationPublicId: string
  paymentPublicId: string | null
  resolutionState: ActivityPaymentResolutionState
  paymentStatus: string
  amountDueMinor: number
  paidAmountMinor: number
  currency: string
  expiresAt: string | null
  allowedActions: ActivityPaymentAllowedAction[]
  refundStatus: string | null
}

export interface PublicActivityProviderAction {
  paymentPublicId: string
  status: 'pending' | 'unknown' | 'failed'
  presentation: 'jsapi'
  expiresAt: string
  payload: Readonly<Record<string, string>> | null
}

interface ActivityPaymentRow extends Record<string, unknown> {
  registration_id: string
  registration_public_id: string
  registration_status: string
  registration_cycle: number
  payment_status: string
  amount_due_minor: string | number
  paid_amount_minor: string | number
  currency: string
  seat_hold_expires_at: string | null
  activity_starts_at: string
  payment_id: string | null
  payment_public_id: string | null
  payment_method: string | null
  authoritative_payment_status: string | null
  provider_action_state: 'creating' | 'ready' | 'unknown' | 'failed' | 'consumed' | null
  refund_status: string | null
}

type ActivityOnlinePayments = Pick<OnlinePaymentService, 'create' | 'query' | 'close'>
type ActivityPaymentCommands = Pick<
  PaymentCommandService,
  'recordProviderQueryResult' | 'requestActivityRefund'
>

export class ActivityPaymentService {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly commands: ActivityPaymentCommands,
    private readonly onlinePayments: ActivityOnlinePayments,
  ) {}

  get(context: PublicCustomerExperienceContext, registrationPublicId: string) {
    return this.transactions.run(context.scope, async (transaction) => (
      view(await ownedActivityPayment(transaction, context.customerId, registrationPublicId))
    ), { readOnly: true })
  }

  async createAction(
    context: PublicCustomerExperienceContext,
    input: Readonly<{ registrationPublicId: string; clientIp: string; idempotencyKey: string }>,
  ): Promise<{ payment: PublicActivityPaymentState; providerAction: PublicActivityProviderAction | null }> {
    const current = await this.transactions.run(context.scope, async (transaction) => (
      ownedActivityPayment(transaction, context.customerId, input.registrationPublicId)
    ), { readOnly: true })
    const before = view(current)
    if (!before.allowedActions.includes('start_payment')) {
      return { payment: before, providerAction: null }
    }
    await this.transactions.run(context.scope, (transaction) => (
      new PaymentRepository(transaction).assertNoUnrefundedHistoricalActivityPayment(
        current.registration_id,
        current.registration_cycle,
      )
    ))
    if (current.payment_id === null) throw invalidActivityPayment('报名缺少权威支付对象')
    if (current.payment_method !== 'jsapi') {
      throw new CustomerExperienceRequestError(
        '这笔历史报名付款方式不能在小程序继续支付，请联系收银协助处理。报名和名额仍会保留。',
        'ACTIVITY_PAYMENT_METHOD_UNSUPPORTED',
        409,
      )
    }
    try {
      const action = await this.onlinePayments.create({
        scope: context.scope,
        paymentId: current.payment_id,
        principal: { type: 'guest', tableSessionId: null, customerId: context.customerId },
        clientIp: input.clientIp,
        operatorId: 'MBOXACTIVITY',
        idempotencyKey: input.idempotencyKey,
      })
      return { payment: await this.get(context, input.registrationPublicId), providerAction: publicProviderAction(action) }
    } catch (error) {
      if (error instanceof WechatPaymentIdentityRequiredError) {
        throw new CustomerExperienceRequestError(error.message, 'WECHAT_IDENTITY_REQUIRED', 409)
      }
      if (!(error instanceof OnlinePaymentUnknownError) && !(error instanceof OnlinePaymentUnavailableError)
        && !(error instanceof Error && error.name === 'PostarPaymentRejectedError')) throw error
      return { payment: await this.get(context, input.registrationPublicId), providerAction: null }
    }
  }

  async query(
    context: PublicCustomerExperienceContext,
    input: Readonly<{ registrationPublicId: string; idempotencyKey: string }>,
  ): Promise<PublicActivityPaymentState> {
    const current = await this.transactions.run(context.scope, async (transaction) => (
      ownedActivityPayment(transaction, context.customerId, input.registrationPublicId)
    ), { readOnly: true })
    const before = view(current)
    if (!before.allowedActions.includes('query_payment')) return before
    if (current.payment_id === null) throw invalidActivityPayment('报名缺少权威支付对象')
    let queried: Awaited<ReturnType<ActivityOnlinePayments['query']>>
    try {
      queried = await this.onlinePayments.query({
        scope: context.scope,
        paymentId: current.payment_id,
        queryBindingId: input.idempotencyKey,
        principal: { type: 'guest', tableSessionId: null, customerId: context.customerId },
      })
    } catch (error) {
      if (error instanceof OnlinePaymentUnknownError || error instanceof OnlinePaymentUnavailableError) return before
      throw error
    }
    return this.applyObservedPayment(context, input.registrationPublicId, queried, input.idempotencyKey)
  }

  /**
   * Before a customer abandons a paid-registration hold, authoritatively query
   * and, when still unpaid, close the single provider order.  A late success
   * therefore becomes a payment/refund workflow instead of being mistaken for
   * a safely cancellable registration.
   */
  async prepareCancellation(
    context: PublicCustomerExperienceContext,
    input: Readonly<{ registrationPublicId: string; idempotencyKey: string }>,
  ): Promise<PublicActivityPaymentState> {
    const current = await this.transactions.run(context.scope, async (transaction) => (
      ownedActivityPayment(transaction, context.customerId, input.registrationPublicId)
    ), { readOnly: true })
    if (current.payment_id === null || current.provider_action_state === null) return view(current)
    const before = view(current)
    if (!['action_required', 'pending', 'unknown'].includes(before.resolutionState)) return before
    let closed: Awaited<ReturnType<ActivityOnlinePayments['close']>>
    try {
      closed = await this.onlinePayments.close({
        scope: context.scope,
        paymentId: current.payment_id,
        closeBindingId: closeBinding(input.idempotencyKey),
        principal: { type: 'guest', tableSessionId: null, customerId: context.customerId },
      })
    } catch (error) {
      if (error instanceof OnlinePaymentUnknownError || error instanceof OnlinePaymentUnavailableError) {
        throw new CustomerExperienceRequestError(
          '支付结果暂时无法确认，请先查询付款状态后再取消报名',
          'ACTIVITY_PAYMENT_RESULT_UNKNOWN',
          409,
        )
      }
      if (error instanceof PostarPaymentRejectedError) {
        // A rejected close can mean the remote rail completed between the
        // query and close calls. Query once more and apply only that bound
        // result; never surface a provider exception as a 500 or assume it
        // means the customer did not pay.
        try {
          const queried = await this.onlinePayments.query({
            scope: context.scope,
            paymentId: current.payment_id,
            queryBindingId: closeBinding(input.idempotencyKey),
            principal: { type: 'guest', tableSessionId: null, customerId: context.customerId },
          })
          return this.applyObservedPayment(
            context,
            input.registrationPublicId,
            queried,
            closeBinding(input.idempotencyKey),
          )
        } catch (retryError) {
          if (!(retryError instanceof OnlinePaymentUnknownError)
            && !(retryError instanceof OnlinePaymentUnavailableError)
            && !(retryError instanceof PostarPaymentRejectedError)) throw retryError
          throw new CustomerExperienceRequestError(
            '支付结果暂时无法确认，请先查询付款状态后再取消报名',
            'ACTIVITY_PAYMENT_RESULT_UNKNOWN',
            409,
          )
        }
      }
      throw error
    }
    return this.applyObservedPayment(context, input.registrationPublicId, closed, closeBinding(input.idempotencyKey))
  }

  private async applyObservedPayment(
    context: PublicCustomerExperienceContext,
    registrationPublicId: string,
    queried: Awaited<ReturnType<ActivityOnlinePayments['query']>>,
    idempotencyKey: string,
  ): Promise<PublicActivityPaymentState> {
    const observed = queried.observation
    const actor: AuditActor = { type: 'integration', ref: 'postar-active-query' }
    const providerSnapshot: JsonObject = {
      providerStatus: observed.status,
      providerReportedAmountMinor: observed.providerReportedAmount ?? observed.amount,
      occurredAt: observed.occurredAt,
      receivedAt: new Date().toISOString(),
      ...(observed.settlementChannel === undefined ? {} : { channel: observed.settlementChannel }),
    }
    await this.commands.recordProviderQueryResult({
      scope: context.scope,
      actor,
      businessDate: context.businessDate,
      idempotencyKey,
      requestFingerprint: fingerprint({
        registrationPublicId,
        paymentPublicId: queried.context.publicId,
        status: observed.status,
        providerTransactionId: observed.providerTransactionId,
        amount: observed.amount,
        currency: observed.currency,
      }),
      verifiedObservationId: queried.verifiedObservationId,
      paymentPublicId: queried.context.publicId,
      provider: 'postar',
      providerTransactionId: observed.providerTransactionId,
      reportedAmountMinor: observed.amount,
      reportedCurrency: observed.currency,
      settlementChannel: observed.settlementChannel,
      status: observed.status,
      providerSnapshot,
      occurredAt: observed.occurredAt,
    })
    return this.get(context, registrationPublicId)
  }

  async requestRefund(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ registrationPublicId: string; paymentPublicId?: string | null; reason: string; idempotencyKey: string }>,
  ) {
    const payment = await this.transactions.run(context.scope, async (transaction) => (
      staffActivityPayment(transaction, input.registrationPublicId, input.paymentPublicId ?? null)
    ), { readOnly: true })
    if (payment.payment_id === null || payment.authoritative_payment_status !== 'succeeded') {
      throw new CustomerExperienceRequestError('只有已成功支付的活动报名可以发起退款', 'ACTIVITY_REFUND_NOT_ALLOWED', 409)
    }
    return this.commands.requestActivityRefund({
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      paymentId: payment.payment_id,
      publicId: deterministicProviderRefundPublicId(context.scope.storeId, input.idempotencyKey),
      reason: input.reason,
      requestEvidence: {
        registrationPublicId: input.registrationPublicId,
        ...(input.paymentPublicId === undefined || input.paymentPublicId === null
          ? {}
          : { lateSuccessPaymentPublicId: input.paymentPublicId }),
      },
    })
  }
}

async function ownedActivityPayment(
  transaction: ScopedTransaction,
  customerId: string,
  registrationPublicId: string,
): Promise<ActivityPaymentRow> {
  const result = await transaction.query<ActivityPaymentRow>(`
    WITH RECURSIVE ancestry AS (
      SELECT id, merged_into_customer_id FROM mbox.customers
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      UNION ALL
      SELECT parent.id, parent.merged_into_customer_id
      FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
      WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
    ), canonical AS (
      SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
    ), family AS (
      SELECT id FROM canonical
      UNION ALL
      SELECT child.id FROM mbox.customers child JOIN family parent ON child.merged_into_customer_id=parent.id
      WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
    )
    SELECT registration.id AS registration_id,
      registration.public_id AS registration_public_id,
      registration.status AS registration_status,
      registration.registration_cycle,
      registration.payment_status,
      registration.amount_due_minor, registration.paid_amount_minor,
      registration.currency, registration.seat_hold_expires_at::text,
      activity.starts_at::text AS activity_starts_at,
      payment.id AS payment_id, payment.public_id AS payment_public_id,
      payment.method AS payment_method,
      payment.status AS authoritative_payment_status,
      provider_action.state AS provider_action_state,
      latest_refund.status AS refund_status
    FROM mbox.community_activity_registrations registration
    JOIN mbox.community_activities activity
      ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
     AND activity.id=registration.activity_id
    LEFT JOIN mbox.payments payment
      ON payment.tenant_id=registration.tenant_id AND payment.store_id=registration.store_id
     AND payment.id=registration.payment_id AND payment.payable_kind='activity_registration'
    LEFT JOIN mbox.payment_provider_actions provider_action
      ON provider_action.tenant_id=payment.tenant_id AND provider_action.store_id=payment.store_id
     AND provider_action.payment_id=payment.id
    LEFT JOIN LATERAL (
      SELECT refund.status
      FROM mbox.refunds refund
      WHERE refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id
        AND refund.payment_id=payment.id
      ORDER BY refund.created_at DESC, refund.id DESC LIMIT 1
    ) latest_refund ON true
    WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
      AND registration.public_id=$4 AND registration.customer_id IN (SELECT id FROM family)
  `, [transaction.scope.tenantId, transaction.scope.storeId, customerId, registrationPublicId])
  const row = result.rows[0]
  if (row === undefined) throw new CustomerExperienceRequestError('没有找到本人的活动报名', 'ACTIVITY_REGISTRATION_NOT_FOUND', 404)
  return row
}

async function staffActivityPayment(
  transaction: ScopedTransaction,
  registrationPublicId: string,
  lateSuccessPaymentPublicId: string | null,
) {
  const result = await transaction.query<ActivityPaymentRow>(`
    SELECT registration.id AS registration_id, registration.public_id AS registration_public_id,
      registration.status AS registration_status, registration.payment_status,
      registration.amount_due_minor, registration.paid_amount_minor, registration.currency,
      registration.seat_hold_expires_at::text, activity.starts_at::text AS activity_starts_at,
      payment.id AS payment_id, payment.public_id AS payment_public_id,
      payment.status AS authoritative_payment_status,
      provider_action.state AS provider_action_state, latest_refund.status AS refund_status
    FROM mbox.community_activity_registrations registration
    JOIN mbox.community_activities activity ON activity.tenant_id=registration.tenant_id
      AND activity.store_id=registration.store_id AND activity.id=registration.activity_id
    LEFT JOIN mbox.payments payment ON payment.tenant_id=registration.tenant_id
      AND payment.store_id=registration.store_id
      AND (
        ($4::text IS NULL AND payment.id=registration.payment_id)
        OR (
          $4::text IS NOT NULL AND payment.public_id=$4::text
          AND payment.activity_registration_id=registration.id
          AND (
            payment.activity_registration_cycle IS NULL
            OR payment.activity_registration_cycle<registration.registration_cycle
          )
          AND payment.status IN ('succeeded','partially_refunded')
        )
      )
    LEFT JOIN mbox.payment_provider_actions provider_action ON provider_action.tenant_id=payment.tenant_id
      AND provider_action.store_id=payment.store_id AND provider_action.payment_id=payment.id
    LEFT JOIN LATERAL (
      SELECT refund.status FROM mbox.refunds refund
      WHERE refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id AND refund.payment_id=payment.id
      ORDER BY refund.created_at DESC, refund.id DESC LIMIT 1
    ) latest_refund ON true
    WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
      AND registration.public_id=$3
  `, [transaction.scope.tenantId, transaction.scope.storeId, registrationPublicId, lateSuccessPaymentPublicId])
  const row = result.rows[0]
  if (row === undefined) throw new CustomerExperienceRequestError('活动报名不存在', 'ACTIVITY_REGISTRATION_NOT_FOUND', 404)
  return row
}

function view(row: Readonly<ActivityPaymentRow>): PublicActivityPaymentState {
  const resolutionState = resolution(row)
  const cancellable = Date.parse(row.activity_starts_at) > Date.now()
    && ['not_required', 'action_required', 'pending', 'failed'].includes(resolutionState)
  const allowedActions: ActivityPaymentAllowedAction[] = resolutionState === 'action_required'
    ? ['start_payment', ...(cancellable ? ['cancel_registration' as const] : [])]
    // Reopening the same ready JSAPI action is safe and does not create a new
    // provider order.  Unknown still stays query-only: a late success must
    // never be raced by another collection method.
    : resolutionState === 'pending'
      ? ['start_payment', 'query_payment', ...(cancellable ? ['cancel_registration' as const] : [])]
      : resolutionState === 'unknown'
        ? ['query_payment']
      : cancellable ? ['cancel_registration'] : []
  return {
    registrationPublicId: row.registration_public_id,
    paymentPublicId: row.payment_public_id,
    resolutionState,
    paymentStatus: row.payment_status,
    amountDueMinor: minor(row.amount_due_minor),
    paidAmountMinor: minor(row.paid_amount_minor),
    currency: row.currency,
    expiresAt: row.seat_hold_expires_at,
    allowedActions,
    refundStatus: row.refund_status,
  }
}

function resolution(row: Readonly<ActivityPaymentRow>): ActivityPaymentResolutionState {
  if (row.refund_status === 'requested') return 'refund_requested'
  if (row.refund_status === 'approved' || row.refund_status === 'processing') return 'refunding'
  if (row.refund_status === 'succeeded' || row.registration_status === 'refunded'
    || row.authoritative_payment_status === 'refunded') return 'refunded'
  if (row.payment_status === 'not_required') return 'not_required'
  if (row.payment_status === 'paid' || row.authoritative_payment_status === 'succeeded'
    || row.authoritative_payment_status === 'partially_refunded') return 'confirmed'
  if (row.payment_status === 'expired' || row.authoritative_payment_status === 'closed') return 'expired'
  if (row.authoritative_payment_status === 'failed' || row.provider_action_state === 'failed') return 'failed'
  if (row.provider_action_state === 'unknown') return 'unknown'
  if (row.provider_action_state === 'creating' || row.provider_action_state === 'ready') return 'pending'
  if (row.authoritative_payment_status === 'created' || row.authoritative_payment_status === 'pending') return 'action_required'
  return 'unknown'
}

function publicProviderAction(action: Readonly<OnlinePaymentAction>): PublicActivityProviderAction {
  if (action.presentation !== 'jsapi') throw invalidActivityPayment('活动顾客入口仅支持微信小程序支付')
  if (action.status !== 'pending') return {
    paymentPublicId: action.paymentPublicId,
    status: action.status,
    presentation: action.presentation,
    expiresAt: action.expiresAt,
    payload: null,
  }
  const source = action.payload ?? {}
  const payload = strictStrings(source, ['timeStamp', 'nonceStr', 'package', 'signType', 'paySign'])
  return {
    paymentPublicId: action.paymentPublicId,
    status: action.status,
    presentation: action.presentation,
    expiresAt: action.expiresAt,
    payload,
  }
}

function strictStrings(source: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of keys) {
    const value = source[key]
    if (typeof value !== 'string' || value.trim().length === 0) throw invalidActivityPayment('支付参数不完整')
    result[key] = value
  }
  return result
}

function closeBinding(idempotencyKey: string) {
  return `activity-close-${createHash('sha256').update(idempotencyKey).digest('hex')}`
}

function invalidActivityPayment(message: string) {
  return new CustomerExperienceRequestError(message, 'ACTIVITY_PAYMENT_INVALID_STATE', 409)
}

function minor(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidActivityPayment('活动支付金额无效')
  return parsed
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function deterministicProviderRefundPublicId(storeId: string, key: string): string {
  return `AR${createHash('sha256').update(`${storeId}:${key}`).digest('hex').slice(0, 32)}`
}
