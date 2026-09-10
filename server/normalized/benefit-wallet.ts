import type { Benefit } from './benefit-repository.js'

export type BenefitWalletState = 'available' | 'upcoming' | 'reserved' | 'redeemed' | 'expired' | 'revoked' | 'unavailable' | 'outside_window'
export interface BenefitWalletCursor { createdAt: string; id: string }

// Read-model status only. This must never authorize redemption or release a hold.
export function benefitWalletState(
  benefit: Pick<Benefit, 'status' | 'quantityAvailable' | 'quantityReserved' | 'quantityRedeemed' | 'quantityTotal' | 'validFrom' | 'validUntil' | 'calendar'>,
  at: Date,
): BenefitWalletState {
  if (benefit.status === 'revoked') return 'revoked'
  if (benefit.status === 'redeemed' || benefit.quantityRedeemed >= benefit.quantityTotal) return 'redeemed'
  // A persisted hold can outlive the display validity. Only its authoritative
  // cancellation/redemption transaction may free it, not this GET or a clock.
  if (benefit.quantityReserved > 0 && benefit.quantityAvailable <= 0) return 'reserved'
  const from = Date.parse(benefit.validFrom)
  const until = benefit.validUntil === null ? Infinity : Date.parse(benefit.validUntil)
  if (!Number.isFinite(at.getTime()) || !Number.isFinite(from) || Number.isNaN(until)) return 'unavailable'
  if (benefit.status === 'expired' || until <= at.getTime()) return 'expired'
  if (from > at.getTime()) return 'upcoming'
  if (benefit.calendar?.available === false) return benefit.calendar.nextAvailableAt === null ? 'expired' : 'outside_window'
  return benefit.quantityAvailable > 0 ? 'available' : 'unavailable'
}

export function parseBenefitWalletCursor(value: unknown): BenefitWalletCursor | null {
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length > 120) throw new Error('优惠券分页位置无效')
  const parts = value.split('|')
  if (parts.length !== 2 || !Number.isFinite(Date.parse(parts[0]!))
    || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4])(?::?[0-5]\d)?)$/.test(parts[0]!)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1]!)) {
    throw new Error('优惠券分页位置无效')
  }
  const [year, month, day] = parts[0]!.slice(0, 10).split('-').map(Number)
  if (day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate()) throw new Error('优惠券分页位置无效')
  return { createdAt: parts[0]!, id: parts[1]! }
}
