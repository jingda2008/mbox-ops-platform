import type { RuntimeState } from '../src/shared/contracts.js'
import { reconcileAutomaticBusinessDay } from './business-day-rollover.js'
import { escalateDueTasks } from './domain.js'
import { processOverdueProductionTasks } from './kds-production-alerts.js'
import { processAwaitingOrderReminders } from './proactive-service.js'
import { processSopRules } from './sop-engine.js'

export function applyScheduledOperations(state: RuntimeState, now = new Date()) {
  const businessDayRollover = reconcileAutomaticBusinessDay(state, now)
  processAwaitingOrderReminders(state, now)
  processSopRules(state, now)
  processOverdueProductionTasks(state, now)
  escalateDueTasks(state, now)
  return businessDayRollover
}

/**
 * The production repository stores one aggregate row. Probe on a clone so an
 * idle scheduler tick never takes the aggregate's exclusive database lock.
 */
export function scheduledOperationsWouldChange(state: RuntimeState, now = new Date()) {
  const probe = structuredClone(state)
  const previousRevision = probe.revision
  applyScheduledOperations(probe, now)
  return probe.revision !== previousRevision
}
