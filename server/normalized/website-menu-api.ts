import { createHash } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { publicCatalogProduct, searchGuestCatalog } from './guest-commerce-service-api.js'
import { publicMiniProgramImageUrl } from './media-asset-url.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

type PublicProduct = ReturnType<typeof publicCatalogProduct>
const text = (value: unknown, max: number): string | null => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
export function websiteProduct(p: PublicProduct) {
  // A second, explicit publication boundary. No identity or operational DTO spread.
  if (!p.guestVisible) return null
  if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor === null || p.amountMinor < 0 || p.currency !== 'CNY') throw new Error('Invalid public price')
  const name = text(p.name, 200), code = text(p.code, 100)
  if (!name || !code || !p.productId) throw new Error('Invalid public product')
  return { id:p.productId, code, name, categoryCode:p.categoryCode,
    categoryName:text(p.categoryName,100) ?? '其他', categoryParentName:text(p.categoryParentName,100),
    specification:text(p.specification,200), description:text(p.description,1000),
    imageUrl:publicMiniProgramImageUrl(p.imageUrl), amountMinor:p.amountMinor, currency:'CNY' as const,
    availability:p.availabilityStatus === 'available' ? 'available' : p.availabilityStatus === 'scheduled' ? 'scheduled' : 'unavailable',
    sortOrder:p.sortOrder }
}
export const websiteMenuApiPlugin: FastifyPluginAsync<{
  transactions: Pick<ScopedPostgresTransactionRunner,'run'>; scope: Readonly<StoreScope>
}> = async (app, options) => {
  // Store scope is captured from server configuration; query/header/cookies cannot select it.
  const scope = Object.freeze({...options.scope})
  let pending: Promise<unknown> | undefined
  app.get('/public/website/menu', async (request, reply) => {
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff')
    if (Object.keys(request.query as object).length) return reply.code(400).send({error:{code:'WEBSITE_MENU_QUERY_INVALID'}})
    try {
      pending ??= options.transactions.run(scope, async transaction => {
        await transaction.query("SET LOCAL statement_timeout = '5000ms'")
        // One SQL statement, one snapshot, no 50-row client pagination truncation.
        const rows = await searchGuestCatalog(transaction,null,{search:'',categoryCode:null,limit:2001,offset:0,includeSoldOut:true},null)
        if (rows.length > 2000) throw new Error('Public menu size limit')
        const products = rows.map(publicCatalogProduct).map(websiteProduct).filter(p => p !== null)
          .sort((a,b) => a.sortOrder-b.sortOrder || a.id.localeCompare(b.id))
        const version = createHash('sha256').update(JSON.stringify(products)).digest('hex')
        return {data:{schemaVersion:1,version,checkedAt:new Date().toISOString(),currency:'CNY',products},meta:{count:products.length,complete:true}}
      },{readOnly:true,isolation:'repeatable-read'}).finally(() => {pending=undefined})
      return reply.send(await pending)
    } catch (error) {
      request.log.warn({err:error},'Public website menu read failed')
      return reply.code(503).send({error:{code:'WEBSITE_MENU_UNAVAILABLE'}})
    }
  })
}
