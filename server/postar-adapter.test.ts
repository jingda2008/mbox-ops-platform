import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
  privateEncrypt,
} from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  PaymentProviderContext,
  ProviderRefundRequest,
} from '../src/shared/payment-provider-contracts.js'
import {
  POSTAR_BASE_URLS,
  POSTAR_ENDPOINTS,
  type PostarAdapterOptions,
  type PostarHttpRequest,
  type PostarHttpResponse,
  type PostarTopLevelPayload,
} from '../src/shared/postar-contracts.js'
import {
  canonicalizePostarPayload,
  hashPostarPayload,
  PostarPaymentProviderAdapter,
} from './postar-adapter.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const NOW = new Date('2026-07-14T04:05:06.000Z')

const secrets = {
  getSecret: vi.fn(async (name: string) => {
    if (name === 'postar.agencyId') return 'AGENCY001'
    if (name === 'postar.publicKey') return publicKeyPem
    throw new Error(`unexpected secret: ${name}`)
  }),
}
const context: PaymentProviderContext = { secrets }

function signAsPostar(payload: PostarTopLevelPayload) {
  const sign = privateEncrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(hashPostarPayload(payload), 'utf8'),
  ).toString('base64')
  return { ...payload, sign }
}

function response(payload: PostarTopLevelPayload): PostarHttpResponse {
  return {
    body: new TextEncoder().encode(JSON.stringify(signAsPostar(payload))),
    headers: { 'content-type': 'application/json' },
    status: 200,
  }
}

function callback(payload: PostarTopLevelPayload) {
  return {
    headers: { 'content-type': 'application/json' },
    rawBody: new TextEncoder().encode(JSON.stringify(signAsPostar(payload))),
    receivedAt: '2026-07-14T04:05:07.000Z',
  }
}

function testOptions(
  post: (request: PostarHttpRequest) => Promise<PostarHttpResponse>,
  bill = new TextEncoder().encode('{"SUM_COUNT":"0","RE_SUM_COUNT":"0"}\n'),
): PostarAdapterOptions {
  return {
    billSource: { downloadBill: vi.fn(async () => bill) },
    environment: 'test',
    httpClient: { post: vi.fn(post) },
    metadataSource: {
      getPaymentMetadata: vi.fn(async () => ({ orderDate: '20260714' })),
      getRefundMetadata: vi.fn(async () => ({ merchantId: 'MERCHANT001', tag: '2' as const })),
      getRefundQueryMetadata: vi.fn(async () => ({ refundDate: '20260714' })),
    },
    now: () => NOW,
  }
}

function decodeRequest(request: PostarHttpRequest) {
  const text = new TextDecoder().decode(request.body)
  const payload = JSON.parse(text) as Record<string, unknown>
  const sign = payload.sign
  expect(typeof sign).toBe('string')
  const decrypted = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(sign as string, 'base64'),
  ).toString('utf8')
  const unsigned = { ...payload }
  delete unsigned.sign
  expect(decrypted).toBe(hashPostarPayload(unsigned as PostarTopLevelPayload))
  return { payload, text }
}

const PAYMENT_CALLBACK = {
  AGET_ID: 'AGENCY001',
  CUST_ID: 'MERCHANT001',
  ORDER_NO: 'POSTAR202607140001',
  ORDER_STATUS: '1',
  ORDER_TIME: '20260714120506',
  THREE_ORDER_NO: 'PaymentABC123',
  TRAN_TYPE_SER: '01',
  TXAMT: '3000',
} as const

describe('Postar canonical signing', () => {
  it('sorts top-level ASCII keys, excludes null, keeps empty strings and compacts nested JSON', () => {
    const payload = { c: 3, ignored: null, b: { z: 1 }, a: '' } as const

    expect(canonicalizePostarPayload(payload)).toBe('a=&b={"z":1}&c=3')
    expect(hashPostarPayload(payload)).toBe(
      '0d3787e7b247bb98ac51ae2c9239e2a2b563b78e01414f11ba4b52c8a169d58b',
    )
  })
})

