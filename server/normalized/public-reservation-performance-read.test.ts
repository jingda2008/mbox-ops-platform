import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  publicReservationApiPlugin,
  type PublicReservationApiOptions,
} from './public-reservation-api.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

const scope: StoreScope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
}

afterEach(() => vi.restoreAllMocks())

describe('public reservation performance view', () => {
  it('returns only the published performance view in a read-only transaction', async () => {
    const schedule = {
      id: '33333333-3333-4333-8333-333333333333',
      performerId: '44444444-4444-4444-8444-444444444444',
      performerCode: 'LI-YAN',
      performerStageName: '李艳',
      performerProfileSnapshot: { genres: ['流行'], internalNote: '不得返回前端' },
      startsAt: '2026-08-12T12:30:00.000Z',
      endsAt: '2026-08-12T13:15:00.000Z',
      status: 'scheduled' as const,
      sortOrder: 1,
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    }
    const getDailyView = vi.fn(async () => ({
      timezone: 'Asia/Shanghai', localDate: '2026-08-12', phase: 'upcoming' as const,
      current: null, next: schedule, startsInSeconds: 3600, remainingSeconds: null,
      schedules: [schedule],
    }))
    const query = vi.fn(async () => ({ rows: [{
      hold_minutes: 20, arrival_grace_minutes: 10, max_advance_days: 90,
      default_duration_minutes: 240, customer_cancel_cutoff_minutes: 120,
      deposit_mode: 'disabled', deposit_minor: null, deposit_ratio_bps: null, deposit_rule_text: null,
    }] }))
    const run = vi.fn(async (
      _scope: Readonly<StoreScope>,
      operation: (transaction: ScopedTransaction) => Promise<unknown>,
      _options?: { readOnly?: boolean },
    ) => operation({ scope, query } as unknown as ScopedTransaction))
    const app = Fastify()
    await app.register(publicReservationApiPlugin, {
      transactions: { run } as unknown as PublicReservationApiOptions['transactions'],
      commands: {} as PublicReservationApiOptions['commands'],
      waitlists: {} as PublicReservationApiOptions['waitlists'],
      reservationSessions: {} as PublicReservationApiOptions['reservationSessions'],
      resolveTrustedScope: () => scope,
      resolveGuest: () => { throw new Error('guest session must not be required') },
      resolveStaff: () => { throw new Error('staff session must not be required') },
      protectContact: () => { throw new Error('contact protection must not be called') },
      currentBusinessDate: () => '2026-08-11',
      now: () => new Date('2026-08-11T11:30:00.000Z'),
      createScheduleRepository: () => ({ getDailyView }),
    })

    const response = await app.inject({
      method: 'GET',
      url: '/public/reservation/performances?date=2026-08-12',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({
      phase: 'upcoming', next: { performerStageName: '李艳', performerProfile: { genres: ['流行'] } },
    })
    expect(JSON.stringify(response.json())).not.toContain('internalNote')
    expect(run.mock.calls[0]?.[2]).toEqual({ readOnly: true })
    expect(getDailyView).toHaveBeenCalledWith('2026-08-12', '2026-08-11T11:30:00.000Z')
    await app.close()
  })
})
