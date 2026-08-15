import { describe, expect, it } from 'vitest'
import type { ScopedTransaction } from './transaction-runner.js'
import {
  SongRequestEligibilityError,
  SongRequestRepository,
} from './song-request-repository.js'

const tenantId = '30000000-0000-4000-8000-000000000001'
const storeId = '30000000-0000-4000-8000-000000000002'
const sessionId = '30000000-0000-4000-8000-000000000003'
const performerId = '30000000-0000-4000-8000-000000000004'
const currentScheduleId = '30000000-0000-4000-8000-000000000005'
const nextScheduleId = '30000000-0000-4000-8000-000000000006'
const requestId = '30000000-0000-4000-8000-000000000007'
const customerId = '30000000-0000-4000-8000-000000000008'
const songId = '30000000-0000-4000-8000-000000000009'

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = []
  constructor(private readonly responses: Array<{ rows: Record<string, unknown>[]; rowCount?: number }>) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ) {
    this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Unexpected query')
    return { rows: response.rows as Row[], rowCount: response.rowCount ?? response.rows.length }
  }
}

describe('SongRequestRepository', () => {
  it('accepts a current-performer extension request even near the end and routes it to staff confirmation', async () => {
    const transaction = submissionTransaction(currentScheduleId, requestRow({ status: 'confirming' }))
    const result = await new SongRequestRepository(transaction).submit({
      tableSessionId: sessionId,
      scheduleId: currentScheduleId,
      songTitle: 'hou lai',
      requestType: 'catalog',
      requestedAt: '2026-08-11T13:14:30.000Z',
      requestExtension: true,
      customerId,
      businessDate: '2026-08-11',
    })

    expect(result).toMatchObject({
      slot: 'current',
      extensionRequested: true,
      requiresStaffConfirmation: true,
      request: { songTitle: '后来', status: 'confirming' },
    })
    expect(transaction.calls.at(-1)?.values[9]).toBe('confirming')
    expect(transaction.calls.at(-1)?.values[6]).toBe(songId)
  })

  it('allows the next scheduled performer and requires custom songs to be confirmed', async () => {
    const transaction = submissionTransaction(nextScheduleId, requestRow({
      schedule_id: nextScheduleId,
      request_type: 'custom',
      song_title: '一首特别的歌',
      status: 'confirming',
    }), true, false)
    const result = await new SongRequestRepository(transaction).submit({
      tableSessionId: sessionId,
      scheduleId: nextScheduleId,
      songTitle: '一首特别的歌',
      requestType: 'custom',
      requestedAt: '2026-08-11T13:00:00.000Z',
      customerId,
      businessDate: '2026-08-11',
    })
    expect(result).toMatchObject({ slot: 'next', request: { requestType: 'custom', status: 'confirming' } })
  })

  it('rejects a catalog song not offered by the selected performer', async () => {
    const transaction = submissionTransaction(currentScheduleId, null, false)
    await expect(new SongRequestRepository(transaction).submit({
      tableSessionId: sessionId,
      scheduleId: currentScheduleId,
      songTitle: '不存在的歌',
      requestType: 'catalog',
      requestedAt: '2026-08-11T13:00:00.000Z',
      customerId,
      businessDate: '2026-08-11',
    })).rejects.toBeInstanceOf(SongRequestEligibilityError)
  })

  it('does not allow an extension request against the next performer', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [{ id: sessionId }] },
      { rows: [{ id: 'customer-link' }] },
      { rows: [scheduleRow(nextScheduleId, '2026-08-11T13:35:00.000Z', '2026-08-11T14:20:00.000Z')] },
      { rows: [storeClock()] },
      { rows: [
        scheduleRow(currentScheduleId, '2026-08-11T12:30:00.000Z', '2026-08-11T13:15:00.000Z'),
        scheduleRow(nextScheduleId, '2026-08-11T13:35:00.000Z', '2026-08-11T14:20:00.000Z'),
      ] },
    ])
    await expect(new SongRequestRepository(transaction).submit({
      tableSessionId: sessionId,
      scheduleId: nextScheduleId,
      songTitle: '后来',
      requestType: 'catalog',
      requestedAt: '2026-08-11T13:00:00.000Z',
      requestExtension: true,
      customerId,
      businessDate: '2026-08-11',
    })).rejects.toThrow('only be requested from the current performer')
  })
})

function submissionTransaction(
  targetScheduleId: string,
  inserted: Record<string, unknown> | null,
  includeInsert = true,
  includeCatalogLookup = true,
): ScriptedTransaction {
  const target = targetScheduleId === currentScheduleId
    ? scheduleRow(currentScheduleId, '2026-08-11T12:30:00.000Z', '2026-08-11T13:15:00.000Z')
    : scheduleRow(nextScheduleId, '2026-08-11T13:35:00.000Z', '2026-08-11T14:20:00.000Z')
  const responses: Array<{ rows: Record<string, unknown>[] }> = [
    { rows: [{ id: sessionId }] },
    { rows: [{ id: 'customer-link' }] },
    { rows: [target] },
    { rows: [storeClock()] },
    { rows: [
      scheduleRow(currentScheduleId, '2026-08-11T12:30:00.000Z', '2026-08-11T13:15:00.000Z'),
      scheduleRow(nextScheduleId, '2026-08-11T13:35:00.000Z', '2026-08-11T14:20:00.000Z'),
    ] },
    { rows: [performerRow()] },
  ]
  if (includeCatalogLookup) responses.push({ rows: includeInsert ? [{ id: songId, title: '后来' }] : [] })
  if (includeInsert && inserted !== null) responses.push({ rows: [inserted] })
  return new ScriptedTransaction(responses)
}

function storeClock(): Record<string, unknown> {
  return {
    timezone: 'Asia/Shanghai',
    business_date: '2026-08-11',
    window_start: '2026-08-10T22:00:00.000Z',
    window_end: '2026-08-11T22:00:00.000Z',
  }
}

function scheduleRow(id: string, startsAt: string, endsAt: string): Record<string, unknown> {
  return {
    id,
    performer_id: performerId,
    song_id: null,
    performer_code: 'NATALIE',
    performer_stage_name: 'Natalie',
    performer_profile_snapshot: {},
    starts_at: startsAt,
    ends_at: endsAt,
    status: 'scheduled',
    sort_order: 0,
    created_at: startsAt,
    updated_at: startsAt,
  }
}

function performerRow(): Record<string, unknown> {
  return {
    id: performerId,
    code: 'NATALIE',
    stage_name: 'Natalie',
    profile_snapshot: {},
    song_catalog: [{ code: 'SONG-1', title: '后来', aliases: ['Hou Lai'] }],
    status: 'active',
    created_at: '2026-08-11T12:00:00.000Z',
    updated_at: '2026-08-11T12:00:00.000Z',
  }
}

function requestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: requestId,
    table_session_id: sessionId,
    performer_id: performerId,
    schedule_id: currentScheduleId,
    customer_id: null,
    song_title: '后来',
    request_type: 'catalog',
    status: 'requested',
    quoted_amount_minor: null,
    currency: null,
    note: null,
    created_at: '2026-08-11T13:00:00.000Z',
    updated_at: '2026-08-11T13:00:00.000Z',
    ...overrides,
  }
}
