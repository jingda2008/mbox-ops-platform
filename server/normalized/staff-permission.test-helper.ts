import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/** Synthetic fixture grants for tests that call staff services directly, bypassing HTTP setup. */
export async function grantFixtureStaffPermissions(
  pool: Pool, scope: { tenantId: string; storeId: string }, employeeIds: readonly string[], codes: readonly string[],
): Promise<void> {
  const roleId = randomUUID()
  await pool.query('INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1::uuid,$2,$3,$4,\'Local service test\')', [roleId, scope.tenantId, scope.storeId, 'AUDIT_'+roleId.replaceAll('-', '').slice(0,24).toUpperCase()])
  for (const code of codes) await pool.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING', [scope.tenantId, scope.storeId, code])
  await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4::text[])', [scope.tenantId, scope.storeId, roleId, codes])
  for (const employeeId of employeeIds) await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')", [scope.tenantId, scope.storeId, employeeId, roleId])
}

/** Hold completed receipts to deterministically revoke authority while a retry waits. */
export async function holdFixtureReceipts(pool: Pool, tenantId: string) {
  const client = await pool.connect()
  await client.query('BEGIN')
  await client.query('SELECT id FROM mbox.idempotency_records WHERE tenant_id=$1 FOR UPDATE', [tenantId])
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
  return {
    async waitUntilBlocked() {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if ((await pool.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows.length) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('Receipt retry did not wait on the held database lock')
    },
    async release() { try { await client.query('ROLLBACK') } finally { client.release() } },
  }
}
