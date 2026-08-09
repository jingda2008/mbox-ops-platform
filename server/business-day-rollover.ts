import { randomUUID } from 'node:crypto'
import type { RuntimeState } from '../src/shared/contracts.js'
import { shiftDateKey, venueBusinessDateKey } from '../src/shared/venue-time.js'
import {
  archiveBusinessDayOperations,
  prepareNextBusinessDayShifts,
  type BusinessDayArchiveSummary,
  type ShiftContinuityResult,
} from './business-day-api.js'
import { closeCashierHandover, handoverSnapshotMatches, latestCashierHandover } from './payment-domain.js'
import { clearPresenceLeases } from './presence.js'
import { tableOperationsConfig } from './table-sessions.js'

const SYSTEM_ACTOR_ID = 'system-business-day-rollover'

type AutomaticShiftContinuity = ShiftContinuityResult | {
  source: 'unavailable'
  shiftIds: string[]
  reason: string
}

export interface AutomaticBusinessDayStep {
  businessDate: string
  nextBusinessDate: string
  financialCloseStatus: 'closed' | 'pending_review'
  handoverId: string | null
  shiftContinuity: AutomaticShiftContinuity
  archiveSummary: BusinessDayArchiveSummary
}

export type AutomaticBusinessDayRolloverResult =
  | { status: 'disabled' | 'current' | 'ahead'; businessDate: string; expectedBusinessDate: string; steps: [] }
  | { status: 'rolled_over'; businessDate: string; expectedBusinessDate: string; steps: AutomaticBusinessDayStep[] }

/**
 * Advances the store's operational day at the configured venue-time cutoff.
 * Financial records remain attached to their original business date; an approved,
 * unchanged handover closes automatically, otherwise the audit trail marks it for review.
 */
export function reconcileAutomaticBusinessDay(
  state: RuntimeState,
  now: Date | number = Date.now(),
): AutomaticBusinessDayRolloverResult {
  const config = tableOperationsConfig(state)
  const rolloverHour = config.businessDayRolloverHour ?? 6
  const expectedBusinessDate = venueBusinessDateKey(now, state.store.timezone, rolloverHour)
  const businessDate = state.store.businessDate
  if (!(config.automaticBusinessDayRollover ?? true)) {
    return { status: 'disabled', businessDate, expectedBusinessDate, steps: [] }
  }
  if (businessDate === expectedBusinessDate) {
    return { status: 'current', businessDate, expectedBusinessDate, steps: [] }
  }
  if (businessDate > expectedBusinessDate) {
    return { status: 'ahead', businessDate, expectedBusinessDate, steps: [] }
  }

  const occurredAt = new Date(now).toISOString()
  const steps: AutomaticBusinessDayStep[] = []
  while (state.store.businessDate < expectedBusinessDate) {
    const closedBusinessDate = state.store.businessDate
    const nextBusinessDate = shiftDateKey(closedBusinessDate, 1)
    const archiveSummary = archiveBusinessDayOperations(
      state,
      closedBusinessDate,
      occurredAt,
      SYSTEM_ACTOR_ID,
    )
    let shiftContinuity: AutomaticShiftContinuity
    try {
      shiftContinuity = prepareNextBusinessDayShifts(state, closedBusinessDate, nextBusinessDate)
    } catch (error) {
      shiftContinuity = {
        source: 'unavailable',
        shiftIds: [],
        reason: error instanceof Error ? error.message : '下一营业日排班准备失败',
      }
    }

    const handover = latestCashierHandover(state.paymentDomain, closedBusinessDate)
    const handoverCanClose = handover?.status === 'approved'
      && handoverSnapshotMatches(state.paymentDomain, handover, {
        timeZone: state.store.timezone,
        rolloverHour,
      })
    if (handoverCanClose) closeCashierHandover(handover, occurredAt)
    const financialCloseStatus = handover?.status === 'closed' ? 'closed' : 'pending_review'

    for (const shift of state.shiftAssignments) {
      if (shift.businessDate === closedBusinessDate && shift.status === 'active') shift.status = 'completed'
    }
    state.store.businessDate = nextBusinessDate
    state.songState.businessDate = nextBusinessDate
    const step: AutomaticBusinessDayStep = {
      businessDate: closedBusinessDate,
      nextBusinessDate,
      financialCloseStatus,
      handoverId: handover?.id ?? null,
      shiftContinuity,
      archiveSummary,
    }
    steps.push(step)
    state.auditEntries.push({
      id: `audit_${randomUUID()}`,
      actorId: SYSTEM_ACTOR_ID,
      action: 'business_day.auto_rolled_over.v1',
      objectType: 'businessDay',
      objectId: closedBusinessDate,
      occurredAt,
      details: {
        nextBusinessDate,
        rolloverHour,
        timeZone: state.store.timezone,
        financialCloseStatus,
        handoverId: handover?.id ?? null,
        shiftContinuity,
        archiveSummary,
      },
    })
  }

  const endedPresenceSessionIds = clearPresenceLeases(state, new Date(now).getTime())
  for (const employee of state.employees) employee.paused = false
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: SYSTEM_ACTOR_ID,
    action: 'business_day.auto_rollover_completed.v1',
    objectType: 'businessDay',
    objectId: state.store.businessDate,
    occurredAt,
    details: {
      previousBusinessDate: businessDate,
      expectedBusinessDate,
      rolloverHour,
      rolledBusinessDayCount: steps.length,
      endedPresenceSessionIds,
    },
  })
  state.revision += 1
  return { status: 'rolled_over', businessDate: state.store.businessDate, expectedBusinessDate, steps }
}
