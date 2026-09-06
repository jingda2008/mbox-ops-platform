import { describe, expect, it, vi } from 'vitest'
import { NormalizedApiClient } from '../normalized-api'
import { loadCompleteActiveCatalog } from './complete-catalog'

function products(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `product-${start + index}`, name: `商品${start + index}` }))
}

describe('loadCompleteActiveCatalog', () => {
  it('loads products beyond the first 100 and removes a repeated boundary record', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: products(0, 100) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [products(0, 100)[99], ...products(100, 20)] }), { status: 200 }))
    const api = new NormalizedApiClient({ fetch: send })

    await expect(loadCompleteActiveCatalog(api)).resolves.toHaveLength(120)
    expect(send.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/catalog/products?status=active&limit=100&offset=0',
      '/api/catalog/products?status=active&limit=100&offset=100',
    ])
  })

  it('fails instead of treating an invalid later page as a complete catalog', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: products(0, 100) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null }), { status: 200 }))
    const api = new NormalizedApiClient({ fetch: send })

    await expect(loadCompleteActiveCatalog(api)).rejects.toThrow('商品目录返回格式无法识别')
  })
})
