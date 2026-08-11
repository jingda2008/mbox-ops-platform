import { describe, expect, it, vi } from 'vitest'
import type { ScopedTransaction } from './transaction-runner.js'
import { TableQrAlreadyProvisionedError, TableQrProvisioner } from './table-qr-provisioner.js'

const scope = {
  tenantId: 'a1000000-0000-4000-8000-000000000001',
  storeId: 'a1000000-0000-4000-8000-000000000002',
}
const employeeId = 'a1000000-0000-4000-8000-000000000003'
const tableId = 'a1000000-0000-4000-8000-000000000004'

describe('TableQrProvisioner', () => {
  it('stores only the HMAC and returns the one-time raw token to the controlled caller', async () => {
    const rawToken = 'T'.repeat(43)
    const queries: Array<{ sql: string; values: readonly unknown[] }> = []
    const transaction = fakeTransaction(queries, false)
    const provisioner = new TableQrProvisioner(fakeRunner(transaction), 's'.repeat(32), () => rawToken)

    const result = await provisioner.provision({
      scope,
      businessDate: '2026-08-11',
      actorEmployeeId: employeeId,
      tableCodes: ['l01'],
      reason: '首次打印固定桌码',
    })

    expect(result).toEqual([expect.objectContaining({ tableCode: 'L01', tableQrToken: rawToken, qrVersion: 1 })])
    const serializedQueries = JSON.stringify(queries)
    expect(serializedQueries).not.toContain(rawToken)
    expect(serializedQueries).toMatch(/[0-9a-f]{64}/)
    expect(serializedQueries).toContain('首次打印固定桌码')
  })

  it('refuses to replace an existing physical code without explicit rotation', async () => {
    const transaction = fakeTransaction([], true)
    const provisioner = new TableQrProvisioner(fakeRunner(transaction), 's'.repeat(32))
    await expect(provisioner.provision({
      scope,
      businessDate: '2026-08-11',
      actorEmployeeId: employeeId,
      tableCodes: ['L01'],
      reason: '重新打印桌码',
    })).rejects.toBeInstanceOf(TableQrAlreadyProvisionedError)
  })

  it('rotates the table version, retires the old credential and audits the change', async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = []
    const transaction = fakeTransaction(queries, true)
    const provisioner = new TableQrProvisioner(fakeRunner(transaction), 's'.repeat(32), () => 'R'.repeat(43))
    const result = await provisioner.provision({
      scope,
      businessDate: '2026-08-11',
      actorEmployeeId: employeeId,
      tableCodes: ['L01'],
      reason: '桌贴损坏后安全换码',
      rotateExisting: true,
    })
    expect(result[0]?.qrVersion).toBe(2)
    expect(queries.some(({ sql }) => sql.includes("status = 'rotated'"))).toBe(true)
    expect(queries.some(({ values }) => values.includes('table_qr.rotated'))).toBe(true)
  })
})

function fakeRunner(transaction: ScopedTransaction) {
  return {
    run: vi.fn(async (_scope, operation) => operation(transaction)),
  }
}

function fakeTransaction(
  queries: Array<{ sql: string; values: readonly unknown[] }>,
  existing: boolean,
): ScopedTransaction {
  return {
    scope,
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values })
      if (sql.includes('SELECT table_record.id')) {
        return {
          rows: [{
            id: tableId,
            code: 'L01',
            display_name: '互动01',
            qr_version: 1,
            active_credential_id: existing ? 'a1000000-0000-4000-8000-000000000005' : null,
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('RETURNING qr_version')) {
        return { rows: [{ qr_version: 2 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }),
  }
}
