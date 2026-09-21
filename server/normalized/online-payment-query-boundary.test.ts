import { describe, expect, it, vi } from 'vitest'
import {
  OnlinePaymentService,
  OnlinePaymentUnknownError,
  OnlinePaymentUnavailableError,
} from './online-payment-service.js'
import { PostarPaymentNotSubmittedError } from '../postar-adapter.js'
import { PaymentProviderActionRepository } from './payment-provider-action-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '93000000-0000-4000-8000-000000000001',
  storeId: '93000000-0000-4000-8000-000000000002',
}
const paymentId = '93000000-0000-4000-8000-000000000003'
const paymentContext = {
  id: paymentId,
  payable_kind: 'order',
  order_id: '93000000-0000-4000-8000-000000000004',
  order_public_id: 'ORDER-QUERY-BOUNDARY-001',
  activity_registration_id: null,
  activity_registration_public_id: null,
  public_id: 'PAYQUERYBOUNDARY001',
  provider: 'postar',
  provider_transaction_id: null,
  method: 'jsapi',
  amount_minor: '13600',
  currency: 'CNY',
  status: 'pending',
  customer_id: '93000000-0000-4000-8000-000000000005',
  table_session_id: '93000000-0000-4000-8000-000000000006',
  table_code: 'L01',
  created_at: '2026-09-06T15:40:00.000Z',
}
const config = {
  provider: 'postar' as const,
  environment: 'test' as const,
  agencyId: 'TESTAGENCY', merchantId: 'TESTMERCHANT', publicKey: 'TESTPUBLICKEY',
  callbackUrl: 'https://example.test/api/payments/providers/postar/callback', timeoutMs: 1_000,
  wechat: null,
}

