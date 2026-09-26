import { MemberVisitRewardRepository } from './member-visit-reward-repository.js'
import type { MemberVisit } from '../../src/shared/member-visit.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { resolveMemberScanCustomer } from './member-participation-query.js'

export class MemberVisitError extends Error {
  constructor(message: string, readonly code = 'MEMBER_VISIT_CONFLICT', readonly statusCode = 409) { super(message) }
}
type VisitRow = { id: string; business_date: string; checked_in_at: string; employee_name: string; cancelled_at: string | null }
const selectVisit = `SELECT v.id,v.business_date::text,v.checked_in_at::text,v.cancelled_at::text,e.display_name AS employee_name
  FROM mbox.member_visit_checkins v JOIN mbox.employees e
  ON e.tenant_id=v.tenant_id AND e.store_id=v.store_id AND e.id=v.checked_in_by_employee_id`
const family = `WITH RECURSIVE family AS (
  SELECT id FROM mbox.customers WHERE tenant_id=$1 AND store_id=$2 AND id=$3
  UNION ALL SELECT c.id FROM mbox.customers c JOIN family f ON c.merged_into_customer_id=f.id
    WHERE c.tenant_id=$1 AND c.store_id=$2
) SELECT id FROM family`

export class MemberVisitRepository {
  constructor(private readonly tx: ScopedTransaction) {}
  async current(memberNo: string, businessDate: string): Promise<MemberVisit | null> {
    const customer = await resolveMemberScanCustomer(this.tx, memberNo)
    return this.currentForCustomer(customer.id, businessDate)
  }
  private async currentForCustomer(customerId: string, businessDate: string): Promise<MemberVisit | null> {
    const row = (await this.tx.query<VisitRow>(`${selectVisit}
      WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.customer_id IN (${family})
        AND v.business_date=$4::date AND v.cancelled_at IS NULL
      ORDER BY v.checked_in_at DESC,v.id LIMIT 1`, [this.tx.scope.tenantId, this.tx.scope.storeId, customerId, businessDate])).rows[0]
    return row ? view(row) : null
  }
  private async lockCustomer(memberNo: string) {
    const customer = await resolveMemberScanCustomer(this.tx, memberNo)
    await new MemberVisitRewardRepository(this.tx).lockCustomer(customer.id)
    const locked = await this.tx.query<{ status: string }>(`SELECT status FROM mbox.customers
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`, [this.tx.scope.tenantId, this.tx.scope.storeId, customer.id])
    if (locked.rows[0]?.status !== 'active') throw new MemberVisitError('会员状态已变化，请重新扫码')
    return customer.id
  }
  async checkIn(memberNo: string, businessDate: string, employeeId: string) {
    const customerId = await this.lockCustomer(memberNo)
    const existing = await this.currentForCustomer(customerId, businessDate)
    if (existing) { await new MemberVisitRewardRepository(this.tx).sync(customerId); return { visit: existing, changed: false } }
    const inserted = await this.tx.query<{ id: string }>(`INSERT INTO mbox.member_visit_checkins
      (tenant_id,store_id,customer_id,business_date,checked_in_by_employee_id)
      VALUES($1,$2,$3,$4::date,$5) RETURNING id`, [this.tx.scope.tenantId, this.tx.scope.storeId, customerId, businessDate, employeeId])
    await new MemberVisitRewardRepository(this.tx).sync(customerId)
    return { visit: await this.byId(inserted.rows[0]!.id), changed: true }
  }
  async cancel(memberNo: string, businessDate: string, visitId: string, employeeId: string, reason: string) {
    const customerId = await this.lockCustomer(memberNo)
    const row = (await this.tx.query<VisitRow>(`${selectVisit}
      WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.customer_id IN (${family})
        AND v.id=$4 AND v.business_date=$5::date FOR UPDATE OF v`, [this.tx.scope.tenantId, this.tx.scope.storeId, customerId, visitId, businessDate])).rows[0]
    if (!row) throw new MemberVisitError('未找到本会员本营业日的签到记录', 'MEMBER_VISIT_NOT_FOUND', 404)
    if (row.cancelled_at) return { visit: view(row), changed: false }
    await this.tx.query(`UPDATE mbox.member_visit_checkins SET cancelled_at=clock_timestamp(),cancelled_by_employee_id=$4,cancel_reason=$5
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [this.tx.scope.tenantId, this.tx.scope.storeId, visitId, employeeId, reason])
    await new MemberVisitRewardRepository(this.tx).sync(customerId)
    return { visit: await this.byId(visitId), changed: true }
  }
  private async byId(id: string) {
    const row = (await this.tx.query<VisitRow>(`${selectVisit} WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.id=$3`, [this.tx.scope.tenantId, this.tx.scope.storeId, id])).rows[0]!
    return view(row)
  }
}
function view(row: VisitRow): MemberVisit {
  return { id: row.id, businessDate: row.business_date, checkedInAt: row.checked_in_at, employeeName: row.employee_name,
    status: row.cancelled_at ? 'cancelled' : 'checked_in' }
}
