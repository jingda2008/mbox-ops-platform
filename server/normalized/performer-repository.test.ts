import { describe, expect, it } from 'vitest'
import type { ScopedTransaction } from './transaction-runner.js'
import { PerformerRepository } from './performer-repository.js'

const tenantId = '10000000-0000-4000-8000-000000000001'
const storeId = '10000000-0000-4000-8000-000000000002'
const performerId = '10000000-0000-4000-8000-000000000003'

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

describe('PerformerRepository', () => {
  it('creates editable performer profile and song catalog without old runtime state', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [{ id: performerId }] },
      { rows: [] },
      { rows: [{ id: '20000000-0000-4000-8000-000000000001', public_id: 'song-import-test-create' }] },
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [performerRow()] },
    ])
    const result = await new PerformerRepository(transaction).create({
      code: 'NATALIE',
      stageName: 'Natalie',
      profileSnapshot: { bio: 'Soul and pop' },
      songCatalog: [{ code: 'SONG-1', title: '后来', aliases: ['Hou Lai'] }],
    })

    expect(result.songCatalog).toEqual([{ code: 'SONG-1', title: '后来', aliases: ['Hou Lai'] }])
    expect(transaction.calls[0]?.sql).toContain('INSERT INTO mbox.performers')
    expect(transaction.calls[0]?.sql).not.toContain('song_catalog')
    expect(transaction.calls.some((call) => call.sql.includes('INSERT INTO mbox.performer_songs'))).toBe(true)
  })

  it('locks one performer and updates only supplied editable fields', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [performerRow()] },
      { rows: [{ id: performerId }] },
      { rows: [] },
      { rows: [{ id: '20000000-0000-4000-8000-000000000002', public_id: 'song-import-test-update' }] },
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [performerRow({ stage_name: '林小满', song_catalog: [{ title: '月亮代表我的心' }] })] },
    ])
    const result = await new PerformerRepository(transaction).update({
      performerId,
      stageName: '林小满',
      songCatalog: [{ title: '月亮代表我的心' }],
    })

    expect(result.stageName).toBe('林小满')
    expect(transaction.calls[0]?.sql).toContain('FOR UPDATE')
    expect(transaction.calls[1]?.sql).not.toContain('song_catalog')
    expect(transaction.calls.some((call) => call.sql.includes("SET status='inactive'"))).toBe(true)
  })

  it('rejects malformed and duplicate catalog entries before writing', async () => {
    const repository = new PerformerRepository(new ScriptedTransaction([]))
    await expect(repository.create({
      code: 'NATALIE',
      stageName: 'Natalie',
      songCatalog: [{ title: '后来' }, { title: '后来' }],
    })).rejects.toThrow('duplicate')
    await expect(repository.create({
      code: 'NATALIE',
      stageName: 'Natalie',
      songCatalog: [{ title: '' }],
    })).rejects.toThrow('must have a title')
  })
})

function performerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: performerId,
    code: 'NATALIE',
    stage_name: 'Natalie',
    profile_snapshot: { bio: 'Soul and pop' },
    song_catalog: [{ code: 'SONG-1', title: '后来', aliases: ['Hou Lai'] }],
    status: 'active',
    created_at: '2026-08-11T12:00:00.000Z',
    updated_at: '2026-08-11T12:00:00.000Z',
    ...overrides,
  }
}