describe('OnlinePaymentService payment query uncertainty boundary', () => {
  it.each([true,false])('persists a proven pre-dispatch failure separately from unknown (%s)',async (notSubmitted)=>{
    const load=vi.spyOn(PaymentProviderActionRepository.prototype,'resolvePaymentContext').mockResolvedValue({
      id:paymentId,status:'pending',publicId:'LOCALPAY0001',provider:'postar',method:'native_qr',amountMinor:800,currency:'CNY',payableKind:'order',orderPublicId:'ORDER001',
    } as never)
    const claim=vi.spyOn(PaymentProviderActionRepository.prototype,'claim').mockResolvedValue({claimed:true} as never)
    const failed=vi.spyOn(PaymentProviderActionRepository.prototype,'markFailed').mockResolvedValue()
    const unknown=vi.spyOn(PaymentProviderActionRepository.prototype,'markUnknown').mockResolvedValue()
    try {
      const service=new OnlinePaymentService(runner(),'test-secret-at-least-thirty-two-bytes',config,{
        createPayment:vi.fn().mockRejectedValue(notSubmitted?new PostarPaymentNotSubmittedError():new Error('response corrupted')),
        queryPayment:vi.fn(),closePayment:vi.fn(),requestRefund:vi.fn(),queryRefund:vi.fn(),
      })
      await expect(service.create({scope,paymentId,principal:{type:'employee',employeeId:'employee'},clientIp:'203.0.113.10',operatorId:'MBOX'}))
        .rejects.toBeInstanceOf(notSubmitted?OnlinePaymentUnavailableError:OnlinePaymentUnknownError)
      if(notSubmitted){expect(failed).toHaveBeenCalledWith(paymentId,'POSTAR_CREATE_NOT_SUBMITTED_INVALID_REQUEST','not_submitted');expect(unknown).not.toHaveBeenCalled()}
      else{expect(unknown).toHaveBeenCalledOnce();expect(failed).not.toHaveBeenCalled()}
    } finally {load.mockRestore();claim.mockRestore();failed.mockRestore();unknown.mockRestore()}
  })

  it('reuses unconsumed verified success while the channel is unavailable', async () => {
    const queryPayment = vi.fn().mockRejectedValue(new Error('channel offline'))
    const recordPayment = vi.fn()
    const service = new OnlinePaymentService(
      runner({id:'saved-observation',provider_transaction_id:'POSTAR-SAVED',reported_amount_minor:'13600',
        reported_currency:'CNY',settlement_channel:'wechat',occurred_at:'2026-09-06T15:41:00.000Z'}),
      'test-secret-at-least-thirty-two-bytes', config,
      {createPayment:vi.fn(),closePayment:vi.fn(),requestRefund:vi.fn(),queryRefund:vi.fn(),queryPayment},
      {recordPayment,recordRefund:vi.fn()},
    )
    const result = await service.querySystem({scope,paymentId,queryBindingId:'local-recovery'})
    expect(result).toMatchObject({verifiedObservationId:'saved-observation',observation:{status:'succeeded',amount:13600,settlementChannel:'wechat'}})
    expect(queryPayment).not.toHaveBeenCalled()
    expect(recordPayment).not.toHaveBeenCalled()
  })

  it('does not append an immutable observation for an unchanged processing result', async () => {
    const recordPayment = vi.fn()
    const service = new OnlinePaymentService(
      runner(), 'test-secret-at-least-thirty-two-bytes', config,
      {
        createPayment: vi.fn(), closePayment: vi.fn(), requestRefund: vi.fn(), queryRefund: vi.fn(),
        queryPayment: vi.fn(async () => ({
          paymentIntentId: paymentContext.public_id,
          providerTransactionId: 'POSTAR-PENDING-001',
          status: 'processing' as const,
          amount: Number(paymentContext.amount_minor),
          currency: paymentContext.currency,
          merchantId: config.merchantId,
          occurredAt: '2026-09-06T15:41:00.000Z',
        })),
      },
      { recordPayment, recordRefund: vi.fn() },
    )

    const result = await service.querySystem({
      scope, paymentId, queryBindingId: 'processing-does-not-grow-ledger',
    })

    expect(result.observation.status).toBe('processing')
    expect(result.verifiedObservationId).toBeNull()
    expect(recordPayment).not.toHaveBeenCalled()
  })

  it('does not extend a resolved guest principal to local historical close queries', async () => {
    const resolve=vi.spyOn(PaymentProviderActionRepository.prototype,'resolvePaymentContext').mockResolvedValue({
      id:paymentId,status:'closed',publicId:'LOCALPAY0001',provider:'postar',amountMinor:800,currency:'CNY',payableKind:'order',
    } as never)
    const queryPayment=vi.fn()
    try{
      const service=new OnlinePaymentService(runner(),'test-secret-at-least-thirty-two-bytes',config,
        {createPayment:vi.fn(),queryPayment,closePayment:vi.fn(),requestRefund:vi.fn(),queryRefund:vi.fn()})
      await expect(service.query({scope,paymentId,queryBindingId:'guest-closed-original-query',
        principal:{type:'guest',customerId:paymentContext.customer_id,tableSessionId:paymentContext.table_session_id}})).rejects.toBeInstanceOf(OnlinePaymentUnavailableError)
      expect(queryPayment).not.toHaveBeenCalled()
    }finally{resolve.mockRestore()}
  })

  it.each(['query', 'querySystem', 'closeSystem'] as const)(
    'maps an unmappable provider response to unknown for %s',
    async (operation) => {
      const queryPayment = vi.fn(async () => {
        throw new Error('provider returned an unmappable query response')
      })
      const service = new OnlinePaymentService(
        runner(), 'test-secret-at-least-thirty-two-bytes', config,
        { createPayment: vi.fn(), queryPayment, closePayment: vi.fn(), requestRefund: vi.fn(), queryRefund: vi.fn() },
        { recordPayment: vi.fn(), recordRefund: vi.fn() },
      )

      const input = operation === 'query'
        ? service.query({
            scope, paymentId, queryBindingId: 'query-boundary-test',
            principal: { type: 'employee', employeeId: '93000000-0000-4000-8000-000000000007' },
          })
        : operation === 'querySystem'
          ? service.querySystem({ scope, paymentId, queryBindingId: 'query-system-boundary-test' })
          : service.closeSystem({ scope, paymentId, closeBindingId: 'close-system-boundary-test' })

      await expect(input).rejects.toBeInstanceOf(OnlinePaymentUnknownError)
      expect(queryPayment).toHaveBeenCalledTimes(1)
    },
  )

  it('maps an unmappable provider close response to unknown after a pending query', async () => {
    const queryPayment = vi.fn(async () => ({
      paymentIntentId: paymentContext.public_id,
      providerTransactionId: 'POSTAR-PENDING-001',
      status: 'pending' as const,
      amount: Number(paymentContext.amount_minor),
      currency: paymentContext.currency,
      merchantId: config.merchantId,
      occurredAt: '2026-09-06T15:41:00.000Z',
    }))
    const closePayment = vi.fn(async () => {
      throw new Error('provider returned an unmappable close response')
    })
    const recordPayment = vi.fn()
    const service = new OnlinePaymentService(
      runner(), 'test-secret-at-least-thirty-two-bytes', config,
      { createPayment: vi.fn(), queryPayment, closePayment, requestRefund: vi.fn(), queryRefund: vi.fn() },
      { recordPayment, recordRefund: vi.fn() },
    )

    await expect(service.closeSystem({
      scope, paymentId, closeBindingId: 'close-response-boundary-test',
    })).rejects.toBeInstanceOf(OnlinePaymentUnknownError)
    expect(queryPayment).toHaveBeenCalledTimes(1)
    expect(closePayment).toHaveBeenCalledTimes(1)
    expect(recordPayment).not.toHaveBeenCalled()
  })
})

function runner(saved?: Record<string, unknown>) {
  const transaction: ScopedTransaction = {
    scope,
    query: async <Row extends Record<string, unknown>>(text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim()
      if (sql.startsWith('SELECT payment.id')) {
        return { rows: [paymentContext as Row], rowCount: 1 }
      }
      if (sql.includes('FROM mbox.idempotency_records')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM mbox.verified_provider_observations')) return { rows: saved ? [saved as Row] : [], rowCount: saved ? 1 : 0 }
      throw new Error(`Unexpected payment query: ${sql}`)
    },
  }
  return {
    run: async (_scope: unknown, handler: (current: ScopedTransaction) => Promise<unknown>) => handler(transaction),
  } as never
}
