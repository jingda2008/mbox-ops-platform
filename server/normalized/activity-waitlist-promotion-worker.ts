import { createHash } from 'node:crypto'
import { NotificationRepository } from './notification-repository.js'
import { PaymentRepository } from './payment-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

interface ReleaseEventRow extends Record<string, unknown> {
  id: string
  activity_id: string
}

interface ActivityRow extends Record<string, unknown> {
  id: string
  public_id: string
  title: string
  status: 'published' | 'full' | 'draft' | 'cancelled' | 'completed'
  starts_at: string
  ends_at: string
  capacity: number
  payment_deadline_minutes: number
  payment_authorized: boolean
}

interface WaitlistedRow extends Record<string, unknown> {
  id: string
  public_id: string
  customer_id: string
  registration_cycle: number
  party_size: number
  requested_payment_choice: 'none' | 'deposit' | 'full'
  requested_payment_method: 'jsapi' | 'native_qr' | null
  requested_amount_due_minor: string | number
  currency: string
  activity_package_id: string | null
  activity_package_snapshot: Record<string, unknown>
}

export interface ActivityWaitlistPromotionBatch {
  workerId: string
  claimed: number
  promotedRegistrationIds: readonly string[]
  deferredEventIds: readonly string[]
  completedEventIds: readonly string[]
}

export class ActivityWaitlistPromotionWorker {
  constructor(
    private readonly transactions: ScopedPostgresTransactionRunner,
    private readonly paymentProviderConfigured: boolean,
  ) {}

  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 25,
  ): Promise<ActivityWaitlistPromotionBatch> {
    validateWorkerId(workerId)
    validateBatchSize(batchSize)
    return this.transactions.run(scope, async (transaction) => {
      const events = await claimReleaseEvents(transaction, batchSize)
      const promotedRegistrationIds: string[] = []
      const deferredEventIds: string[] = []
      const completedEventIds: string[] = []
      for (const event of events) {
        const result = await this.processEvent(transaction, event, workerId)
        promotedRegistrationIds.push(...result.promotedRegistrationIds)
        if (result.deferred) deferredEventIds.push(event.id)
        else completedEventIds.push(event.id)
      }
      return {
        workerId,
        claimed: events.length,
        promotedRegistrationIds,
        deferredEventIds,
        completedEventIds,
      }
    })
  }

  private async processEvent(
    transaction: ScopedTransaction,
    event: ReleaseEventRow,
    workerId: string,
  ): Promise<{ promotedRegistrationIds: string[]; deferred: boolean }> {
    const activity = await lockActivity(transaction, event.activity_id)
    if (activity === null || !['published','full'].includes(activity.status)
      || Date.parse(activity.starts_at) <= Date.now()) {
      await completeEvent(transaction, event.id, 'activity_unavailable', workerId)
      return { promotedRegistrationIds: [], deferred: false }
    }

    const promotedRegistrationIds: string[] = []
    const skippedRegistrationIds: string[] = []
    while (true) {
      const occupiedSeats = await occupied(transaction, activity.id)
      const availableSeats = Math.max(0, activity.capacity - occupiedSeats)
      const next = await firstWaitlisted(transaction, activity.id, skippedRegistrationIds)
      if (next === null) {
        await setActivityCapacityStatus(transaction, activity.id, availableSeats, false)
        await completeEvent(
          transaction,
          event.id,
          skippedRegistrationIds.length === 0 ? 'waitlist_empty' : 'package_unavailable',
          workerId,
        )
        return { promotedRegistrationIds, deferred: false }
      }
      if (availableSeats < next.party_size) {
        await setActivityCapacityStatus(transaction, activity.id, availableSeats, true)
        await completeEvent(transaction, event.id, 'head_party_does_not_fit', workerId)
        return { promotedRegistrationIds, deferred: false }
      }
      const paymentRequired = next.requested_payment_choice !== 'none'
      if (paymentRequired && (!this.paymentProviderConfigured || !activity.payment_authorized)) {
        await deferEvent(transaction, event.id, workerId)
        return { promotedRegistrationIds, deferred: true }
      }
      const amountDueMinor = minor(next.requested_amount_due_minor, 'requested activity amount')
      if ((paymentRequired && (amountDueMinor <= 0 || next.requested_payment_method === null))
        || (!paymentRequired && (amountDueMinor !== 0 || next.requested_payment_method !== null))) {
        throw new Error('waitlisted activity payment intent is internally inconsistent')
      }
      const promoted = await promoteRegistration(
        transaction,
        next,
        paymentDeadlineMinutes(next, activity.payment_deadline_minutes),
      )
      if (!promoted) continue
      const stockHeld = await reservePromotedPackageInventory(transaction, {
        registration: next,
        expiresAt: promoted.payment_due_at ?? activity.ends_at,
      })
      if (!stockHeld) {
        await returnPromotionToWaitlist(transaction, next)
        skippedRegistrationIds.push(next.id)
        continue
      }
      const payment = paymentRequired
        ? await new PaymentRepository(transaction).createForActivityRegistration({
          activityRegistrationId: next.id,
          publicId: deterministicPublicId('activity-waitlist-payment', next.id, next.registration_cycle),
          method: requiredPaymentMethod(next.requested_payment_method),
          amountMinor: amountDueMinor,
          currency: next.currency,
        })
        : null
      const notification = await new NotificationRepository(transaction).create({
        businessKey: `activity-waitlist-promotion:${next.id}:${next.registration_cycle}`,
        channel: 'in_app',
        recipient: { type: 'customer', id: next.customer_id },
        templateCode: paymentRequired
          ? 'community.activity.waitlist_payment_ready'
          : 'community.activity.waitlist_confirmed',
        payload: {
          activityPublicId: activity.public_id,
          activityTitle: activity.title,
          registrationPublicId: next.public_id,
          paymentRequired,
          paymentDueAt: promoted.payment_due_at,
        },
      })
      await recordPromotion(transaction, {
        eventId: event.id,
        activityId: activity.id,
        registration: next,
        paymentId: payment?.id ?? null,
        notificationId: notification.id,
        status: paymentRequired ? 'payment_pending' : 'confirmed',
        workerId,
      })
      promotedRegistrationIds.push(next.id)
    }
  }
}

