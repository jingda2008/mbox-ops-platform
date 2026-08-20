import { describe, expect, it, vi } from 'vitest'
import { ReservationPerformanceNotificationWorker } from './reservation-performance-notification-worker.js'

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  storeId: '10000000-0000-4000-8000-000000000002',
}

describe('ReservationPerformanceNotificationWorker', () => {
  it('preflights the formal provider before consuming a one-use reservation authorization', async () => {
    const run = vi.fn()
    const worker = new ReservationPerformanceNotificationWorker(
      { run } as never,
      { resolveMiniProgramNotificationRecipient: vi.fn() },
      {
        preflight: vi.fn(async () => { throw new Error('formal provider unavailable') }),
        sendTemplate: vi.fn(),
      },
    )

    await expect(worker.runBatch(scope, 'reservation-worker-001')).rejects.toThrow('formal provider unavailable')
    expect(run).not.toHaveBeenCalled()
  })

  it('sends only typed reservation-context fields and records the terminal provider result', async () => {
    const queries: string[] = []
    const transaction = {
      scope,
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        if (sql.includes('RETURNING job.*')) return { rows: [claimedJob()], rowCount: 1 }
        if (sql.includes('reservation_performance_notification_receipts')) {
          return { rows: [{ id: 'receipt-001' }], rowCount: 1 }
        }
        return { rows: [], rowCount: sql.includes("SET status='suppressed'") ? 0 : 1 }
      }),
    }
    const recipients = {
      resolveMiniProgramNotificationRecipient: vi.fn(async () => ({
        identityExternalId: 'identity-001', openId: 'openid-self',
      })),
    }
    const delivery = {
      preflight: vi.fn(async () => undefined),
      sendTemplate: vi.fn(async () => ({
        outcome: 'accepted' as const, providerReference: 'provider-rid-001',
      })),
    }
    const worker = new ReservationPerformanceNotificationWorker(
      { run: async (_scope, callback) => callback(transaction as never) } as never,
      recipients,
      delivery,
    )

    await expect(worker.runBatch(scope, 'reservation-worker-001')).resolves.toEqual({
      workerId: 'reservation-worker-001', claimed: 1, accepted: ['job-001'],
      rejected: [], unknown: [], suppressed: 0,
    })
    expect(delivery.sendTemplate).toHaveBeenCalledWith({
      jobId: 'job-001', recipientOpenId: 'openid-self',
      templateId: 'wechat-template-reservation-revised',
      pagePath: 'pages/reservations/index',
      data: {
        thing1: '演出改期', time2: '2026-08-20 20:30', time3: '2026-08-20 19:30',
      },
    })
    expect(queries.join('\n')).toContain("authorization_context='reservation'")
    expect(queries.join('\n')).toContain("notification_type='reservation_performance_revised'")
    expect(queries.join('\n')).toContain('grant_record.template_id=job.template_id')
    expect(queries.join('\n')).toContain('grant_record.reservation_id=job.reservation_id')
    expect(queries.join('\n')).toContain('latest.reservation_id=grant_record.reservation_id')
    expect(queries.join('\n')).toContain('reservation_performance_notification_authorization_uses')
    expect(queries.join('\n')).toContain('reservation_performance_notification_receipts')
  })
})

function claimedJob() {
  return {
    id: 'job-001', customer_id: 'customer-001', identity_external_id: 'identity-001',
    template_id: 'wechat-template-reservation-revised', page_path: 'pages/reservations/index',
    change_type_data_key: 'thing1', performance_time_data_key: 'time2',
    reservation_time_data_key: 'time3', revision_kind: 'rescheduled' as const,
    resulting_starts_at: '2026-08-20T12:30:00.000Z',
    reservation_arrival_at: '2026-08-20T11:30:00.000Z',
  }
}
