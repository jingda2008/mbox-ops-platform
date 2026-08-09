import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createSeedState } from '../dist-server/server/seed.js'
import { receiveInventory } from '../dist-server/server/inventory-domain.js'

const output = resolve(process.env.MBOX_LOAD_STATE_PATH?.trim() || '.runtime/rc68-load-state.json')
const referenceTime = new Date(process.env.MBOX_LOAD_REFERENCE_TIME ?? '2026-08-09T12:00:00.000Z')
if (!Number.isFinite(referenceTime.getTime())) throw new Error('MBOX_LOAD_REFERENCE_TIME must be a valid ISO timestamp')
const state = createSeedState(referenceTime)
if (!state.inventoryDomain) throw new Error('RC68 load fixture requires an inventory domain')
receiveInventory(state.inventoryDomain, {
  movementId: 'rc68-load-cocktail-opening-stock',
  productId: 'product-cocktail',
  unitCode: 'serving',
  quantity: 10_000,
  actorId: 'emp-chen',
  reason: 'RC68负载测试招牌鸡尾酒期初库存',
  businessDate: state.store.businessDate,
  occurredAt: referenceTime.toISOString(),
  idempotencyKey: 'rc68-load-cocktail-opening-stock-v1',
})
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
console.log(output)
