import type { NormalizedApiClient } from '../normalized-api'

const CATALOG_PAGE_SIZE = 100
const MAXIMUM_CATALOG_OFFSET = 10_000

/** Load a management catalog completely or fail instead of returning a partial first page. */
export async function loadCompleteActiveCatalog(
  api: Pick<NormalizedApiClient, 'getEndpoint'>,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const products = new Map<string, unknown>()
  for (let offset = 0; offset <= MAXIMUM_CATALOG_OFFSET; offset += CATALOG_PAGE_SIZE) {
    const response = await api.getEndpoint<{ data: unknown }>(
      `/api/catalog/products?status=active&limit=${CATALOG_PAGE_SIZE}&offset=${offset}`,
      { signal },
    )
    if (!Array.isArray(response.data)) throw new Error('商品目录返回格式无法识别')
    for (const value of response.data) {
      const id = productId(value)
      if (id !== null) products.set(id, value)
    }
    if (response.data.length < CATALOG_PAGE_SIZE) return [...products.values()]
  }
  throw new Error('商品数量超过安全读取范围，未返回不完整目录')
}

function productId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id.trim().length > 0 ? id : null
}
