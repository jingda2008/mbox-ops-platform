import type { ScopedTransaction } from './transaction-runner.js'

export type ScheduleStatus = 'scheduled' | 'performing' | 'completed' | 'cancelled'
export type PerformancePhase = 'no_schedule' | 'upcoming' | 'live' | 'between' | 'ended'

export interface PerformanceSchedule {
  id: string
  performerId: string
  performerCode: string
  performerStageName: string
  performerProfileSnapshot: Record<string, unknown>
  startsAt: string
  endsAt: string
  status: ScheduleStatus
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface CreateScheduleInput {
  performerId: string
  startsAt: string
  endsAt: string
  sortOrder?: number
}

export interface UpdateScheduleInput {
  scheduleId: string
  startsAt?: string
  endsAt?: string
  sortOrder?: number
}

export interface DailyPerformanceView {
  timezone: string
  localDate: string
  phase: PerformancePhase
  current: PerformanceSchedule | null
  next: PerformanceSchedule | null
  startsInSeconds: number | null
  remainingSeconds: number | null
  schedules: PerformanceSchedule[]
}

interface ScheduleRow extends Record<string, unknown> {
  id: string
  performer_id: string
  performer_code: string
  performer_stage_name: string
  performer_profile_snapshot: Record<string, unknown>
  starts_at: string
  ends_at: string
  status: ScheduleStatus
  sort_order: number
  created_at: string
  updated_at: string
}

interface StoreClockRow extends Record<string, unknown> {
  timezone: string
  business_date: string
  window_start: string
  window_end: string
}

const SCHEDULE_COLUMNS = `
  schedule.id, schedule.performer_id,
  performer.code AS performer_code,
  performer.stage_name AS performer_stage_name,
  performer.profile_snapshot AS performer_profile_snapshot,
  schedule.starts_at::text, schedule.ends_at::text, schedule.status,
  schedule.sort_order, schedule.created_at::text, schedule.updated_at::text
`

export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Performance schedule was not found: ${id}`)
    this.name = 'ScheduleNotFoundError'
  }
}

export class ScheduleConflictError extends Error {
  constructor() {
    super('Performance schedule overlaps another active stage slot')
    this.name = 'ScheduleConflictError'
  }
}

export class ScheduleTransitionError extends Error {
  constructor(id: string, from: ScheduleStatus, to: ScheduleStatus) {
    super(`Performance schedule ${id} cannot transition from ${from} to ${to}`)
    this.name = 'ScheduleTransitionError'
  }
}

export class ScheduleRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async findById(id: string, forUpdate = false): Promise<PerformanceSchedule | null> {
    const lock = forUpdate ? 'FOR UPDATE OF schedule' : ''
    const result = await this.transaction.query<ScheduleRow>(`
      SELECT ${SCHEDULE_COLUMNS}
      FROM mbox.schedules AS schedule
      JOIN mbox.performers AS performer
        ON performer.tenant_id = schedule.tenant_id
        AND performer.store_id = schedule.store_id
        AND performer.id = schedule.performer_id
      WHERE schedule.tenant_id = $1::uuid AND schedule.store_id = $2::uuid
        AND schedule.id = $3::uuid
      ${lock}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return result.rows[0] === undefined ? null : mapSchedule(result.rows[0])
  }

  async create(input: Readonly<CreateScheduleInput>): Promise<PerformanceSchedule> {
    validateRange(input.startsAt, input.endsAt)
    await this.lockStoreTimeline()
    await this.requireActivePerformer(input.performerId)
    await this.assertNoOverlap(input.startsAt, input.endsAt, null)
    const inserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.schedules (
        tenant_id, store_id, performer_id, starts_at, ends_at, sort_order
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz, $6)
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.performerId,
      input.startsAt,
      input.endsAt,
      input.sortOrder ?? 0,
    ])
    const id = requireOne(inserted, 'schedule insert').id
    const schedule = await this.findById(id)
    if (schedule === null) throw new ScheduleNotFoundError(id)
    return schedule
  }

  async update(input: Readonly<UpdateScheduleInput>): Promise<PerformanceSchedule> {
    validateUpdate(input)
    await this.lockStoreTimeline()
    const current = await this.findById(input.scheduleId, true)
    if (current === null) throw new ScheduleNotFoundError(input.scheduleId)
    if (current.status !== 'scheduled') {
      throw new ScheduleTransitionError(current.id, current.status, 'scheduled')
    }
    const startsAt = input.startsAt ?? current.startsAt
    const endsAt = input.endsAt ?? current.endsAt
    validateRange(startsAt, endsAt)
    await this.assertNoOverlap(startsAt, endsAt, input.scheduleId)
    await this.transaction.query(`
      UPDATE mbox.schedules
      SET starts_at = $4::timestamptz, ends_at = $5::timestamptz,
          sort_order = COALESCE($6::integer, sort_order)
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status = 'scheduled'
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.scheduleId,
      startsAt,
      endsAt,
      input.sortOrder ?? null,
    ])
    const schedule = await this.findById(input.scheduleId)
    if (schedule === null) throw new ScheduleNotFoundError(input.scheduleId)
    return schedule
  }

  start(scheduleId: string): Promise<PerformanceSchedule> {
    return this.transition(scheduleId, ['scheduled'], 'performing')
  }

  complete(scheduleId: string): Promise<PerformanceSchedule> {
    return this.transition(scheduleId, ['performing'], 'completed')
  }

  cancel(scheduleId: string): Promise<PerformanceSchedule> {
    return this.transition(scheduleId, ['scheduled'], 'cancelled')
  }

  async getDailyView(businessDate: string, at = new Date().toISOString()): Promise<DailyPerformanceView> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new TypeError('businessDate must be YYYY-MM-DD')
    requireInstant(at, 'at')
    const clockResult = await this.transaction.query<StoreClockRow>(`
      SELECT timezone, $3::date::text AS business_date,
        (($3::date::timestamp + business_day_cutoff) AT TIME ZONE timezone)::text AS window_start,
        ((($3::date + 1)::timestamp + business_day_cutoff) AT TIME ZONE timezone)::text AS window_end
      FROM mbox.stores
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND status <> 'closed'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, businessDate])
    const clock = requireOne(clockResult, 'store clock query')
    const schedules = await this.transaction.query<ScheduleRow>(`
      SELECT ${SCHEDULE_COLUMNS}
      FROM mbox.schedules AS schedule
      JOIN mbox.performers AS performer
        ON performer.tenant_id = schedule.tenant_id
        AND performer.store_id = schedule.store_id
        AND performer.id = schedule.performer_id
      WHERE schedule.tenant_id = $1::uuid AND schedule.store_id = $2::uuid
        AND schedule.status <> 'cancelled'
        AND schedule.starts_at < $4::timestamptz
        AND schedule.ends_at > $3::timestamptz
      ORDER BY schedule.starts_at, schedule.sort_order, schedule.id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      clock.window_start,
      clock.window_end,
    ])
    return buildDailyPerformanceView(clock.timezone, clock.business_date, at, schedules.rows.map(mapSchedule))
  }

  private async transition(
    scheduleId: string,
    allowedFrom: readonly ScheduleStatus[],
    target: ScheduleStatus,
  ): Promise<PerformanceSchedule> {
    const current = await this.findById(scheduleId, true)
    if (current === null) throw new ScheduleNotFoundError(scheduleId)
    if (current.status === target) return current
    if (!allowedFrom.includes(current.status)) {
      throw new ScheduleTransitionError(scheduleId, current.status, target)
    }
    const result = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.schedules
      SET status = $4
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status = ANY($5::text[])
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      scheduleId,
      target,
      allowedFrom,
    ])
    requireOne(result, 'schedule transition')
    const schedule = await this.findById(scheduleId)
    if (schedule === null) throw new ScheduleNotFoundError(scheduleId)
    return schedule
  }

  private async lockStoreTimeline(): Promise<void> {
    await this.transaction.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:performance-timeline`],
    )
  }

  private async requireActivePerformer(performerId: string): Promise<void> {
    const performer = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.performers
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status = 'active'
      FOR KEY SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, performerId])
    if (performer.rowCount !== 1) throw new Error(`Active performer was not found: ${performerId}`)
  }

  private async assertNoOverlap(startsAt: string, endsAt: string, excludingId: string | null): Promise<void> {
    const overlap = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.schedules
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status IN ('scheduled', 'performing')
        AND starts_at < $4::timestamptz AND ends_at > $3::timestamptz
        AND ($5::uuid IS NULL OR id <> $5::uuid)
      LIMIT 1
      FOR UPDATE
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      startsAt,
      endsAt,
      excludingId,
    ])
    if (overlap.rowCount !== 0) throw new ScheduleConflictError()
  }
}

