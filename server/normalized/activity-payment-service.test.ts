import { describe, expect, it, vi } from 'vitest'
import { ActivityPaymentService } from './activity-payment-service.js'
import { OnlinePaymentUnknownError } from './online-payment-service.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '91000000-0000-4000-8000-000000000001',
  storeId: '91000000-0000-4000-8000-000000000002',
}
const customerId = '91000000-0000-4000-8000-000000000003'
const registrationPublicId = 'activity-registration-service-test'
const paymentId = '91000000-0000-4000-8000-000000000004'

describe('ActivityPaymentService', () => {
  it('returns stable states and only the actions that are safe for each state', async () => {
    const cases = [
      { overrides: { payment_status: 'not_required', authoritative_payment_status: null }, state: 'not_required', actions: ['cancel_registration'] },
      { overrides: {}, state: 'action_required', actions: ['start_payment', 'cancel_registration'] },
      { overrides: { provider_action_state: 'ready' }, state: 'pending', actions: ['start_payment', 'query_payment', 'cancel_registration'] },
      { overrides: { provider_action_state: 'unknown' }, state: 'unknown', actions: ['query_payment'] },
      { overrides: { payment_status: 'paid', authoritative_payment_status: 'succeeded' }, state: 'confirmed', actions: [] },
      { overrides: { authoritative_payment_status: 'failed' }, state: 'failed', actions: ['cancel_registration'] },
      { overrides: { refund_status: 'requested' }, state: 'refund_requested', actions: [] },
      { overrides: { refund_status: 'approved' }, state: 'refunding', actions: [] },
      { overrides: { refund_status: 'succeeded' }, state: 'refunded', actions: [] },
    ] as const
    for (const item of cases) {
      const service = serviceFor({ ...paymentRow(), ...item.overrides })
      await expect(service.get(publicContext(), registrationPublicId)).resolves.toMatchObject({
        resolutionState: item.state,
        allowedActions: item.actions,
      })
    }
  })

  it('whitelists WeChat payment parameters and forwards the action idempotency key', async () => {
    let calls = 0
    const rows = () => ({ ...paymentRow(), provider_action_state: calls++ === 0 ? null : 'ready' })
    const create = vi.fn(async () => ({
      paymentId, paymentPublicId: 'activity-payment-service-test', payableKind: 'activity_registration' as const,
      orderPublicId: null, activityRegistrationPublicId: registrationPublicId,
      status: 'pending' as const, presentation: 'jsapi' as const,
      expiresAt: '2026-08-16T12:05:00.000Z',
      payload: {
        appId: 'must-not-leak', timeStamp: '1', nonceStr: 'nonce', package: 'prepay_id=1',
        signType: 'RSA', paySign: 'signature', providerInternal: 'must-not-leak',
      },
    }))
    const service = serviceFor(rows, { create })
    const result = await service.createAction(publicContext(), {
      registrationPublicId, clientIp: '127.0.0.1', idempotencyKey: 'activity-action-service-key-0001',
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      paymentId, idempotencyKey: 'activity-action-service-key-0001',
      principal: { type: 'guest', tableSessionId: null, customerId },
    }))
    expect(result.providerAction?.payload).toEqual({
      timeStamp: '1', nonceStr: 'nonce', package: 'prepay_id=1', signType: 'RSA', paySign: 'signature',
    })
  })

  it('does not create an invisible QR action for a historical non-JSAPI activity payment', async () => {
    const create = vi.fn()
    const service = serviceFor({ ...paymentRow(), payment_method: 'native_qr' }, { create })

    await expect(service.createAction(publicContext(), {
      registrationPublicId, clientIp: '127.0.0.1', idempotencyKey: 'activity-legacy-qr-key-0001',
    })).rejects.toMatchObject({ code: 'ACTIVITY_PAYMENT_METHOD_UNSUPPORTED', statusCode: 409 })
    expect(create).not.toHaveBeenCalled()
  })

  it('preserves an unknown provider result and never records it as success', async () => {
    const commands = { recordProviderQueryResult: vi.fn(), requestActivityRefund: vi.fn() }
    const service = serviceFor(
      { ...paymentRow(), provider_action_state: 'unknown' },
      { query: vi.fn(async () => { throw new OnlinePaymentUnknownError() }) },
      commands,
    )

    await expect(service.query(publicContext(), {
      registrationPublicId, idempotencyKey: 'activity-query-service-key-0001',
    })).resolves.toMatchObject({ resolutionState: 'unknown', allowedActions: ['query_payment'] })
    expect(commands.recordProviderQueryResult).not.toHaveBeenCalled()
  })

  it('forwards the strong query observation and settlement channel to the payment command', async () => {
    const recordProviderQueryResult = vi.fn(async () => ({ value: {}, replayed: false }))
    const query = vi.fn(async () => ({
      context: { publicId: 'activity-payment-service-test' },
      verifiedObservationId: '91000000-0000-4000-8000-000000000007',
      observation: {
        providerTransactionId: 'POSTAR-ACTIVITY-PAYMENT-0001',
        status: 'succeeded' as const, amount: 2000, currency: 'CNY',
        settlementChannel: 'wechat' as const, occurredAt: '2026-08-16T12:00:00.000Z',
      },
    }))
    const service = serviceFor(
      { ...paymentRow(), provider_action_state: 'ready' },
      { query },
      { recordProviderQueryResult },
    )

    await service.query(publicContext(), {
      registrationPublicId, idempotencyKey: 'activity-query-verified-key-0001',
    })

    expect(recordProviderQueryResult).toHaveBeenCalledWith(expect.objectContaining({
      verifiedObservationId: '91000000-0000-4000-8000-000000000007',
      providerTransactionId: 'POSTAR-ACTIVITY-PAYMENT-0001',
      settlementChannel: 'wechat',
      status: 'succeeded',
    }))
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      queryBindingId: 'activity-query-verified-key-0001',
    }))
  })

  it('queries and closes the one unpaid activity payment before cancellation can release a seat', async () => {
    const recordProviderQueryResult = vi.fn(async () => ({ value: {}, replayed: false }))
    const close = vi.fn(async () => ({
      context: { publicId: 'activity-payment-service-test' },
      verifiedObservationId: '91000000-0000-4000-8000-000000000008',
      observation: {
        providerTransactionId: 'POSTAR-ACTIVITY-CLOSE-0001',
        status: 'closed' as const, amount: 2000, currency: 'CNY',
        settlementChannel: 'wechat' as const, occurredAt: '2026-08-16T12:02:00.000Z',
      },
    }))
    const service = serviceFor(
      { ...paymentRow(), provider_action_state: 'ready' },
      { close },
      { recordProviderQueryResult },
    )

    await service.prepareCancellation(publicContext(), {
      registrationPublicId, idempotencyKey: 'activity-cancel-close-service-key-0001',
    })

    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      paymentId,
      principal: { type: 'guest', tableSessionId: null, customerId },
      closeBindingId: expect.stringMatching(/^activity-close-[a-f0-9]{64}$/),
    }))
    expect(recordProviderQueryResult).toHaveBeenCalledWith(expect.objectContaining({
      status: 'closed',
      verifiedObservationId: '91000000-0000-4000-8000-000000000008',
    }))
  })

  it('does not release a registration when the provider close cannot determine the outcome', async () => {
    const recordProviderQueryResult = vi.fn()
    const service = serviceFor(
      { ...paymentRow(), provider_action_state: 'ready' },
      { close: vi.fn(async () => { throw new OnlinePaymentUnknownError() }) },
      { recordProviderQueryResult },
    )

    await expect(service.prepareCancellation(publicContext(), {
      registrationPublicId, idempotencyKey: 'activity-cancel-unknown-service-key-0001',
    })).rejects.toMatchObject({ code: 'ACTIVITY_PAYMENT_RESULT_UNKNOWN', statusCode: 409 })
    expect(recordProviderQueryResult).not.toHaveBeenCalled()
  })

  it('starts a paid activity refund through the existing maker-checker command', async () => {
    const requestActivityRefund = vi.fn(async () => ({ value: { status: 'requested' }, replayed: false }))
    const service = serviceFor(
      { ...paymentRow(), payment_status: 'paid', authoritative_payment_status: 'succeeded' },
      undefined,
      { recordProviderQueryResult: vi.fn(), requestActivityRefund },
    )
    await service.requestRefund({
      scope, employeeId: '91000000-0000-4000-8000-000000000005', businessDate: '2026-08-16',
    }, {
      registrationPublicId, reason: '顾客取消收费活动', idempotencyKey: 'activity-refund-service-key-0001',
    })
    expect(requestActivityRefund).toHaveBeenCalledWith(expect.objectContaining({
      paymentId, reason: '顾客取消收费活动',
      actor: { type: 'employee', employeeId: '91000000-0000-4000-8000-000000000005' },
    }))
  })
})

