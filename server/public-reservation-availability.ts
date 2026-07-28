import type { RuntimeState } from '../src/shared/contracts.js'
import type { ReservationState } from '../src/shared/reservation-contracts.js'
import { mboxVenueTableCodes } from '../src/shared/venue-layout.js'
import { reservationBusinessSlot, reservationDepositRule } from './reservation-domain.js'

export type PublicTableAvailabilityStatus = 'available' | 'reserved' | 'locked'

export interface PublicTableAvailability {
  id: string
  code: string
  displayName: string
  areaId: string
  areaPreferenceCode: string
  capacity: number
  status: PublicTableAvailabilityStatus
  statusReason: string
  depositAmount: number
  minimumSpendAmount: number
  deductibleRateBps: number
  customerNotice: string
}

const tableAreaPreference: Record<string, string> = {
  booth: 'booth',
  lounge: 'lounge',
  'main-a': 'social',
  'main-b': 'social',
  'main-c': 'social',
  social: 'interactive',
  special: 'booth',
  walkin: 'walkin',
}

function periodKey(slotTime: string) {
  const hour = Number(slotTime.slice(0, 2))
  return hour >= 18 || hour < 6 ? 'evening' : 'afternoon'
}

function reservationOccupiesPeriod(
  domain: ReservationState,
  reservation: ReservationState['reservations'][number],
  businessDate: string,
  period: string,
) {
  if (['cancelled', 'no_show'].includes(reservation.status) || !reservation.requestedTableCode) return false
  try {
    const slot = reservationBusinessSlot(domain.config, reservation.scheduledAt)
    return slot.businessDate === businessDate && periodKey(slot.slotTime) === period
  } catch {
    return false
  }
}

export function publicTableAvailability(
  runtime: RuntimeState,
  domain: ReservationState,
  scheduledAt: string,
  excludeReservationId?: string,
): PublicTableAvailability[] {
  const target = reservationBusinessSlot(domain.config, scheduledAt)
  const targetPeriod = periodKey(target.slotTime)
  return runtime.tables
    .filter((table) => mboxVenueTableCodes.has(table.code))
    .map((table) => {
      const areaPreferenceCode = tableAreaPreference[table.areaId]
      const depositRule = reservationDepositRule(domain.config, areaPreferenceCode)
      const collidingReservation = domain.reservations.find((reservation) =>
        reservation.id !== excludeReservationId
        && reservation.requestedTableCode === table.code
        && reservationOccupiesPeriod(domain, reservation, target.businessDate, targetPeriod),
      )
      const appliesLiveStatus = runtime.store.businessDate === target.businessDate
      const liveStatus = appliesLiveStatus ? table.status : 'available'
      const status: PublicTableAvailabilityStatus = collidingReservation || liveStatus === 'reserved'
        ? 'reserved'
        : liveStatus === 'occupied' || liveStatus === 'paused'
          ? 'locked'
          : 'available'
      const statusReason = collidingReservation
        ? '该时段已有预约'
        : liveStatus === 'reserved'
          ? '现场已锁定'
          : liveStatus === 'occupied'
            ? '当前正在使用'
            : liveStatus === 'paused'
              ? '暂不开放'
              : '可以预约'
      return {
        id: table.id,
        code: table.code,
        displayName: table.displayName,
        areaId: table.areaId,
        areaPreferenceCode: areaPreferenceCode ?? 'social',
        capacity: table.capacity,
        status,
        statusReason,
        depositAmount: depositRule.depositAmount,
        minimumSpendAmount: depositRule.minimumSpendAmount,
        deductibleRateBps: depositRule.deductibleRateBps,
        customerNotice: depositRule.customerNotice,
      }
    })
    .toSorted((left, right) => left.code.localeCompare(right.code, 'en', { numeric: true }))
}

export function assertPublicRequestedTableAvailable(
  runtime: RuntimeState,
  domain: ReservationState,
  scheduledAt: string,
  requestedTableCode: string,
  excludeReservationId?: string,
) {
  const table = publicTableAvailability(runtime, domain, scheduledAt, excludeReservationId)
    .find((item) => item.code === requestedTableCode)
  if (!table) throw new Error('所选桌位不存在或暂未开放预约')
  if (table.status !== 'available') throw new Error(`${requestedTableCode}${table.statusReason}，请重新选择`)
  return table
}
