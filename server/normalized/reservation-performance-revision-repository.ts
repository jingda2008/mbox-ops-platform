import { NotificationRepository, NotificationPolicyError } from './notification-repository.js'
import {
  ScheduleRepository,
  type PerformanceSchedule,
} from './schedule-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type PerformanceRevisionKind = 'rescheduled' | 'cancelled' | 'replaced'
export type PerformanceImpactDecision = 'keep' | 'reselect' | 'clear'

export interface RevisePerformanceInput {
  publicId: string
  scheduleId: string
  kind: PerformanceRevisionKind
  startsAt: string | null
  endsAt: string | null
  replacementScheduleId: string | null
  reason: string
  employeeId: string
  idempotencyKey: string
  requestFingerprint: string
}

export interface PerformanceScheduleRevision {
  publicId: string
  scheduleId: string
  revisionNumber: number
  kind: PerformanceRevisionKind
  previousPerformerId: string
  previousPerformerStageName: string
  previousStartsAt: string
  previousEndsAt: string
  previousStatus: string
  resultingScheduleId: string | null
  resultingPerformerId: string | null
  resultingPerformerStageName: string | null
  resultingStartsAt: string | null
  resultingEndsAt: string | null
  resultingStatus: string | null
  reason: string
  createdByEmployeeId: string
  createdAt: string
  affectedReservations: number
}

export interface ReservationPerformanceImpact {
  publicId: string
  reservationPublicId: string
  reservationStatus: string
  arrivalAt: string
  revision: PerformanceScheduleRevision
  acknowledgement: null | {
    publicId: string
    decision: PerformanceImpactDecision
    selectedScheduleId: string | null
    resultingPreferredScheduleId: string | null
    acknowledgedAt: string
  }
  eligibleSchedules: Array<{
    id: string
    performerStageName: string
    startsAt: string
    endsAt: string
  }>
}

export interface AcknowledgePerformanceImpactInput {
  publicId: string
  impactPublicId: string
  actingCustomerId: string
  decision: PerformanceImpactDecision
  selectedScheduleId: string | null
  idempotencyKey: string
  requestFingerprint: string
}

interface ScheduleRevisionRow extends Record<string, unknown> {
  id: string
  public_id: string
  schedule_id: string
  revision_number: number
  revision_kind: PerformanceRevisionKind
  previous_performer_id: string
  previous_performer_stage_name: string
  previous_starts_at: string
  previous_ends_at: string
  previous_status: string
  resulting_schedule_id: string | null
  resulting_performer_id: string | null
  resulting_performer_stage_name: string | null
  resulting_starts_at: string | null
  resulting_ends_at: string | null
  resulting_status: string | null
  reason: string
  created_by_employee_id: string
  created_at: string
  affected_reservations: string | number
}

interface ImpactRow extends ScheduleRevisionRow {
  impact_id: string
  impact_public_id: string
  reservation_id: string
  reservation_public_id: string
  reservation_status: string
  reservation_arrival_at: string
  canonical_customer_id: string | null
  acknowledgement_public_id: string | null
  acknowledgement_decision: PerformanceImpactDecision | null
  selected_schedule_id: string | null
  resulting_preferred_schedule_id: string | null
  acknowledged_at: string | null
}

interface EligibleScheduleRow extends Record<string, unknown> {
  impact_id: string
  schedule_id: string
  performer_stage_name: string
  starts_at: string
  ends_at: string
}

interface AcknowledgementRow extends Record<string, unknown> {
  public_id: string
  decision: PerformanceImpactDecision
  selected_schedule_id: string | null
  resulting_preferred_schedule_id: string | null
  acknowledged_at: string
}

export class ReservationPerformanceRevisionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(message)
    this.name = 'ReservationPerformanceRevisionError'
  }
}

export class ReservationPerformanceRevisionRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async revise(input: Readonly<RevisePerformanceInput>): Promise<PerformanceScheduleRevision> {
    const schedules = new ScheduleRepository(this.transaction)
    const current = await schedules.findById(input.scheduleId, true)
    if (current === null) throw error('演出场次不存在', 'PERFORMANCE_SCHEDULE_NOT_FOUND', 404)
    if (current.status !== 'scheduled') {
      throw error('只有尚未开始的演出可以取消、改期或换场', 'PERFORMANCE_REVISION_NOT_ALLOWED')
    }

