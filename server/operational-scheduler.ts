import type { RuntimeState } from '../src/shared/contracts.js'
import { venueBusinessDateKey } from '../src/shared/venue-time.js'
import { reconcileAutomaticBusinessDay } from './business-day-rollover.js'
import { escalateDueTasks } from './domain.js'
import { processOverdueProductionTasks } from './kds-production-alerts.js'
import { processAwaitingOrderReminders } from './proactive-service.js'
import { processSopRules } from './sop-engine.js'
import { tableOperationsConfig } from './table-sessions.js'

export function applyScheduledOperations(state: RuntimeState, now = new Date()) {
  const businessDayRollover = reconcileAutomaticBusinessDay(state, now)
  processAwaitingOrderReminders(state, now)
  processSopRules(state, now)
  processOverdueProductionTasks(state, now)
  escalateDueTasks(state, now)
  return businessDayRollover
}

/**
 * Cheap read-only guard for the common no-work tick. The previous probe cloned
 * the whole venue aggregate every two seconds even when no timer was due,
 * producing avoidable event-loop stalls on the same process that serves KDS.
 *
 * This guard is deliberately conservative: true means "run the authoritative
 * clone-and-compare probe", while false proves that none of the timer-backed
 * processors can change state at this instant.
 */
export function scheduledOperationsMayBeDue(state: RuntimeState, now = new Date()) {
  const nowMs = now.getTime()
  const operationsConfig = tableOperationsConfig(state)
  if (
    (operationsConfig.automaticBusinessDayRollover ?? true)
    && state.store.businessDate < venueBusinessDateKey(
      now,
      state.store.timezone,
      operationsConfig.businessDayRolloverHour ?? 6,
    )
  ) return true

  const openSessionByTableId = new Map(
    state.songState.tableSessions
      .filter((session) => session.status === 'open')
      .map((session) => [session.tableId, session]),
  )
  for (const intent of state.awaitingOrderIntents) {
    if (intent.status !== 'active') continue
    const table = state.tables.find((candidate) => candidate.id === intent.tableId)
    if (!table || table.status !== 'occupied') return true
    const session = openSessionByTableId.get(intent.tableId)
    if (!session) return true
    if (session && state.orderDomain.orders.some((order) => (
      order.tableSessionId === session.id
      && Boolean(order.submittedAt)
      && order.submittedAt! >= intent.startedAt
    ))) return true
    if (intent.nextReminderAt && Date.parse(intent.nextReminderAt) <= nowMs) return true
  }

  // Legacy tasks can receive their SLA snapshots during normalization. They
  // must reach the authoritative probe so a newly derived overdue deadline is
  // not hidden by this fast path.
  if (state.orderDomain.kdsTasks.some((task) => (
    !task.workstation || !task.productionSla || !task.pickupSla
  ))) return true

  if (state.orderDomain.kdsTasks.some((task) => {
    const dueAt = task.productionSla?.dueAt
    return ['queued', 'preparing'].includes(task.status)
      && dueAt !== null
      && dueAt !== undefined
      && Date.parse(dueAt) <= nowMs
  })) return true

  if (state.tasks.some((task) => {
    if (!['pending', 'accepted', 'escalated', 'reopened'].includes(task.status)) return false
    const firstDue = task.escalationLevel < 1 && Date.parse(task.escalateAt) <= nowMs
    const managerDue = task.escalationLevel < 2 && Date.parse(task.managerAt) <= nowMs
    return firstDue || managerDue
  })) return true

  // SOP status and stop conditions can react to related task/order changes, not
  // just a timestamp. Keep the authoritative probe whenever SOP automation is
  // configured or active; correctness takes precedence over this fast path.
  return Boolean(
    state.sopExecutions?.some((execution) => execution.status === 'active')
    || state.config.sopRules?.some((rule) => rule.enabled),
  )
}

/**
 * The production repository stores one aggregate row. Probe on a clone so an
 * idle scheduler tick never takes the aggregate's exclusive database lock.
 */
export function scheduledOperationsWouldChange(state: RuntimeState, now = new Date()) {
  if (!scheduledOperationsMayBeDue(state, now)) return false
  const probe = structuredClone(state)
  const previousRevision = probe.revision
  applyScheduledOperations(probe, now)
  return probe.revision !== previousRevision
}
