import { describe, expect, it } from 'vitest'
import type { ScopedTransaction } from './transaction-runner.js'
import {
  NotificationBusinessKeyConflictError,
  NotificationNotFoundError,
  NotificationPolicyError,
  NotificationRepository,
  NotificationRetryNotAllowedError,
  assertPrivacySafePayload,
  outboxNotificationBusinessKey,
} from './notification-repository.js'

const tenantId = '10000000-0000-4000-8000-000000000001'
const storeId = '10000000-0000-4000-8000-000000000002'
const employeeId = '10000000-0000-4000-8000-000000000003'
const outboxId = '10000000-0000-4000-8000-000000000004'
const notificationId = '10000000-0000-4000-8000-000000000005'

interface Response { rows: Record<string, unknown>[]; rowCount?: number }

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = []
  constructor(private readonly responses: Response[]) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ) {
    this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
    const response = this.responses.shift()
    if (!response) throw new Error(`Unexpected query: ${sql}`)
    return { rows: response.rows as Row[], rowCount: response.rowCount ?? response.rows.length }
  }
}

describe('NotificationRepository', () => {
  it('creates a minimal in-app employee notification with a stable business key', async () => {
    const transaction = new ScriptedTransaction([
      response([]),
      response([{ id: employeeId }]),
      response([notificationRow()]),
    ])
    const created = await new NotificationRepository(transaction).create(baseInput())

    expect(created.businessKey).toBe('service:task-42:completed:employee-3')
    expect(transaction.calls[1]?.sql).toContain('FROM mbox.employees')
    expect(transaction.calls[2]?.sql).toContain('ON CONFLICT (tenant_id, store_id, business_key) DO NOTHING')
    expect(transaction.calls[2]?.values[8]).toBe('{"tableCode":"VIP1","taskCode":"water"}')
  })

  it('materializes from an outbox event only when that source exists in the same store', async () => {
    const sourceInput = {
      sourceOutboxMessageId: outboxId,
      channel: 'in_app' as const,
      recipient: { type: 'employee' as const, id: employeeId },
      templateCode: 'service.completed',
      payload: { tableCode: 'VIP1', taskCode: 'water' },
    }
    const transaction = new ScriptedTransaction([
      response([]),
      response([{ id: employeeId }]),
      response([{ id: outboxId }]),
      response([notificationRow({
        business_key: outboxNotificationBusinessKey(sourceInput),
        source_outbox_message_id: outboxId,
      })]),
    ])
    const result = await new NotificationRepository(transaction).materializeFromOutbox(sourceInput)

    expect(result.sourceOutboxMessageId).toBe(outboxId)
    expect(result.businessKey).toMatch(/^outbox:/)
    expect(transaction.calls[2]?.sql).toContain('FROM mbox.outbox_messages')
    expect(transaction.calls[2]?.sql).toContain('FOR KEY SHARE')
  })

  it('replays the same business notification without another recipient lookup or insert', async () => {
    const transaction = new ScriptedTransaction([response([notificationRow({
      payload: { taskCode: 'water', tableCode: 'VIP1' },
    })])])
    const replay = await new NotificationRepository(transaction).create(baseInput())

    expect(replay.id).toBe(notificationId)
    expect(transaction.calls).toHaveLength(1)
  })

  it('rejects reusing one business key for different immutable content', async () => {
    const transaction = new ScriptedTransaction([response([notificationRow()])])
    await expect(new NotificationRepository(transaction).create({
      ...baseInput(),
      templateCode: 'service.cancelled',
    })).rejects.toBeInstanceOf(NotificationBusinessKeyConflictError)
    expect(transaction.calls).toHaveLength(1)
  })

  it('requires explicit customer consent for external customer channels', async () => {
    const customerId = '10000000-0000-4000-8000-000000000006'
    const transaction = new ScriptedTransaction([response([]), response([])])
    await expect(new NotificationRepository(transaction).create({
      ...baseInput(),
      channel: 'wechat',
      recipient: { type: 'customer', id: customerId },
    })).rejects.toThrow('has not consented')
    expect(transaction.calls[1]?.sql).toContain('customer_notification_consents')
    expect(transaction.calls[1]?.sql).toContain("consent.purpose = 'transactional_service'")
    expect(transaction.calls[1]?.sql).not.toContain('consent_snapshot')
    expect(transaction.calls[1]?.values[3]).toBe('wechat')
  })

  it('rejects incompatible channel recipients and direct personal or secret data', async () => {
    const sampleMobile = ['138', '0013', '8000'].join('')
    const sampleAccessKey = ['LTAI', '12345678', '90123456'].join('')
    const transaction = new ScriptedTransaction([response([])])
    await expect(new NotificationRepository(transaction).create({
      ...baseInput(),
      channel: 'sms',
    })).rejects.toBeInstanceOf(NotificationPolicyError)

    expect(() => assertPrivacySafePayload({ phone: sampleMobile })).toThrow('not permitted')
    expect(() => assertPrivacySafePayload({ note: `call ${sampleMobile} now` })).toThrow('personal or secret')
    expect(() => assertPrivacySafePayload({ accessKey: sampleAccessKey })).toThrow('not permitted')
    expect(() => assertPrivacySafePayload({ customerName: '王女士' })).toThrow('not permitted')
    expect(() => assertPrivacySafePayload({ score: Number.NaN })).toThrow('number is invalid')
  })

  it('lists only the requested recipient and puts failed work first', async () => {
    const transaction = new ScriptedTransaction([response([
      notificationRow({ status: 'failed', last_error: 'delivery_failed:timeout' }),
    ])])
    const result = await new NotificationRepository(transaction).list({
      statuses: ['failed', 'pending'],
      recipient: { type: 'employee', id: employeeId },
      limit: 20,
    })

    expect(result).toHaveLength(1)
    expect(transaction.calls[0]?.sql).toContain("WHEN 'failed' THEN 0")
    expect(transaction.calls[0]?.values).toEqual([
      tenantId,
      storeId,
      ['failed', 'pending'],
      'employee',
      employeeId,
      20,
    ])
  })

  it('requeues only failed notifications without resetting delivery attempts', async () => {
    const transaction = new ScriptedTransaction([response([
      notificationRow({ status: 'failed', attempts: 2, last_error: null }),
    ])])
    const result = await new NotificationRepository(transaction).retryFailed(notificationId)

    expect(result.status).toBe('failed')
    expect(result.attempts).toBe(2)
    expect(transaction.calls[0]?.sql).toContain("AND status = 'failed'")
    expect(transaction.calls[0]?.sql).not.toContain('attempts = 0')
  })

  it('distinguishes a missing notification from a non-retryable status', async () => {
    const missing = new ScriptedTransaction([response([]), response([])])
    await expect(new NotificationRepository(missing).retryFailed(notificationId))
      .rejects.toBeInstanceOf(NotificationNotFoundError)

    const delivered = new ScriptedTransaction([
      response([]),
      response([{ status: 'delivered' }]),
    ])
    await expect(new NotificationRepository(delivered).retryFailed(notificationId))
      .rejects.toBeInstanceOf(NotificationRetryNotAllowedError)
  })
})

function baseInput() {
  return {
    businessKey: 'service:task-42:completed:employee-3',
    channel: 'in_app' as const,
    recipient: { type: 'employee' as const, id: employeeId },
    templateCode: 'service.completed',
    payload: { tableCode: 'VIP1', taskCode: 'water' },
  }
}

function notificationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: notificationId,
    business_key: 'service:task-42:completed:employee-3',
    source_outbox_message_id: null,
    channel: 'in_app',
    recipient_type: 'employee',
    recipient_id: employeeId,
    template_code: 'service.completed',
    payload: { tableCode: 'VIP1', taskCode: 'water' },
    status: 'pending',
    available_at: '2026-08-11T12:00:00.000Z',
    delivered_at: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    dead_at: null,
    cancelled_at: null,
    created_at: '2026-08-11T12:00:00.000Z',
    updated_at: '2026-08-11T12:00:00.000Z',
    ...overrides,
  }
}

function response(rows: Record<string, unknown>[], rowCount = rows.length): Response {
  return { rows, rowCount }
}