function serviceFor(
  source: Record<string, unknown> | (() => Record<string, unknown>),
  onlineOverrides: Partial<{ create: (...args: never[]) => unknown; query: (...args: never[]) => unknown; close: (...args: never[]) => unknown }> = {},
  commandOverrides: Partial<{ recordProviderQueryResult: (...args: never[]) => unknown; requestActivityRefund: (...args: never[]) => unknown }> = {},
) {
  const transactions = {
    run: async (_scope: unknown, handler: (transaction: ScopedTransaction) => Promise<unknown>) => handler({
      scope,
      query: async () => {
        const row = typeof source === 'function' ? source() : source
        return { rows: [row], rowCount: 1 }
      },
    }),
  }
  return new ActivityPaymentService(
    transactions as never,
    {
      recordProviderQueryResult: vi.fn(), requestActivityRefund: vi.fn(), ...commandOverrides,
    } as never,
    {
      create: vi.fn(async () => { throw new Error('unexpected create') }),
      query: vi.fn(async () => { throw new Error('unexpected query') }),
      close: vi.fn(async () => { throw new Error('unexpected close') }),
      ...onlineOverrides,
    } as never,
  )
}

function publicContext() {
  return { scope, customerId, businessDate: '2026-08-16', actorRef: 'guest:test' }
}

function paymentRow(): Record<string, unknown> {
  return {
    registration_id: '91000000-0000-4000-8000-000000000006',
    registration_public_id: registrationPublicId,
    registration_status: 'payment_pending', registration_cycle: 1, payment_status: 'pending',
    amount_due_minor: '2000', paid_amount_minor: '0', currency: 'CNY',
    seat_hold_expires_at: '2026-08-16T12:15:00.000Z',
    activity_starts_at: '2099-08-18T12:00:00.000Z',
    payment_id: paymentId, payment_public_id: 'activity-payment-service-test',
    payment_method: 'jsapi',
    authoritative_payment_status: 'pending', provider_action_state: null, refund_status: null,
  }
}
