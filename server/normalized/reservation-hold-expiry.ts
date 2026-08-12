import type { ScopedTransaction } from './transaction-runner.js'

export interface ExpirableReservation {
  id: string
  publicId: string
}

export async function expireReservationHold(
  transaction: ScopedTransaction,
  reservation: Readonly<ExpirableReservation>,
  actorRef: string,
): Promise<void> {
  const locks = await transaction.query(`
    UPDATE mbox.reservation_table_locks
    SET status = 'expired', hold_expires_at = NULL
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND reservation_id = $3::uuid AND status = 'held'
  `, [transaction.scope.tenantId, transaction.scope.storeId, reservation.id])
  if ((locks.rowCount ?? 0) < 1) {
    throw new Error(`Expired reservation had no held table lock: ${reservation.id}`)
  }

  const updated = await transaction.query(`
    UPDATE mbox.reservations
    SET status = 'cancelled'
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND id = $3::uuid AND status = 'pending'
  `, [transaction.scope.tenantId, transaction.scope.storeId, reservation.id])
  if (updated.rowCount !== 1) {
    throw new Error(`Expired reservation could not be cancelled: ${reservation.id}`)
  }

  const audit = await transaction.query(`
    INSERT INTO mbox.audit_events (
      tenant_id, store_id, actor_type, actor_ref, action,
      object_type, object_id, business_date, metadata
    )
    SELECT $1::uuid, $2::uuid, 'system', $4,
      'reservation.hold_expired', 'reservation', $3,
      (
        (clock_timestamp() AT TIME ZONE store.timezone)
        - make_interval(secs => extract(epoch FROM store.business_day_cutoff))
      )::date,
      jsonb_build_object('actorRef', $4, 'expiredLockCount', $5::integer)
    FROM mbox.stores AS store
    WHERE store.tenant_id = $1::uuid AND store.id = $2::uuid
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    reservation.id,
    actorRef,
    locks.rowCount ?? 0,
  ])
  if (audit.rowCount !== 1) throw new Error(`Reservation expiry audit was not recorded: ${reservation.id}`)

  const outbox = await transaction.query(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload
    ) VALUES (
      $1::uuid, $2::uuid, $3, 'reservation', $4::uuid,
      2, 'reservation.hold_expired.v1',
      jsonb_build_object('reservationId', $4::uuid, 'publicId', $5, 'actorRef', $6)
    )
    ON CONFLICT (tenant_id, store_id, message_key) DO NOTHING
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    `reservation-hold-expired:${reservation.id}`,
    reservation.id,
    reservation.publicId,
    actorRef,
  ])
  if (outbox.rowCount !== 1) {
    throw new Error(`Reservation expiry outbox message was not recorded: ${reservation.id}`)
  }
}