async function claimReleaseEvents(
  transaction: ScopedTransaction,
  batchSize: number,
): Promise<ReleaseEventRow[]> {
  const result = await transaction.query<ReleaseEventRow>(`
    SELECT event.id,event.activity_id
    FROM mbox.activity_waitlist_release_events event
    WHERE event.tenant_id=$1::uuid AND event.store_id=$2::uuid
      AND event.processed_at IS NULL AND event.next_attempt_at<=clock_timestamp()
    ORDER BY event.created_at,event.id
    FOR UPDATE OF event SKIP LOCKED
    LIMIT $3
  `, [transaction.scope.tenantId,transaction.scope.storeId,batchSize])
  return result.rows
}

async function lockActivity(transaction: ScopedTransaction, activityId: string): Promise<ActivityRow | null> {
  const result = await transaction.query<ActivityRow>(`
    SELECT activity.id,activity.public_id,activity.title,activity.status,
      activity.starts_at::text,activity.ends_at::text,activity.capacity,activity.payment_deadline_minutes,
      COALESCE(policy.online_payment_enabled,false)
        AND EXISTS (
          SELECT 1 FROM mbox.customer_experience_features feature
          WHERE feature.tenant_id=activity.tenant_id AND feature.store_id=activity.store_id
            AND feature.feature_code='community.activity.payment'
            AND feature.rollout_state IN ('pilot','enabled')
            AND (feature.effective_from IS NULL OR feature.effective_from<=clock_timestamp())
            AND (feature.effective_until IS NULL OR feature.effective_until>clock_timestamp())
        ) AS payment_authorized
    FROM mbox.community_activities activity
    LEFT JOIN mbox.store_commerce_policies policy
      ON policy.tenant_id=activity.tenant_id AND policy.store_id=activity.store_id
    WHERE activity.tenant_id=$1::uuid AND activity.store_id=$2::uuid
      AND activity.id=$3::uuid
    FOR UPDATE OF activity
  `, [transaction.scope.tenantId,transaction.scope.storeId,activityId])
  return result.rows[0] ?? null
}

async function occupied(transaction: ScopedTransaction, activityId: string): Promise<number> {
  const result = await transaction.query<{ seats: string | number }>(`
    SELECT COALESCE(sum(party_size),0)::bigint AS seats
    FROM mbox.community_activity_registrations
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND activity_id=$3::uuid
      AND status IN ('reserved','payment_pending','confirmed','checked_in')
  `, [transaction.scope.tenantId,transaction.scope.storeId,activityId])
  return minor(result.rows[0]?.seats ?? 0, 'occupied activity seats')
}

