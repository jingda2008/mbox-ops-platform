import type { ScopedTransaction } from './transaction-runner.js'
import type { OperatingHistory } from '../../src/shared/operating-history.js'
import type { OperatingDaySummary } from '../../src/shared/operating-history.js'
export interface OperatingHistoryFilter { businessDate: string; endDate?: string; table: string; employee: string; page: number; exportAll?:boolean }

export async function readOperatingHistory(tx: ScopedTransaction, input: OperatingHistoryFilter): Promise<OperatingHistory> {
  const orders=await tx.query<{id:string;business_date:string;public_id:string;table_code:string;employee_name:string|null;
    submitted_at:string;status:string;payment_status:string;total_amount_minor:string}>(`
    SELECT ordering.id,ordering.business_date::text,ordering.public_id,venue.code AS table_code,employee.display_name AS employee_name,
      COALESCE(ordering.submitted_at,ordering.created_at)::text AS submitted_at,
      ordering.status,ordering.payment_status,ordering.total_amount_minor::text
    FROM mbox.orders ordering JOIN mbox.table_sessions session
      ON session.tenant_id=ordering.tenant_id AND session.store_id=ordering.store_id AND session.id=ordering.table_session_id
    JOIN mbox.tables venue ON venue.tenant_id=session.tenant_id AND venue.store_id=session.store_id AND venue.id=session.table_id
    LEFT JOIN mbox.employees employee ON employee.tenant_id=ordering.tenant_id AND employee.store_id=ordering.store_id
      AND employee.id=ordering.created_by_employee_id
    WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid AND ordering.business_date BETWEEN $3::date AND $7::date
      AND ordering.status<>'draft' AND ($4='' OR venue.code ILIKE '%'||$4||'%')
      AND ($5='' OR employee.display_name ILIKE '%'||$5||'%')
    ORDER BY ordering.created_at DESC,ordering.id DESC LIMIT ${input.exportAll?5001:51} OFFSET $6
  `,[tx.scope.tenantId,tx.scope.storeId,input.businessDate,input.table,input.employee,input.exportAll?0:input.page*50,input.endDate??input.businessDate])
  if(input.exportAll&&orders.rows.length>5000)throw new TypeError('筛选结果超过5000单，请缩小日期或桌台范围后导出；不会只导出部分数据')
  const page=input.exportAll?orders.rows:orders.rows.slice(0,50)
  const items=page.length?await tx.query<{id:string;order_id:string;name:string;quantity:number;unit_price_minor:string;
    total_amount_minor:string;status:string;note:string|null;delivered_at:string|null;delivered_by:string|null}>(`
    SELECT item.id,item.order_id,COALESCE(NULLIF(item.product_snapshot->>'name',''),product.name) AS name,
      item.quantity,item.unit_price_minor::text,item.total_amount_minor::text,item.status,item.note,
      delivery.delivered_at,delivery.delivered_by
    FROM mbox.order_items item JOIN mbox.products product
      ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id AND product.id=item.product_id
    LEFT JOIN LATERAL (
      SELECT audit.occurred_at::text AS delivered_at,employee.display_name AS delivered_by
      FROM mbox.kds_tasks task JOIN mbox.audit_events audit
        ON audit.tenant_id=task.tenant_id AND audit.store_id=task.store_id
          AND audit.object_type='kds_task' AND audit.object_id=task.id::text AND audit.action='kds.deliver'
      LEFT JOIN mbox.employees employee ON employee.tenant_id=audit.tenant_id AND employee.store_id=audit.store_id AND employee.id=audit.actor_employee_id
      WHERE task.tenant_id=item.tenant_id AND task.store_id=item.store_id AND task.order_item_id=item.id AND item.status='delivered'
      ORDER BY audit.occurred_at DESC,audit.id DESC LIMIT 1
    ) delivery ON true
    WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.order_id=ANY($3::uuid[])
    ORDER BY item.created_at,item.id
  `,[tx.scope.tenantId,tx.scope.storeId,page.map(row=>row.id)]):{rows:[]}
  const receipts=await tx.query<{provider:string;received:string;refunded:string;net:string}>(`
    SELECT provider,COALESCE(sum(amount_minor) FILTER(WHERE entry_type='payment'),0)::text AS received,
      (-COALESCE(sum(amount_minor) FILTER(WHERE entry_type='refund'),0))::text AS refunded,
      COALESCE(sum(amount_minor),0)::text AS net
    FROM mbox.reconciliation_entries WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND business_date BETWEEN $3::date AND $4::date
      AND entry_type IN ('payment','refund') GROUP BY provider ORDER BY provider
  `,[tx.scope.tenantId,tx.scope.storeId,input.businessDate,input.endDate??input.businessDate])
  const summary=(!input.endDate||input.endDate===input.businessDate)?(await tx.query<{summary:OperatingDaySummary}>('SELECT mbox.operating_day_summary($1,$2,$3::date) AS summary',[tx.scope.tenantId,tx.scope.storeId,input.businessDate])).rows[0]?.summary:undefined
  return {businessDate:input.businessDate,endDate:input.endDate??input.businessDate,summary,generatedAt:new Date().toISOString(),page:input.exportAll?0:input.page,hasMore:!input.exportAll&&orders.rows.length>50,
    receipts:receipts.rows.map(row=>({provider:row.provider,receivedMinor:minor(row.received),refundedMinor:minor(row.refunded),netMinor:minor(row.net)})),
    orders:page.map(row=>({id:row.id,businessDate:row.business_date,publicId:row.public_id,tableCode:row.table_code,employeeName:row.employee_name,
      submittedAt:row.submitted_at,status:row.status,paymentStatus:row.payment_status,totalMinor:minor(row.total_amount_minor),
      items:items.rows.filter(item=>item.order_id===row.id).map(item=>({id:item.id,name:item.name,quantity:item.quantity,
        unitPriceMinor:minor(item.unit_price_minor),totalMinor:minor(item.total_amount_minor),status:item.status,note:item.note,
        deliveredAt:item.delivered_at??null,deliveredBy:item.delivered_by??null}))}))}
}
function minor(value:string):number {const number=Number(value);if(!Number.isSafeInteger(number))throw new TypeError('Invalid ledger amount');return number}
