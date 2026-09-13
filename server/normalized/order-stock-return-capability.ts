/** Read-only capability mirrors the original physical-return conditions. It
 * never asserts that goods have been received or that a refund implies units. */
export function legacyStockReturnCapabilitySql(item:string):string {
  if(!/^[a-z_]+$/.test(item))throw new TypeError('Invalid stock-return item alias')
  return `SELECT jsonb_build_object(
    'remainingQuantity',facts.remaining,
    'canReturnUnmade',facts.eligible AND ${item}.status='cancelled' AND NOT facts.started AND facts.tasks_stopped,
    'canReturnUnopened',facts.eligible AND ${item}.status IN ('delivered','cancelled') AND facts.packaged,
    'reason',CASE WHEN facts.quantity_managed THEN '请在原商品售后中按份数处理'
      WHEN facts.redemption THEN '积分兑换商品沿用原兑换恢复流程'
      WHEN facts.remaining=0 OR facts.restored THEN '库存已恢复或预留已释放，无需再次退库'
      WHEN NOT facts.refunded THEN '尚无本商品成功退货退款依据'
      WHEN facts.reservation_count=0 THEN '没有可退的原已扣减库存记录'
      WHEN NOT facts.all_consumed THEN '原库存处置状态需核对，不重复释放或回库'
      WHEN ${item}.status NOT IN ('delivered','cancelled') THEN '仍在出品或配送中，先核对实际商品去向'
      WHEN NOT facts.packaged AND NOT (${item}.status='cancelled' AND NOT facts.started AND facts.tasks_stopped) THEN '已制作配方或散装商品不能自动还原为原料'
      ELSE '仅按实际收回或已核实未制作的份数登记' END) AS capability
    FROM (
      SELECT raw.*,raw.remaining>0 AND raw.refunded AND NOT raw.redemption AND NOT raw.quantity_managed
        AND raw.reservation_count>0 AND raw.all_consumed AND NOT raw.restored AS eligible
      FROM (
        SELECT GREATEST(0,${item}.quantity-(SELECT COALESCE(sum(quantity),0) FROM mbox.order_stock_returns returned
            WHERE returned.tenant_id=${item}.tenant_id AND returned.store_id=${item}.store_id AND returned.order_item_id=${item}.id))::integer AS remaining,
          EXISTS(SELECT 1 FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=${item}.tenant_id AND unit.store_id=${item}.store_id AND unit.order_item_id=${item}.id) AS quantity_managed,
          EXISTS(SELECT 1 FROM mbox.member_redemptions redemption WHERE redemption.tenant_id=${item}.tenant_id AND redemption.store_id=${item}.store_id AND redemption.order_id=${item}.order_id) AS redemption,
          EXISTS(SELECT 1 FROM mbox.refunds refund JOIN mbox.payments payment ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
            JOIN mbox.refund_items allocation ON allocation.tenant_id=refund.tenant_id AND allocation.store_id=refund.store_id AND allocation.refund_id=refund.id
            WHERE refund.tenant_id=${item}.tenant_id AND refund.store_id=${item}.store_id AND COALESCE(refund.order_id,payment.order_id)=${item}.order_id
              AND refund.status='succeeded' AND (refund.purpose IS NULL OR refund.purpose='return_goods')
              AND (allocation.order_item_id=${item}.id OR allocation.order_item_id=${item}.parent_order_item_id)) AS refunded,
          EXISTS(SELECT 1 FROM mbox.kds_tasks task JOIN mbox.kds_task_events event ON event.tenant_id=task.tenant_id AND event.store_id=task.store_id AND event.kds_task_id=task.id
            WHERE task.tenant_id=${item}.tenant_id AND task.store_id=${item}.store_id AND task.order_item_id=${item}.id
              AND (event.from_status IN ('preparing','ready') OR event.to_status IN ('preparing','ready'))) AS started,
          NOT EXISTS(SELECT 1 FROM mbox.kds_tasks task WHERE task.tenant_id=${item}.tenant_id AND task.store_id=${item}.store_id AND task.order_item_id=${item}.id
            AND (task.ready_at IS NOT NULL OR task.status NOT IN ('cancelled','failed'))) AS tasks_stopped,
          (reservation_facts.all_restored OR EXISTS(SELECT 1 FROM mbox.inventory_movements movement WHERE movement.tenant_id=${item}.tenant_id AND movement.store_id=${item}.store_id
            AND movement.order_item_id=${item}.id AND movement.reference_type='refund_unmade' AND movement.movement_type='return')) AS restored,
          reservation_facts.total AS reservation_count,reservation_facts.all_consumed,reservation_facts.packaged
        FROM LATERAL(SELECT count(*)::integer AS total,COALESCE(bool_and(reservation.status='consumed'),false) AS all_consumed,
          COALESCE(bool_and(reservation.status IN ('released','returned')),false) AS all_restored,
          count(*)=1 AND COALESCE(bool_and(CASE WHEN inventory.base_unit='ml' AND inventory.item_type='bottle' THEN inventory.package_volume_ml>0 AND mod(reservation.quantity/${item}.quantity,NULLIF(inventory.package_volume_ml,0))=0
            WHEN inventory.base_unit IN ('bottle','piece') AND inventory.item_type IN ('bottle','food') THEN reservation.quantity/${item}.quantity>=1 AND mod(reservation.quantity/${item}.quantity,1)=0 ELSE false END),false) AS packaged
          FROM mbox.inventory_order_reservations reservation JOIN mbox.inventory_items inventory ON inventory.tenant_id=reservation.tenant_id AND inventory.store_id=reservation.store_id AND inventory.id=reservation.inventory_item_id
          WHERE reservation.tenant_id=${item}.tenant_id AND reservation.store_id=${item}.store_id AND reservation.order_item_id=${item}.id) reservation_facts
      ) raw
    ) facts`
}

/** Permission to read history remains the caller's responsibility. Only an
 * actionable original-item remainder extends its existing history window. */
export function orderHasLegacyStockReturnSql(order:string):string {
  if(!/^[a-z_]+$/.test(order))throw new TypeError('Invalid stock-return order alias')
  return `EXISTS(SELECT 1 FROM mbox.order_items return_candidate CROSS JOIN LATERAL(${legacyStockReturnCapabilitySql('return_candidate')}) return_work
    WHERE return_candidate.tenant_id=${order}.tenant_id AND return_candidate.store_id=${order}.store_id AND return_candidate.order_id=${order}.id
      AND (return_work.capability @> '{"canReturnUnmade":true}'::jsonb OR return_work.capability @> '{"canReturnUnopened":true}'::jsonb))`
}