async function firstWaitlisted(
  transaction: ScopedTransaction,
  activityId: string,
  excludedRegistrationIds: readonly string[],
): Promise<WaitlistedRow | null> {
  const result = await transaction.query<WaitlistedRow>(`
    SELECT registration.id,registration.public_id,registration.customer_id,registration.registration_cycle,
      registration.party_size,registration.requested_payment_choice,registration.requested_payment_method,
      registration.requested_amount_due_minor,registration.currency,registration.activity_package_id,
      registration.activity_package_snapshot
    FROM mbox.community_activity_registrations registration
    WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
      AND registration.activity_id=$3::uuid AND registration.status='waitlisted'
      AND NOT (registration.id=ANY($4::uuid[]))
      AND (
        registration.activity_package_id IS NULL OR EXISTS (
          SELECT 1 FROM mbox.community_activity_packages package
          WHERE package.tenant_id=registration.tenant_id AND package.store_id=registration.store_id
            AND package.id=registration.activity_package_id AND package.status='published'
            AND (package.available_from IS NULL OR package.available_from<=clock_timestamp())
            AND (package.available_until IS NULL OR package.available_until>clock_timestamp())
            AND COALESCE((
              SELECT sum(active_registration.party_size)
              FROM mbox.community_activity_registrations active_registration
              WHERE active_registration.tenant_id=package.tenant_id AND active_registration.store_id=package.store_id
                AND active_registration.activity_package_id=package.id
                AND active_registration.status IN ('reserved','payment_pending','confirmed','checked_in')
            ),0)+registration.party_size<=package.capacity
        )
      )
    ORDER BY registration.registered_at,registration.id
    FOR UPDATE OF registration SKIP LOCKED
    LIMIT 1
  `, [transaction.scope.tenantId,transaction.scope.storeId,activityId,[...excludedRegistrationIds]])
  return result.rows[0] ?? null
}

async function promoteRegistration(
  transaction: ScopedTransaction,
  registration: WaitlistedRow,
  paymentDeadlineMinutes: number,
): Promise<{ payment_due_at: string | null } | null> {
  const paymentRequired = registration.requested_payment_choice !== 'none'
  const result = await transaction.query<{ payment_due_at: string | null }>(`
    UPDATE mbox.community_activity_registrations
    SET status=CASE WHEN $5::boolean THEN 'payment_pending' ELSE 'confirmed' END,
      payment_choice=requested_payment_choice,
      payment_status=CASE WHEN $5::boolean THEN 'pending' ELSE 'not_required' END,
      amount_due_minor=CASE WHEN $5::boolean THEN requested_amount_due_minor ELSE 0 END,
      payment_due_at=CASE WHEN $5::boolean
        THEN clock_timestamp()+make_interval(mins=>$6) ELSE NULL END,
      seat_hold_expires_at=CASE WHEN $5::boolean
        THEN clock_timestamp()+make_interval(mins=>$6) ELSE NULL END,
      updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND registration_cycle=$4 AND status='waitlisted' AND payment_id IS NULL
    RETURNING payment_due_at::text
  `, [
    transaction.scope.tenantId,transaction.scope.storeId,registration.id,
    registration.registration_cycle,paymentRequired,paymentDeadlineMinutes,
  ])
  return result.rows[0] ?? null
}

function paymentDeadlineMinutes(registration: WaitlistedRow, fallback: number): number {
  const value = registration.activity_package_snapshot.paymentDeadlineMinutes
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed >= 5 && parsed <= 1_440 ? parsed : fallback
}

/**
 * The worker makes a real inventory hold before it emits a promotion payment
 * object.  No table order is created.  A failed package hold simply leaves
 * that candidate on the waitlist and permits a later, independently sellable
 * package to be considered in the same release event.
 */
