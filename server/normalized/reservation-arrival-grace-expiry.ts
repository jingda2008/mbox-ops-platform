import type { ScopedTransaction } from './transaction-runner.js'

export interface ArrivalGraceReservation {
  id: string
  publicId: string
}

export async function expireReservationArrivalGrace(
  transaction: ScopedTransaction,
  reservation: Readonly<ArrivalGraceReservation>,
  actorRef: string,
): Promise<void> {
  const locks = await transaction.query(`
    UPDATE mbox.reservation_table_locks
    SET status = 'released', hold_expires_at = NULL
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND reservation_id = $3::uuid AND status = 'confirmed'
  `, [transaction.scope.tenantId, transaction.scope.storeId, reservation.id])
  const updated = await transaction.query<{ aggregate_version: string | number }>(`
    UPDATE mbox.reservations
    SET status = 'no_show', aggregate_version = aggregate_version + 1
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND id = $3::uuid AND status = 'confirmed'
    RETURNING aggregate_version
  `, [transaction.scope.tenantId, transaction.scope.storeId, reservation.id])
  const aggregateVersion = updated.rows[0]?.aggregate_version
  if (updated.rowCount !== 1 || aggregateVersion === undefined) {
    throw new Error(`Arrival grace reservation could not be marked no-show: ${reservation.id}`)
  }

  const audit = await transaction.query(`
    INSERT INTO mbox.audit_events (
      tenant_id, store_id, actor_type, actor_ref, action,
      object_type, object_id, business_date, metadata
    )
    SELECT $1::uuid, $2::uuid, 'system', $4::text,
      'reservation.arrival_grace_expired', 'reservation', $3::uuid,
      (
        (clock_timestamp() AT TIME ZONE store.timezone)
        - make_interval(secs => extract(epoch FROM store.business_day_cutoff))
      )::date,
      jsonb_build_object('actorRef', $4::text, 'releasedLockCount', $5::integer)
    FROM mbox.stores AS store
    WHERE store.tenant_id = $1::uuid AND store.id = $2::uuid
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    reservation.id,
    actorRef,
    locks.rowCount ?? 0,
  ])
  if (audit.rowCount !== 1) throw new Error(`Arrival grace audit was not recorded: ${reservation.id}`)

  const outbox = await transaction.query(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload
    ) VALUES (
      $1::uuid, $2::uuid, $3, 'reservation', $4::uuid,
      $5::bigint, 'reservation.no_show.v1',
      jsonb_build_object('reservationId', $4::uuid, 'publicId', $6::text, 'actorRef', $7::text)
    )
    ON CONFLICT (tenant_id, store_id, message_key) DO NOTHING
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    `reservation-arrival-grace-expired:${reservation.id}`,
    reservation.id,
    Number(aggregateVersion),
    reservation.publicId,
    actorRef,
  ])
  if (outbox.rowCount !== 1) {
    throw new Error(`Arrival grace outbox message was not recorded: ${reservation.id}`)
  }
}
