import { describe, expect, it } from 'vitest'
import { extractProductOperationalFields, hydrateProductSnapshot } from './product-operational-fields.js'

describe('product operational strong fields', () => {
  it('keeps the 9999 quantity business case and strips runtime decisions from display JSON', () => {
    const operational = extractProductOperationalFields({
      description: '补差额',
      guestVisible: false,
      searchText: '补差额 其他',
      maxOrderQuantity: 9_999,
      allowedChannels: ['cashier'],
      availableFrom: '18:00',
      availableUntil: '02:00',
      kdsPriority: 900,
      fulfillmentSlaSeconds: 300,
      costAmount: 0,
      recommendation: {
        enabled: true,
        minimumPartySize: 2,
        maximumPartySize: 6,
        priority: 500,
        sceneTags: ['friends'],
      },
    }, { code: 'OTHER-001', name: '补差额' })

    expect(operational).toMatchObject({
      guestVisible: false,
      maxOrderQuantity: 9_999,
      allowedChannels: ['cashier'],
      availableFrom: '18:00',
      availableUntil: '02:00',
      kdsPriority: 900,
      fulfillmentSlaSeconds: 300,
      costAmountMinor: 0,
      recommendationEnabled: true,
      recommendationMinGuests: 2,
      recommendationMaxGuests: 6,
    })
    expect(operational.displaySnapshot).toEqual({ description: '补差额', recommendation: {} })
  })

  it('rejects invalid availability and empty channel policies instead of silently widening access', () => {
    expect(() => extractProductOperationalFields({
      availableFrom: '18:00', allowedChannels: ['cashier'],
    }, { code: 'A', name: 'A' })).toThrow(/configured together/)
    expect(() => extractProductOperationalFields({
      allowedChannels: [],
    }, { code: 'A', name: 'A' })).toThrow(/allowedChannels/)
  })

  it('hydrates compatibility copies for an application rollback without changing typed authority', () => {
    const snapshot = hydrateProductSnapshot({ description: '可回滚展示' }, {
      guestVisible: true,
      searchText: '商品 A',
      recommendationEnabled: false,
      recommendationMinGuests: 1,
      recommendationMaxGuests: 100,
      recommendationPriority: 100,
      recommendationSceneTags: [],
      recommendationIntentTags: [],
      recommendationTasteTags: [],
      recommendationDwellTags: [],
      recommendationSingleWaveEligible: true,
      recommendationExpectedPrepMinutes: 8,
      recommendationHoldMinutes: 10,
      recommendationUpgradeProductId: null,
      menuSortOrder: 20,
      availableFrom: null,
      availableUntil: null,
      allowedChannels: ['guest_qr', 'cashier'],
      maxOrderQuantity: 50,
      kdsPriority: 100,
      fulfillmentSlaSeconds: null,
      costAmountMinor: 1200,
    })
    expect(snapshot).toMatchObject({
      description: '可回滚展示', searchText: '商品 A', sortOrder: 20,
      allowedChannels: ['guest_qr', 'cashier'], maxOrderQuantity: 50, costAmount: 1200,
    })
  })
})
