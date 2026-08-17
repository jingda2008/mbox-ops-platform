import type {
  PaymentProviderSecretSource,
  ProviderPaymentObservation,
  ProviderRefundObservation,
} from '../../src/shared/payment-provider-contracts.js'
import type { RefundItem, SettlementChannel } from '../../src/shared/payment-contracts.js'
import type { OnlinePaymentAction } from '../../src/shared/online-payment-contracts.js'
import type { PostarHttpClient, PostarTransactionMetadataSource, PostarSftpBillSource } from '../../src/shared/postar-contracts.js'
import { PostarPaymentProviderAdapter, PostarPaymentRejectedError } from '../postar-adapter.js'
import type { NormalizedPaymentRuntimeConfig } from './normalized-runtime-config.js'
import {
  PaymentProviderActionRepository,
  type PaymentPrincipal,
  type ProviderPaymentContext,
  type ProviderPresentation,
} from './payment-provider-action-repository.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'
import {
  VerifiedProviderObservationService,
  providerObservationEventId,
  type ProviderObservationRecorderPort,
} from './provider-verification-observation.js'

export type { OnlinePaymentAction } from '../../src/shared/online-payment-contracts.js'

export interface CreateOnlinePaymentInput {
  scope: Readonly<StoreScope>
  paymentId: string
  principal: Readonly<PaymentPrincipal>
  clientIp: string
  operatorId: string
  customerAuthCode?: string
  idempotencyKey?: string
}

export interface ActiveOnlinePaymentInput {
  scope: Readonly<StoreScope>
  orderId: string
  principal: Readonly<PaymentPrincipal>
}

export interface QueryOnlinePaymentInput {
  scope: Readonly<StoreScope>
  paymentId: string
  queryBindingId: string
  principal: Readonly<PaymentPrincipal>
}

export interface OnlinePaymentQueryResult {
  context: ProviderPaymentContext
  observation: ProviderPaymentObservation
  verifiedObservationId: string
}

export interface OnlineRefundResult {
  refundId: string
  refundPublicId: string
  merchantRefundId: string
  paymentPublicId: string
  originalProviderTransactionId: string
  amountMinor: number
  currency: string
  observation: ProviderRefundObservation
  verifiedObservationId: string | null
}

interface RefundExecutionRow extends Record<string, unknown> {
  refund_id: string
  refund_public_id: string
  refund_status: string
  merchant_refund_id: string | null
  provider_submission_started_at: string | null
  provider_submission_state: 'not_started' | 'submitting' | 'submitted' | 'manual_review'
  amount_minor: string | number
  currency: string
  created_at: string
  payment_public_id: string
  payment_provider: string
  payment_method: string
  payment_status: string
  provider_transaction_id: string | null
  settlement_channel: 'wechat' | 'alipay' | 'unionpay' | null
  provider_snapshot: Readonly<Record<string, unknown>>
  refund_items: unknown
}

type OnlinePaymentAdapter = Pick<
  PostarPaymentProviderAdapter,
  'createPayment' | 'queryPayment' | 'requestRefund' | 'queryRefund'
>

export class OnlinePaymentUnavailableError extends Error {
  constructor(message = '线上支付尚未配置，请改用其他收款方式') {
    super(message)
    this.name = 'OnlinePaymentUnavailableError'
  }
}

export class OnlinePaymentUnknownError extends Error {
  constructor() {
    super('支付结果暂时无法确认，请先查单，不要重复收款')
    this.name = 'OnlinePaymentUnknownError'
  }
}

