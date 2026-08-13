import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { PaymentMethod, PaymentProvider } from './payment-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type ProviderPresentation = 'jsapi' | 'qr' | 'barcode'
export type ProviderActionPayload = Readonly<Record<string, unknown>>

export interface ProviderPaymentContext {
  id: string
  orderId: string
  orderPublicId: string
  publicId: string
  provider: PaymentProvider
  method: PaymentMethod
  amountMinor: number
  currency: string
  status: string
  tableSessionId: string
  tableCode: string
  createdAt: string
}

export type PaymentPrincipal =
  | { type: 'employee'; employeeId: string }
  | { type: 'guest'; tableSessionId: string; customerId: string }

interface ContextRow extends Record<string, unknown> {
  id: string
  order_id: string
  order_public_id: string
  public_id: string
  provider: PaymentProvider
  method: PaymentMethod
  amount_minor: string | number
  currency: string
  status: string
  table_session_id: string
  table_code: string
  created_at: string
}

interface ActionRow extends Record<string, unknown> {
  presentation: ProviderPresentation
  initiated_by_type: PaymentPrincipal['type']
  initiated_by_ref: string
  state: 'creating' | 'ready' | 'unknown' | 'failed' | 'consumed'
  ciphertext: Buffer | null
  nonce: Buffer | null
  auth_tag: Buffer | null
  expires_at: string
  updated_at: string
}

export class ProviderPaymentInProgressError extends Error {
  constructor() {
    super('付款正在发起，请勿重复操作')
    this.name = 'ProviderPaymentInProgressError'
  }
}

export class ProviderPaymentMethodConflictError extends Error {
  constructor(message = '这笔订单已有其他付款方式正在处理，请先核对付款状态') {
    super(message)
    this.name = 'ProviderPaymentMethodConflictError'
  }
}

export class ProviderPaymentUnknownError extends Error {
  constructor() {
    super('支付结果暂时无法确认，请先查单，不要重复收款')
    this.name = 'ProviderPaymentUnknownError'
  }
}

export class WechatPaymentIdentityRequiredError extends Error {
  constructor() {
    super('当前微信身份尚未完成安全绑定，请改用客人扫码支付')
    this.name = 'WechatPaymentIdentityRequiredError'
  }
}

export class PaymentProviderActionRepository {
  private readonly key: Buffer

  constructor(
    private readonly transaction: ScopedTransaction,
    secret: string,
  ) {
    this.key = createHash('sha256').update(secret).update(':payment-provider-action:v1').digest()
  }