export function buildDailyPerformanceView(
  timezone: string,
  localDate: string,
  at: string,
  schedules: readonly PerformanceSchedule[],
): DailyPerformanceView {
  const nowMs = requireInstant(at, 'at')
  const ordered = [...schedules].sort((left, right) => (
    Date.parse(left.startsAt) - Date.parse(right.startsAt)
    || left.sortOrder - right.sortOrder
    || left.id.localeCompare(right.id)
  ))
  const current = ordered.find((schedule) => (
    schedule.status !== 'completed'
    && Date.parse(schedule.startsAt) <= nowMs
    && nowMs < Date.parse(schedule.endsAt)
  )) ?? null
  const next = ordered.find((schedule) => (
    schedule.status !== 'completed' && Date.parse(schedule.startsAt) > nowMs
  )) ?? null
  let phase: PerformancePhase
  if (ordered.length === 0) phase = 'no_schedule'
  else if (current !== null) phase = 'live'
  else if (next !== null && nowMs < Date.parse(ordered[0]!.startsAt)) phase = 'upcoming'
  else if (next !== null) phase = 'between'
  else phase = 'ended'
  return {
    timezone,
    localDate,
    phase,
    current,
    next,
    startsInSeconds: next === null ? null : Math.max(0, Math.ceil((Date.parse(next.startsAt) - nowMs) / 1_000)),
    remainingSeconds: current === null ? null : Math.max(0, Math.ceil((Date.parse(current.endsAt) - nowMs) / 1_000)),
    schedules: ordered,
  }
}

function validateUpdate(input: Readonly<UpdateScheduleInput>): void {
  if (input.scheduleId.trim().length === 0) throw new TypeError('scheduleId must not be blank')
  if (input.startsAt === undefined && input.endsAt === undefined && input.sortOrder === undefined) {
    throw new TypeError('Schedule update must contain at least one change')
  }
}

function validateRange(startsAt: string, endsAt: string): void {
  const start = requireInstant(startsAt, 'startsAt')
  const end = requireInstant(endsAt, 'endsAt')
  if (end <= start) throw new TypeError('Schedule endsAt must be after startsAt')
}

function requireInstant(value: string, field: string): number {
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) throw new TypeError(`${field} must be an ISO timestamp`)
  return instant
}

function mapSchedule(row: ScheduleRow): PerformanceSchedule {
  return {
    id: row.id,
    performerId: row.performer_id,
    performerCode: row.performer_code,
    performerStageName: row.performer_stage_name,
    performerProfileSnapshot: row.performer_profile_snapshot ?? {},
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function requireOne<Row extends Record<string, unknown>>(
  result: { rows: Row[]; rowCount: number | null },
  action: string,
): Row {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error(`${action} did not return exactly one row`)
  return row
}