async function reservePromotedPackageInventory(
  transaction: ScopedTransaction,
  input: Readonly<{ registration: WaitlistedRow; expiresAt: string }>,
): Promise<boolean> {
  if (input.registration.activity_package_id === null) return true
  const components = await transaction.query<{
    id: string
    inventory_item_id: string
    item_status: string
    required_quantity: string
  }>(`
    SELECT component.id,component.inventory_item_id,item.status AS item_status,
      (component.quantity*CASE WHEN component.per_participant THEN $4::numeric ELSE 1::numeric END)::text
        AS required_quantity
    FROM mbox.community_activity_package_components component
    JOIN mbox.inventory_items item
      ON item.tenant_id=component.tenant_id AND item.store_id=component.store_id
     AND item.id=component.inventory_item_id
    WHERE component.tenant_id=$1::uuid AND component.store_id=$2::uuid
      AND component.activity_package_id=$3::uuid
    ORDER BY component.inventory_item_id,component.id
    FOR KEY SHARE OF component,item
  `, [
    transaction.scope.tenantId,transaction.scope.storeId,
    input.registration.activity_package_id,input.registration.party_size,
  ])
  if (components.rows.some((component) => component.item_status !== 'active')) return false
  for (const component of components.rows) {
    await transaction.query(`
      INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id)
      VALUES($1::uuid,$2::uuid,$3::uuid)
      ON CONFLICT(tenant_id,store_id,inventory_item_id) DO NOTHING
    `, [transaction.scope.tenantId,transaction.scope.storeId,component.inventory_item_id])
  }
  const balances = await transaction.query<{
    inventory_item_id: string
    on_hand_quantity: string
    reserved_quantity: string
  }>(`
    SELECT balance.inventory_item_id,balance.on_hand_quantity::text,balance.reserved_quantity::text
    FROM mbox.inventory_balances balance
    WHERE balance.tenant_id=$1::uuid AND balance.store_id=$2::uuid
      AND balance.inventory_item_id=ANY($3::uuid[])
    ORDER BY balance.inventory_item_id
    FOR UPDATE
  `, [
    transaction.scope.tenantId,transaction.scope.storeId,
    components.rows.map((component) => component.inventory_item_id),
  ])
  const balanceByItem = new Map(balances.rows.map((balance) => [balance.inventory_item_id, balance]))
  for (const component of components.rows) {
    const balance = balanceByItem.get(component.inventory_item_id)
    if (balance === undefined || Number(balance.on_hand_quantity) - Number(balance.reserved_quantity) < Number(component.required_quantity)) {
      return false
    }
  }
  for (const component of components.rows) {
    const held = await transaction.query(`
      UPDATE mbox.inventory_balances
      SET reserved_quantity=reserved_quantity+$4::numeric,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid
        AND on_hand_quantity-reserved_quantity>=$4::numeric
    `, [
      transaction.scope.tenantId,transaction.scope.storeId,
      component.inventory_item_id,component.required_quantity,
    ])
    if (held.rowCount !== 1) throw new Error('locked activity package inventory balance changed unexpectedly')
    await transaction.query(`
      INSERT INTO mbox.community_activity_package_inventory_reservations(
        tenant_id,store_id,registration_id,registration_cycle,package_component_id,
        inventory_item_id,quantity,status,expires_at
      ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::numeric,'reserved',$8::timestamptz)
    `, [
      transaction.scope.tenantId,transaction.scope.storeId,input.registration.id,
      input.registration.registration_cycle,component.id,component.inventory_item_id,
      component.required_quantity,input.expiresAt,
    ])
  }
  return true
}

async function returnPromotionToWaitlist(
  transaction: ScopedTransaction,
  registration: WaitlistedRow,
): Promise<void> {
  const restored = await transaction.query(`
    UPDATE mbox.community_activity_registrations
    SET status='waitlisted',payment_choice='none',payment_status='not_required',
      amount_due_minor=0,payment_due_at=NULL,seat_hold_expires_at=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND registration_cycle=$4 AND status IN ('confirmed','payment_pending') AND payment_id IS NULL
  `, [
    transaction.scope.tenantId,transaction.scope.storeId,
    registration.id,registration.registration_cycle,
  ])
  if (restored.rowCount !== 1) throw new Error('unable to restore activity package waitlist candidate')
}

