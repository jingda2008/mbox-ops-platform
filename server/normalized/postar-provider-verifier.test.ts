import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
} from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { JsonObject } from './command-executor.js'
import { PaymentProviderVerificationError } from './payment-api.js'
import {
  canonicalPostarSignString,
  PostarRsaPaymentProviderVerifier,
} from './postar-provider-verifier.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const agencyId = 'FWH000030224'
const merchantId = '60000001067349'
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

function verifier() {
  return new PostarRsaPaymentProviderVerifier({
    bindings: [{ agencyId, merchantId, scope: { tenantId, storeId }, publicKey }],
  })
}

describe('PostarRsaPaymentProviderVerifier', () => {
  const feeFields = {
    AGET_ID: agencyId, CUST_ID: merchantId, THREE_ORDER_NO: 'payment-public-0001',
    ORDER_NO: 'POSTAR-TX-0001', TXAMT: '10800', NETR_AMT: '10735', CUST_FEE: '65',
    NOTIFY_TYPE: '01', ORDER_TIME: '20260916002702',
  }

  it('recognizes the official fee notification without ORDER_STATUS and never treats it as payment authority', async () => {
    const fields = signedNotification({ ...feeFields, OPEN_ID: 'private-customer', FUTURE_FIELD: 'supported' })
    const result = await verifier().verifyNotification(request(fields))
    expect(result).toMatchObject({ kind: 'fee', value: { amountMinor: 10800, netAmountMinor: 10735, feeMinor: 65 } })
    expect(JSON.stringify(result)).not.toContain('private-customer')
    expect(JSON.stringify(result)).not.toContain(String(fields.sign))
    expect(await verifier().verifyNotification(request(fields))).toEqual(result)
    await expect(verifier().verifyPaymentCallback(request(fields))).rejects.toMatchObject({ reason: 'unsupported_notification' })
    await expect(verifier().verifyRefundCallback(request(fields))).rejects.toMatchObject({ reason: 'unsupported_notification' })
  })

  it('preserves signed refund fees and zero fees without inventing a financial terminal state', async () => {
    expect(await verifier().verifyNotification(request(signedNotification({ ...feeFields,
      TXAMT: '-10800', NETR_AMT: '-10800', CUST_FEE: '0' }))))
      .toMatchObject({ kind: 'fee', value: { amountMinor: -10800, netAmountMinor: -10800, feeMinor: 0 } })
  })

  it.each(['NETR_AMT', 'CUST_FEE', 'TXAMT'])('rejects malformed %s even with a valid signature', async (field) => {
    await expect(verifier().verifyNotification(request(signedNotification({ ...feeFields, [field]: '1.5' }))))
      .rejects.toMatchObject({ reason: 'invalid_payload' })
  })

  it('rejects tampered fees before type dispatch and distinguishes unbound merchants', async () => {
    const fields = signedNotification(feeFields)
    await expect(verifier().verifyNotification(request({ ...fields, CUST_FEE: '1' })))
      .rejects.toMatchObject({ reason: 'signature_invalid' })
    await expect(verifier().verifyNotification(request(signedNotification({ ...feeFields, CUST_ID: 'unknown' }))))
      .rejects.toMatchObject({ reason: 'merchant_unbound' })
  })

  it.each(['3', '4', '5'])('dispatches signed refund status %s on the shared notification contract', async (status) => {
    const result = await verifier().verifyNotification(request(signedNotification({
      ...feeFields, NOTIFY_TYPE: 'other', ORDER_STATUS: status, TXAMT: '-10800', OLD_ORDER_NO: 'ORIGINAL-TX',
    })))
    expect(result.kind).toBe(status === '5' ? 'refund_processing' : 'refund')
    expect(result.value).toMatchObject({ amountMinor: 10800, succeeded: status === '4' })
  })

  it('does not acknowledge unknown or missing transaction states as fees', async () => {
    await expect(verifier().verifyNotification(request(signedNotification({ ...feeFields, NOTIFY_TYPE: '99' }))))
      .rejects.toMatchObject({ reason: 'invalid_payload' })
    await expect(verifier().verifyNotification(request(signedNotification({ ...feeFields, NOTIFY_TYPE: '99', ORDER_STATUS: 'unknown' }))))
      .rejects.toMatchObject({ reason: 'unsupported_notification' })
  })

  it('verifies a real RSA payment callback and returns only the configured merchant binding', async () => {
    const fields = signedNotification({
      AGET_ID: agencyId,
      CUST_ID: merchantId,
      THREE_ORDER_NO: 'payment-public-0001',
      ORDER_NO: 'POSTAR-TX-0001',
      TXAMT: '8800',
      ORDER_STATUS: '1',
      ORDER_TIME: '20260811200506',
      PAY_CHANNEL: '2',
      OPTIONAL_EMPTY: '',
      OPTIONAL_NULL: null,
    })
    const rawBody = Buffer.from(JSON.stringify(fields), 'utf8')
    const verified = await verifier().verifyPaymentCallback({
      provider: 'postar',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      rawBody,
      body: { AGET_ID: 'untrusted-body-is-not-used' },
    })

    expect(verified).toMatchObject({
      merchant: {
        provider: 'postar',
        agencyId,
        merchantId,
        scope: { tenantId, storeId },
      },
      paymentPublicId: 'payment-public-0001',
      providerTransactionId: 'POSTAR-TX-0001',
      amountMinor: 8800,
      currency: 'CNY',
      settlementChannel: 'wechat',
      occurredAt: '2026-08-11T12:05:06.000Z',
    })
    expect(verified.businessIdentity).toMatch(/^postar:[0-9a-f]{64}$/)
    expect(verified.evidence).toMatchObject({ channel: 'wechat' })
    expect(verified.evidence).not.toHaveProperty('sign')
    expect(JSON.stringify(verified)).not.toContain(publicKey.slice(0, 20))
  })

  it('verifies refund identity, original transaction, exact amount and terminal result', async () => {
    const fields = signedNotification({
      AGET_ID: agencyId,
      CUST_ID: merchantId,
      THREE_ORDER_NO: 'refund-public-0001',
      ORDER_NO: 'POSTAR-REFUND-0001',
      OLD_ORDER_NO: 'POSTAR-TX-0001',
      TXAMT: '-1000',
      ORDER_STATUS: '4',
      ORDER_TIME: '20260811203000',
    })
    const verified = await verifier().verifyRefundCallback(request(fields))

    expect(verified).toMatchObject({
      refundPublicId: 'refund-public-0001',
      provider: 'postar',
      succeeded: true,
      providerRefundId: 'POSTAR-REFUND-0001',
      originalProviderTransactionId: 'POSTAR-TX-0001',
      amountMinor: 1000,
      currency: 'CNY',
    })
  })

  it('rejects a byte-level financial mutation after signing', async () => {
    const fields = signedNotification({
      AGET_ID: agencyId,
      CUST_ID: merchantId,
      THREE_ORDER_NO: 'payment-public-0001',
      ORDER_NO: 'POSTAR-TX-0001',
      TXAMT: '8800',
      ORDER_STATUS: '1',
      ORDER_TIME: '20260811200506',
    })
    const tampered = { ...fields, TXAMT: '1' }
    await expect(verifier().verifyPaymentCallback(request(tampered)))
      .rejects.toBeInstanceOf(PaymentProviderVerificationError)
  })

  it('rejects an unknown merchant and every unsupported provider', async () => {
    const unknown = signedNotification({
      AGET_ID: agencyId,
      CUST_ID: 'OTHER-MERCHANT',
      THREE_ORDER_NO: 'payment-public-0001',
      ORDER_NO: 'POSTAR-TX-0001',
      TXAMT: '8800',
      ORDER_STATUS: '1',
      ORDER_TIME: '20260811200506',
    })
    await expect(verifier().verifyPaymentCallback(request(unknown)))
      .rejects.toThrow('未绑定门店')
    await expect(verifier().verifyPaymentCallback({ ...request(unknown), provider: 'wechat' }))
      .rejects.toThrow('不支持该支付机构')
  })

  it('rejects normalized-but-impossible completion timestamps', async () => {
    const impossible = signedNotification({
      AGET_ID: agencyId,
      CUST_ID: merchantId,
      THREE_ORDER_NO: 'payment-public-0001',
      ORDER_NO: 'POSTAR-TX-0001',
      TXAMT: '8800',
      ORDER_STATUS: '1',
      ORDER_TIME: '20260231010101',
    })
    await expect(verifier().verifyPaymentCallback(request(impossible)))
      .rejects.toThrow('ORDER_TIME无效')
  })
})

function request(fields: JsonObject) {
  return {
    provider: 'postar' as const,
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify(fields), 'utf8'),
    body: fields,
  }
}

function signedNotification(fields: JsonObject): JsonObject {
  const digest = createHash('sha256')
    .update(canonicalPostarSignString(fields), 'utf8')
    .digest('hex')
  const sign = privateEncrypt(
    { key: keys.privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(digest, 'utf8'),
  ).toString('base64')
  return { ...fields, sign }
}
