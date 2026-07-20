import type { ServiceTask } from '../src/shared/contracts.js'
import type { KdsTask, OrderDomainState } from '../src/shared/order-contracts.js'
import type { SongRequest } from '../src/shared/song-contracts.js'
import { chinaBusinessDateKey } from '../src/shared/china-time.js'

const ACTIVE_SONG_REQUEST_STATUSES = new Set([
  'pending_confirmation', 'pending_payment', 'paid', 'accepted', 'performing', 'refund_required',
])

export function isServiceTaskOperationallyClosed(task: ServiceTask) {
  return ['completed', 'confirmed', 'cancelled'].includes(task.status)
}

export function isKdsTaskOperationallyClosed(orderDomain: OrderDomainState, task: KdsTask) {
  const reports = task.exceptionEvents?.filter((event) => event.type === 'reported') ?? []
  if (reports.length === 0) return task.status === 'delivered'

  return reports.every((report) => {
    const disposition = task.exceptionEvents?.find((event) => (
      event.type === 'manager_disposition' && event.exceptionId === report.exceptionId
    ))
    if (!disposition) return false
    if (disposition.managerDisposition === 'cancelled') return true
    return disposition.managerDisposition === 'remake'
      && disposition.remakeKdsTaskId !== null
      && orderDomain.kdsTasks.some((candidate) => candidate.id === disposition.remakeKdsTaskId)
  })
}

export function isKdsTaskActiveForBusinessDate(
  orderDomain: OrderDomainState,
  task: KdsTask,
  businessDate: string,
  rolloverHour = 6,
) {
  return !isKdsTaskOperationallyClosed(orderDomain, task)
    && chinaBusinessDateKey(task.queuedAt, rolloverHour) === businessDate
}

export function isSongRequestOperationallyClosed(request: SongRequest) {
  return !ACTIVE_SONG_REQUEST_STATUSES.has(request.status)
}
