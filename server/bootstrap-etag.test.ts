import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import { buildBootstrapViewEtag } from './bootstrap-etag.js'

describe('bootstrap view etag', () => {
  it('ignores heartbeat-only revision and lease timestamp changes', () => {
    const before = createSeedState()
    before.presenceLeases = [{
      sessionId: 'session-1',
      actorId: 'emp-chen',
      storeId: before.store.id,
      businessDate: before.store.businessDate,
      establishedAt: 100,
      lastSeenAt: 100,
      expiresAt: 1_000,
      sessionExpiresAt: 10_000,
    }]
    const after = structuredClone(before)
    after.revision += 1
    after.presenceLeases![0]!.lastSeenAt = 500
    after.presenceLeases![0]!.expiresAt = 1_500

    expect(buildBootstrapViewEtag(after)).toBe(buildBootstrapViewEtag(before))
  })

  it('is stable when PostgreSQL JSONB returns object keys in another order', () => {
    const before = createSeedState()
    const reordered = structuredClone(before)
    reordered.store = Object.fromEntries(Object.entries(reordered.store).reverse()) as typeof reordered.store

    expect(buildBootstrapViewEtag(reordered)).toBe(buildBootstrapViewEtag(before))
  })

  it('changes when employee availability or operating data changes', () => {
    const before = createSeedState()
    const online = structuredClone(before)
    online.employees[0]!.online = !online.employees[0]!.online
    const operatingDataChanged = structuredClone(before)
    operatingDataChanged.store.name = 'Updated store name'

    expect(buildBootstrapViewEtag(online)).not.toBe(buildBootstrapViewEtag(before))
    expect(buildBootstrapViewEtag(operatingDataChanged)).not.toBe(buildBootstrapViewEtag(before))
  })
})