  async resolvePaymentContext(
    paymentId: string,
    principal: Readonly<PaymentPrincipal>,
    options: Readonly<{ lock?: boolean }> = {},
  ): Promise<ProviderPaymentContext> {
    const lockClause = options.lock === false ? '' : 'FOR SHARE OF payment, ordering'
    const result = await this.transaction.query<ContextRow>(`
      SELECT payment.id, payment.order_id, ordering.public_id AS order_public_id,
        payment.public_id, payment.provider, payment.method, payment.amount_minor,
        payment.currency, payment.status, payment.created_at::text,
        ordering.table_session_id, venue_table.code AS table_code
      FROM mbox.payments payment
      JOIN mbox.orders ordering
        ON ordering.tenant_id = payment.tenant_id
       AND ordering.store_id = payment.store_id
       AND ordering.id = payment.order_id
      JOIN mbox.table_sessions table_session
        ON table_session.tenant_id = ordering.tenant_id
       AND table_session.store_id = ordering.store_id
       AND table_session.id = ordering.table_session_id
      JOIN mbox.tables venue_table
        ON venue_table.tenant_id = table_session.tenant_id
       AND venue_table.store_id = table_session.store_id
       AND venue_table.id = table_session.table_id
      WHERE payment.tenant_id = $1::uuid
        AND payment.store_id = $2::uuid
        AND payment.id = $3::uuid
      ${lockClause}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const row = result.rows[0]
    if (row === undefined) throw new Error('支付记录不存在')
    await this.assertAccess(row.table_session_id, principal)
    return mapContext(row)
  }

  async resolveOrderForGuest(
    orderPublicId: string,
    principal: Extract<PaymentPrincipal, { type: 'guest' }>,
  ): Promise<{ orderId: string; activePaymentId: string | null }> {
    const linked = await this.transaction.query<{ order_id: string; payment_id: string | null }>(`
      SELECT ordering.id AS order_id,
        (
          SELECT payment.id
          FROM mbox.payments payment
          WHERE payment.tenant_id = ordering.tenant_id
            AND payment.store_id = ordering.store_id
            AND payment.order_id = ordering.id
            AND payment.status IN ('created', 'pending')
          ORDER BY payment.created_at DESC, payment.id DESC
          LIMIT 1
        ) AS payment_id
      FROM mbox.orders ordering
      WHERE ordering.tenant_id = $1::uuid
        AND ordering.store_id = $2::uuid
        AND ordering.public_id = $3
        AND ordering.table_session_id = $4::uuid
        AND ordering.status NOT IN ('draft', 'cancelled')
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      orderPublicId,
      principal.tableSessionId,
    ])
    const row = linked.rows[0]
    if (row === undefined) throw new Error('当前桌次没有找到这笔订单')
    await this.assertAccess(principal.tableSessionId, principal)
    return { orderId: row.order_id, activePaymentId: row.payment_id }
  }

  async resolveActivePaymentForOrder(
    orderId: string,
    principal: Readonly<PaymentPrincipal>,
  ): Promise<ProviderPaymentContext | null> {
    const result = await this.transaction.query<ContextRow>(`
      SELECT payment.id, payment.order_id, ordering.public_id AS order_public_id,
        payment.public_id, payment.provider, payment.method, payment.amount_minor,
        payment.currency, payment.status, payment.created_at::text,
        ordering.table_session_id, venue_table.code AS table_code
      FROM mbox.payments payment
      JOIN mbox.orders ordering
        ON ordering.tenant_id = payment.tenant_id
       AND ordering.store_id = payment.store_id
       AND ordering.id = payment.order_id
      JOIN mbox.table_sessions table_session
        ON table_session.tenant_id = ordering.tenant_id
       AND table_session.store_id = ordering.store_id
       AND table_session.id = ordering.table_session_id
      JOIN mbox.tables venue_table
        ON venue_table.tenant_id = table_session.tenant_id
       AND venue_table.store_id = table_session.store_id
       AND venue_table.id = table_session.table_id
      WHERE payment.tenant_id = $1::uuid
        AND payment.store_id = $2::uuid
        AND payment.order_id = $3::uuid
        AND payment.status IN ('created', 'pending')
      ORDER BY payment.created_at DESC, payment.id DESC
      LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    const row = result.rows[0]
    if (row === undefined) return null
    await this.assertAccess(row.table_session_id, principal)
    return mapContext(row)
  }

  async claim(
    paymentId: string,
    presentation: ProviderPresentation,
    expiresAt: string,
    principal: Readonly<PaymentPrincipal>,
  ): Promise<{ claimed: true } | { claimed: false; payload: ProviderActionPayload; expiresAt: string }> {
    const inserted = await this.transaction.query(`
      INSERT INTO mbox.payment_provider_actions (
        payment_id, tenant_id, store_id, presentation,
        initiated_by_type, initiated_by_ref, state, expires_at
      ) VALUES ($3::uuid, $1::uuid, $2::uuid, $4, $5, $6::uuid, 'creating', $7::timestamptz)
      ON CONFLICT (tenant_id, store_id, payment_id) DO NOTHING
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      paymentId,
      presentation,
      principal.type,
      principalReference(principal),
      expiresAt,
    ])
    if (inserted.rowCount === 1) return { claimed: true }
    const selected = await this.transaction.query<ActionRow>(`
      SELECT presentation, initiated_by_type, initiated_by_ref,
        state, ciphertext, nonce, auth_tag,
        expires_at::text, updated_at::text
      FROM mbox.payment_provider_actions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND payment_id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const action = selected.rows[0]
    if (action === undefined) throw new Error('支付动作抢占失败')
    if (action.presentation !== presentation) throw new ProviderPaymentMethodConflictError()
    if (presentation === 'jsapi' && (
      action.initiated_by_type !== principal.type
      || action.initiated_by_ref !== principalReference(principal)
    )) {
      throw new ProviderPaymentMethodConflictError()
    }
    if (action.state === 'ready') {
      if (Date.parse(action.expires_at) <= Date.now()) throw new ProviderPaymentUnknownError()
      return {
        claimed: false,
        payload: this.decrypt(paymentId, action),
        expiresAt: action.expires_at,
      }
    }
    if (action.state === 'unknown') throw new ProviderPaymentUnknownError()
    if (action.state === 'failed') throw new Error('这次支付发起已失败，请重新建立付款')
    if (action.state === 'consumed') throw new Error('这笔订单已经完成付款，请勿重复支付')
    throw new ProviderPaymentInProgressError()
  }

  async complete(
    paymentId: string,
    presentation: ProviderPresentation,
    payload: ProviderActionPayload,
    expiresAt: string,
    providerTransactionId: string | null,
  ): Promise<void> {
    const encrypted = this.encrypt(paymentId, presentation, payload)
    const updated = await this.transaction.query(`
      WITH action_updated AS (
        UPDATE mbox.payment_provider_actions
        SET state = 'ready', ciphertext = $5, nonce = $6, auth_tag = $7,
            expires_at = $8::timestamptz, last_error_code = NULL,
            updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND payment_id = $3::uuid AND presentation = $4 AND state = 'creating'
        RETURNING payment_id
      )
      UPDATE mbox.payments payment
      SET provider_transaction_id = COALESCE($9, payment.provider_transaction_id),
          provider_snapshot = payment.provider_snapshot || jsonb_build_object(
            'providerStatus', 'created',
            'providerPresentation', $4,
            'providerOrderCreatedAt', clock_timestamp()::text
          ),
          updated_at = clock_timestamp()
      FROM action_updated
      WHERE payment.tenant_id = $1::uuid AND payment.store_id = $2::uuid
        AND payment.id = action_updated.payment_id
      RETURNING payment.id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      paymentId,
      presentation,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.authTag,
      expiresAt,
      providerTransactionId,
    ])
    if (updated.rowCount !== 1) throw new Error('支付渠道结果没有安全写回')
  }

  async markUnknown(paymentId: string, errorCode: string): Promise<void> {
    await this.transaction.query(`
      UPDATE mbox.payment_provider_actions
      SET state = 'unknown', ciphertext = NULL, nonce = NULL, auth_tag = NULL,
          last_error_code = $4, updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND payment_id = $3::uuid AND state = 'creating'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId, errorCode.slice(0, 128)])
  }

  async markFailed(paymentId: string, errorCode: string): Promise<void> {
    await this.transaction.query(`
      WITH action_updated AS (
        UPDATE mbox.payment_provider_actions
        SET state = 'failed', ciphertext = NULL, nonce = NULL, auth_tag = NULL,
            last_error_code = $4, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND payment_id = $3::uuid AND state = 'creating'
        RETURNING payment_id
      )
      , payment_updated AS (
        UPDATE mbox.payments payment
        SET status = 'failed',
            provider_snapshot = payment.provider_snapshot || jsonb_build_object(
              'providerStatus', 'rejected', 'errorCode', $4
            ),
            updated_at = clock_timestamp()
        FROM action_updated
        WHERE payment.tenant_id = $1::uuid AND payment.store_id = $2::uuid
          AND payment.id = action_updated.payment_id
          AND payment.status IN ('created', 'pending')
        RETURNING payment.order_id
      )
      UPDATE mbox.orders ordering
      SET payment_status = 'unpaid', updated_at = clock_timestamp()
      FROM payment_updated
      WHERE ordering.tenant_id = $1::uuid AND ordering.store_id = $2::uuid
        AND ordering.id = payment_updated.order_id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId, errorCode.slice(0, 128)])
  }

  async resolveWechatPayerId(
    customerId: string,
    appId: string,
    channel: 'official_account' | 'mini_program',
  ): Promise<string> {
    const result = await this.transaction.query<{
      ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer
    }>(`
      SELECT ciphertext, nonce, auth_tag
      FROM mbox.wechat_payment_identities
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND customer_id = $3::uuid AND app_id = $4 AND channel = $5 AND status = 'active'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId, appId, channel])
    const row = result.rows[0]
    if (row === undefined) throw new WechatPaymentIdentityRequiredError()
    const aad = Buffer.from(`${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${customerId}:${appId}:${channel}`)
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.nonce)
      decipher.setAAD(aad)
      decipher.setAuthTag(row.auth_tag)
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8')
    } catch {
      throw new WechatPaymentIdentityRequiredError()
    }
  }

  private async assertAccess(tableSessionId: string, principal: Readonly<PaymentPrincipal>): Promise<void> {
    if (principal.type === 'employee') return
    if (principal.tableSessionId !== tableSessionId) throw new Error('订单不属于当前桌次')
    const result = await this.transaction.query<{ linked: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM mbox.table_session_customers
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND table_session_id = $3::uuid AND customer_id = $4::uuid
      ) AS linked
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      principal.tableSessionId,
      principal.customerId,
    ])
    if (result.rows[0]?.linked !== true) throw new Error('当前客人未关联到这桌')
  }

  private encrypt(paymentId: string, presentation: ProviderPresentation, payload: ProviderActionPayload) {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(this.actionAad(paymentId, presentation))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
    return { ciphertext, nonce, authTag: cipher.getAuthTag() }
  }

  private decrypt(paymentId: string, row: ActionRow): ProviderActionPayload {
    if (row.ciphertext === null || row.nonce === null || row.auth_tag === null) {
      throw new ProviderPaymentUnknownError()
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.nonce)
      decipher.setAAD(this.actionAad(paymentId, row.presentation))
      decipher.setAuthTag(row.auth_tag)
      const decoded = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8')
      const payload: unknown = JSON.parse(decoded)
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('invalid')
      return payload as ProviderActionPayload
    } catch {
      throw new ProviderPaymentUnknownError()
    }
  }

  private actionAad(paymentId: string, presentation: ProviderPresentation): Buffer {
    return Buffer.from(`${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${paymentId}:${presentation}`)
  }
}

function mapContext(row: ContextRow): ProviderPaymentContext {
  const amountMinor = Number(row.amount_minor)
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('支付金额无效')
  return {
    id: row.id,
    orderId: row.order_id,
    orderPublicId: row.order_public_id,
    publicId: row.public_id,
    provider: row.provider,
    method: row.method,
    amountMinor,
    currency: row.currency,
    status: row.status,
    tableSessionId: row.table_session_id,
    tableCode: row.table_code,
    createdAt: row.created_at,
  }
}

function principalReference(principal: Readonly<PaymentPrincipal>): string {
  return principal.type === 'employee' ? principal.employeeId : principal.customerId
}
