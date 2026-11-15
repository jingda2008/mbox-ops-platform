import { parseInstant } from '../shared/instant-time'
export interface MenuChannelQuote {
  id: string
  expiresAt: string
  payableMinor: number
  discountMinor: number
  fingerprint: string
}

/** The same authoritative quote drives every payable total and the final submit gate. */
export function menuCheckoutPricing(input: {
  originalMinor: number
  quote: MenuChannelQuote | null
  fingerprint: string
  now: number
  loading?: boolean
  needsReview?: boolean
  sameSource?: boolean
}) {
  const { quote } = input
  const valid = quote !== null && input.sameSource !== false && quote.fingerprint === input.fingerprint
    && Boolean(quote.id) && parseInstant(quote.expiresAt) > input.now
    && Number.isSafeInteger(quote.payableMinor) && quote.payableMinor >= 0
    && Number.isSafeInteger(quote.discountMinor) && quote.discountMinor >= 0
  const needsReview = Boolean(input.loading || input.needsReview || (quote && !valid))
  return {
    needsReview,
    amountMinor: needsReview ? null : valid ? quote.payableMinor : input.originalMinor,
    label: needsReview ? '待核对优惠' : valid ? '优惠后应付' : '合计',
    quoteId: !needsReview && valid ? quote.id : undefined,
    discountMinor: !needsReview && valid ? quote.discountMinor : null,
  }
}
