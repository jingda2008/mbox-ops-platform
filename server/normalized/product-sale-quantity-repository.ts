import { OrderProductUnavailableError, type OrderItem } from './order-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

type Product = { id: string; name: string; sale_remaining_quantity: number; sale_quantity_generation: string }
type Allocation = { order_item_id: string; product_id: string; generation: string; quantity: number; status: string }

export class ProductSaleQuantityUnavailableError extends OrderProductUnavailableError {}

/** Optional sales portions, separate from ingredient inventory and cost accounting. */
export class ProductSaleQuantityRepository {
  constructor(private readonly tx: ScopedTransaction) {}

  async allocate(items: readonly OrderItem[], status: 'reserved' | 'consumed'): Promise<void> {
    if (!items.length) return
    // Every caller is inside the original order transaction. A stable product
    // lock order prevents two different orders overselling the last portion.
    const products = await this.tx.query<Product>(`/* product-sale-quantity */
      SELECT id,name,sale_remaining_quantity,sale_quantity_generation::text
      FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])
        AND sale_remaining_quantity IS NOT NULL ORDER BY id FOR UPDATE`,
      [this.tx.scope.tenantId,this.tx.scope.storeId,[...new Set(items.map(item=>item.productId))]])
    if (!products.rows.length) return
    const current = await this.tx.query<Allocation>(`/* product-sale-quantity */
      SELECT order_item_id,product_id,generation::text,quantity,status
      FROM mbox.product_sale_quantity_allocations WHERE tenant_id=$1 AND store_id=$2
        AND order_item_id=ANY($3::uuid[]) FOR UPDATE`,
      [this.tx.scope.tenantId,this.tx.scope.storeId,items.map(item=>item.id)])
    const allocated = new Map(current.rows.map(row=>[row.order_item_id,row]))
    for (const product of products.rows) {
      const pending = items.filter(item=>item.productId===product.id &&
        (!allocated.has(item.id)||allocated.get(item.id)!.status==='released'))
      const required = pending.reduce((sum,item)=>sum+item.quantity,0)
      if (!required) continue
      if (required>product.sale_remaining_quantity) throw new ProductSaleQuantityUnavailableError(product.id,
        `${product.name}剩余可售${product.sale_remaining_quantity}份，请减少数量或选择其他菜品`)
      await this.tx.query(`/* product-sale-quantity */ UPDATE mbox.products
        SET sale_remaining_quantity=sale_remaining_quantity-$4,sale_quantity_version=sale_quantity_version+1
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
        [this.tx.scope.tenantId,this.tx.scope.storeId,product.id,required])
      for (const item of pending) await this.tx.query(`/* product-sale-quantity */
        INSERT INTO mbox.product_sale_quantity_allocations(tenant_id,store_id,order_item_id,order_id,product_id,generation,quantity,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(tenant_id,store_id,order_item_id) DO UPDATE
        SET generation=EXCLUDED.generation,quantity=EXCLUDED.quantity,status=EXCLUDED.status,updated_at=clock_timestamp()
        WHERE product_sale_quantity_allocations.status='released'`,
        [this.tx.scope.tenantId,this.tx.scope.storeId,item.id,item.orderId,item.productId,product.sale_quantity_generation,item.quantity,status])
    }
  }

  async consume(orderId: string, orderItemId: string | null = null): Promise<void> {
    // No new deduction here: payment/production only commits an existing hold.
    await this.tx.query(`/* product-sale-quantity */ UPDATE mbox.product_sale_quantity_allocations
      SET status='consumed',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND status='reserved'
        AND (($3::uuid IS NOT NULL AND order_id=$3) OR ($4::uuid IS NOT NULL AND order_item_id=$4))`,
      [this.tx.scope.tenantId,this.tx.scope.storeId,orderId || null,orderItemId])
  }

  async release(orderId: string): Promise<void> {
    // Products always precede allocations in the lock order. Disabling and
    // enabling a cap starts a new generation; old cancellations cannot refill it.
    await this.tx.query(`/* product-sale-quantity */ SELECT id FROM mbox.products
      WHERE tenant_id=$1 AND store_id=$2 AND id IN
        (SELECT product_id FROM mbox.product_sale_quantity_allocations WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status='reserved')
      ORDER BY id FOR UPDATE`,[this.tx.scope.tenantId,this.tx.scope.storeId,orderId])
    const released = await this.tx.query<Allocation>(`/* product-sale-quantity */
      UPDATE mbox.product_sale_quantity_allocations SET status='released',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status='reserved'
      RETURNING product_id,generation::text,quantity`,[this.tx.scope.tenantId,this.tx.scope.storeId,orderId])
    for (const row of released.rows) await this.tx.query(`/* product-sale-quantity */
      UPDATE mbox.products SET sale_remaining_quantity=sale_remaining_quantity+$5,sale_quantity_version=sale_quantity_version+1
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND sale_quantity_generation=$4 AND sale_remaining_quantity IS NOT NULL`,
      [this.tx.scope.tenantId,this.tx.scope.storeId,row.product_id,row.generation,row.quantity])
  }
}