export class OnlinePaymentService {
  private readonly adapter: OnlinePaymentAdapter | null
  private readonly secrets: PaymentProviderSecretSource | null
  private readonly providerObservations: ProviderObservationRecorderPort

  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly secret: string,
    private readonly config: Readonly<NormalizedPaymentRuntimeConfig> | null,
    adapterOverride?: OnlinePaymentAdapter,
    providerObservations?: ProviderObservationRecorderPort,
  ) {
    this.providerObservations = providerObservations
      ?? new VerifiedProviderObservationService(this.transactions)
    if (config === null) {
      this.adapter = null
      this.secrets = null
      return
    }
    this.secrets = environmentSecrets(config)
    this.adapter = adapterOverride ?? new PostarPaymentProviderAdapter({
      environment: config.environment,
      httpClient: fetchHttpClient(config.timeoutMs),
      metadataSource: runtimeMetadataSource(config),
      billSource: unsupportedBillSource(),
    })
  }

  assertAvailable(provider: 'postar' | 'simulation'): void {
    if (provider === 'simulation') return
    if (this.adapter === null || this.secrets === null || this.config === null) {
      throw new OnlinePaymentUnavailableError()
    }
  }

  async resolveActivePayment(input: Readonly<ActiveOnlinePaymentInput>): Promise<ProviderPaymentContext | null> {
    return this.transactions.run(input.scope, async (transaction) => (
      new PaymentProviderActionRepository(transaction, this.secret)
        .resolveActivePaymentForOrder(input.orderId, input.principal)
    ), { readOnly: true })
  }

  async resolveGuestMethod(
    scope: Readonly<StoreScope>,
    customerId: string,
  ): Promise<'jsapi' | 'native_qr'> {
    if (this.config?.wechat === null || this.config?.wechat === undefined) return 'native_qr'
    try {
      await this.transactions.run(scope, async (transaction) => {
        await new PaymentProviderActionRepository(transaction, this.secret).resolveWechatPayerId(
          customerId,
          this.config!.wechat!.appId,
          this.config!.wechat!.tradeType === '8' ? 'mini_program' : 'official_account',
        )
      }, { readOnly: true })
      return 'jsapi'
    } catch {
      return 'native_qr'
    }
  }

  async query(input: Readonly<QueryOnlinePaymentInput>): Promise<OnlinePaymentQueryResult> {
    if (this.adapter === null || this.secrets === null || this.config === null) {
      throw new OnlinePaymentUnavailableError()
    }
    const context = await this.transactions.run(input.scope, async (transaction) => (
      new PaymentProviderActionRepository(transaction, this.secret)
        .resolvePaymentContext(input.paymentId, input.principal, { lock: false })
    ), { readOnly: true })
    if (context.provider !== 'postar') {
      throw new OnlinePaymentUnavailableError('当前付款不支持星驿主动查单')
    }
    if (!['created', 'pending'].includes(context.status)) {
      throw new OnlinePaymentUnavailableError('这笔付款已有明确结果，无需重复查单')
    }
    const observation = await this.adapter.queryPayment({
      paymentIntentId: context.publicId,
      merchantId: this.config.merchantId,
      amount: context.amountMinor,
      currency: context.currency,
      providerTransactionId: context.providerTransactionId,
      orderDate: postarOrderDate(context.createdAt),
    }, { secrets: this.secrets })
    if (observation.amount !== context.amountMinor || observation.currency !== context.currency) {
      throw new OnlinePaymentUnknownError()
    }
    const evidence = paymentQueryEvidence(observation)
    const verifiedObservationId = await this.providerObservations.recordPayment({
        scope: input.scope,
        provider: 'postar',
        verificationKind: 'active_query_binding',
        providerEventId: providerObservationEventId([
          'payment-query', input.queryBindingId, context.publicId, observation.providerTransactionId,
          observation.status, observation.amount, observation.currency, observation.occurredAt,
        ]),
        integrationRef: 'postar-active-query',
        paymentPublicId: context.publicId,
        providerTransactionId: observation.providerTransactionId,
        reportedAmountMinor: observation.amount,
        reportedCurrency: observation.currency,
        status: observation.status,
        settlementChannel: observation.settlementChannel,
        occurredAt: observation.occurredAt,
        evidence,
      })
    return { context, observation, verifiedObservationId }
  }

  async requestRefund(
    scope: Readonly<StoreScope>,
    refundId: string,
    queryBindingId: string,
  ): Promise<OnlineRefundResult> {
    const context = await this.refundContext(scope, refundId)
    const adapter = this.requireRefundAdapter()
    const settlementChannel = refundSettlementChannel(context)
    const claimed = await this.claimRefundSubmission(scope, context.refund_id)
    if (!claimed) return this.queryRefund(scope, refundId, queryBindingId)
    const claimedContext = await this.refundContext(scope, refundId)
    const providerRefundId = requireMerchantRefundId(claimedContext)
    try {
      const observation = await adapter.requestRefund({
        refundId: providerRefundId,
        paymentIntentId: claimedContext.payment_public_id,
        providerTransactionId: requireProviderTransactionId(claimedContext),
        amount: safeMinor(claimedContext.amount_minor, '退款金额'),
        currency: claimedContext.currency,
        items: refundItems(claimedContext),
        idempotencyKey: providerRefundId,
        settlementChannel,
      }, { secrets: this.secrets! })
      await this.recordRefundObservation(scope, claimedContext.refund_id, observation)
      // The refund endpoint only acknowledges submission. StarPay requires a
      // signed callback or refund query before any terminal result is trusted.
      return onlineRefundResult(claimedContext, observation, null)
    } catch (error) {
      if (error instanceof PostarPaymentRejectedError) throw error
      throw new OnlinePaymentUnknownError()
    }
  }

  async queryRefund(
    scope: Readonly<StoreScope>,
    refundId: string,
    queryBindingId: string,
  ): Promise<OnlineRefundResult> {
    const context = await this.refundContext(scope, refundId)
    const adapter = this.requireRefundAdapter()
    const providerRefundId = requireMerchantRefundId(context)
    try {
      const observation = await adapter.queryRefund({
        refundId: providerRefundId,
        providerRefundId,
        merchantId: this.config!.merchantId,
        originalProviderTransactionId: requireProviderTransactionId(context),
        refundDate: refundSubmissionDate(context),
      }, { secrets: this.secrets! })
      if (observation.amount !== safeMinor(context.amount_minor, '退款金额')
        || observation.currency !== context.currency
        || observation.originalProviderTransactionId !== context.provider_transaction_id) {
        throw new OnlinePaymentUnknownError()
      }
      await this.recordRefundObservation(scope, context.refund_id, observation)
      const verifiedObservationId = await this.providerObservations.recordRefund({
          scope,
          provider: 'postar',
          verificationKind: 'active_query_binding',
          providerEventId: providerObservationEventId([
            'refund-query', queryBindingId, context.refund_id, observation.refundId,
            observation.providerRefundTransactionId, observation.status,
            observation.amount, observation.currency, observation.occurredAt,
          ]),
          integrationRef: 'postar-refund-active-query',
          refundPublicId: context.refund_public_id,
          providerTransactionId: observation.providerRefundTransactionId
            ?? requireMerchantRefundId(context),
          originalProviderTransactionId: observation.originalProviderTransactionId,
          reportedAmountMinor: observation.amount,
          reportedCurrency: observation.currency,
          status: observation.status,
          occurredAt: observation.occurredAt,
          evidence: refundQueryEvidence(observation),
        })
      return onlineRefundResult(context, observation, verifiedObservationId)
    } catch (error) {
      if (error instanceof OnlinePaymentUnknownError) throw error
      throw new OnlinePaymentUnknownError()
    }
  }

  async create(input: Readonly<CreateOnlinePaymentInput>): Promise<OnlinePaymentAction> {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    const prepared = await this.transactions.run(input.scope, async (transaction) => {
      const repository = new PaymentProviderActionRepository(transaction, this.secret)
      const context = await repository.resolvePaymentContext(input.paymentId, input.principal)
      if (context.status !== 'pending' && context.status !== 'created') {
        throw new Error('这笔订单已经不处于待付款状态')
      }
      if (context.provider === 'simulation') {
        const presentation = providerPresentation(context.method)
        const claim = await repository.claim(input.paymentId, presentation, expiresAt, input.principal, input.idempotencyKey)
        if (!claim.claimed) return { context, payerId: null, cached: claim, simulated: true as const }
        const payload = { presentation: 'simulation' }
        await repository.complete(context.id, presentation, payload, expiresAt, null)
        return { context, payerId: null, cached: null, simulated: true as const }
      }
      if (context.provider !== 'postar') throw new OnlinePaymentUnavailableError()
      if (this.adapter === null || this.secrets === null || this.config === null) {
        throw new OnlinePaymentUnavailableError()
      }
      const presentation = providerPresentation(context.method)
      if (presentation === 'barcode' && !input.customerAuthCode?.trim()) {
        throw new OnlinePaymentUnavailableError('这笔订单正在由员工扫描付款码，请勿从桌码重复发起')
      }
      const claim = await repository.claim(input.paymentId, presentation, expiresAt, input.principal, input.idempotencyKey)
      if (!claim.claimed) {
        return { context, payerId: null, cached: claim, simulated: false as const }
      }
      const payerId = presentation === 'jsapi'
        ? await this.resolvePayerId(repository, input)
        : null
      return { context, payerId, cached: null, simulated: false as const }
    })
    const presentation = providerPresentation(prepared.context.method)
    if (prepared.simulated) {
      return {
        paymentId: prepared.context.id,
        paymentPublicId: prepared.context.publicId,
        payableKind: prepared.context.payableKind,
        orderPublicId: prepared.context.orderPublicId,
        activityRegistrationPublicId: prepared.context.activityRegistrationPublicId,
        status: 'pending',
        presentation,
        expiresAt: prepared.cached?.expiresAt ?? expiresAt,
        payload: prepared.cached?.payload ?? { presentation: 'simulation' },
      }
    }
    if (this.adapter === null || this.secrets === null || this.config === null) throw new OnlinePaymentUnavailableError()
    if (prepared.cached !== null) {
      return {
        paymentId: prepared.context.id,
        paymentPublicId: prepared.context.publicId,
        payableKind: prepared.context.payableKind,
        orderPublicId: prepared.context.orderPublicId,
        activityRegistrationPublicId: prepared.context.activityRegistrationPublicId,
        status: 'pending',
        presentation,
        expiresAt: prepared.cached.expiresAt,
        payload: prepared.cached.payload,
      }
    }

    try {
      const result = await this.adapter.createPayment({
        paymentIntentId: prepared.context.publicId,
        merchantId: this.config.merchantId,
        amount: prepared.context.amountMinor,
        currency: prepared.context.currency,
        expiresAt,
        presentation,
        payWay: presentation === 'jsapi' ? 'wechat' : undefined,
        payerId: prepared.payerId ?? undefined,
        customerAuthCode: presentation === 'barcode' ? input.customerAuthCode : undefined,
        clientIp: trustedIp(input.clientIp),
        callbackUrl: this.config.callbackUrl,
        operatorId: safeOperator(input.operatorId),
        remark: providerRemark(prepared.context),
        wxAppid: presentation === 'jsapi' ? this.config.wechat?.appId : undefined,
        wechatTradeType: presentation === 'jsapi' ? this.config.wechat?.tradeType : undefined,
      }, { secrets: this.secrets })
      await this.transactions.run(input.scope, async (transaction) => {
        await new PaymentProviderActionRepository(transaction, this.secret).complete(
          prepared.context.id,
          presentation,
          result.paymentPayload,
          expiresAt,
          result.providerTransactionId,
        )
      })
      return {
        paymentId: prepared.context.id,
        paymentPublicId: prepared.context.publicId,
        payableKind: prepared.context.payableKind,
        orderPublicId: prepared.context.orderPublicId,
        activityRegistrationPublicId: prepared.context.activityRegistrationPublicId,
        status: 'pending',
        presentation,
        expiresAt,
        payload: result.paymentPayload,
      }
    } catch (error) {
      const code = safeErrorCode(error)
      try {
        await this.transactions.run(input.scope, async (transaction) => {
          const repository = new PaymentProviderActionRepository(transaction, this.secret)
          if (error instanceof PostarPaymentRejectedError) await repository.markFailed(prepared.context.id, code)
          else await repository.markUnknown(prepared.context.id, code)
        })
      } catch {
        throw new OnlinePaymentUnknownError()
      }
      if (error instanceof PostarPaymentRejectedError) throw error
      throw new OnlinePaymentUnknownError()
    }
  }

  private async resolvePayerId(
    repository: PaymentProviderActionRepository,
    input: Readonly<CreateOnlinePaymentInput>,
  ): Promise<string> {
    if (input.principal.type !== 'guest' || this.config?.wechat === null || this.config?.wechat === undefined) {
      throw new OnlinePaymentUnavailableError('当前入口不能发起微信内支付，请改用客人扫码支付')
    }
    return repository.resolveWechatPayerId(
      input.principal.customerId,
      this.config.wechat.appId,
      this.config.wechat.tradeType === '8' ? 'mini_program' : 'official_account',
    )
  }

  private requireRefundAdapter(): OnlinePaymentAdapter {
    if (this.adapter === null || this.secrets === null || this.config === null) {
      throw new OnlinePaymentUnavailableError('线上退款尚未配置')
    }
    return this.adapter
  }

  private refundContext(scope: Readonly<StoreScope>, refundId: string): Promise<RefundExecutionRow> {
    return this.transactions.run(scope, async (transaction) => {
      const result = await transaction.query<RefundExecutionRow>(`
        SELECT refund.id AS refund_id, refund.public_id AS refund_public_id,
          refund.status AS refund_status, refund.merchant_refund_id,
          refund.provider_submission_started_at::text, refund.provider_submission_state,
          refund.amount_minor, refund.currency, refund.created_at::text,
          payment.public_id AS payment_public_id,
          payment.provider AS payment_provider, payment.method AS payment_method,
          payment.status AS payment_status, payment.provider_transaction_id,
          payment.settlement_channel, payment.provider_snapshot,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'orderId', payment.order_id,
              'orderItemId', item.order_item_id,
              'amount', item.amount_minor
            ) ORDER BY item.order_item_id)
            FROM mbox.refund_items item
            WHERE item.tenant_id=refund.tenant_id AND item.store_id=refund.store_id
              AND item.refund_id=refund.id
          ), '[]'::jsonb) AS refund_items
        FROM mbox.refunds refund
        JOIN mbox.payments payment ON payment.tenant_id=refund.tenant_id
          AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
        WHERE refund.tenant_id=$1::uuid AND refund.store_id=$2::uuid AND refund.id=$3::uuid
      `, [scope.tenantId, scope.storeId, refundId])
      const row = result.rows[0]
      if (row === undefined) throw new OnlinePaymentUnavailableError('退款记录不存在')
      if (row.refund_status !== 'processing') {
        throw new OnlinePaymentUnavailableError('退款必须先由店长发起、不同员工复核，再由收银执行')
      }
      if (row.provider_submission_state === 'manual_review') {
        throw new OnlinePaymentUnavailableError('这笔历史退款缺少可证明的支付机构提交状态，必须人工复核')
      }
      if (row.payment_provider !== 'postar' || !['succeeded', 'partially_refunded'].includes(row.payment_status)) {
        throw new OnlinePaymentUnavailableError('这笔退款不属于可执行的星驿线上付款')
      }
      requireProviderTransactionId(row)
      refundSettlementChannel(row)
      return row
    }, { readOnly: true })
  }

  private recordRefundObservation(
    scope: Readonly<StoreScope>,
    refundId: string,
    observation: Readonly<ProviderRefundObservation>,
  ): Promise<void> {
    return this.transactions.run(scope, async (transaction) => {
      const updated = await transaction.query(`
        UPDATE mbox.refunds
        SET provider_submission_state='submitted',
          provider_snapshot=provider_snapshot || jsonb_build_object(
          'merchantRefundId', $4,
          'providerStatus', $5,
          'occurredAt', $6
        ), updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='processing'
          AND provider_submission_state IN ('submitting', 'submitted')
          AND merchant_refund_id=$4
      `, [
        scope.tenantId, scope.storeId, refundId,
        observation.refundId, observation.status, observation.occurredAt,
      ])
      if (updated.rowCount !== 1) throw new OnlinePaymentUnknownError()
    })
  }

  private claimRefundSubmission(scope: Readonly<StoreScope>, refundId: string): Promise<boolean> {
    return this.transactions.run(scope, async (transaction) => {
      const claimed = await transaction.query(`
        UPDATE mbox.refunds
        SET merchant_refund_id=$4,
          provider_submission_started_at=clock_timestamp(),
          provider_submission_state='submitting',
          provider_snapshot=provider_snapshot || jsonb_build_object(
          'merchantRefundId', $4,
          'providerStatus', 'submission_started',
          'occurredAt', clock_timestamp()::text
        ), updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='processing' AND provider_submission_state='not_started'
      `, [scope.tenantId, scope.storeId, refundId, merchantRefundId(refundId)])
      return claimed.rowCount === 1
    })
  }
}