    const replacement = input.kind === 'replaced'
      ? await this.requireReplacement(input.scheduleId, input.replacementScheduleId)
      : null
    const result = revisionResult(input, current, replacement)
    const inserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.performance_schedule_revisions(
        tenant_id,store_id,public_id,schedule_id,revision_number,revision_kind,
        previous_performer_id,previous_starts_at,previous_ends_at,previous_status,
        resulting_schedule_id,resulting_performer_id,resulting_starts_at,
        resulting_ends_at,resulting_status,reason,created_by_employee_id,
        idempotency_key,request_fingerprint
      ) SELECT $1::uuid,$2::uuid,$3,$4::uuid,
          COALESCE(MAX(revision_number),0)+1,$5,$6::uuid,$7::timestamptz,
          $8::timestamptz,$9,$10::uuid,$11::uuid,$12::timestamptz,
          $13::timestamptz,$14,$15,$16::uuid,$17,$18
        FROM mbox.performance_schedule_revisions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND schedule_id=$4::uuid
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      input.scheduleId,
      input.kind,
      current.performerId,
      current.startsAt,
      current.endsAt,
      current.status,
      result.scheduleId,
      result.performerId,
      result.startsAt,
      result.endsAt,
      result.status,
      input.reason,
      input.employeeId,
      input.idempotencyKey,
      input.requestFingerprint,
    ])
    const revisionId = inserted.rows[0]?.id
    if (revisionId === undefined) throw new Error('Performance revision was not inserted')
    await this.transaction.query(`SELECT set_config('mbox.performance_revision_id',$1,true)`, [revisionId])

    if (input.kind === 'rescheduled') {
      await schedules.update({
        scheduleId: input.scheduleId,
        startsAt: result.startsAt ?? undefined,
        endsAt: result.endsAt ?? undefined,
      })
    } else {
      await schedules.cancel(input.scheduleId)
    }

    const impacts = await this.transaction.query<{
      id: string
      public_id: string
      canonical_customer_id: string | null
    }>(`
      INSERT INTO mbox.reservation_performance_impacts(
        tenant_id,store_id,public_id,revision_id,reservation_id,
        reservation_customer_id,canonical_customer_id,original_preferred_schedule_id,
        impact_kind
      )
      SELECT reservation.tenant_id,reservation.store_id,
        'reservation-impact-'||encode(digest($3||':'||reservation.id::text,'sha256'),'hex'),
        $4::uuid,reservation.id,reservation.customer_id,
        CASE WHEN reservation.customer_id IS NULL THEN NULL
          ELSE mbox.canonical_customer_id(reservation.tenant_id,reservation.store_id,reservation.customer_id)
        END,
        reservation.preferred_schedule_id,$5
      FROM mbox.reservations reservation
      WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
        AND reservation.preferred_schedule_id=$6::uuid
        AND reservation.status IN ('pending','confirmed','arrived','seated')
      ON CONFLICT (tenant_id,store_id,revision_id,reservation_id) DO NOTHING
      RETURNING id,public_id,canonical_customer_id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      revisionId,
      input.kind,
      input.scheduleId,
    ])

    for (const impact of impacts.rows) {
      if (impact.canonical_customer_id === null) continue
      try {
        await new NotificationRepository(this.transaction).create({
          businessKey: `reservation:performance:${impact.id}`,
          channel: 'in_app',
          recipient: { type: 'customer', id: impact.canonical_customer_id },
          templateCode: 'reservation.performance_revised',
          payload: {
            impactPublicId: impact.public_id,
            revisionKind: input.kind,
            scheduleId: input.scheduleId,
            resultingScheduleId: result.scheduleId,
            previousStartsAt: current.startsAt,
            resultingStartsAt: result.startsAt,
          },
          maxAttempts: 5,
        })
      } catch (notificationError) {
        if (!(notificationError instanceof NotificationPolicyError)) throw notificationError
      }
    }
    await this.enqueueWechatJobs(revisionId)
    return this.requireRevision(input.publicId)
  }

  async listCustomerImpacts(customerId: string): Promise<ReservationPerformanceImpact[]> {
    const canonical = await this.canonicalCustomerId(customerId)
    const result = await this.transaction.query<ImpactRow>(`
      SELECT ${IMPACT_COLUMNS}
      FROM mbox.reservation_performance_impacts impact
      JOIN mbox.performance_schedule_revisions revision
        ON revision.tenant_id=impact.tenant_id AND revision.store_id=impact.store_id
       AND revision.id=impact.revision_id
      JOIN mbox.reservations reservation
        ON reservation.tenant_id=impact.tenant_id AND reservation.store_id=impact.store_id
       AND reservation.id=impact.reservation_id
      JOIN mbox.performers previous_performer
        ON previous_performer.tenant_id=revision.tenant_id
       AND previous_performer.store_id=revision.store_id
       AND previous_performer.id=revision.previous_performer_id
      LEFT JOIN mbox.performers resulting_performer
        ON resulting_performer.tenant_id=revision.tenant_id
       AND resulting_performer.store_id=revision.store_id
       AND resulting_performer.id=revision.resulting_performer_id
      LEFT JOIN mbox.reservation_performance_acknowledgements acknowledgement
        ON acknowledgement.tenant_id=impact.tenant_id
       AND acknowledgement.store_id=impact.store_id
       AND acknowledgement.impact_id=impact.id
      WHERE impact.tenant_id=$1::uuid AND impact.store_id=$2::uuid
        AND impact.canonical_customer_id=$3::uuid
      ORDER BY (acknowledgement.id IS NULL) DESC,revision.created_at DESC,impact.id
      LIMIT 100
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, canonical])
    return this.mapImpactsWithEligibleSchedules(result.rows)
  }

  async listRevisionImpacts(publicId: string): Promise<ReservationPerformanceImpact[]> {
    const result = await this.transaction.query<ImpactRow>(`
      SELECT ${IMPACT_COLUMNS}
      FROM mbox.reservation_performance_impacts impact
      JOIN mbox.performance_schedule_revisions revision
        ON revision.tenant_id=impact.tenant_id AND revision.store_id=impact.store_id
       AND revision.id=impact.revision_id
      JOIN mbox.reservations reservation
        ON reservation.tenant_id=impact.tenant_id AND reservation.store_id=impact.store_id
       AND reservation.id=impact.reservation_id
      JOIN mbox.performers previous_performer
        ON previous_performer.tenant_id=revision.tenant_id
       AND previous_performer.store_id=revision.store_id
       AND previous_performer.id=revision.previous_performer_id
      LEFT JOIN mbox.performers resulting_performer
        ON resulting_performer.tenant_id=revision.tenant_id
       AND resulting_performer.store_id=revision.store_id
       AND resulting_performer.id=revision.resulting_performer_id
      LEFT JOIN mbox.reservation_performance_acknowledgements acknowledgement
        ON acknowledgement.tenant_id=impact.tenant_id
       AND acknowledgement.store_id=impact.store_id
       AND acknowledgement.impact_id=impact.id
      WHERE revision.tenant_id=$1::uuid AND revision.store_id=$2::uuid
        AND revision.public_id=$3
      ORDER BY reservation.arrival_at,impact.id
      LIMIT 500
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    return this.mapImpactsWithEligibleSchedules(result.rows)
  }

  async acknowledge(
    input: Readonly<AcknowledgePerformanceImpactInput>,
  ): Promise<ReservationPerformanceImpact> {
    const canonical = await this.canonicalCustomerId(input.actingCustomerId)
    const selected = await this.transaction.query<ImpactRow>(`
      SELECT ${IMPACT_COLUMNS}
      FROM mbox.reservation_performance_impacts impact
      JOIN mbox.performance_schedule_revisions revision
        ON revision.tenant_id=impact.tenant_id AND revision.store_id=impact.store_id
       AND revision.id=impact.revision_id
      JOIN mbox.reservations reservation
        ON reservation.tenant_id=impact.tenant_id AND reservation.store_id=impact.store_id
       AND reservation.id=impact.reservation_id
      JOIN mbox.performers previous_performer
        ON previous_performer.tenant_id=revision.tenant_id
       AND previous_performer.store_id=revision.store_id
       AND previous_performer.id=revision.previous_performer_id
      LEFT JOIN mbox.performers resulting_performer
        ON resulting_performer.tenant_id=revision.tenant_id
       AND resulting_performer.store_id=revision.store_id
       AND resulting_performer.id=revision.resulting_performer_id
      LEFT JOIN mbox.reservation_performance_acknowledgements acknowledgement
        ON acknowledgement.tenant_id=impact.tenant_id
       AND acknowledgement.store_id=impact.store_id
       AND acknowledgement.impact_id=impact.id
      WHERE impact.tenant_id=$1::uuid AND impact.store_id=$2::uuid
        AND impact.public_id=$3
      FOR UPDATE OF reservation,impact
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.impactPublicId])
    const impact = selected.rows[0]
    if (impact === undefined || impact.canonical_customer_id !== canonical) {
      throw error('未找到本人受影响的预约', 'RESERVATION_PERFORMANCE_IMPACT_NOT_FOUND', 404)
    }
    if (impact.acknowledgement_public_id !== null) {
      if (impact.acknowledgement_decision === input.decision
        && impact.selected_schedule_id === input.selectedScheduleId) {
        return (await this.mapImpactsWithEligibleSchedules([impact]))[0]!
      }
      throw error('该演出调整已经确认，请刷新预约状态', 'RESERVATION_PERFORMANCE_ALREADY_ACKNOWLEDGED')
    }
    if (!['pending','confirmed','arrived','seated'].includes(impact.reservation_status)) {
      throw error('当前预约状态无需再确认演出调整', 'RESERVATION_PERFORMANCE_ACK_NOT_ALLOWED')
    }
    const newer = await this.transaction.query(`
      SELECT 1
      FROM mbox.reservation_performance_impacts later_impact
      JOIN mbox.performance_schedule_revisions later_revision
        ON later_revision.tenant_id=later_impact.tenant_id
       AND later_revision.store_id=later_impact.store_id
       AND later_revision.id=later_impact.revision_id
      WHERE later_impact.tenant_id=$1::uuid AND later_impact.store_id=$2::uuid
        AND later_impact.reservation_id=$3::uuid
        AND later_revision.schedule_id=$4::uuid
        AND later_revision.revision_number>$5
      LIMIT 1
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      impact.reservation_id,
      impact.schedule_id,
      impact.revision_number,
    ])
    if (newer.rowCount !== 0) {
      throw error('演出安排再次变化，请刷新后确认最新调整', 'RESERVATION_PERFORMANCE_REVISION_STALE')
    }

    const resultingPreferredScheduleId = await this.resolvePreferredSchedule(impact, input)
    const acknowledgement = await this.transaction.query<AcknowledgementRow & { id: string }>(`
      INSERT INTO mbox.reservation_performance_acknowledgements(
        tenant_id,store_id,public_id,impact_id,revision_id,reservation_id,
        acting_customer_id,canonical_customer_id,decision,selected_schedule_id,
        resulting_preferred_schedule_id,idempotency_key,request_fingerprint
      ) VALUES (
        $1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
        $9,$10::uuid,$11::uuid,$12,$13
      )
      ON CONFLICT (tenant_id,store_id,impact_id) DO NOTHING
      RETURNING id,public_id,decision,selected_schedule_id,
        resulting_preferred_schedule_id,acknowledged_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      impact.impact_id,
      impact.id,
      impact.reservation_id,
      input.actingCustomerId,
      canonical,
      input.decision,
      input.selectedScheduleId,
      resultingPreferredScheduleId,
      input.idempotencyKey,
      input.requestFingerprint,
    ])
    const inserted = acknowledgement.rows[0]
    if (inserted === undefined) {
      throw error('该演出调整已被另一请求确认，请刷新', 'RESERVATION_PERFORMANCE_ACK_CONFLICT')
    }
    await this.transaction.query(`
      SELECT set_config('mbox.reservation_performance_acknowledgement_id',$1,true)
    `, [inserted.id])
    const updated = await this.transaction.query(`
      UPDATE mbox.reservations
      SET preferred_schedule_id=$4::uuid,aggregate_version=aggregate_version+1
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status IN ('pending','confirmed','arrived','seated')
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      impact.reservation_id,
      resultingPreferredScheduleId,
    ])
    if (updated.rowCount !== 1) throw error('预约状态刚刚变化，请刷新', 'RESERVATION_PERFORMANCE_ACK_CONFLICT')
    const refreshed = await this.listCustomerImpacts(input.actingCustomerId)
    const result = refreshed.find((candidate) => candidate.publicId === input.impactPublicId)
    if (result === undefined) throw new Error('Acknowledged reservation performance impact was not found')
    return result
  }

  private async requireRevision(publicId: string): Promise<PerformanceScheduleRevision> {
    const result = await this.transaction.query<ScheduleRevisionRow>(`
      SELECT ${REVISION_COLUMNS}
      FROM mbox.performance_schedule_revisions revision
      JOIN mbox.performers previous_performer
        ON previous_performer.tenant_id=revision.tenant_id
       AND previous_performer.store_id=revision.store_id
       AND previous_performer.id=revision.previous_performer_id
      LEFT JOIN mbox.performers resulting_performer
        ON resulting_performer.tenant_id=revision.tenant_id
       AND resulting_performer.store_id=revision.store_id
       AND resulting_performer.id=revision.resulting_performer_id
      WHERE revision.tenant_id=$1::uuid AND revision.store_id=$2::uuid
        AND revision.public_id=$3
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    const row = result.rows[0]
    if (row === undefined) throw new Error('Performance revision was not found after insert')
    return mapRevision(row)
  }

  private async requireReplacement(
    sourceScheduleId: string,
    replacementScheduleId: string | null,
  ): Promise<PerformanceSchedule> {
    if (replacementScheduleId === null || replacementScheduleId === sourceScheduleId) {
      throw error('换场必须选择另一场尚未开始的演出', 'PERFORMANCE_REPLACEMENT_INVALID', 400)
    }
    const replacement = await new ScheduleRepository(this.transaction).findById(replacementScheduleId, true)
    if (replacement === null || replacement.status !== 'scheduled') {
      throw error('替代演出不存在或已经不可选择', 'PERFORMANCE_REPLACEMENT_INVALID')
    }
    return replacement
  }

  private async canonicalCustomerId(customerId: string): Promise<string> {
    const result = await this.transaction.query<{ customer_id: string | null }>(`
      SELECT mbox.canonical_customer_id($1::uuid,$2::uuid,$3::uuid) AS customer_id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    const canonical = result.rows[0]?.customer_id
    if (canonical === null || canonical === undefined) {
      throw error('顾客身份不存在', 'RESERVATION_CUSTOMER_NOT_FOUND', 404)
    }
    return canonical
  }

  private async resolvePreferredSchedule(
    impact: ImpactRow,
    input: Readonly<AcknowledgePerformanceImpactInput>,
  ): Promise<string | null> {
    if (input.decision === 'clear') {
      if (input.selectedScheduleId !== null) throw error('清空演出偏好不能同时选择场次', 'PERFORMANCE_DECISION_INVALID', 400)
      return null
    }
    if (input.decision === 'keep') {
      if (input.selectedScheduleId !== null) throw error('接受调整不能同时选择其他场次', 'PERFORMANCE_DECISION_INVALID', 400)
      if (impact.revision_kind === 'cancelled') return null
      const scheduleId = impact.resulting_schedule_id
      if (scheduleId === null) return null
      return await this.isEligibleSchedule(scheduleId, impact.reservation_id) ? scheduleId : null
    }
    if (input.selectedScheduleId === null) {
      throw error('重新选择必须指定演出场次', 'PERFORMANCE_DECISION_INVALID', 400)
    }
    await this.requireEligibleSchedule(input.selectedScheduleId, impact.reservation_id)
    return input.selectedScheduleId
  }

  private async requireEligibleSchedule(scheduleId: string, reservationId: string): Promise<void> {
    if (await this.isEligibleSchedule(scheduleId, reservationId)) return
    throw error('所选演出不属于该预约日期或已不可选择', 'PERFORMANCE_SCHEDULE_UNAVAILABLE')
  }

  private async isEligibleSchedule(scheduleId: string, reservationId: string): Promise<boolean> {
    const eligible = await this.transaction.query(`
      SELECT schedule.id
      FROM mbox.schedules schedule
      JOIN mbox.reservations reservation
        ON reservation.tenant_id=schedule.tenant_id AND reservation.store_id=schedule.store_id
       AND reservation.id=$4::uuid
      JOIN mbox.stores store
        ON store.tenant_id=schedule.tenant_id AND store.id=schedule.store_id
      WHERE schedule.tenant_id=$1::uuid AND schedule.store_id=$2::uuid
        AND schedule.id=$3::uuid AND schedule.status='scheduled'
        AND (schedule.starts_at AT TIME ZONE store.timezone)::date
          =(reservation.arrival_at AT TIME ZONE store.timezone)::date
      FOR KEY SHARE OF schedule,reservation
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, scheduleId, reservationId])
    return eligible.rowCount === 1
  }

  private async mapImpactsWithEligibleSchedules(rows: ImpactRow[]): Promise<ReservationPerformanceImpact[]> {
    if (rows.length === 0) return []
    const eligible = await this.transaction.query<EligibleScheduleRow>(`
      SELECT impact.id AS impact_id,schedule.id AS schedule_id,
        performer.stage_name AS performer_stage_name,
        schedule.starts_at::text,schedule.ends_at::text
      FROM mbox.reservation_performance_impacts impact
      JOIN mbox.reservations reservation
        ON reservation.tenant_id=impact.tenant_id AND reservation.store_id=impact.store_id
       AND reservation.id=impact.reservation_id
      JOIN mbox.stores store
        ON store.tenant_id=impact.tenant_id AND store.id=impact.store_id
      JOIN mbox.schedules schedule
        ON schedule.tenant_id=impact.tenant_id AND schedule.store_id=impact.store_id
       AND schedule.status='scheduled'
       AND (schedule.starts_at AT TIME ZONE store.timezone)::date
          =(reservation.arrival_at AT TIME ZONE store.timezone)::date
      JOIN mbox.performers performer
        ON performer.tenant_id=schedule.tenant_id AND performer.store_id=schedule.store_id
       AND performer.id=schedule.performer_id
      WHERE impact.tenant_id=$1::uuid AND impact.store_id=$2::uuid
        AND impact.id=ANY($3::uuid[])
      ORDER BY impact.id,schedule.starts_at,schedule.id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      rows.map((row) => row.impact_id),
    ])
    const byImpact = new Map<string, ReservationPerformanceImpact['eligibleSchedules']>()
    for (const row of eligible.rows) {
      const values = byImpact.get(row.impact_id) ?? []
      values.push({
        id: row.schedule_id,
        performerStageName: row.performer_stage_name,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
      })
      byImpact.set(row.impact_id, values)
    }
    return rows.map((row) => mapImpact(row, byImpact.get(row.impact_id) ?? []))
  }

  private async enqueueWechatJobs(revisionId: string): Promise<void> {
    await this.transaction.query(`SELECT mbox.enqueue_reservation_performance_wechat_jobs($1::uuid,$2::uuid,$3::uuid)`, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      revisionId,
    ])
  }
}

function revisionResult(
  input: Readonly<RevisePerformanceInput>,
  current: PerformanceSchedule,
  replacement: PerformanceSchedule | null,
) {
  if (input.kind === 'rescheduled') {
    if (input.replacementScheduleId !== null) {
      throw error('改期不能同时指定替代场次', 'PERFORMANCE_REVISION_INPUT_INVALID', 400)
    }
    if (input.startsAt === null || input.endsAt === null) {
      throw error('改期必须填写新的开始和结束时间', 'PERFORMANCE_REVISION_INPUT_INVALID', 400)
    }
    if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) {
      throw error('演出结束时间必须晚于开始时间', 'PERFORMANCE_REVISION_INPUT_INVALID', 400)
    }
    if (input.startsAt === current.startsAt && input.endsAt === current.endsAt) {
      throw error('新的演出时间没有变化', 'PERFORMANCE_REVISION_INPUT_INVALID', 400)
    }
    return {
      scheduleId: current.id,
      performerId: current.performerId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: 'scheduled',
    }
  }
  if (input.startsAt !== null || input.endsAt !== null) {
    throw error('取消或换场不能提交改期时间', 'PERFORMANCE_REVISION_INPUT_INVALID', 400)
  }
  if (input.kind === 'cancelled') {
    if (input.replacementScheduleId !== null) {
      throw error('直接取消不能指定替代场次', 'PERFORMANCE_REVISION_INPUT_INVALID', 400)
    }
    return {
      scheduleId: current.id,
      performerId: current.performerId,
      startsAt: current.startsAt,
      endsAt: current.endsAt,
      status: 'cancelled',
    }
  }
  if (replacement === null) throw new Error('Replacement schedule was not loaded')
  return {
    scheduleId: replacement.id,
    performerId: replacement.performerId,
    startsAt: replacement.startsAt,
    endsAt: replacement.endsAt,
    status: replacement.status,
  }
}

const REVISION_COLUMNS = `
  revision.id,revision.public_id,revision.schedule_id,revision.revision_number,
  revision.revision_kind,revision.previous_performer_id,
  previous_performer.stage_name AS previous_performer_stage_name,
  revision.previous_starts_at::text,revision.previous_ends_at::text,
  revision.previous_status,revision.resulting_schedule_id,
  revision.resulting_performer_id,
  resulting_performer.stage_name AS resulting_performer_stage_name,
  revision.resulting_starts_at::text,revision.resulting_ends_at::text,
  revision.resulting_status,revision.reason,revision.created_by_employee_id,
  revision.created_at::text,
  (SELECT count(*) FROM mbox.reservation_performance_impacts counted
    WHERE counted.tenant_id=revision.tenant_id AND counted.store_id=revision.store_id
      AND counted.revision_id=revision.id) AS affected_reservations
`

const IMPACT_COLUMNS = `
  ${REVISION_COLUMNS},impact.id AS impact_id,impact.public_id AS impact_public_id,
  impact.reservation_id,reservation.public_id AS reservation_public_id,
  reservation.status AS reservation_status,reservation.arrival_at::text AS reservation_arrival_at,
  impact.canonical_customer_id,
  acknowledgement.public_id AS acknowledgement_public_id,
  acknowledgement.decision AS acknowledgement_decision,
  acknowledgement.selected_schedule_id,
  acknowledgement.resulting_preferred_schedule_id,
  acknowledgement.acknowledged_at::text
`

function mapRevision(row: ScheduleRevisionRow): PerformanceScheduleRevision {
  return {
    publicId: row.public_id,
    scheduleId: row.schedule_id,
    revisionNumber: Number(row.revision_number),
    kind: row.revision_kind,
    previousPerformerId: row.previous_performer_id,
    previousPerformerStageName: row.previous_performer_stage_name,
    previousStartsAt: row.previous_starts_at,
    previousEndsAt: row.previous_ends_at,
    previousStatus: row.previous_status,
    resultingScheduleId: row.resulting_schedule_id,
    resultingPerformerId: row.resulting_performer_id,
    resultingPerformerStageName: row.resulting_performer_stage_name,
    resultingStartsAt: row.resulting_starts_at,
    resultingEndsAt: row.resulting_ends_at,
    resultingStatus: row.resulting_status,
    reason: row.reason,
    createdByEmployeeId: row.created_by_employee_id,
    createdAt: row.created_at,
    affectedReservations: Number(row.affected_reservations),
  }
}

function mapImpact(
  row: ImpactRow,
  eligibleSchedules: ReservationPerformanceImpact['eligibleSchedules'],
): ReservationPerformanceImpact {
  return {
    publicId: row.impact_public_id,
    reservationPublicId: row.reservation_public_id,
    reservationStatus: row.reservation_status,
    arrivalAt: row.reservation_arrival_at,
    revision: mapRevision(row),
    acknowledgement: row.acknowledgement_public_id === null ? null : {
      publicId: row.acknowledgement_public_id,
      decision: row.acknowledgement_decision!,
      selectedScheduleId: row.selected_schedule_id,
      resultingPreferredScheduleId: row.resulting_preferred_schedule_id,
      acknowledgedAt: row.acknowledged_at!,
    },
    eligibleSchedules,
  }
}

function error(message: string, code: string, statusCode = 409) {
  return new ReservationPerformanceRevisionError(message, code, statusCode)
}
