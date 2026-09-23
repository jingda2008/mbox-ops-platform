import type { ScopedTransaction } from './transaction-runner.js'

/** Acquire before reading or changing staff authority, including legacy writers. */
export async function lockStaffAccessConfiguration(transaction: ScopedTransaction): Promise<void> {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended('staff-access:' || $1::text || ':' || $2::text, 0))",
    [transaction.scope.tenantId, transaction.scope.storeId])
}

export class StaffAccessVersionConflictError extends Error {
  constructor() { super('权限配置已发生变化，请重新读取并核对修改'); this.name = 'StaffAccessVersionConflictError' }
}
