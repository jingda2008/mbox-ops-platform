import { describe, expect, it } from 'vitest'
import {
  PaymentProviderActionRepository,
  ProviderPaymentMethodConflictError,
} from './payment-provider-action-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const paymentId = '33333333-3333-4333-8333-333333333333'
const employeeId = '44444444-4444-4444-8444-444444444444'
const customerOneId = '55555555-5555-4555-8555-555555555555'
const customerTwoId = '66666666-6666-4666-8666-666666666666'
const tableSessionId = '77777777-7777-4777-8777-777777777777'
const secret = 'provider-action-unit-test-secret-at-least-32-bytes'
const expiresAt = '2099-08-13T13:05:00.000Z'

describe('PaymentProviderActionRepository', () => {
  it('resolves an existing payment in a read-only transaction without a locking clause', async () => {
    let capturedSql = ''
    const transaction = {
      scope: { tenantId, storeId },
      query: async (text: string) => {
        capturedSql = text
        return { rows: [{
          id: paymentId,
          order_id: '88888888-8888-4888-8888-888888888888',
          order_public_id: 'order-shared-payment-0001',
          public_id: 'payment-shared-0001',
          provider: 'postar',
          provider_transaction_id: null,
          method: 'native_qr',
          amount_minor: '8800',
          currency: 'CNY',
          status: 'pending',
          table_session_id: tableSessionId,
          table_code: 'W01',
          created_at: '2026-08-14T00:00:00.000Z',
        }], rowCount: 1 }
      },
    } as unknown as ScopedTransaction
    const repository = new PaymentProviderActionRepository(transaction, secret)

    await expect(repository.resolvePaymentContext(
      paymentId,
      { type: 'employee', employeeId },
      { lock: false },
    )).resolves.toMatchObject({ id: paymentId, method: 'native_qr', tableCode: 'W01' })
    expect(capturedSql).not.toContain('FOR SHARE')
  })

  it('encrypts and reuses one QR action across staff and guests at the same table', async () => {
    const transaction = new ActionTransaction()
    const repository = new PaymentProviderActionRepository(transaction, secret)
    const first = await repository.claim(paymentId, 'qr', expiresAt, { type: 'employee', employeeId })
    expect(first).toEqual({ claimed: true })

    const payload = { qrCodeUrl: 'https://pay.example.test/short-lived-order' }
    await repository.complete(paymentId, 'qr', payload, expiresAt, null)
    const reused = await repository.claim(paymentId, 'qr', expiresAt, {
      type: 'guest', tableSessionId, customerId: customerOneId,
    })

    expect(reused).toEqual({ claimed: false, payload, expiresAt })
    expect(transaction.persisted?.ciphertext.toString('utf8')).not.toContain('pay.example.test')
  })

  it('does not expose one guest JSAPI parameters to another guest', async () => {
    const transaction = new ActionTransaction()
    const repository = new PaymentProviderActionRepository(transaction, secret)
    await repository.claim(paymentId, 'jsapi', expiresAt, {
      type: 'guest', tableSessionId, customerId: customerOneId,
    })
    await repository.complete(paymentId, 'jsapi', { package: 'prepay_id=secret' }, expiresAt, null)

    await expect(repository.claim(paymentId, 'jsapi', expiresAt, {
      type: 'guest', tableSessionId, customerId: customerTwoId,
    })).rejects.toBeInstanceOf(ProviderPaymentMethodConflictError)
  })

  it('locks a payment to the first selected presentation', async () => {
    const transaction = new ActionTransaction()
    const repository = new PaymentProviderActionRepository(transaction, secret)
    await repository.claim(paymentId, 'qr', expiresAt, { type: 'employee', employeeId })
    await expect(repository.claim(paymentId, 'barcode', expiresAt, { type: 'employee', employeeId }))
      .rejects.toBeInstanceOf(ProviderPaymentMethodConflictError)
  })
})

class ActionTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  persisted: null | {
    presentation: 'jsapi' | 'qr' | 'barcode'
    initiated_by_type: 'employee' | 'guest'
    initiated_by_ref: string
    state: 'creating' | 'ready'
    ciphertext: Buffer
    nonce: Buffer
    auth_tag: Buffer
    expires_at: string
    updated_at: string
  } = null

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, ' ').trim()
    if (sql.startsWith('INSERT INTO mbox.payment_provider_actions')) {
      if (this.persisted !== null) return { rows: [], rowCount: 0 }
      this.persisted = {
        presentation: values[3] as 'jsapi' | 'qr' | 'barcode',
        initiated_by_type: values[4] as 'employee' | 'guest',
        initiated_by_ref: String(values[5]),
        state: 'creating',
        ciphertext: Buffer.alloc(0), nonce: Buffer.alloc(0), auth_tag: Buffer.alloc(0),
        expires_at: String(values[6]), updated_at: new Date().toISOString(),
      }
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('SELECT presentation')) {
      if (this.persisted === null) return { rows: [], rowCount: 0 }
      return { rows: [this.persisted as unknown as Row], rowCount: 1 }
    }
    if (sql.startsWith('WITH action_updated AS')) {
      if (this.persisted === null || this.persisted.state !== 'creating') return { rows: [], rowCount: 0 }
      this.persisted = {
        ...this.persisted,
        state: 'ready',
        ciphertext: values[4] as Buffer,
        nonce: values[5] as Buffer,
        auth_tag: values[6] as Buffer,
        expires_at: String(values[7]),
        updated_at: new Date().toISOString(),
      }
      return { rows: [{ id: paymentId } as unknown as Row], rowCount: 1 }
    }
    throw new Error(`Unexpected query: ${sql}`)
  }
}
