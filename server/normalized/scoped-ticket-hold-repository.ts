import type { ScopedTransaction } from './transaction-runner.js'
import { lockReservationPolicy } from './reservation-policy-lock.js'

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
type HoldIdentity = { ordinal: number; reservationLockId: string }

/** Local foundation. No application routes create or use scoped holds yet. */
export class ScopedTicketHoldRepository {
  constructor(private readonly tx: ScopedTransaction) {}

  async list(registrationId: string): Promise<HoldIdentity[]> {
    if (!uuid.test(registrationId)) throw new TypeError('Invalid scoped hold registration')
    const { tenantId, storeId } = this.tx.scope
    return (await this.tx.query<HoldIdentity>(`
      SELECT ordinal,reservation_lock_id AS "reservationLockId"
      FROM mbox.scoped_ticket_hold_identity
      WHERE (tenant_id,store_id,registration_id)=($1,$2,$3)
      ORDER BY ordinal`, [tenantId, storeId, registrationId])).rows
  }

  /**
   * Register a fresh physical lock created by the caller in THIS transaction.
   * Roll back the complete purchase and lock if binding fails. Existing exact
   * bindings can be replayed without extending the hold or changing ownership.
   */
  async bind(registrationId: string, ordinal: number, reservationLockId: string): Promise<void> {
    if (!uuid.test(registrationId) || !uuid.test(reservationLockId)
      || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 2147483647) {
      throw new TypeError('Invalid scoped hold identity')
    }
    const { tenantId, storeId } = this.tx.scope
    await lockReservationPolicy(this.tx)
    const existing = (await this.list(registrationId)).find(row => row.ordinal === ordinal)
    if (existing) {
      if (existing.reservationLockId.toLowerCase() === reservationLockId.toLowerCase()) return
      throw new Error('Scoped hold unit already owns a different physical lock')
    }
    await this.tx.query(`
      INSERT INTO mbox.scoped_ticket_hold_identity(tenant_id,store_id,registration_id,ordinal,reservation_lock_id)
      VALUES ($1,$2,$3,$4,$5)`, [tenantId, storeId, registrationId, ordinal, reservationLockId])
  }
}
