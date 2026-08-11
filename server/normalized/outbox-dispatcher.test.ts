import { describe, expect, it } from 'vitest'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'
import { OutboxDispatcher } from './outbox-dispatcher.js'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
}

interface Response { rows: Record<string, unknown>[]; rowCount: number }

class ScriptedTransactions {
  calls: Array<{ sql: string; values: readonly unknown[] }> = []
  constructor(private readonly responses: Response[]) {}

  async run<Result>(
    currentScope: Readonly<StoreScope>,
    operation: (transaction: ScopedTransaction) => Promise<Result>,
  ): Promise<Result> {
    const transaction: ScopedTransaction = {
      scope: currentScope,
      query: async <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
        this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
        const response = this.responses.shift()
        if (!response) throw new Error(`Unexpected query: ${sql}`)
        return response as { rows: Row[]; rowCount: number }
      },
    }
    return operation(transaction)
  }
}

describe('OutboxDispatcher', () => {
  it('claims at most 50 messages with SKIP LOCKED and marks successful delivery', async () => {
    const transactions = new ScriptedTransactions([
      response([messageRow('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')]),
      response([], 1),
    ])
    const delivered: string[] = []
    const result = await new OutboxDispatcher(transactions).runBatch(
      scope,
      'worker-one',
      async (message) => { delivered.push(message.id) },
      { limit: 50 },
    )

    expect(result).toEqual({
      claimed: 1,
      delivered: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      failed: [],
    })
    expect(delivered).toEqual(result.delivered)
    expect(transactions.calls[0]?.sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(transactions.calls[0]?.sql).toContain('LIMIT $4')
    expect(transactions.calls[1]?.sql).toContain('delivered_at = clock_timestamp()')
  })

  it('releases a failed message for retry without persisting the exception message', async () => {
    const transactions = new ScriptedTransactions([
      response([messageRow('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')]),
      response([], 1),
    ])
    const result = await new OutboxDispatcher(transactions).runBatch(
      scope,
      'worker-two',
      async () => { throw new TypeError('secret token must never enter logs') },
    )

    expect(result).toEqual({
      claimed: 1,
      delivered: [],
      failed: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    })
    expect(transactions.calls[1]?.values[5]).toBe('delivery_failed:TypeError')
    expect(String(transactions.calls[1]?.values[5])).not.toContain('secret')
    expect(transactions.calls[1]?.sql).toContain('available_at = clock_timestamp()')
  })

  it('rejects unsafe batch sizes before touching the database', async () => {
    const transactions = new ScriptedTransactions([])
    await expect(new OutboxDispatcher(transactions).runBatch(
      scope, 'worker-three', async () => undefined, { limit: 51 },
    )).rejects.toThrow('limit must be an integer between 1 and 50')
    expect(transactions.calls).toHaveLength(0)
  })
})

function response(rows: Record<string, unknown>[], rowCount = rows.length): Response {
  return { rows, rowCount }
}

function messageRow(id: string): Record<string, unknown> {
  return {
    id,
    message_key: `message-${id}`,
    aggregate_type: 'service_task',
    aggregate_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    aggregate_version: '1',
    message_type: 'service.completed.v1',
    payload: { serviceTaskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    headers: {},
    attempts: 1,
    occurred_at: '2026-08-11T12:00:00.000Z',
  }
}
