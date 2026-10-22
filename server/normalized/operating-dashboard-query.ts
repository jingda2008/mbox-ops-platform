import type { ScopedTransaction } from './transaction-runner.js'
import type { OperatingDashboardProjection, OperatingDashboardSource, OperatingDashboardSourceQuery, OperatingDashboardBreakdown } from '../../src/shared/operating-dashboard.js'
import { orderCollectionDueSql } from './order-collection-sql.js'

export interface DashboardRange { startDate: string; endDate: string; requestedEndDate: string; currentBusinessDate: string }
interface SourceRow extends Record<string, unknown> {
  id: string; kind: OperatingDashboardSource['kind']; category: string; source_type: string; public_id: string;
  label: string; business_date: string | null; occurred_at: string; amount: string | null; original_amount: string | null; missing: number;
}

/** All monetary rows are read in the caller's repeatable-read transaction. */
export async function readOperatingDashboard(tx: ScopedTransaction, period: string, range: DashboardRange, currency: string,
  filter: OperatingDashboardSourceQuery = {}): Promise<OperatingDashboardProjection> {
  const values = [tx.scope.tenantId, tx.scope.storeId, range.startDate, range.endDate, currency]
  const result = await tx.query<SourceRow>(`
    WITH money_sources AS (
      SELECT e.id::text||':'||COALESCE(o.id::text,r.id::text,'unassigned') id,e.entry_type,
        e.business_date cash_date,e.occurred_at,e.currency,e.amount_minor original_amount,
        CASE WHEN p.order_batch_id IS NULL THEN e.amount_minor
          WHEN e.entry_type='payment' THEN a.amount_minor
          WHEN e.entry_type='refund' THEN e.amount_minor
          ELSE trunc(e.amount_minor::numeric*a.cumulative_minor/NULLIF(p.amount_minor,0))
            -trunc(e.amount_minor::numeric*(a.cumulative_minor-a.amount_minor)/NULLIF(p.amount_minor,0)) END amount,
        COALESCE(o.business_date,f.business_date,CASE WHEN p.activity_registration_cycle=r.registration_cycle
          THEN mbox.activity_purchase_business_date(r.tenant_id,r.store_id,r.registered_at) END) purchase_date,
        COALESCE(o.public_id,r.public_id,p.public_id,e.id::text) public_id,
        CASE WHEN o.id IS NOT NULL THEN 'order' WHEN r.id IS NOT NULL THEN 'activity' ELSE 'unassigned' END source_type,
        CASE WHEN r.id IS NULL THEN 'ordinary_order' ELSE COALESCE(r.purchase_kind,'legacy_activity') END category
      FROM mbox.reconciliation_entries e
      JOIN mbox.stores s ON s.tenant_id=e.tenant_id AND s.id=e.store_id
      LEFT JOIN mbox.payments p ON (p.tenant_id,p.store_id,p.id)=(e.tenant_id,e.store_id,e.payment_id)
      LEFT JOIN mbox.refunds refund ON (refund.tenant_id,refund.store_id,refund.id)=(e.tenant_id,e.store_id,e.refund_id)
      LEFT JOIN LATERAL(SELECT x.order_id,x.amount_minor,sum(x.amount_minor) OVER(ORDER BY x.position) cumulative_minor
        FROM mbox.order_payment_allocations x WHERE x.tenant_id=p.tenant_id AND x.store_id=p.store_id AND x.batch_id=p.order_batch_id) a ON true
      LEFT JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,COALESCE(p.order_id,a.order_id))
        AND (e.entry_type<>'refund' OR refund.order_id IS NULL OR refund.order_id=o.id)
      LEFT JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.activity_registration_id)
      LEFT JOIN mbox.activity_purchase_finance f ON (f.tenant_id,f.store_id,f.registration_id,f.registration_cycle)=
        (r.tenant_id,r.store_id,r.id,p.activity_registration_cycle)
      WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.currency=$5
        AND (p.order_batch_id IS NULL OR o.id IS NOT NULL)
    ), active_costs AS (
      SELECT c.* FROM mbox.operating_cost_entries c WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.currency=$5
        AND c.category<>'beverage_purchase' AND c.source_type<>'inventory_purchase'
        AND NOT EXISTS(SELECT 1 FROM mbox.operating_cost_entries replacement
          WHERE replacement.tenant_id=c.tenant_id AND replacement.store_id=c.store_id AND replacement.corrects_cost_entry_id=c.id)
    ), rows AS (
      SELECT id,'income'::text kind,category,source_type,public_id,
        CASE WHEN entry_type='refund' THEN '成功退款归原购买日' ELSE '已收款归原购买日' END label,
        purchase_date business_date,occurred_at,amount,original_amount,0 missing
        FROM money_sources WHERE entry_type IN('payment','refund') AND purchase_date BETWEEN $3::date AND $4::date
      UNION ALL
      SELECT id,'income','unassigned',source_type,public_id,'缺少原购买归属或调整分类',NULL,occurred_at,NULL,original_amount,1
        FROM money_sources WHERE (purchase_date IS NULL OR entry_type='adjustment')
          AND entry_type IN('payment','refund','adjustment','fee') AND cash_date BETWEEN $3::date AND $4::date
      UNION ALL
      SELECT e.id::text,CASE WHEN e.entry_type='payment' THEN 'receipt' ELSE 'refund' END,
        e.entry_type,'reconciliation',COALESCE(p.public_id,e.id::text),CASE WHEN e.entry_type='payment' THEN '实际收款' ELSE '成功退款' END,
        e.business_date,e.occurred_at,CASE WHEN e.entry_type='refund' THEN -e.amount_minor ELSE e.amount_minor END,e.amount_minor,0
        FROM mbox.reconciliation_entries e LEFT JOIN mbox.payments p ON (p.tenant_id,p.store_id,p.id)=(e.tenant_id,e.store_id,e.payment_id)
        WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.currency=$5 AND e.entry_type IN('payment','refund') AND e.business_date BETWEEN $3::date AND $4::date
      UNION ALL
      SELECT id,'cost','provider_fee',source_type,public_id,'支付手续费',purchase_date,occurred_at,-amount,original_amount,0
        FROM money_sources WHERE entry_type='fee' AND purchase_date BETWEEN $3::date AND $4::date
      UNION ALL
      SELECT i.id::text,'cost','goods','order',o.public_id,COALESCE(i.product_snapshot->>'name','订单商品'),o.business_date,
        COALESCE(o.submitted_at,o.created_at),i.total_cost_minor_at_submission,i.total_cost_minor_at_submission,
        CASE WHEN i.total_cost_minor_at_submission IS NULL THEN 1 ELSE 0 END
        FROM mbox.order_items i JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(i.tenant_id,i.store_id,i.order_id)
        WHERE i.tenant_id=$1 AND i.store_id=$2 AND i.currency=$5 AND o.business_date BETWEEN $3::date AND $4::date
          AND o.payment_status IN('paid','partially_refunded','refunded') AND o.status<>'cancelled'
          AND i.parent_order_item_id IS NULL AND i.status<>'cancelled'
      UNION ALL
      SELECT r.id::text,'cost','activity_goods','activity',r.public_id,'活动商品冻结成本',
        COALESCE(f.business_date,mbox.activity_purchase_business_date(r.tenant_id,r.store_id,r.registered_at)),r.registered_at,
        CASE WHEN f.id IS NOT NULL THEN f.goods_cost_minor WHEN r.activity_package_id IS NULL AND NOT r.service_has_meal AND jsonb_array_length(r.service_items_snapshot)=0 THEN 0 ELSE NULL END,
        f.goods_cost_minor,COALESCE(f.missing_cost_count,CASE WHEN r.activity_package_id IS NULL AND NOT r.service_has_meal AND jsonb_array_length(r.service_items_snapshot)=0 THEN 0 ELSE 1 END)
        FROM mbox.community_activity_registrations r JOIN mbox.stores s ON s.tenant_id=r.tenant_id AND s.id=r.store_id
        LEFT JOIN mbox.activity_purchase_finance f ON (f.tenant_id,f.store_id,f.registration_id,f.registration_cycle)=(r.tenant_id,r.store_id,r.id,r.registration_cycle)
        WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.currency=$5 AND r.status IN('confirmed','checked_in','no_show')
          AND (r.payment_status='paid' OR (r.payment_status='not_required' AND r.fee_amount_minor=0) OR (r.payment_status='refunded' AND r.service_refund_disposition IS NOT NULL))
          AND COALESCE(f.business_date,mbox.activity_purchase_business_date(r.tenant_id,r.store_id,r.registered_at)) BETWEEN $3::date AND $4::date
      UNION ALL
      SELECT c.id::text||':'||day::date::text,'cost',c.category,'operating_cost',c.public_id,
        CASE WHEN c.source_type='payroll_run' THEN '工资费用' ELSE '经营费用' END,day::date,c.recorded_at,
        c.gross_amount_minor/(c.service_end_date-c.service_start_date+1)
          +CASE WHEN day::date-c.service_start_date < c.gross_amount_minor%(c.service_end_date-c.service_start_date+1) THEN 1 ELSE 0 END,
        c.gross_amount_minor,0
        FROM active_costs c CROSS JOIN LATERAL generate_series(GREATEST(c.service_start_date,$3::date)::timestamp,
          LEAST(c.service_end_date,$4::date)::timestamp,interval '1 day') day
      UNION ALL
      SELECT m.id::text,'cost',CASE WHEN m.movement_type='waste' THEN 'inventory_loss' ELSE 'activity_remake' END,
        'inventory_movement',m.id::text,CASE WHEN m.movement_type='waste' THEN '独立库存损耗' ELSE '活动补做新增耗用' END,
        ((m.occurred_at AT TIME ZONE s.timezone)-s.business_day_cutoff)::date,m.occurred_at,
        round(abs(m.quantity_delta)*m.unit_cost_minor),round(abs(m.quantity_delta)*m.unit_cost_minor),CASE WHEN m.unit_cost_minor IS NULL THEN 1 ELSE 0 END
        FROM mbox.inventory_movements m JOIN mbox.stores s ON s.tenant_id=m.tenant_id AND s.id=m.store_id
        WHERE m.tenant_id=$1 AND m.store_id=$2 AND m.currency=$5
          AND (m.movement_type='waste' OR (m.movement_type='sale' AND m.reference_type='activity_service' AND m.metadata->>'sourceRef' LIKE 'remake:%'))
          AND ((m.occurred_at AT TIME ZONE s.timezone)-s.business_day_cutoff)::date BETWEEN $3::date AND $4::date
    ) SELECT id,kind,category,source_type,public_id,label,business_date::text,occurred_at::text,
      amount::text,original_amount::text,missing FROM rows
    ORDER BY business_date DESC NULLS FIRST,occurred_at DESC,id,kind
  `, values)
  const rows: OperatingDashboardSource[] = result.rows.map(r => ({ id:r.id,kind:r.kind,category:r.category,sourceType:r.source_type,
    publicId:r.public_id,label:r.label,businessDate:r.business_date,occurredAt:r.occurred_at,amountMinor:nullableMoney(r.amount),
    ...(r.original_amount===null?{}:{originalAmountMinor:money(r.original_amount)}),missingCount:r.missing }))
  const outstanding = await tx.query<{public_id:string;source_type:string;business_date:string;occurred_at:string;amount:string;paid:boolean}>(`
    SELECT o.public_id,'order' source_type,o.business_date::text,COALESCE(o.submitted_at,o.created_at)::text occurred_at,
      (${orderCollectionDueSql('o')})::text amount,o.payment_status IN('paid','partially_refunded','refunded') paid
    FROM mbox.orders o WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.currency=$5 AND o.status<>'draft' AND (o.status<>'cancelled' OR ${orderCollectionDueSql('o')}>0)
      AND (o.business_date BETWEEN $3::date AND $4::date OR ${orderCollectionDueSql('o')}>0)
    UNION ALL
    SELECT r.public_id,'activity',COALESCE(f.business_date,mbox.activity_purchase_business_date(r.tenant_id,r.store_id,r.registered_at))::text,
      r.registered_at::text,CASE WHEN r.status='payment_pending' AND r.payment_status='pending'
        AND (r.payment_due_at IS NULL OR r.payment_due_at>clock_timestamp()) AND r.service_refund_disposition IS NULL THEN r.amount_due_minor ELSE 0 END::text,
      r.payment_status IN('paid','refunded') OR (r.payment_status='not_required' AND r.fee_amount_minor=0)
    FROM mbox.community_activity_registrations r JOIN mbox.stores s ON s.tenant_id=r.tenant_id AND s.id=r.store_id
    LEFT JOIN mbox.activity_purchase_finance f ON (f.tenant_id,f.store_id,f.registration_id,f.registration_cycle)=(r.tenant_id,r.store_id,r.id,r.registration_cycle)
    WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.currency=$5 AND r.status IN('payment_pending','confirmed','checked_in','no_show')
      AND (r.status<>'payment_pending' OR (r.payment_due_at IS NULL OR r.payment_due_at>clock_timestamp()))
  `, values)
  let periodOutstandingMinor=0,currentAllOutstandingMinor=0,validOrderCount=0,paidOrderCount=0
  for(const r of outstanding.rows) {
    const amount=money(r.amount),within=r.business_date>=range.startDate&&r.business_date<=range.endDate
    if(within) { validOrderCount++; if(r.paid)paidOrderCount++;periodOutstandingMinor+=amount }
    currentAllOutstandingMinor+=amount
    if(within&&amount>0)rows.push({id:r.public_id,kind:'outstanding',category:r.source_type,sourceType:r.source_type,publicId:r.public_id,
      label:'截至查询仍有效待收',businessDate:r.business_date,occurredAt:r.occurred_at,amountMinor:amount,missingCount:0})
  }
  const unreconciled = await tx.query<{amount:string}>(`
    SELECT COALESCE(sum(p.amount_minor),0)::text amount FROM mbox.payments p
    JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.activity_registration_id)
    LEFT JOIN mbox.activity_purchase_finance f ON (f.tenant_id,f.store_id,f.registration_id,f.registration_cycle)=(r.tenant_id,r.store_id,r.id,p.activity_registration_cycle)
    WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.currency=$5 AND p.status IN('succeeded','partially_refunded','refunded')
      AND COALESCE(f.business_date,CASE WHEN p.activity_registration_cycle=r.registration_cycle THEN mbox.activity_purchase_business_date(r.tenant_id,r.store_id,r.registered_at) END)
        BETWEEN $3::date AND $4::date
      AND NOT EXISTS(SELECT 1 FROM mbox.reconciliation_entries e WHERE e.tenant_id=p.tenant_id AND e.store_id=p.store_id AND e.payment_id=p.id AND e.entry_type='payment')
  `,values)
  const sum=(kind:string)=>safeSum(rows.filter(r=>r.kind===kind).map(r=>r.amountMinor??0))
  const incomeMinor=sum('income'),totalCostMinor=sum('cost'),actualReceiptsMinor=sum('receipt'),successfulRefundsMinor=sum('refund')
  const trend=new Map<string,OperatingDashboardProjection['trend'][number]>()
  for(let d=range.startDate;d<=range.endDate;d=nextDay(d)) {
    const key=period==='year'?d.slice(0,7):d
    if(!trend.has(key))trend.set(key,{businessDate:period==='year'?`${key}-01`:key,label:key,incomeMinor:0,costMinor:0,actualNetReceiptsMinor:0,provisional:false})
  }
  for(const row of rows) {
    if(!row.businessDate)continue
    const bucket=trend.get(period==='year'?row.businessDate.slice(0,7):row.businessDate)
    if(!bucket)continue
    if(row.kind==='income')bucket.incomeMinor+=row.amountMinor??0
    if(row.kind==='cost')bucket.costMinor+=row.amountMinor??0
    if(row.kind==='receipt')bucket.actualNetReceiptsMinor+=row.amountMinor??0
    if(row.kind==='refund')bucket.actualNetReceiptsMinor-=row.amountMinor??0
    if(row.missingCount)bucket.provisional=true
  }
  const filtered=sourceRowsForDisplay(rows).filter(r=>(r.kind!=='cost'||filter.includeCostDetails===true)&&(!filter.kind||r.kind===filter.kind)&&(!filter.category||r.category===filter.category))
  const page=filter.page??0,pageSize=50
  return {
    dashboard:{incomeMinor,totalCostMinor,operatingProfitMinor:money(incomeMinor-totalCostMinor),actualReceiptsMinor,successfulRefundsMinor,
      actualNetReceiptsMinor:money(actualReceiptsMinor-successfulRefundsMinor),periodOutstandingMinor:money(periodOutstandingMinor),currentAllOutstandingMinor:money(currentAllOutstandingMinor),validOrderCount,paidOrderCount},
    trend:[...trend.values()],incomeBreakdown:breakdown(rows,'income'),costBreakdown:breakdown(rows,'cost'),
    coverage:['普通订单及合并支付','活动报名、加餐和单点按各自购买记录归属','按已入账数据计算；未录费用无法量化','历史成本不按当前成本回填；未知调整保留为待核对'],
    currentBusinessDate:range.currentBusinessDate,effectiveEndDate:range.endDate,requestedEndDate:range.requestedEndDate,incomeBasis:'purchase_business_date',
    knownMissingCostCount:safeSum(rows.filter(r=>r.kind==='cost').map(r=>r.missingCount)),
    unassignedIncomeCount:safeSum(rows.filter(r=>r.kind==='income').map(r=>r.missingCount)),
    unreconciledActivityPaymentsMinor:money(unreconciled.rows[0]!.amount),
    sources:{rows:filtered.slice(page*pageSize,(page+1)*pageSize),page,pageSize,total:filtered.length,hasMore:(page+1)*pageSize<filtered.length},
  }
}
const labels:Record<string,string>={ordinary_order:'普通订单',admission_package:'活动报名套餐',meal_package:'活动加餐套餐',single_dish:'活动单点',legacy_activity:'旧活动报名',unassigned:'归属待核对',goods:'普通订单商品成本',activity_goods:'活动商品成本',provider_fee:'支付手续费',inventory_loss:'独立库存损耗',activity_remake:'活动补做成本',rent:'租金',personnel:'人工',operating_labor:'临时用工',utilities:'水电',marketing:'营销',miscellaneous:'其他费用',performer:'演出人员',band:'乐队'}
function sourceRowsForDisplay(rows:OperatingDashboardSource[]):OperatingDashboardSource[] {
  const combined=new Map<string,OperatingDashboardSource>()
  for(const source of rows){
    if(source.sourceType!=='operating_cost'){combined.set(source.kind+':'+source.id,source);continue}
    const id=source.id.split(':')[0]!,key='cost:'+id,previous=combined.get(key)
    if(!previous)combined.set(key,{...source,id,label:'经营费用 · 所选期间分摊'})
    else {
      previous.amountMinor=previous.amountMinor===null||source.amountMinor===null?null:money(previous.amountMinor+source.amountMinor)
      if(source.businessDate&&(!previous.businessDate||source.businessDate<previous.businessDate))previous.businessDate=source.businessDate
    }
  }
  return [...combined.values()]
}
function breakdown(rows:OperatingDashboardSource[],kind:'income'|'cost'):OperatingDashboardBreakdown[]{
  const groups=new Map<string,OperatingDashboardBreakdown>()
  for(const row of sourceRowsForDisplay(rows).filter(r=>r.kind===kind)) {
    const group=groups.get(row.category)??{code:row.category,label:labels[row.category]??row.category,amountMinor:0,count:0,missingCount:0}
    group.amountMinor=money(group.amountMinor+(row.amountMinor??0));group.count++;group.missingCount+=row.missingCount;groups.set(row.category,group)
  }
  return [...groups.values()]
}
function money(value:string|number):number { const n=Number(value);if(!Number.isSafeInteger(n))throw new RangeError('经营金额超出安全整数范围');return n }
function nullableMoney(value:string|null){return value===null?null:money(value)}
function safeSum(values:number[]){return values.reduce((a,b)=>money(a+b),0)}
function nextDay(date:string){return new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10)}