async function recordPromotion(transaction: ScopedTransaction, input: Readonly<{
  eventId: string
  activityId: string
  registration: WaitlistedRow
  paymentId: string | null
  notificationId: string
  status: 'confirmed' | 'payment_pending'
  workerId: string
}>): Promise<void> {
  const inserted = await transaction.query<{ id: string }>(`
    INSERT INTO mbox.activity_waitlist_promotions(
      tenant_id,store_id,release_event_id,activity_id,registration_id,
      registration_cycle,party_size,promotion_status,payment_id,notification_id,
      promoted_by_worker_id
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9::uuid,$10::uuid,$11
    )
    ON CONFLICT (tenant_id,store_id,registration_id,registration_cycle) DO NOTHING
    RETURNING id
  `, [
    transaction.scope.tenantId,transaction.scope.storeId,input.eventId,input.activityId,
    input.registration.id,input.registration.registration_cycle,input.registration.party_size,
    input.status,input.paymentId,input.notificationId,input.workerId,
  ])
  if (inserted.rowCount !== 1) throw new Error('activity waitlist promotion evidence already exists')
  await transaction.query(`
    INSERT INTO mbox.audit_events(
      tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,
      business_date,metadata
    ) SELECT $1::uuid,$2::uuid,'system',$8,'community.activity.waitlist_promoted',
      'community_activity_registration',$3::uuid::text,
      ((clock_timestamp() AT TIME ZONE store.timezone)
        - make_interval(secs=>extract(epoch FROM store.business_day_cutoff)))::date,
      jsonb_build_object(
        'activityId',$4::uuid,'registrationCycle',$5::integer,
        'partySize',$6::integer,'promotionStatus',$7::text
      )
    FROM mbox.stores store WHERE store.tenant_id=$1::uuid AND store.id=$2::uuid
  `, [
    transaction.scope.tenantId,transaction.scope.storeId,input.registration.id,
    input.activityId,input.registration.registration_cycle,input.registration.party_size,
    input.status,input.workerId,
  ])
}

async function setActivityCapacityStatus(
  transaction: ScopedTransaction,
  activityId: string,
  availableSeats: number,
  hasWaitlist: boolean,
): Promise<void> {
  await transaction.query(`
    UPDATE mbox.community_activities
    SET status=CASE WHEN $4::integer>0 AND NOT $5::boolean THEN 'published' ELSE 'full' END,
      updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status IN ('published','full')
  `, [transaction.scope.tenantId,transaction.scope.storeId,activityId,availableSeats,hasWaitlist])
}

async function completeEvent(
  transaction: ScopedTransaction,
  eventId: string,
  resolution: 'activity_unavailable' | 'waitlist_empty' | 'head_party_does_not_fit' | 'package_unavailable',
  workerId: string,
): Promise<void> {
  const updated = await transaction.query(`
    UPDATE mbox.activity_waitlist_release_events
    SET processed_at=clock_timestamp(),resolution=$4,
      promotion_count=(
        SELECT count(*)::integer FROM mbox.activity_waitlist_promotions promotion
        WHERE promotion.tenant_id=$1::uuid AND promotion.store_id=$2::uuid
          AND promotion.release_event_id=$3::uuid
      ),
      processed_by_worker_id=$5,attempt_count=attempt_count+1
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND processed_at IS NULL
  `, [transaction.scope.tenantId,transaction.scope.storeId,eventId,resolution,workerId])
  if (updated.rowCount !== 1) throw new Error('activity waitlist release event lease was lost')
}

async function deferEvent(transaction: ScopedTransaction, eventId: string, workerId: string): Promise<void> {
  const updated = await transaction.query(`
    UPDATE mbox.activity_waitlist_release_events
    SET next_attempt_at=clock_timestamp()+interval '15 minutes',
      attempt_count=attempt_count+1,last_block_reason='payment_gate_closed',
      processed_by_worker_id=$4
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND processed_at IS NULL
  `, [transaction.scope.tenantId,transaction.scope.storeId,eventId,workerId])
  if (updated.rowCount !== 1) throw new Error('activity waitlist release event lease was lost')
}

function deterministicPublicId(prefix: string, registrationId: string, cycle: number): string {
  return `${prefix}-${createHash('sha256').update(`${registrationId}:${cycle}`).digest('hex').slice(0,24)}`
}

function requiredPaymentMethod(value: 'jsapi' | 'native_qr' | null): 'jsapi' | 'native_qr' {
  if (value === null) throw new Error('waitlisted payment method is missing')
  return value
}

function minor(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${label} is invalid`)
  return parsed
}

function validateWorkerId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(value)) throw new TypeError('workerId is invalid')
}

function validateBatchSize(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new TypeError('batchSize must be an integer between 1 and 50')
  }
}
