import { describe, expect, it } from 'vitest'
import { menuCheckoutPricing, type MenuChannelQuote } from './menu-channel-pricing'
const now = Date.parse('2026-11-15T10:00:00Z')
const quote: MenuChannelQuote = {id:'quote-1',expiresAt:'2026-11-15T10:01:00Z',payableMinor:9000,discountMinor:1000,fingerprint:'W1-1x100'}
const price = (patch: Partial<Parameters<typeof menuCheckoutPricing>[0]> = {}) => menuCheckoutPricing({originalMinor:10000,quote,fingerprint:quote.fingerprint,now,...patch})
describe('one payable amount throughout channel checkout', () => {
  it.each([[9000,1000],[8000,2000],[12345,655],[0,10000],[10000,0]])('uses server payable %i including caps, decimals and zero', (payableMinor,discountMinor) => {
    expect(price({quote:{...quote,payableMinor,discountMinor}})).toMatchObject({amountMinor:payableMinor,label:'优惠后应付',quoteId:'quote-1',needsReview:false,discountMinor})
  })
  it('uses the current regular price only without a quote or after an explicit opt-out', () => {
    expect(price({quote:null})).toMatchObject({amountMinor:10000,label:'合计',quoteId:undefined,needsReview:false})
  })
  it.each([{loading:true},{needsReview:true},{fingerprint:'W2-1x100'},{fingerprint:'W1-2x100'}, {sameSource:false},{now:now+60000}])('never presents stale or pending amounts as payable: %j', patch => {
    expect(price(patch)).toMatchObject({amountMinor:null,quoteId:undefined,needsReview:true,label:'待核对优惠'})
  })
  it.each([{payableMinor:-1},{payableMinor:NaN},{payableMinor:1.5},{payableMinor:Number.MAX_SAFE_INTEGER+1},{discountMinor:-1},{discountMinor:NaN},{expiresAt:'invalid'},{id:''}])('rejects malformed quote %j', patch => {
    expect(price({quote:{...quote,...patch}}).amountMinor).toBeNull()
  })
  it('rechecks the same quote at final confirmation rather than trusting earlier validation', () => {
    expect(price().quoteId).toBe('quote-1')
    expect(price({now:now+60001}).quoteId).toBeUndefined()
    expect(price({now:now+60001}).needsReview).toBe(true)
  })
})
