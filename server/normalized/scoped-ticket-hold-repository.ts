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
   * Closed-gate acquisition primitive: caller owns the same purchase transaction.
   * A failure must roll back all work; no publishing/payment code calls it yet.
   * Prelinked ordinary reservations require a separate audited conversion path.
   */
  async acquirePending(registrationId: string): Promise<HoldIdentity[]> {
    if (!uuid.test(registrationId)) throw new TypeError('Invalid scoped hold registration')
    const {tenantId,storeId}=this.tx.scope
    const args=[tenantId,storeId,registrationId]
    await lockReservationPolicy(this.tx)
    const purchase=(await this.tx.query<{quantity:number;credit:number}>(`
      SELECT p.quantity,mbox.scoped_pending_ticket_hold_credit(p.tenant_id,p.store_id,p.registration_id) AS credit
      FROM mbox.table_ticket_purchases p
      JOIN mbox.scoped_ticket_offer_membership m
        ON (m.tenant_id,m.store_id,m.offer_id)=(p.tenant_id,p.store_id,p.offer_id)
      JOIN mbox.community_activity_registrations c
        ON (c.tenant_id,c.store_id,c.id)=(p.tenant_id,p.store_id,p.registration_id)
      WHERE (p.tenant_id,p.store_id,p.registration_id)=($1,$2,$3)
        AND p.original_lock_id IS NULL AND p.quantity BETWEEN 1 AND 200
        AND c.status='payment_pending' AND c.seat_hold_expires_at>statement_timestamp()
      FOR UPDATE OF c`, args)).rows[0]
    if(!purchase)throw new Error('Scoped pending hold acquisition not eligible')
    const existing=await this.list(registrationId)
    if(existing.length){
      if(existing.length===purchase.quantity&&purchase.credit===purchase.quantity)return existing
      throw new Error('Scoped pending hold set incomplete or stale')
    }
    const desks=(await this.tx.query<{id:string}>(`
      SELECT d.id FROM mbox.table_ticket_purchases p
      JOIN mbox.scoped_ticket_offer_membership m
        ON (m.tenant_id,m.store_id,m.offer_id)=(p.tenant_id,p.store_id,p.offer_id)
      JOIN mbox.tables d ON (d.tenant_id,d.store_id,d.area_id)=(m.tenant_id,m.store_id,m.area_id) AND d.id=ANY(m.table_ids)
      JOIN mbox.areas a ON (a.tenant_id,a.store_id,a.id)=(d.tenant_id,d.store_id,d.area_id)
      JOIN mbox.ticket_table_roster r ON (r.tenant_id,r.store_id,r.table_id)=(d.tenant_id,d.store_id,d.id)
      WHERE (p.tenant_id,p.store_id,p.registration_id)=($1,$2,$3)
        AND d.status='available' AND a.status='active'
        AND NOT EXISTS (SELECT 1 FROM mbox.reservation_table_locks blocked
          WHERE (blocked.tenant_id,blocked.store_id,blocked.table_id)=(d.tenant_id,d.store_id,d.id)
            AND blocked.status IN('held','confirmed') AND blocked.reserved_during && tstzrange(p.starts_at,p.ends_at,'[)'))
        AND NOT EXISTS (SELECT 1 FROM mbox.table_sessions active
          WHERE (active.tenant_id,active.store_id,active.table_id)=(d.tenant_id,d.store_id,d.id)
            AND active.status IN('open','closing') AND active.opened_at<p.ends_at AND p.starts_at<=statement_timestamp())
      ORDER BY d.id LIMIT $4 FOR SHARE OF d,a`, [...args,purchase.quantity])).rows
    if(desks.length!==purchase.quantity)throw new Error('Scoped pending physical capacity unavailable')
    // The physical lock follows payment; the reservation request deadline cannot pass arrival.
    const deskIds=desks.map(desk=>desk.id)
    const locks=(await this.tx.query<{ordinal:number;reservationLockId:string}>(`
      WITH selection AS (
        SELECT desk,position::int AS ordinal
        FROM unnest($4::uuid[]) WITH ORDINALITY selected(desk,position)
      ), purchase AS (
        SELECT p.starts_at,p.ends_at,c.customer_id,c.seat_hold_expires_at
        FROM mbox.table_ticket_purchases p JOIN mbox.community_activity_registrations c
          ON (c.tenant_id,c.store_id,c.id)=(p.tenant_id,p.store_id,p.registration_id)
        WHERE (p.tenant_id,p.store_id,p.registration_id)=($1,$2,$3)
          AND c.status='payment_pending' AND c.seat_hold_expires_at>statement_timestamp()
      ), created AS (
        INSERT INTO mbox.reservations(tenant_id,store_id,public_id,customer_id,customer_name,contact_token,guest_count,
          arrival_at,expected_end_at,request_hold_expires_at,source,reservation_snapshot)
        SELECT $1,$2,'scoped-ticket-'||$3::uuid::text||'-'||ordinal,customer_id,'桌票预占','scoped-ticket-hold',1,
          starts_at,ends_at,least(starts_at,seat_hold_expires_at),'integration',
          jsonb_build_object('scopedTicketHold',jsonb_build_object('registrationId',$3::uuid,'ordinal',ordinal))
        FROM purchase CROSS JOIN selection RETURNING id,reservation_snapshot
      ), held AS (
        INSERT INTO mbox.reservation_table_locks(tenant_id,store_id,reservation_id,table_id,reserved_during,hold_expires_at)
        SELECT $1,$2,created.id,selection.desk,tstzrange(starts_at,ends_at,'[)'),seat_hold_expires_at
        FROM created JOIN selection ON selection.ordinal=(created.reservation_snapshot#>>'{scopedTicketHold,ordinal}')::int
        CROSS JOIN purchase RETURNING id,table_id
      )
      SELECT ordinal,held.id AS "reservationLockId" FROM selection JOIN held ON held.table_id=selection.desk
      ORDER BY ordinal`, [...args,deskIds])).rows
    if(locks.length!==purchase.quantity)throw new Error('Scoped pending hold window expired')
    await this.tx.query(`
      INSERT INTO mbox.scoped_ticket_hold_identity(tenant_id,store_id,registration_id,ordinal,reservation_lock_id)
      SELECT $1,$2,$3,position::int,id FROM unnest($4::uuid[]) WITH ORDINALITY held(id,position)`,
      [...args,locks.map(lock=>lock.reservationLockId)])
    return locks
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
