import { describe, expect, it } from 'vitest'
import {
  assertEmployeeTableSessionAccess,
  assertEmployeeTableSessionReadAccess,
} from './employee-table-access.js'
import type { PostgresQueryResult, ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
}
const employeeId = '33333333-3333-4333-8333-333333333333'
const tableSessionId = '44444444-4444-4444-8444-444444444444'

function authorizedTransaction(queries: string[]): ScopedTransaction {
  return {
    scope,
    query: async <Row extends Record<string, unknown>>(sql: string): Promise<PostgresQueryResult<Row>> => {
      queries.push(sql)
      return {
        rows: [{
          employee_status: 'active', session_status: 'open', allowed: true, permissions_allowed: true,
        } as Row],
        rowCount: 1,
      }
    },
  }
}

describe('employee table-session access guards', () => {
  it('uses no row lock for a read-only table view', async () => {
    const queries: string[] = []

    await assertEmployeeTableSessionReadAccess(authorizedTransaction(queries), {
      employeeId,
      tableSessionId,
      includeTableViewAll: false,
    })

    expect(queries).toHaveLength(1)
    expect(queries[0]).not.toMatch(/\bFOR\s+(?:KEY\s+)?(?:SHARE|UPDATE)\b/)
  })

  it('keeps employee/session locks for a table command', async () => {
    const queries: string[] = []

    await assertEmployeeTableSessionAccess(authorizedTransaction(queries), {
      employeeId,
      tableSessionId,
      lockTableSession: true,
    })

    expect(queries[0]).toContain('FOR SHARE OF employee FOR UPDATE OF session')
  })
})
