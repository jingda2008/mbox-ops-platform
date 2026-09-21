import {currentRefundAttemptSql} from './refund-attempt-sql.js'
import {legacyStockReturnCapabilitySql,orderHasLegacyStockReturnSql} from './order-stock-return-capability.js'
import {orderNeedsCollectionSql,orderReceivableSql} from './order-collection-sql.js'
import type { ScopedTransaction } from './transaction-runner.js'
import type { OperatingHistory,SharedDeliveryHistory } from '../../src/shared/operating-history.js'
import type { PickupUnit } from '../../src/shared/pickup-workflow.js'
import type { OperatingDaySummary } from '../../src/shared/operating-history.js'
export interface OperatingHistoryFilter { businessDate: string; endDate?: string; table: string; employee: string; page: number; exportAll?:boolean;
  workKind?:'prepared'|'delivered'; workEmployeeId?:string; workStations?:string[];
  sharedDeliveryScope?:{employeeId:string;canViewAllTables:boolean};
  search?:string; paymentStatus?:string; area?:string;
  earliestBusinessDate?:string|null; allowFinancialSummary?:boolean; includeStockReturnWork?:boolean }

export async function readOperatingHistory(tx: ScopedTransaction, input: OperatingHistoryFilter): Promise<OperatingHistory> {
  const orders=await tx.query<{id:string;business_date:string;public_id:string;table_code:string;employee_name:string|null;
    submitted_at:string;status:string;payment_status:string;total_amount_minor:string;effective_amount_minor?:string;table_session_id:string;session_public_id:string;area_name:string}>(`
    SELECT ordering.id,ordering.business_date::text,ordering.public_id,venue.code AS table_code,employee.display_name AS employee_name,
      COALESCE(ordering.submitted_at,ordering.created_at)::text AS submitted_at,
      ordering.status,ordering.payment_status,ordering.total_amount_minor::text,(${orderReceivableSql('ordering')})::text AS effective_amount_minor,ordering.table_session_id,session.public_id AS session_public_id,area.name AS area_name
    FROM mbox.orders ordering JOIN mbox.table_sessions session
      ON session.tenant_id=ordering.tenant_id AND session.store_id=ordering.store_id AND session.id=ordering.table_session_id
    JOIN mbox.tables venue ON venue.tenant_id=session.tenant_id AND venue.store_id=session.store_id AND venue.id=session.table_id
    JOIN mbox.areas area ON area.tenant_id=venue.tenant_id AND area.store_id=venue.store_id AND area.id=venue.area_id
    LEFT JOIN mbox.employees employee ON employee.tenant_id=ordering.tenant_id AND employee.store_id=ordering.store_id
      AND employee.id=ordering.created_by_employee_id
    CROSS JOIN LATERAL (SELECT (
      ${orderNeedsCollectionSql('ordering')}
      OR EXISTS(SELECT 1 FROM mbox.refunds refund JOIN mbox.order_payment_facts payment
        ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id AND payment.id=refund.payment_id AND (refund.order_id IS NULL OR refund.order_id=payment.order_id)
        WHERE payment.tenant_id=ordering.tenant_id AND payment.store_id=ordering.store_id AND payment.order_id=ordering.id
          AND refund.status IN ('requested','approved','processing','failed') AND ${currentRefundAttemptSql('refund')})
      ${input.includeStockReturnWork?`OR ${orderHasLegacyStockReturnSql('ordering')}`:''}
    ) AS needs_attention) attention
    WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid
      AND (ordering.business_date BETWEEN $3::date AND $7::date OR (ordering.business_date<$3::date AND attention.needs_attention))
      AND ($8::date IS NULL OR ordering.business_date>=$8::date OR attention.needs_attention)
      AND ordering.status<>'draft' AND ($4='' OR venue.code ILIKE '%'||$4||'%')
      AND ($5='' OR employee.display_name ILIKE '%'||$5||'%')
      AND ($9='' OR ordering.public_id ILIKE '%'||$9||'%' OR venue.code ILIKE '%'||$9||'%'
        OR ordering.total_amount_minor::numeric/100=CASE WHEN $9 ~ '^\\d+(\\.\\d{1,2})?$' THEN $9::numeric ELSE NULL END)
      AND ($10='' OR ordering.payment_status=$10)
      AND ($11='' OR area.name ILIKE '%'||$11||'%')
      AND ($12::text IS NULL OR EXISTS(SELECT 1 FROM mbox.order_items history_item JOIN mbox.kds_tasks history_task
        ON history_task.tenant_id=history_item.tenant_id AND history_task.store_id=history_item.store_id AND history_task.order_item_id=history_item.id
        JOIN mbox.audit_events history_event ON history_event.tenant_id=history_task.tenant_id AND history_event.store_id=history_task.store_id
          AND history_event.object_type='kds_task' AND history_event.object_id=history_task.id::text
        WHERE history_item.tenant_id=ordering.tenant_id AND history_item.store_id=ordering.store_id AND history_item.order_id=ordering.id
          AND history_event.action=CASE $12 WHEN 'prepared' THEN 'kds.complete' ELSE 'kds.deliver' END
          AND ($13::uuid IS NULL OR history_event.actor_employee_id=$13)
          AND ($14::text[] IS NULL OR history_task.station_code=ANY($14))))
    ORDER BY ordering.created_at DESC,ordering.id DESC LIMIT ${input.exportAll?5001:51} OFFSET $6
  `,[tx.scope.tenantId,tx.scope.storeId,input.businessDate,input.table,input.employee,input.exportAll?0:input.page*50,input.endDate??input.businessDate,
    input.earliestBusinessDate??null,input.search??'',input.paymentStatus??'',input.area??'',input.workKind??null,input.workEmployeeId??null,input.workStations??null])
  if(input.exportAll&&orders.rows.length>5000)throw new TypeError('筛选结果超过5000单，请缩小日期或桌台范围后导出；不会只导出部分数据')
  const page=input.exportAll?orders.rows:orders.rows.slice(0,50)
  const items=page.length?await tx.query<{id:string;order_id:string;name:string;quantity:number;unit_price_minor:string;
    stock_return_capability?:import('../../src/shared/operating-history.js').StockReturnCapability|null;product_id?:string;category_label?:string|null;unit_label?:string|null;returned_quantity?:number;quantity_facts?:{total:number;held:number;stopped:number;ready:number;delivered:number;usedLoss:number}|null;total_amount_minor:string;parent_order_item_id:string|null;status:string;note:string|null;delivered_at:string|null;delivered_by:string|null;prepared_at:string|null;prepared_by:string|null;work_quantity:number|null}>(`
    SELECT item.id,item.order_id,item.product_id,
      NULLIF(item.product_snapshot->>'categoryName','') AS category_label,
      COALESCE(NULLIF(item.product_snapshot->>'unitName',''),NULLIF(item.product_snapshot->>'unit','')) AS unit_label,COALESCE(NULLIF(item.product_snapshot->>'name',''),product.name) AS name,
      item.quantity,item.unit_price_minor::text,item.total_amount_minor::text,item.parent_order_item_id,item.status,item.note,
      stock_return_read.capability AS stock_return_capability,quantity_facts.facts AS quantity_facts,
      CASE WHEN quantity_facts.total>0 THEN quantity_facts.returned ELSE CASE WHEN item.status='cancelled'  AND (
        EXISTS(SELECT 1 FROM mbox.inventory_order_reservations r WHERE r.tenant_id=item.tenant_id AND r.store_id=item.store_id AND r.order_item_id=item.id
          GROUP BY r.order_item_id HAVING bool_and(r.status IN ('released','returned')))
        OR EXISTS(SELECT 1 FROM mbox.inventory_movements movement WHERE movement.tenant_id=item.tenant_id AND movement.store_id=item.store_id
          AND movement.order_item_id=item.id AND movement.reference_type='refund_unmade' AND movement.movement_type='return')
      ) THEN item.quantity ELSE (SELECT COALESCE(sum(stock_return.quantity),0)::integer FROM mbox.order_stock_returns stock_return WHERE stock_return.tenant_id=item.tenant_id AND stock_return.store_id=item.store_id AND stock_return.order_item_id=item.id) END END AS returned_quantity,
      delivery.delivered_at,delivery.delivered_by,preparation.prepared_at,preparation.prepared_by,work_result.quantity AS work_quantity
    FROM mbox.order_items item JOIN mbox.products product
      ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id AND product.id=item.product_id
    LEFT JOIN LATERAL (${input.includeStockReturnWork?legacyStockReturnCapabilitySql('item'):'SELECT NULL::jsonb AS capability'}) stock_return_read ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total,
        count(*) FILTER(WHERE EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory stock WHERE stock.tenant_id=unit.tenant_id AND stock.store_id=unit.store_id AND stock.unit_id=unit.id)
          AND NOT EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory stock WHERE stock.tenant_id=unit.tenant_id AND stock.store_id=unit.store_id AND stock.unit_id=unit.id AND stock.status NOT IN ('released','returned')))::int AS returned,
        CASE WHEN count(*)>0 THEN jsonb_build_object('total',count(*),'held',count(*) FILTER(WHERE unit.held_by_case_id IS NOT NULL AND NOT unit.operationally_stopped),
          'stopped',count(*) FILTER(WHERE unit.operationally_stopped),
          'ready',count(*) FILTER(WHERE unit.production_state='ready' AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped),
          'delivered',count(*) FILTER(WHERE unit.production_state='delivered'),
          'usedLoss',count(*) FILTER(WHERE EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory stock WHERE stock.tenant_id=unit.tenant_id AND stock.store_id=unit.store_id AND stock.unit_id=unit.id AND stock.status='used_loss'))) END AS facts
      FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=item.tenant_id AND unit.store_id=item.store_id AND unit.order_item_id=item.id
    ) quantity_facts ON true
    LEFT JOIN LATERAL (
      SELECT audit.occurred_at::text AS delivered_at,employee.display_name AS delivered_by
      FROM mbox.kds_tasks task JOIN mbox.audit_events audit
        ON audit.tenant_id=task.tenant_id AND audit.store_id=task.store_id
          AND audit.object_type='kds_task' AND audit.object_id=task.id::text AND audit.action='kds.deliver'
      LEFT JOIN mbox.employees employee ON employee.tenant_id=audit.tenant_id AND employee.store_id=audit.store_id AND employee.id=audit.actor_employee_id
      WHERE task.tenant_id=item.tenant_id AND task.store_id=item.store_id AND task.order_item_id=item.id AND (item.status='delivered' OR $4::text='delivered')
        AND ($4::text IS DISTINCT FROM 'delivered' OR $5::uuid IS NULL OR audit.actor_employee_id=$5)
      ORDER BY audit.occurred_at DESC,audit.id DESC LIMIT 1
    ) delivery ON true
    LEFT JOIN LATERAL (
      SELECT audit.occurred_at::text AS prepared_at,employee.display_name AS prepared_by
      FROM mbox.kds_tasks task JOIN mbox.audit_events audit
        ON audit.tenant_id=task.tenant_id AND audit.store_id=task.store_id
        AND audit.object_type='kds_task' AND audit.object_id=task.id::text AND audit.action='kds.complete'
      LEFT JOIN mbox.employees employee ON employee.tenant_id=audit.tenant_id AND employee.store_id=audit.store_id AND employee.id=audit.actor_employee_id
      WHERE task.tenant_id=item.tenant_id AND task.store_id=item.store_id AND task.order_item_id=item.id
        AND ($4::text IS DISTINCT FROM 'prepared' OR $5::uuid IS NULL OR audit.actor_employee_id=$5)
        AND ($4::text IS DISTINCT FROM 'prepared' OR $6::text[] IS NULL OR task.station_code=ANY($6))
      ORDER BY audit.occurred_at DESC,audit.id DESC LIMIT 1
    ) preparation ON true
    LEFT JOIN LATERAL (
      SELECT sum(COALESCE((audit.after_snapshot->>'affectedQuantity')::integer,task.quantity))::integer AS quantity
      FROM mbox.kds_tasks task JOIN mbox.audit_events audit
        ON audit.tenant_id=task.tenant_id AND audit.store_id=task.store_id
        AND audit.object_type='kds_task' AND audit.object_id=task.id::text
        AND audit.action=CASE $4 WHEN 'prepared' THEN 'kds.complete' ELSE 'kds.deliver' END
      WHERE $4::text IS NOT NULL AND task.tenant_id=item.tenant_id AND task.store_id=item.store_id AND task.order_item_id=item.id
        AND ($5::uuid IS NULL OR audit.actor_employee_id=$5) AND ($6::text[] IS NULL OR task.station_code=ANY($6))
    ) work_result ON true
    WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.order_id=ANY($3::uuid[])
      AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM mbox.kds_tasks ht JOIN mbox.audit_events he
        ON he.tenant_id=ht.tenant_id AND he.store_id=ht.store_id AND he.object_type='kds_task' AND he.object_id=ht.id::text
        WHERE ht.tenant_id=item.tenant_id AND ht.store_id=item.store_id AND ht.order_item_id=item.id
          AND he.action=CASE $4 WHEN 'prepared' THEN 'kds.complete' ELSE 'kds.deliver' END
          AND ($5::uuid IS NULL OR he.actor_employee_id=$5) AND ($6::text[] IS NULL OR ht.station_code=ANY($6))))
    ORDER BY item.created_at,item.id
  `,[tx.scope.tenantId,tx.scope.storeId,page.map(row=>row.id),input.workKind??null,input.workEmployeeId??null,input.workStations??null]):{rows:[]}
  const receipts=input.allowFinancialSummary===false?{rows:[]}:await tx.query<{provider:string;received:string;refunded:string;net:string}>(`
    SELECT provider,COALESCE(sum(amount_minor) FILTER(WHERE entry_type='payment'),0)::text AS received,
      (-COALESCE(sum(amount_minor) FILTER(WHERE entry_type='refund'),0))::text AS refunded,
      COALESCE(sum(amount_minor),0)::text AS net
    FROM mbox.reconciliation_entries WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND business_date BETWEEN $3::date AND $4::date
      AND entry_type IN ('payment','refund') GROUP BY provider ORDER BY provider
  `,[tx.scope.tenantId,tx.scope.storeId,input.earliestBusinessDate&&input.businessDate<input.earliestBusinessDate?input.earliestBusinessDate:input.businessDate,input.endDate??input.businessDate])
  const financialStartDate=input.earliestBusinessDate&&input.businessDate<input.earliestBusinessDate?input.earliestBusinessDate:input.businessDate
  const financialEndDate=input.endDate??input.businessDate
  // Historical exports may span years. Keep the new per-day summary bounded;
  // ledger totals and historical order access retain their existing range.
  const summaryRangeDays=(Date.parse(financialEndDate)-Date.parse(financialStartDate))/86_400_000+1
  const summary=input.allowFinancialSummary!==false&&financialStartDate<=financialEndDate
    &&Number.isInteger(summaryRangeDays)&&summaryRangeDays>=1&&summaryRangeDays<=366
    ? financialStartDate===financialEndDate
      ? (await tx.query<{summary:OperatingDaySummary}>('SELECT mbox.operating_day_summary($1,$2,$3::date) AS summary',[tx.scope.tenantId,tx.scope.storeId,financialStartDate])).rows[0]?.summary
      : combineOperatingSummaries((await tx.query<{summary:OperatingDaySummary}>(`
          SELECT mbox.operating_day_summary($1,$2,day::date) AS summary
          FROM generate_series($3::date::timestamp,$4::date::timestamp,interval '1 day') day
        `,[tx.scope.tenantId,tx.scope.storeId,financialStartDate,financialEndDate])).rows.map(row=>row.summary))
    :undefined
  const shared=input.workKind==='delivered'&&input.sharedDeliveryScope?await readSharedDeliveryHistory(tx,input):undefined
  return {businessDate:input.businessDate,endDate:input.endDate??input.businessDate,summary,generatedAt:new Date().toISOString(),page:input.exportAll?0:input.page,hasMore:!input.exportAll&&(orders.rows.length>50||shared?.hasMore===true),
    ...(shared?{sharedDeliveries:shared.records}:{}),
    financialSummaryVisible:input.allowFinancialSummary!==false,
    financialStartDate:input.earliestBusinessDate&&input.businessDate<input.earliestBusinessDate?input.earliestBusinessDate:input.businessDate,
    receipts:receipts.rows.map(row=>({provider:row.provider,receivedMinor:minor(row.received),refundedMinor:minor(row.refunded),netMinor:minor(row.net)})),
    orders:page.map(row=>({id:row.id,businessDate:row.business_date,publicId:row.public_id,tableCode:row.table_code,employeeName:row.employee_name,
      tableSessionId:row.table_session_id,sessionPublicId:row.session_public_id,areaName:row.area_name,
      submittedAt:row.submitted_at,status:row.status,paymentStatus:row.payment_status,totalMinor:minor(row.total_amount_minor),effectiveAmountMinor:minor(row.effective_amount_minor??row.total_amount_minor),stoppedAmountMinor:Math.max(0,minor(row.total_amount_minor)-minor(row.effective_amount_minor??row.total_amount_minor)),...(minor(row.effective_amount_minor??row.total_amount_minor)>minor(row.total_amount_minor)?{receivableIncreaseMinor:minor(row.effective_amount_minor??row.total_amount_minor)-minor(row.total_amount_minor)}:{}),
      items:items.rows.filter(item=>item.order_id===row.id).map(item=>({id:item.id,name:item.name,quantity:item.quantity,...(item.work_quantity==null?{}:{workQuantity:item.work_quantity}),productId:item.product_id,categoryLabel:item.category_label??null,unitLabel:item.unit_label??null,bundleParentId:item.parent_order_item_id,
        unitPriceMinor:minor(item.unit_price_minor),totalMinor:minor(item.total_amount_minor),includedInBundle:item.parent_order_item_id!=null,status:item.status,note:item.note,returnedQuantity:item.returned_quantity??0,...(item.stock_return_capability?{stockReturn:item.stock_return_capability}:{}),...(item.quantity_facts?{quantities:item.quantity_facts}:{}),
        deliveredAt:item.delivered_at??null,deliveredBy:item.delivered_by??null,preparedAt:item.prepared_at??null,preparedBy:item.prepared_by??null}))}))}
}
async function readSharedDeliveryHistory(tx:ScopedTransaction,input:OperatingHistoryFilter):Promise<{records:SharedDeliveryHistory[];hasMore:boolean}> {
  const scope=input.sharedDeliveryScope!
  const result=await tx.query<{id:string;business_date:string;table_session_id:string;table_code:string;pickup_table_code:string;taken_at:string;units:PickupUnit[]}>(`
    SELECT receipt.id,receipt.business_date::text,receipt.table_session_id,venue.code AS table_code,
      receipt.snapshot->>'tableCode' AS pickup_table_code,receipt.taken_at::text,receipt.snapshot->'units' AS units
    FROM mbox.pickup_receipts receipt JOIN mbox.table_sessions session
      ON (session.tenant_id,session.store_id,session.id)=(receipt.tenant_id,receipt.store_id,receipt.table_session_id)
    JOIN mbox.tables venue ON (venue.tenant_id,venue.store_id,venue.id)=(session.tenant_id,session.store_id,session.table_id)
    WHERE receipt.tenant_id=$1 AND receipt.store_id=$2
      AND receipt.business_date BETWEEN $3::date AND $4::date
      AND ($5::date IS NULL OR receipt.business_date>=$5::date)
      AND ($6='' OR venue.code ILIKE '%'||$6||'%' OR receipt.snapshot->>'tableCode' ILIKE '%'||$6||'%')
      AND NOT EXISTS(SELECT 1 FROM mbox.pickup_undos undo
        WHERE (undo.tenant_id,undo.store_id,undo.receipt_id)=(receipt.tenant_id,receipt.store_id,receipt.id))
      AND ($7::boolean OR EXISTS(SELECT 1 FROM mbox.table_assignments assignment
        WHERE (assignment.tenant_id,assignment.store_id,assignment.table_id)=(session.tenant_id,session.store_id,session.table_id)
          AND assignment.employee_id=$8::uuid AND assignment.assignment_type IN ('primary','backup')
          AND assignment.starts_at<=transaction_timestamp() AND (assignment.ends_at IS NULL OR assignment.ends_at>transaction_timestamp())))
    ORDER BY receipt.taken_at DESC,receipt.id DESC LIMIT ${input.exportAll?5001:51} OFFSET $9
  `,[tx.scope.tenantId,tx.scope.storeId,input.businessDate,input.endDate??input.businessDate,input.earliestBusinessDate??null,input.table,
    scope.canViewAllTables,scope.employeeId,input.exportAll?0:input.page*50])
  if(input.exportAll&&result.rows.length>5000)throw new TypeError('筛选结果超过5000条送达记录，请缩小日期或桌台范围后导出；不会只导出部分数据')
  return {hasMore:result.rows.length>50,records:(input.exportAll?result.rows:result.rows.slice(0,50)).map(row=>{
    const items=new Map<string,SharedDeliveryHistory['items'][number]>()
    for(const unit of row.units){const key=JSON.stringify([unit.itemId,unit.kind,unit.specification,unit.itemNote,unit.orderNote]);const found=items.get(key)
      if(found)found.quantity++
      else items.set(key,{itemId:unit.itemId,name:unit.productName,quantity:1,specification:unit.specification,itemNote:unit.itemNote,orderNote:unit.orderNote,kind:unit.kind})}
    return {receiptId:row.id,businessDate:row.business_date,tableSessionId:row.table_session_id,tableCode:row.table_code,pickupTableCode:row.pickup_table_code,
      deliveredAt:new Date(row.taken_at).toISOString(),source:'shared_pickup_device',items:[...items.values()]}
  })}
}
function combineOperatingSummaries(rows:OperatingDaySummary[]):OperatingDaySummary|undefined {
  if(rows.length===0)return undefined
  const sum=(field:keyof OperatingDaySummary)=>rows.reduce((total,row)=>{
    const raw=row?.[field]
    if(raw===null||raw===undefined||!/^\d+$/.test(String(raw)))throw new TypeError('营业汇总字段缺失或无效')
    const value=total+Number(raw)
    if(!Number.isSafeInteger(value))throw new TypeError('营业汇总超出金额范围')
    return value
  },0)
  return {orderCount:sum('orderCount'),orderAmountMinor:String(sum('orderAmountMinor')),
    unsettledCount:sum('unsettledCount'),outstandingMinor:String(sum('outstandingMinor')),
    pendingPaymentCount:sum('pendingPaymentCount'),pendingRefundCount:sum('pendingRefundCount')}
}
function minor(value:string):number {const number=Number(value);if(!Number.isSafeInteger(number))throw new TypeError('Invalid ledger amount');return number}
