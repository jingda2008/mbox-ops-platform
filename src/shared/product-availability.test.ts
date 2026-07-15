import { describe, expect, it } from 'vitest'
import type { MenuProduct } from './contracts.js'
import { productAvailability } from './product-availability.js'

const product: MenuProduct = {
  id: 'product-test', sku: 'TEST', name: '测试商品', specification: '1份',
  listPriceAmount: 1000, costAmount: 200, stationId: 'bar-main', enabled: true, configVersion: 1,
}

const atShanghaiTime = (hour: number, minute = 0) => new Date(Date.UTC(2026, 6, 15, hour - 8, minute))

describe('product availability', () => {
  it('keeps an unrestricted enabled product orderable', () => {
    expect(productAvailability(product, atShanghaiTime(18))).toEqual({ state: 'available', orderable: true, label: '在售' })
  })

  it('shows sold-out and hidden products without allowing an order', () => {
    expect(productAvailability({ ...product, soldOut: true, soldOutReason: '原料补货中' })).toEqual({
      state: 'sold_out', orderable: false, label: '原料补货中',
    })
    expect(productAvailability({ ...product, enabled: false }).state).toBe('hidden')
  })

  it('supports daytime and cross-midnight service windows', () => {
    const daytime = { ...product, availableFrom: '18:00', availableUntil: '23:00' }
    expect(productAvailability(daytime, atShanghaiTime(20)).orderable).toBe(true)
    expect(productAvailability(daytime, atShanghaiTime(2))).toMatchObject({ state: 'scheduled', orderable: false })

    const overnight = { ...product, availableFrom: '20:00', availableUntil: '02:00' }
    expect(productAvailability(overnight, atShanghaiTime(23, 30)).orderable).toBe(true)
    expect(productAvailability(overnight, atShanghaiTime(1, 30)).orderable).toBe(true)
    expect(productAvailability(overnight, atShanghaiTime(2)).orderable).toBe(false)
    expect(productAvailability(overnight, atShanghaiTime(19)).orderable).toBe(false)
  })
})