describe('Postar payment callback', () => {
  it('verifies a private-key-produced callback signature and maps only a normal success', async () => {
    const adapter = new PostarPaymentProviderAdapter(testOptions(async () => response({})))

    const observation = await adapter.verifyPaymentCallback(callback(PAYMENT_CALLBACK), context)

    expect(observation).toMatchObject({
      amount: 3000,
      merchantId: 'MERCHANT001',
      paymentIntentId: 'PaymentABC123',
      providerTransactionId: 'POSTAR202607140001',
      status: 'succeeded',
    })
    expect(observation.providerEventId).toMatch(/^postar:[a-f0-9]{64}$/)
  })

  it('rejects tampering, unknown states and pre-authorisation even with a valid signature', async () => {
    const adapter = new PostarPaymentProviderAdapter(testOptions(async () => response({})))
    const tampered = callback(PAYMENT_CALLBACK)
    const parsed = JSON.parse(new TextDecoder().decode(tampered.rawBody)) as Record<string, unknown>
    parsed.TXAMT = '3001'
    tampered.rawBody = new TextEncoder().encode(JSON.stringify(parsed))

    await expect(adapter.verifyPaymentCallback(tampered, context)).rejects.toThrow('签名验证失败')
    await expect(adapter.verifyPaymentCallback(callback({
      ...PAYMENT_CALLBACK,
      ORDER_STATUS: '14',
      TRAN_TYPE_SER: '07',
    }), context)).rejects.toThrow('不是普通支付成功类型')
    await expect(adapter.verifyPaymentCallback(callback({
      ...PAYMENT_CALLBACK,
      ORDER_STATUS: 'new-status',
    }), context)).rejects.toThrow('未知星驿订单状态')
  })
})

describe('Postar active payment query', () => {
  it('uses the whitelisted endpoint, injected HTTP/key/metadata sources and verifies response signing', async () => {
    const post = vi.fn(async (_request: PostarHttpRequest) => response({
      code: '000000',
      data: {
        agetId: 'AGENCY001',
        orderNo: 'POSTAR202607140001',
        orderStatus: '1',
        orderTime: '20260714120506',
        threeOrderNo: 'PaymentABC123',
        txamt: '3000',
      },
      msg: 'success',
    }))
    const options = testOptions(post)
    const adapter = new PostarPaymentProviderAdapter(options)

    const observation = await adapter.queryPayment({
      merchantId: 'MERCHANT001',
      paymentIntentId: 'PaymentABC123',
      providerTransactionId: null,
    }, context)

    expect(observation.status).toBe('succeeded')
    const sent = post.mock.calls[0]?.[0]
    expect(sent?.url).toBe(`${POSTAR_BASE_URLS.test}${POSTAR_ENDPOINTS.queryPayment}`)
    const decoded = decodeRequest(sent!)
    expect(decoded.text).not.toMatch(/\s/)
    expect(Object.keys(decoded.payload)).toEqual([...Object.keys(decoded.payload)].sort())
    expect(decoded.payload).toMatchObject({
      agetId: 'AGENCY001',
      custId: 'MERCHANT001',
      orderNo: 'PaymentABC123',
      orderTime: '20260714',
      timeStamp: '20260714120506',
      version: '1.0.0',
    })
    expect(options.metadataSource.getPaymentMetadata).toHaveBeenCalledOnce()
    expect(secrets.getSecret).toHaveBeenCalledWith('postar.publicKey')
  })

  it('fails closed when a synchronous response is unsigned or reports pre-authorisation', async () => {
    const unsigned = new PostarPaymentProviderAdapter(testOptions(async () => ({
      body: new TextEncoder().encode('{"code":"000000","msg":"success"}'),
      headers: {},
      status: 200,
    })))
    await expect(unsigned.queryPayment({
      merchantId: 'MERCHANT001',
      paymentIntentId: 'PaymentABC123',
      providerTransactionId: null,
    }, context)).rejects.toThrow('响应缺少签名')

    const preauthorised = new PostarPaymentProviderAdapter(testOptions(async () => response({
      code: '000000',
      data: {
        agetId: 'AGENCY001',
        orderNo: 'POSTAR202607140001',
        orderStatus: '14',
        orderTime: '20260714120506',
        threeOrderNo: 'PaymentABC123',
        txamt: '3000',
      },
      msg: 'success',
    })))
    await expect(preauthorised.queryPayment({
      merchantId: 'MERCHANT001',
      paymentIntentId: 'PaymentABC123',
      providerTransactionId: null,
    }, context)).rejects.toThrow('不是普通支付状态')
  })
})