function providerPresentation(method: string): ProviderPresentation {
  if (method === 'jsapi') return 'jsapi'
  if (method === 'native_qr') return 'qr'
  if (method === 'auth_code') return 'barcode'
  throw new OnlinePaymentUnavailableError('当前付款方式不是线上支付')
}

function providerRemark(context: Readonly<ProviderPaymentContext>): string {
  if (context.payableKind === 'activity_registration') {
    return `MBOX ACTIVITY ${context.activityRegistrationPublicId ?? context.publicId}`.slice(0, 60)
  }
  return `MBOX ${context.tableCode ?? 'TABLE'} ${context.orderPublicId ?? context.publicId}`.slice(0, 60)
}

function environmentSecrets(config: Readonly<NormalizedPaymentRuntimeConfig>): PaymentProviderSecretSource {
  return {
    async getSecret(name) {
      if (name === 'postar.agencyId') return config.agencyId
      if (name === 'postar.publicKey') return config.publicKey
      throw new OnlinePaymentUnavailableError('支付安全配置不完整')
    },
  }
}

function fetchHttpClient(timeoutMs: number): PostarHttpClient {
  return {
    async post(request) {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: Buffer.from(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = new Uint8Array(await response.arrayBuffer())
      if (body.byteLength > 1_048_576) throw new Error('星驿HTTP响应超过1MB限制')
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => { headers[key] = value })
      return { status: response.status, headers, body }
    },
  }
}

