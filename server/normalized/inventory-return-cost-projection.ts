import { InventoryConflictError, InventoryRepository } from './inventory-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

/** The original command/event may be retried after the competing writer commits.
 * This is not a business refusal: no inventory or command receipt is committed. */
export class InventoryReturnCostProjectionBusyError extends Error {
  readonly code = 'INVENTORY_RETURN_COST_RETRY'
  readonly retryable = true
  constructor(options?: ErrorOptions) {
    super('商品成本正在更新，本次退库尚未提交，请稍后用原操作重试核对', options)
    this.name = 'InventoryReturnCostProjectionBusyError'
  }
}

/** Returns already own stock locks, while orders acquire product locks first.
 * Never wait for the reverse lock order: prelock every dependency NOWAIT, then
 * use the same cost calculation as receipts. Any conflict rolls back the return.
 * Parent/FK locks also prevent new recipe/bundle edges appearing after discovery. */
export async function synchronizeInventoryReturnCostProjection(
  tx: ScopedTransaction,
  input: { inventoryItemId: string; movementId: string; employeeId: string | null },
): Promise<void> {
  const scope = [tx.scope.tenantId, tx.scope.storeId]
  try {
    await tx.query(`SELECT id FROM mbox.inventory_items WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE NOWAIT`,
      [...scope, input.inventoryItemId])
    // Include inactive recipes: activating one must not escape dependency locks.
    const owners = (await tx.query<{ product_id: string }>(`SELECT DISTINCT recipe.product_id
      FROM mbox.recipes recipe JOIN mbox.recipe_items component
        ON component.tenant_id=recipe.tenant_id AND component.store_id=recipe.store_id AND component.recipe_id=recipe.id
      WHERE recipe.tenant_id=$1 AND recipe.store_id=$2 AND component.inventory_item_id=$3
      ORDER BY recipe.product_id`, [...scope, input.inventoryItemId])).rows.map(row => row.product_id)
    if (!owners.length) return
    // replaceActiveRecipe uses this same advisory lock, including new versions.
    for (const id of owners) {
      const locked = (await tx.query<{ locked: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked`,
        [`inventory-recipe:${tx.scope.tenantId}:${tx.scope.storeId}:${id}`])).rows[0]?.locked
      if (!locked) throw new InventoryReturnCostProjectionBusyError()
    }
    await tx.query(`SELECT id FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE NOWAIT`, [...scope, owners])
    await tx.query(`SELECT id FROM mbox.recipes WHERE tenant_id=$1 AND store_id=$2 AND product_id=ANY($3::uuid[]) ORDER BY id FOR UPDATE NOWAIT`, [...scope, owners])
    const active = (await tx.query<{ id: string; product_id: string }>(`SELECT recipe.id,recipe.product_id
      FROM mbox.recipes recipe JOIN mbox.products product
        ON product.tenant_id=recipe.tenant_id AND product.store_id=recipe.store_id AND product.id=recipe.product_id
      WHERE recipe.tenant_id=$1 AND recipe.store_id=$2 AND recipe.product_id=ANY($3::uuid[])
        AND recipe.status='active' AND product.inventory_control_mode='tracked' ORDER BY recipe.product_id`, [...scope, owners])).rows
    if (!active.length) return
    const materials = (await tx.query<{ inventory_item_id: string }>(`SELECT inventory_item_id FROM mbox.recipe_items
      WHERE tenant_id=$1 AND store_id=$2 AND recipe_id=ANY($3::uuid[]) ORDER BY id FOR UPDATE NOWAIT`,
    [...scope, active.map(row => row.id)])).rows.map(row => row.inventory_item_id)
    const materialIds = [...new Set(materials)].sort()
    await tx.query(`SELECT id FROM mbox.inventory_items WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE NOWAIT`, [...scope, materialIds])
    const balances = await tx.query(`SELECT inventory_item_id FROM mbox.inventory_balances
      WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=ANY($3::uuid[]) ORDER BY inventory_item_id FOR UPDATE NOWAIT`, [...scope, materialIds])
    if (balances.rowCount !== materialIds.length) {
      throw new InventoryConflictError('配方物料库存余额不完整，退库未提交，请先核对库存记录')
    }
    const productIds = active.map(row => row.product_id)
    const bundles = (await tx.query<{ bundle_product_id: string }>(`SELECT DISTINCT bundle_product_id FROM mbox.product_bundle_components
      WHERE tenant_id=$1 AND store_id=$2 AND component_product_id=ANY($3::uuid[])
      UNION SELECT choice_group.bundle_product_id FROM mbox.product_bundle_choice_options choice_option
      JOIN mbox.product_bundle_choice_groups choice_group
        ON choice_group.tenant_id=choice_option.tenant_id AND choice_group.store_id=choice_option.store_id AND choice_group.id=choice_option.choice_group_id
      WHERE choice_option.tenant_id=$1 AND choice_option.store_id=$2 AND choice_option.component_product_id=ANY($3::uuid[])
      ORDER BY bundle_product_id`, [...scope, productIds])).rows.map(row => row.bundle_product_id)
    if (bundles.length) {
      await tx.query(`SELECT id FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE NOWAIT`, [...scope, bundles])
      const companions = (await tx.query<{ component_product_id: string }>(`SELECT component_product_id FROM mbox.product_bundle_components
        WHERE tenant_id=$1 AND store_id=$2 AND bundle_product_id=ANY($3::uuid[]) ORDER BY id FOR UPDATE NOWAIT`, [...scope, bundles])).rows.map(row => row.component_product_id)
      const groups = (await tx.query<{ id: string }>(`SELECT id FROM mbox.product_bundle_choice_groups
        WHERE tenant_id=$1 AND store_id=$2 AND bundle_product_id=ANY($3::uuid[]) ORDER BY id FOR UPDATE NOWAIT`, [...scope, bundles])).rows.map(row => row.id)
      const options = (await tx.query<{ component_product_id: string }>(`SELECT component_product_id FROM mbox.product_bundle_choice_options
        WHERE tenant_id=$1 AND store_id=$2 AND choice_group_id=ANY($3::uuid[]) ORDER BY id FOR UPDATE NOWAIT`, [...scope, groups])).rows.map(row => row.component_product_id)
      await tx.query(`SELECT id FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE NOWAIT`, [...scope, [...companions, ...options]])
    }
    const repository = new InventoryRepository(tx)
    for (const row of active) await repository.synchronizeTrackedProductRecipeCost(
      row.product_id, input.employeeId, `实际退库后自动重算：${input.movementId}`, input.movementId,
    )
    await repository.synchronizeBundleCostsForComponentProducts(productIds)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03') {
      throw new InventoryReturnCostProjectionBusyError({ cause: error })
    }
    throw error
  }
}
