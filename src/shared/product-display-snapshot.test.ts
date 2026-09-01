import { describe, expect, it } from 'vitest'
import {
  productDisplaySnapshotHasOperationalFields,
  sanitizeProductDisplaySnapshot,
} from './product-display-snapshot'

describe('product display snapshot compatibility', () => {
  it('removes legacy operational fields without losing display metadata', () => {
    const source = {
      description: '陈年龙舌兰，适合纯饮',
      imageUrl: '/menu/tequila.webp',
      guestVisible: true,
      allowedChannels: ['guest_qr'],
      recommendation: { enabled: true, priority: 1, badge: '店长推荐' },
      source: { sortOrder: 10, importer: 'legacy-seed' },
    }

    expect(productDisplaySnapshotHasOperationalFields(source)).toBe(true)
    expect(sanitizeProductDisplaySnapshot(source)).toEqual({
      description: '陈年龙舌兰，适合纯饮',
      imageUrl: '/menu/tequila.webp',
      recommendation: { badge: '店长推荐' },
      source: { importer: 'legacy-seed' },
    })
    expect(source).toHaveProperty('guestVisible')
  })

  it('leaves a display-only snapshot unchanged', () => {
    const source = { description: '清爽', specification: '45ml', aliases: ['shot'] }
    expect(productDisplaySnapshotHasOperationalFields(source)).toBe(false)
    expect(sanitizeProductDisplaySnapshot(source)).toEqual(source)
  })
})
