import { describe, expect, it } from 'vitest'
import type { PostgresQueryResult, ScopedTransaction } from './transaction-runner.js'
import {
  AssistedOrderContextDeniedError,
  AssistedOrderContextRepository,
  hashAssistedOrderContextToken,
} from './assisted-order-context.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const staffSessionId = '44444444-4444-4444-8444-444444444444'
const deviceAccessLeaseId = '55555555-5555-4555-8555-555555555555'
const tableSessionId = '66666666-6666-4666-8666-666666666666'
const tableId = '77777777-7777-4777-8777-777777777777'
const contextId = '88888888-8888-4888-8888-888888888888'

describe('AssistedOrderContextRepository', () => {
  it('issues a short-lived opaque token but persists only its SHA-256 hash', async () => {
    const transaction = scriptedTransaction()
    const issued = await new AssistedOrderContextRepository(transaction).issue({
      employeeId,
      staffSessionId,
      deviceAccessLeaseId,
      tableSessionId,
    })

    expect(issued).toMatchObject({
      id: contextId, employeeId, staffSessionId, deviceAccessLeaseId,
      tableSessionId, tableId, tableCode: 'VIP1',
    })
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
    const insert = transaction.calls.find((call) => call.sql.includes('INSERT INTO mbox.assisted_order_contexts'))!
    expect(insert.values).not.toContain(issued.token)
    expect(insert.values).toContain(hashAssistedOrderContextToken(issued.token))
    expect(insert.sql).toContain("session.status = 'open'")
  })

  it('binds submit proof to employee, current staff session, device lease and open table', async () => {
    const token = 'B'.repeat(43)
    const transaction = scriptedTransaction()
    const context = await new AssistedOrderContextRepository(transaction).requireForSubmit({
      token,
      employeeId,
      staffSessionId,
      deviceAccessLeaseId,
    })

    expect(context).toMatchObject({ id: contextId, tableSessionId, tableCode: 'VIP1' })
    const consume = transaction.calls.find((call) => call.sql.startsWith('UPDATE mbox.assisted_order_contexts'))!
    expect(consume.sql).toContain('context.expires_at > clock_timestamp()')
    expect(consume.sql).toContain('staff_session.online_lease_until > clock_timestamp()')
    expect(consume.sql).toContain("table_session.status = 'open'")
    expect(consume.values).toEqual([
      tenantId, storeId, hashAssistedOrderContextToken(token), employeeId,
      staffSessionId, deviceAccessLeaseId,
    ])
  })

  it('fails closed when the proof is expired, revoked or bound to another device', async () => {
    const transaction = scriptedTransaction({ denyContext: true })
    await expect(new AssistedOrderContextRepository(transaction).requireForSubmit({
      token: 'C'.repeat(43), employeeId, staffSessionId, deviceAccessLeaseId,
    })).rejects.toBeInstanceOf(AssistedOrderContextDeniedError)
    expect(transaction.calls).toHaveLength(1)
  })
})

function scriptedTransaction(input: {
  denyContext?: boolean
} = {}): ScopedTransaction & { calls: Array<{ sql: string; values: readonly unknown[] }> } {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  return {
    scope: { tenantId, storeId },
    calls,
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<PostgresQueryResult<Row>> => {
      const sql = text.replace(/\s+/g, ' ').trim()
      calls.push({ sql, values: [...values] })
      if (sql.startsWith('UPDATE mbox.assisted_order_contexts')) {
        return result(input.denyContext ? [] : [contextRow()]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.employees') && sql.includes('employee_code')) {
        return result([{ id: employeeId, employee_code: 'LIYAN', display_name: '李艳', status: 'active' }]) as PostgresQueryResult<Row>
      }
      if (sql.startsWith('SELECT DISTINCT r.code, r.name')) {
        return result([{ code: 'SERVICE', name: '服务员' }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('role_granted')) {
        return result([{ code: 'order.create', role_granted: true, override_granted: false, override_denied: false }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.role_data_scopes')
        || sql.includes('FROM mbox.role_approval_limits')
        || sql.includes('FROM mbox.role_navigation_items')) {
        return result([]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.table_sessions AS table_session')
        && sql.includes('table_allowed')) {
        return result([{ table_allowed: true }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('INSERT INTO mbox.assisted_order_contexts')) {
        expect(values[2]).toMatch(/^[0-9a-f]{64}$/)
        return result([contextRow()]) as PostgresQueryResult<Row>
      }
      throw new Error(`Unexpected query: ${sql}`)
    },
  }
}

function contextRow() {
  return {
    id: contextId,
    employee_id: employeeId,
    staff_session_id: staffSessionId,
    device_access_lease_id: deviceAccessLeaseId,
    table_session_id: tableSessionId,
    table_id: tableId,
    table_code: 'VIP1',
    expires_at: '2026-08-11T12:15:00.000Z',
  }
}

function result(values: Record<string, unknown>[]): PostgresQueryResult {
  return { rows: values, rowCount: values.length }
}
