import type { ScopedTransaction } from './transaction-runner.js'
import { parseProductServiceWindow, type ProductServiceWindow } from '../../src/shared/product-service-window.js'

export async function readProductServiceWindow(tx: ScopedTransaction, productId: string, projectId: string|null = null): Promise<ProductServiceWindow|null> {
  const result=await tx.query<{window:unknown}>('SELECT mbox.product_service_window_json($1,$2,$3,$4) AS window',[tx.scope.tenantId,tx.scope.storeId,productId,projectId])
  return parseProductServiceWindow(result.rows[0]?.window)
}

export async function saveProductServiceWindow(tx: ScopedTransaction, productId: string, value: unknown, projectId: string|null = null) {
  const window=parseProductServiceWindow(value)
  const args=[tx.scope.tenantId,tx.scope.storeId,productId,projectId]
  await tx.query('SELECT id FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',args.slice(0,3))
  if(!window){
    await tx.query('DELETE FROM mbox.product_service_windows WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND card_project_id IS NOT DISTINCT FROM $4::uuid',args)
    if(projectId===null) await validateProductServiceWindowOverlaps(tx,productId)
    return
  }
  await tx.query(`INSERT INTO mbox.product_service_windows(tenant_id,store_id,product_id,card_project_id,date_from,date_through,weekdays,sale_start_minute,sale_end_minute,visible_start_minute,visible_end_minute)
    VALUES($1,$2,$3,$4,$5::date,$6::date,$7::smallint[],$8,$9,$10,$11)
    ON CONFLICT(tenant_id,store_id,product_id,card_project_id) DO UPDATE SET date_from=EXCLUDED.date_from,date_through=EXCLUDED.date_through,weekdays=EXCLUDED.weekdays,
    sale_start_minute=EXCLUDED.sale_start_minute,sale_end_minute=EXCLUDED.sale_end_minute,visible_start_minute=EXCLUDED.visible_start_minute,visible_end_minute=EXCLUDED.visible_end_minute,updated_at=clock_timestamp()`,
    [...args,window.dateFrom,window.dateThrough,window.weekdays,window.saleStartMinute,window.saleEndMinute,window.visibleStartMinute,window.visibleEndMinute])
  if(projectId){
    const overlap=await tx.query<{allowed:boolean}>(`SELECT mbox.product_service_windows_overlap($1,$2,$3,$4) AS allowed`,args)
    if(overlap.rows[0]?.allowed===false)throw new TypeError('专属时段与商品基础供应时段没有交集，无法售卖')
  } else await validateProductServiceWindowOverlaps(tx,productId)
}

/** Changing the product supply must not silently publish an empty active card intersection. */
export async function validateProductServiceWindowOverlaps(tx:ScopedTransaction,productId:string) {
  const invalid=await tx.query(`SELECT w.card_project_id FROM mbox.product_service_windows w
    JOIN mbox.member_card_menu_items mi ON (mi.tenant_id,mi.store_id,mi.product_id,mi.project_id)=(w.tenant_id,w.store_id,w.product_id,w.card_project_id)
    WHERE w.tenant_id=$1 AND w.store_id=$2 AND w.product_id=$3 AND mi.active
      AND NOT mbox.product_service_windows_overlap(w.tenant_id,w.store_id,w.product_id,w.card_project_id) LIMIT 1`,[tx.scope.tenantId,tx.scope.storeId,productId])
  if(invalid.rowCount)throw new TypeError('新的基础供应时间与已启用专属菜单没有交集，请先调整专属时段')
}