function runtimeMetadataSource(config: Readonly<NormalizedPaymentRuntimeConfig>): PostarTransactionMetadataSource {
  const unavailable = async (): Promise<never> => { throw new Error('规范化支付查询尚未接入此适配器实例') }
  return {
    getPaymentMetadata: unavailable,
    getRefundMetadata: async (request) => ({
      merchantId: config.merchantId,
      tag: request.settlementChannel === 'wechat' ? '2'
        : request.settlementChannel === 'alipay' ? '1'
          : request.settlementChannel === 'unionpay' ? '9'
            : await unavailable(),
    }),
    getRefundQueryMetadata: unavailable,
  }
}

function merchantRefundId(refundId: string): string {
  const value = refundId.replaceAll('-', '')
  if (!/^[A-Fa-f0-9]{32}$/.test(value)) throw new OnlinePaymentUnavailableError('内部退款编号不能映射为支付机构退款单号')
  return value
}

function requireMerchantRefundId(context: Readonly<RefundExecutionRow>): string {
  if (!['submitting', 'submitted'].includes(context.provider_submission_state)) {
    throw new OnlinePaymentUnavailableError('退款尚未建立可查询的支付机构提交凭据')
  }
  const expected = merchantRefundId(context.refund_id)
  if (context.merchant_refund_id !== expected) {
    throw new OnlinePaymentUnavailableError('退款支付机构单号与内部退款记录不匹配')
  }
  return expected
}

