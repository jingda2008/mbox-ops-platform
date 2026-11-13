import { CHANNEL_ERROR_MESSAGES, type ChannelErrorCode, type ChannelRule } from '../../src/shared/channel-distribution.js'

export class ChannelDistributionError extends Error {
  constructor(readonly code: ChannelErrorCode, readonly statusCode = 409) { super(CHANNEL_ERROR_MESSAGES[code]); this.name = 'ChannelDistributionError' }
}

export class ChannelBusinessError extends ChannelDistributionError { constructor(message:string){super('VERSION_CONFLICT',409);this.message=message} }

export function requireChannelWindow(from: string, until: string, now: Date): void {
  const start = Date.parse(from), end = Date.parse(until), time = now.getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(time) || end <= start) throw new ChannelDistributionError('VERSION_CONFLICT')
  if (time < start) throw new ChannelDistributionError('NOT_STARTED')
  if (time >= end) throw new ChannelDistributionError('EXPIRED')
}

export function assertChannelClaimCapacity(input: {
  rule: ChannelRule; issued: number; customerIssued: number; poolRemaining: number; capacityRemaining: number; paused: boolean; now: Date
}): void {
  requireChannelWindow(input.rule.claimFrom, input.rule.claimUntil, input.now)
  if (input.paused) throw new ChannelDistributionError('PAUSED')
  if (input.issued >= input.rule.totalClaims || input.poolRemaining < 1) throw new ChannelDistributionError('CLAIM_LIMIT')
  if (input.customerIssued >= input.rule.perCustomerClaims) throw new ChannelDistributionError('CUSTOMER_LIMIT')
  if (input.capacityRemaining < 1) throw new ChannelDistributionError('CAPACITY')
}

/** Called only for NEW activation: replay is returned before inspecting expiry.
 * Issuance quota is deliberately absent: a previously issued coupon is a promise. */
export function assertChannelActivation(input: {
  rule: ChannelRule; now: Date; couponCustomerId: string; verifiedCustomerId: string
  atCurrentVisit: boolean; usedAndHeld: number; lockedVisitLimit: number | null
  existingSource: string | null; source: string; existingCampaign: string | null; campaign: string
}): void {
  if (!input.atCurrentVisit || input.couponCustomerId !== input.verifiedCustomerId) throw new ChannelDistributionError('OWNERSHIP', 403)
  requireChannelWindow(input.rule.useFrom, input.rule.useUntil, input.now)
  if (input.existingSource !== null && (input.existingSource !== input.source || input.existingCampaign !== input.campaign)) throw new ChannelDistributionError('SOURCE_CONFLICT')
  if (input.usedAndHeld >= Math.min(input.lockedVisitLimit ?? input.rule.perVisitUses, input.rule.perVisitUses)) throw new ChannelDistributionError('VISIT_LIMIT')
}

function integer(value: number, signed = false): bigint {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) throw new ChannelDistributionError('INVALID_AMOUNT')
  return BigInt(value)
}
function safeNumber(value: bigint): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) throw new ChannelDistributionError('INVALID_AMOUNT')
  return n
}

/** Cumulative rounding removes split-order / partial-refund rounding drift. */
export function channelCommissionDelta(netBasisMinor: number, rateBps: number, previouslyAccruedMinor: number): { targetMinor: number; deltaMinor: number } {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) throw new ChannelDistributionError('INVALID_AMOUNT')
  const target = (integer(netBasisMinor) * BigInt(rateBps) + 5000n) / 10000n
  return { targetMinor: safeNumber(target), deltaMinor: safeNumber(target - integer(previouslyAccruedMinor, true)) }
}

/** Deterministic largest-remainder allocation. Stable keys, never caller order,
 * determine the pennies; cancellations/refunds must refer to this saved split. */
export function allocateChannelAmount(amountMinor: number, lines: readonly { id: string; basisMinor: number }[]): { id: string; amountMinor: number }[] {
  const amount = integer(amountMinor)
  if (new Set(lines.map(l => l.id)).size !== lines.length) throw new ChannelDistributionError('INVALID_AMOUNT')
  const total = lines.reduce((sum, l) => sum + integer(l.basisMinor), 0n)
  if (amount > total) throw new ChannelDistributionError('INVALID_AMOUNT')
  if (total === 0n) return lines.map(l => ({ id: l.id, amountMinor: 0 }))
  const parts = lines.map(l => ({ id: l.id, share: amount * integer(l.basisMinor) / total, remainder: amount * integer(l.basisMinor) % total }))
  const ranked = [...parts].sort((a, b) => a.remainder === b.remainder ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.remainder > b.remainder ? -1 : 1)
  let left = amount - parts.reduce((sum, l) => sum + l.share, 0n)
  for (const part of ranked) { if (left === 0n) break; part.share++; left-- }
  return parts.map(l => ({ id: l.id, amountMinor: safeNumber(l.share) }))
}

/** Total entitlement, not a new grant per order. Callers reserve only the delta. */
export function channelDiscountTarget(rule: ChannelRule, eligibleMinor: number): number {
  const basis = integer(eligibleMinor)
  if (eligibleMinor < rule.minimumMinor || rule.offer.kind === 'gift') return 0
  if (rule.offer.kind === 'credit') return Math.min(eligibleMinor, rule.offer.amountMinor)
  const reduction = safeNumber((basis * BigInt(rule.offer.discountBps) + 5000n) / 10000n)
  return Math.min(eligibleMinor, reduction, rule.offer.maximumMinor)
}