describe('Postar ordinary partial refund', () => {
  const refundRequest: ProviderRefundRequest = {
    amount: 1200,
    currency: 'CNY',
    idempotencyKey: 'refund-idempotency-1',
    items: [{ amount: 1200, orderId: 'Order1', orderItemId: 'Line1', quantity: 1, unitPaidAmount: 1200 }],
    paymentIntentId: 'PaymentABC123',
    providerTransactionId: 'POSTAR202607140001',
    refundId: 'RefundABC123',
  }

  it('submits an ordinary partial refund but keeps a successful acceptance response processing', async () => {
    const post = vi.fn(async (_request: PostarHttpRequest) => response({
      code: '000000',
      data: {
        agetId: 'AGENCY001',
        custId: 'MERCHANT001',
        orderFlowNo: 'POSTARREFUND001',
        orderStatus: '4',
        orderTime: '20260714120600',
        realRefundAmt: '-1200',
        threeOrderNo: 'RefundABC123',
      },
      msg: 'accepted',
    }))
    const adapter = new PostarPaymentProviderAdapter(testOptions(post))

    const observation = await adapter.requestRefund(refundRequest, context)

    expect(observation).toMatchObject({
      amount: 1200,
      providerRefundId: 'RefundABC123',
      providerRefundTransactionId: null,
      status: 'processing',
    })
    const decoded = decodeRequest(post.mock.calls[0]![0])
    expect(decoded.payload).toMatchObject({
      custId: 'MERCHANT001',
      orderNo: 'RefundABC123',
      reOrderNo: 'POSTAR202607140001',
      refundAmount: '1200',
      tag: '2',
    })
  })

  it('maps a signed ordinary refund query result and rejects withdrawal states', async () => {
    const success = new PostarPaymentProviderAdapter(testOptions(async () => response({
      code: '000000',
      data: {
        agetId: 'AGENCY001',
        custId: 'MERCHANT001',
        orderFlowNo: 'POSTARREFUND001',
        orderStatus: '4',
        orderTime: '20260714120700',
        refundAmt: '-1200',
      },
      msg: 'success',
    })))
    const observation = await success.queryRefund({
      merchantId: 'MERCHANT001',
      providerRefundId: 'RefundABC123',
      refundId: 'RefundABC123',
    }, context)
    expect(observation).toMatchObject({
      amount: 1200,
      providerRefundTransactionId: 'POSTARREFUND001',
      status: 'succeeded',
    })

    const withdrawal = new PostarPaymentProviderAdapter(testOptions(async () => response({
      code: '000000',
      data: {
        agetId: 'AGENCY001',
        custId: 'MERCHANT001',
        orderFlowNo: 'POSTARREFUND001',
        orderStatus: '7',
        orderTime: '20260714120700',
        refundAmt: '-1200',
      },
      msg: 'success',
    })))
    await expect(withdrawal.queryRefund({
      merchantId: 'MERCHANT001',
      providerRefundId: 'RefundABC123',
      refundId: 'RefundABC123',
    }, context)).rejects.toThrow('不是普通退款状态')
  })
})

describe('Postar SFTP reconciliation bill', () => {
  it('parses only the injected English JSONL bill and filters the requested merchant', async () => {
    const bill = [
      '{"SUM_COUNT":"2","RE_SUM_COUNT":"1"}',
      '{"JY_TYPE":"1","AGET_ID":"AGENCY001","CUST_ID":"MERCHANT001","JY_ORDER_NO":"PAY001","JY_OLD_TXAMT":"3000","JY_DATE":"20260714","JY_TIME":"20260714120100"}',
      '{"JY_TYPE":"1","AGET_ID":"AGENCY001","CUST_ID":"OTHER","JY_ORDER_NO":"PAY002","JY_OLD_TXAMT":"500","JY_DATE":"20260714","JY_TIME":"20260714120200"}',
      '{"JY_TYPE":"2","AGET_ID":"AGENCY001","CUST_ID":"MERCHANT001","JY_ORDER_NO":"REF001","JY_OLD_TXAMT":"-1200","JY_DATE":"20260714","JY_TIME":"20260714120300"}',
    ].join('\n')
    const options = testOptions(async () => response({}), new TextEncoder().encode(bill))
    const adapter = new PostarPaymentProviderAdapter(options)

    const entries = await adapter.downloadBill({
      businessDate: '2026-07-14',
      merchantId: 'MERCHANT001',
    }, context)

    expect(entries).toEqual([
      expect.objectContaining({ amount: 3000, providerTransactionId: 'PAY001', type: 'payment' }),
      expect.objectContaining({ amount: 1200, providerTransactionId: 'REF001', type: 'refund' }),
    ])
    expect(options.billSource.downloadBill).toHaveBeenCalledWith({
      agencyId: 'AGENCY001',
      businessDate: '2026-07-14',
      format: 'english-json-lines',
      merchantId: 'MERCHANT001',
    })
  })
})