function requireProviderTransactionId(context: Readonly<RefundExecutionRow>): string {
  const value = context.provider_transaction_id
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OnlinePaymentUnavailableError('原支付缺少已绑定的星驿支付订单号')
  }
  return value
}

function refundSettlementChannel(context: Readonly<RefundExecutionRow>): Extract<SettlementChannel, 'wechat' | 'alipay' | 'unionpay'> {
  const channel = context.settlement_channel
  if (channel === 'wechat' || channel === 'alipay' || channel === 'unionpay') return channel
  throw new OnlinePaymentUnavailableError('原支付的结算渠道未被验签回执或主动查单确认，不能自动退款')
}

function refundSubmissionDate(context: Readonly<RefundExecutionRow>): string {
  const submittedAt = context.provider_submission_started_at
  if (typeof submittedAt !== 'string' || !Number.isFinite(Date.parse(submittedAt))) {
    throw new OnlinePaymentUnavailableError('退款缺少首次提交时间，不能猜测支付机构查询日期')
  }
  return postarOrderDate(submittedAt)
}

function refundItems(context: Readonly<RefundExecutionRow>): RefundItem[] {
  if (!Array.isArray(context.refund_items)) return []
  return context.refund_items.flatMap((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const row = value as Record<string, unknown>
    if (typeof row.orderId !== 'string' || typeof row.orderItemId !== 'string') return []
    const amount = safeMinor(row.amount as string | number, '退款分配金额')
    return [{ orderId: row.orderId, orderItemId: row.orderItemId, quantity: 1, unitPaidAmount: amount, amount }]
  })
}

function safeMinor(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new OnlinePaymentUnavailableError(`${label}无效`)
  return parsed
}

function onlineRefundResult(
  context: Readonly<RefundExecutionRow>,
  observation: ProviderRefundObservation,
  verifiedObservationId: string | null,
): OnlineRefundResult {
  return {
    refundId: context.refund_id,
    refundPublicId: context.refund_public_id,
    merchantRefundId: requireMerchantRefundId(context),
    paymentPublicId: context.payment_public_id,
    originalProviderTransactionId: requireProviderTransactionId(context),
    amountMinor: safeMinor(context.amount_minor, '退款金额'),
    currency: context.currency,
    observation,
    verifiedObservationId,
  }
}

function paymentQueryEvidence(observation: Readonly<ProviderPaymentObservation>) {
  return {
    providerStatus: observation.status,
    providerOrderId: observation.providerTransactionId,
    providerReportedAmountMinor: observation.providerReportedAmount ?? observation.amount,
    occurredAt: observation.occurredAt,
    ...(observation.settlementChannel === undefined
      ? {}
      : { channel: observation.settlementChannel }),
  }
}

function refundQueryEvidence(observation: Readonly<ProviderRefundObservation>) {
  return {
    providerStatus: observation.status,
    providerOrderId: observation.providerRefundTransactionId ?? observation.providerRefundId,
    merchantRefundId: observation.refundId,
    providerReportedAmountMinor: observation.amount,
    occurredAt: observation.occurredAt,
  }
}

function postarOrderDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new OnlinePaymentUnknownError()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value
  const result = `${part('year') ?? ''}${part('month') ?? ''}${part('day') ?? ''}`
  if (!/^\d{8}$/.test(result)) throw new OnlinePaymentUnknownError()
  return result
}

function unsupportedBillSource(): PostarSftpBillSource {
  return { async downloadBill(): Promise<never> { throw new Error('星驿SFTP账单尚未配置') } }
}

function trustedIp(value: string): string {
  const normalized = value.trim().replace(/^::ffff:/, '')
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) || /^[0-9a-f:]+$/i.test(normalized)) return normalized
  throw new OnlinePaymentUnavailableError('无法确认支付终端网络地址')
}

function safeOperator(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)
  return normalized || 'MBOX'
}

function safeErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError'
  return name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 128) || 'UnknownError'
}
