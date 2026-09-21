import { settlementDisplayNumber } from './settlement-display-number.js'
import { readCheckoutPrintSummary } from './checkout-print-summary.js'
import {orderReceivableSql} from './order-collection-sql.js'
import { buildDailyReportLines, DEFAULT_DAILY_REPORT, type DailyReportOptions } from './daily-report-format.js'
import {readOperatingHistory} from './operating-history-query.js'
import type { JsonObject } from './command-executor.js'
import {
  HardwareRepository,
  type HardwareStation,
  type PrintJob,
} from './hardware-repository.js'
import {
  createPrintTicketSnapshot,
  parsePrintTicketSnapshot,
  paginatePrintTicket,
  ticketToJson,
  type PrintTicketKind,
  type PrintTicketLine,
  type PrintTicketPayment,
  type PrintTicketSnapshot,
} from './print-ticket-layout.js'
import type { ScopedTransaction } from './transaction-runner.js'

interface OrderContextRow extends Record<string, unknown> {
  original_amount_minor?: number
  stopped_amount_minor?: number
  settlement_mode: string
  subtotal_amount_minor: string | number
  discount_amount_minor: string | number
  order_status: string
  order_id: string
  order_public_id: string
  order_note: string | null
  total_amount_minor: string | number
  currency: string
  payment_status: string
  table_code: string
  guest_count: number
  business_date: string
  submitted_at: string
}

interface OrderItemRow extends Record<string, unknown> {
  item_id: string
  parent_order_item_id: string | null
  quantity: number
  total_amount_minor: string | number
  unit_price_minor?: string | number
  fulfillment_station: HardwareStation | 'cashier' | 'none'
  product_snapshot: unknown
  note: string | null
}

interface PaymentContextRow extends OrderContextRow {
  retry_released: boolean
  payment_id: string
  payment_public_id: string
  payment_provider: string
  payment_method: string
  payment_amount_minor: string | number
  payment_status_value: string
  succeeded_at: string | null
  settled_payment_count: string | number
  settled_amount_minor: string | number
}

interface RefundContextRow extends OrderContextRow {
  refund_id: string
  refund_public_id: string
  refund_amount_minor: string | number
  refund_status: string
  completed_at: string | null
  payment_provider: string
  payment_method: string
}

interface ActivityPaymentContextRow extends Record<string, unknown> {
  payment_id: string
  payment_public_id: string
  payment_provider: string
  payment_method: string
  payment_amount_minor: string | number
  payment_status_value: string
  succeeded_at: string | null
  business_date: string
  activity_public_id: string
  activity_title: string
  registration_public_id: string
  party_size: number
  currency: string
}

interface ActivityRefundContextRow extends ActivityPaymentContextRow {
  refund_id: string
  refund_public_id: string
  refund_amount_minor: string | number
  refund_status: string
  completed_at: string | null
}

interface RouteCategoryRow extends Record<string, unknown> {
  product_category_code: string | null
}

interface SourceItem {
  id: string
  name: string
  quantity: number
  note: string | null
  totalAmountMinor: number
  unitAmountMinor: number | null
  referenceUnitAmountMinor: number | null
  categoryCode: string | null
  parentOrderItemId: string | null
  fulfillmentStation: HardwareStation | 'cashier' | 'none'
  productKind: string
}

/**
 * Creates printer snapshots exclusively from committed server facts.  It never
 * accepts a product name, amount, table or payment method from an API caller.
 */
export class PrintTicketSourceRepository {
  private explicitSkipReason:string|null=null
  get skipReason():string{return this.explicitSkipReason??this.hardware.lastSkipReason??'print_no_eligible_lines'}
  private readonly hardware: HardwareRepository

  constructor(private readonly transaction: ScopedTransaction, private readonly manualRequest = false) {
    this.hardware = new HardwareRepository(transaction)
  }

  async materializeManualTableBill(sourceId:string,sessionId:string,operatorLabel:string):Promise<readonly PrintJob[]>{
    if(!this.manualRequest)throw new Error('整桌账单须由订单中心明确请求')
    const orders=(await this.transaction.query<{id:string;public_id:string;total_amount_minor:string;status:string}>(`SELECT id,public_id,total_amount_minor::text,status FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3 AND status<>'draft' ORDER BY submitted_at,id LIMIT 1001 FOR SHARE`,[this.transaction.scope.tenantId,this.transaction.scope.storeId,sessionId])).rows
    if(!orders.length)throw new Error('本桌次没有已提交订单，不能生成消费账单')
    if(orders.length>1000)throw new Error('本桌次超过1000单，请按订单分批打印，避免截断账单')
    const context=await this.loadOrderContext(orders[0]!.id)
    const source=(await this.transaction.query<{occurred_at:string}>('SELECT occurred_at::text FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[this.transaction.scope.tenantId,this.transaction.scope.storeId,sourceId])).rows[0]!
    const totals=await readCheckoutPrintSummary(this.transaction,orders.map(o=>o.id))
    const lines:PrintTicketLine[]=[]
    const reductions=new Map((await this.transaction.query<{order_id:string;amount:string}>(`SELECT order_id,sum(amount_minor)::text AS amount FROM mbox.item_receivable_adjustment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[]) GROUP BY order_id`,[this.transaction.scope.tenantId,this.transaction.scope.storeId,orders.map(order=>order.id)])).rows.map(row=>[row.order_id,signedAdjustment(row.amount)]))
    for(const order of orders){
      const original=numeric(order.total_amount_minor,'total'),stopped=reductions.get(order.id)??0
      if(stopped>original)throw new Error('停止减免超过原订单金额，未生成整桌账单')
      lines.push({name:`订单 ${order.public_id}${order.status==='cancelled'?'（已取消）':''}`,quantity:1},...(await this.loadItems(order.id,false,true)).map(toCashierLine),{name:'原订单应付',quantity:1,totalAmountMinor:original})
      if(stopped!==0)lines.push({name:stopped>0?'退菜减额（已扣除）':'套餐按单点价补差（已计入）',quantity:1,totalAmountMinor:Math.abs(stopped)},{name:'退菜重算后应付',quantity:1,totalAmountMinor:original-stopped})
    }
    lines.push({name:'桌次实际收款',quantity:1,totalAmountMinor:totals.received},
      {name:'桌次实际退款',quantity:1,totalAmountMinor:totals.refunded},
      {name:'桌次实际净收',quantity:1,totalAmountMinor:totals.net},
      {name:'尚未收款',quantity:1,totalAmountMinor:totals.due})
    if(totals.pending>0)lines.push({name:'渠道待确认金额（不计入实收）',quantity:1,totalAmountMinor:totals.pending})
    // A manually generated bill is a document of its own. Keep the source UUID
    // for job idempotency and table tracing; older bridges print ticketReference directly.
    const billNumber=settlementDisplayNumber(source.occurred_at,this.transaction.scope.tenantId,this.transaction.scope.storeId,sourceId)
    const statusLabel=totals.state==='paid'?'已确认收款':totals.state==='partial'?'部分收款 · 尚未结清':'未确认收款 · 不代表已付款'
    return this.materializeDocument(sourceId,sessionId,{kind:'order_summary',documentRole:'checkout',checkoutState:totals.state,subtitle:`陆家嘴中心 L+MALL · 本桌次完整消费账单 · ${statusLabel}`,test:false,issuedAt:source.occurred_at,businessDate:context.business_date,ticketReference:billNumber,tableCode:context.table_code,guestCount:context.guest_count,operatorLabel,note:`合计为整桌应付，实收及退款另列。取消订单不计入应付。付款后请重新生成账单；补打保留原快照。原始桌次追溯码：${sessionId}`,payment:null,lines,totalAmountMinor:totals.receivable,currency:currency(context.currency)})
  }

  async materializeManualOrderBill(sourceId:string,orderId:string,operatorLabel:string):Promise<readonly PrintJob[]> {
    if(!this.manualRequest)throw new Error('账单须由订单中心明确请求')
    const source=(await this.transaction.query<{occurred_at:string}>(
      'SELECT occurred_at::text FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2 AND id=$3',
      [this.transaction.scope.tenantId,this.transaction.scope.storeId,sourceId])).rows[0]
    if(!source)throw new Error('打印请求不存在')
    const context=await this.loadOrderContext(orderId)
    if(context.order_status==='draft')throw new Error('草稿不能生成消费账单')
    const items=await this.loadItems(orderId,false,true)
    const amounts=await readCheckoutPrintSummary(this.transaction,[orderId])
    const {received,refunded,pending,due}=amounts
    const total=amounts.receivable
    const unsettled=amounts.state!=='paid'
    const consumedAt=new Date(context.submitted_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})
    const packageComparisons:PrintTicketLine[]=[]
    for(const parent of items.filter(item=>item.productKind==='bundle'&&item.parentOrderItemId===null)){
      const children=items.filter(item=>item.parentOrderItemId===parent.id)
      if(!children.length||children.some(item=>item.referenceUnitAmountMinor===null)||parent.unitAmountMinor===null){
        packageComparisons.push({name:`${parent.name} · 套餐参考价`,quantity:1,note:'历史单点参考价未完整留存，不能计算单点对比优惠。'})
        continue
      }
      const reference=children.reduce((sum,item)=>sum+item.referenceUnitAmountMinor!*item.quantity,0)
      const packagePrice=parent.unitAmountMinor*parent.quantity
      if(!Number.isSafeInteger(reference)||!Number.isSafeInteger(packagePrice))throw new Error('套餐参考金额超出有效范围')
      packageComparisons.push({name:`${parent.name} · 单点参考合计`,quantity:1,totalAmountMinor:reference},
        {name:reference>=packagePrice?'套餐优惠（已体现在套餐售价）':'套餐售价高于单点参考的差额',quantity:1,totalAmountMinor:Math.abs(reference-packagePrice)})
    }
    const lines:PrintTicketLine[]=[{name:'消费时间',quantity:1,note:consumedAt},...items.map(toCashierLine),...packageComparisons,
      {name:'优惠前应付（套餐按套餐售价）',quantity:1,totalAmountMinor:numeric(context.subtotal_amount_minor,'subtotal')},
      {name:'其他优惠减免（已扣除）',quantity:1,totalAmountMinor:numeric(context.discount_amount_minor,'discount')},
      ...receivableAdjustmentLines(context),
      {name:'订单应付金额',quantity:1,totalAmountMinor:total},
      {name:'已确认实际收款',quantity:1,totalAmountMinor:received},
      {name:'已确认实际退款',quantity:1,totalAmountMinor:refunded},
      {name:'实际净收款',quantity:1,totalAmountMinor:received-refunded},
      {name:'尚未收款',quantity:1,totalAmountMinor:due},
      {name:'渠道待确认金额（不计入实收）',quantity:1,totalAmountMinor:pending}]
    return this.materializeDocument(sourceId,orderId,{
      kind:unsettled?'cashier_settlement':'order_summary',checkoutState:amounts.state,
      subtitle:context.order_status==='cancelled'?'订单已取消 · 历史收退款核对':unsettled?(amounts.state==='partial'?'订单预结账 · 部分收款，尚未结清':'订单预结账 · 不代表已付款'):'单笔订单账单 · 非整桌汇总',
      test:false,issuedAt:source.occurred_at,businessDate:context.business_date,
      ticketReference:context.order_public_id,tableCode:context.table_code,guestCount:context.guest_count,
      operatorLabel,note:context.order_note,
      payment:null,lines,totalAmountMinor:total,currency:currency(context.currency),
    })
  }

  async materializeOrderSummary(sourceId: string, orderId: string): Promise<readonly PrintJob[]> {
    const context = await this.loadOrderContext(orderId)
    if (['cancelled', 'draft'].includes(context.order_status)) return []
    const items = await this.loadItems(orderId)
    if (!items.length || !await this.hasActiveRoute('cashier')) return []
    const snapshot: Omit<PrintTicketSnapshot, 'schemaVersion' | 'title'> = {
      kind: 'order_summary', subtitle: 'M-BOX · 整单核对，含后厨商品；不代表已收款', test: false,
      issuedAt: context.submitted_at, businessDate: context.business_date,
      ticketReference: context.order_public_id, tableCode: context.table_code,
      guestCount: context.guest_count, operatorLabel: null, note: context.order_note,
      payment: null, currency: currency(context.currency),
      lines: [...items.map(toCashierLine),...receivableAdjustmentLines(context)],
      totalAmountMinor: numeric(context.total_amount_minor, 'order total'),
    }
    snapshot.lines = [...snapshot.lines,
      {name:'优惠前应付合计（套餐按套餐售价）',quantity:1,totalAmountMinor:numeric(context.subtotal_amount_minor,'subtotal')},
      {name:'优惠减免（已扣除）',quantity:1,totalAmountMinor:numeric(context.discount_amount_minor,'discount')}]
    const jobs = await this.materializeDocument(sourceId, `${context.order_public_id}:summary`, snapshot)
    // A tab order needs a pre-bill before any collection has been initiated.
    // Immediate checkout does not grant this path permission to produce food.
    if (context.settlement_mode === 'table_tab' && ['unpaid', 'pending', 'partially_paid'].includes(context.payment_status)) {
      const amount = numeric(context.total_amount_minor, 'order total')
      const received = (await this.transaction.query<{ net: string }>(`
        SELECT COALESCE(sum(p.amount_minor - COALESCE((SELECT sum(r.amount_minor) FROM mbox.refunds r
          WHERE r.tenant_id=p.tenant_id AND r.store_id=p.store_id AND r.payment_id=p.id AND (r.order_id IS NULL OR r.order_id=p.order_id) AND r.status='succeeded'),0)),0)::text net
        FROM mbox.order_payment_facts p WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.order_id=$3
          AND p.status IN ('succeeded','partially_refunded','refunded')`,
      [this.transaction.scope.tenantId,this.transaction.scope.storeId,orderId])).rows[0]
      const due = Math.max(0, amount - Number(received?.net ?? 0))
      if (due > 0) jobs.push(...await this.materializeDocument(sourceId, `${context.order_public_id}:prebill`,
        { ...snapshot, kind: 'cashier_settlement',
          subtitle: 'M-BOX · 挂单未结清；合计为本订单待收款，不是到账凭证', totalAmountMinor: due }))
    }
    return jobs
  }

  async materializeDelivery(sourceId: string, taskId: string): Promise<readonly PrintJob[]> {
    const task = (await this.transaction.query<{order_id:string; order_item_id:string; ready_at:string}>(`
      SELECT item.order_id,task.order_item_id,task.ready_at::text
      FROM mbox.kds_tasks task JOIN mbox.order_items item
        ON item.tenant_id=task.tenant_id AND item.store_id=task.store_id AND item.id=task.order_item_id
      WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.id=$3
        AND task.status='ready' AND item.status<>'delivered' AND item.status<>'cancelled'
      FOR SHARE OF task,item`, [this.transaction.scope.tenantId,this.transaction.scope.storeId,taskId])).rows[0]
    if (!task) return []
    const context = await this.loadOrderContext(task.order_id)
    if (context.order_status === 'cancelled') return []
    const result = await this.transaction.query<OrderItemRow>(`SELECT item.id AS item_id,item.parent_order_item_id,
      item.quantity,item.unit_price_minor,item.total_amount_minor,item.fulfillment_station,item.product_snapshot,item.note
      FROM mbox.order_items item WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=$3`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,task.order_item_id])
    const item = sourceItem(result.rows[0]!)
    if (item.fulfillmentStation !== 'bar' && item.fulfillmentStation !== 'kitchen') return []
    if (!await this.hasActiveRoute(item.fulfillmentStation)) return []
    return this.materializeDocument(sourceId, taskId, createPrintTicketSnapshot({
      kind:'delivery',subtitle:`M-BOX · ${item.fulfillmentStation === 'kitchen' ? '后厨' : '吧台'}取货后送桌，不是制作单`,
      test:false,issuedAt:task.ready_at,businessDate:context.business_date,ticketReference:context.order_public_id,
      tableCode:context.table_code,guestCount:context.guest_count,operatorLabel:null,note:context.order_note,
      payment:null,lines:[toProductionLine(item)],totalAmountMinor:null,currency:'CNY',
    }), item.fulfillmentStation)
  }

  async materializeDeliveryBatch(sourceId:string,batchId:string):Promise<readonly PrintJob[]>{
    const scope=[this.transaction.scope.tenantId,this.transaction.scope.storeId]
    const batch=(await this.transaction.query<{station_code:'bar'|'kitchen';created_at:string;table_code:string;business_date:string;employee_name:string}>(`
      SELECT batch.station_code,batch.created_at::text,venue.code AS table_code,session.business_date::text,employee.display_name AS employee_name
      FROM mbox.delivery_batches batch JOIN mbox.table_sessions session ON session.tenant_id=batch.tenant_id AND session.store_id=batch.store_id AND session.id=batch.table_session_id
      JOIN mbox.tables venue ON venue.tenant_id=session.tenant_id AND venue.store_id=session.store_id AND venue.id=session.table_id
      JOIN mbox.employees employee ON employee.tenant_id=batch.tenant_id AND employee.store_id=batch.store_id AND employee.id=batch.created_by_employee_id
      WHERE batch.tenant_id=$1 AND batch.store_id=$2 AND batch.id=$3`,[...scope,batchId])).rows[0]
    if(!batch)throw new Error('配送批次不存在')
    const rows=(await this.transaction.query<OrderItemRow & {is_remake:boolean}>(`SELECT item.id AS item_id,item.parent_order_item_id,
      CASE WHEN task.quantity_remake_batch_id IS NULL THEN part.quantity ELSE (SELECT count(*)::int FROM mbox.delivery_batch_remake_units binding
        JOIN mbox.quantity_remake_units physical ON physical.tenant_id=binding.tenant_id AND physical.store_id=binding.store_id AND physical.id=binding.remake_unit_id
        JOIN mbox.order_item_quantity_units original_unit ON original_unit.tenant_id=physical.tenant_id AND original_unit.store_id=physical.store_id AND original_unit.id=physical.unit_id
        JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
        JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
        WHERE binding.tenant_id=part.tenant_id AND binding.store_id=part.store_id AND binding.batch_id=part.batch_id AND binding.kds_task_id=task.id
          AND physical.production_state='ready' AND physical.cancelled_at IS NULL AND original_unit.held_by_case_id IS NULL AND NOT original_unit.operationally_stopped
          AND original.status<>'cancelled' AND visit.status IN ('open','closing')) END AS quantity,task.quantity_remake_batch_id IS NOT NULL AS is_remake,
      item.unit_price_minor,item.total_amount_minor,item.fulfillment_station,item.product_snapshot,item.note
      FROM mbox.delivery_batch_items part JOIN mbox.kds_tasks task ON task.tenant_id=part.tenant_id AND task.store_id=part.store_id AND task.id=part.kds_task_id
      JOIN mbox.order_items item ON item.tenant_id=task.tenant_id AND item.store_id=task.store_id AND item.id=task.order_item_id
      WHERE part.tenant_id=$1 AND part.store_id=$2 AND part.batch_id=$3 ORDER BY item.created_at,item.id`,[...scope,batchId])).rows
    const lines:PrintTicketLine[]=[],keys:string[]=[]
    for(const row of rows){
      if(row.quantity<=0)continue
      const line=toProductionLine(sourceItem(row))
      if(row.is_remake){line.name=`重做：${line.name}`;line.unitAmountMinor=null;line.totalAmountMinor=null}
      const key=JSON.stringify([row.product_snapshot,row.note,row.is_remake])
      const existing=lines[keys.indexOf(key)]
      if(existing)existing.quantity+=line.quantity
      else {lines.push(line);keys.push(key)}
    }
    if(!lines.length){this.explicitSkipReason='print_delivery_no_remaining_quantity';return []}
    return this.materializeDocument(sourceId,batchId,{kind:'delivery',subtitle:'本批配送 · 勿重复制作',test:false,
      issuedAt:batch.created_at,businessDate:batch.business_date,ticketReference:batchId,tableCode:batch.table_code,
      guestCount:null,operatorLabel:batch.employee_name,note:null,payment:null,lines,totalAmountMinor:null,currency:'CNY'},batch.station_code)
  }

  async materializeTableSettlement(sourceId: string, sessionId: string): Promise<readonly PrintJob[]> {
    const session = (await this.transaction.query<{code:string;public_id:string;business_date:string;closed_at:string;guest_count:number}>(`
      SELECT t.code,s.public_id,s.business_date::text,s.closed_at::text,s.guest_count
      FROM mbox.table_sessions s JOIN mbox.tables t ON t.tenant_id=s.tenant_id AND t.store_id=s.store_id AND t.id=s.table_id
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.id=$3 AND s.status='closed' FOR SHARE OF s`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,sessionId])).rows[0]
    if (!session || !await this.hasActiveRoute('cashier')) return []
    const orders = (await this.transaction.query<{id:string;public_id:string;total_amount_minor:string;payment_status:string}>(`
      SELECT ordering.id,ordering.public_id,${orderReceivableSql('ordering')}::text AS total_amount_minor,ordering.payment_status FROM mbox.orders ordering
      WHERE ordering.tenant_id=$1 AND ordering.store_id=$2 AND ordering.table_session_id=$3 AND ordering.status<>'cancelled' ORDER BY ordering.created_at,ordering.id`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,sessionId])).rows
    if (!orders.length || orders.some(o => Number(o.total_amount_minor)>0 && !['paid','refunded','partially_refunded'].includes(o.payment_status))) return []
    const lines: PrintTicketLine[] = []
    for (const order of orders) {
      lines.push({name:`订单 ${order.public_id}`,quantity:1,totalAmountMinor:Number(order.total_amount_minor)})
      for (const item of await this.loadItems(order.id)) lines.push(toProductionLine(item))
    }
    const amounts = (await this.transaction.query<{received:string;refunded:string}>(`
      SELECT COALESCE(sum(p.amount_minor),0)::text received,
        COALESCE(sum((SELECT COALESCE(sum(r.amount_minor),0) FROM mbox.refunds r
          WHERE r.tenant_id=p.tenant_id AND r.store_id=p.store_id AND r.payment_id=p.id AND (r.order_id IS NULL OR r.order_id=p.order_id) AND r.status='succeeded')),0)::text refunded
      FROM mbox.order_payment_facts p JOIN mbox.orders o ON o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.id=p.order_id
      WHERE p.tenant_id=$1 AND p.store_id=$2 AND o.table_session_id=$3 AND p.status IN ('succeeded','partially_refunded','refunded')`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,sessionId])).rows[0]!
    lines.push({name:'累计成功收款',quantity:1,totalAmountMinor:Number(amounts.received)},
      {name:'累计成功退款',quantity:1,totalAmountMinor:Number(amounts.refunded)})
    const existing = (await this.transaction.query<{print_snapshot: JsonObject}>(`
      SELECT print_snapshot FROM mbox.print_jobs
      WHERE tenant_id=$1 AND store_id=$2 AND source_outbox_message_id=$3
        AND print_snapshot->>'kind'='table_settlement'
      ORDER BY created_at,id LIMIT 1`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,sourceId])).rows[0]
    const displayNumber = existing
      ? existing.print_snapshot.displayNumber
      : settlementDisplayNumber(session.closed_at, this.transaction.scope.tenantId, this.transaction.scope.storeId, sessionId)
    return this.materializeDocument(sourceId, sessionId, {
      ...(typeof displayNumber === 'string' ? {displayNumber} : {}),
      kind:'table_settlement',subtitle:'M-BOX · 已关桌，合计为净收款；以生成时财务记录为准',test:false,
      issuedAt:session.closed_at,businessDate:session.business_date,ticketReference:session.public_id,
      tableCode:session.code,guestCount:session.guest_count,operatorLabel:null,note:null,payment:null,
      lines,totalAmountMinor:Math.max(0,Number(amounts.received)-Number(amounts.refunded)),currency:'CNY',
    })
  }

  async materializeManualDailyReport(sourceId:string,businessDate:string,operatorLabel:string,endDate=businessDate,options:DailyReportOptions=DEFAULT_DAILY_REPORT):Promise<readonly PrintJob[]> {
    if(!this.manualRequest)throw new Error('日报需要手动打印请求')
    const snapshot=await readOperatingHistory(this.transaction,{businessDate,endDate,table:'',employee:'',page:0,exportAll:true,allowFinancialSummary:true})
    const source=(await this.transaction.query<{occurred_at:string}>(`SELECT occurred_at::text FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[this.transaction.scope.tenantId,this.transaction.scope.storeId,sourceId])).rows[0]
    if(!source)throw new Error('打印请求不存在')
    const lines=buildDailyReportLines(snapshot,businessDate,endDate,options)
    return this.materializeDocument(sourceId,sourceId,{kind:'daily_settlement',subtitle:`${businessDate} 至 ${endDate} · ${options.mode === 'summary' ? '汇总' : options.mode === 'details' ? '明细' : '汇总及明细'} · 模板2 · 打印不结束营业日`,test:false,
      issuedAt:source.occurred_at,businessDate,ticketReference:sourceId,tableCode:null,guestCount:null,operatorLabel,
      note:'金额及所选订单待收为生成时快照，不是历史时点余额。销售按订单营业日；收退款按入账营业日，包含活动款项。后续入账请重新生成新快照。',payment:null,lines,totalAmountMinor:null,currency:'CNY'})
  }

  async materializeDailySettlement(sourceId:string,boundaryId:string):Promise<readonly PrintJob[]> {
    const row=(await this.transaction.query<{business_date:string;ended_at:string;reason:string;employee_name:string;operating_snapshot:Record<string,string|number>;ledger_snapshot:Array<{provider:string;receivedMinor:string;refundedMinor:string;netMinor:string}>}>(`
      SELECT boundary.business_date::text,boundary.ended_at::text,boundary.reason,employee.display_name AS employee_name,boundary.ledger_snapshot,boundary.operating_snapshot
      FROM mbox.manual_business_day_ends boundary JOIN mbox.employees employee
        ON employee.tenant_id=boundary.tenant_id AND employee.store_id=boundary.store_id AND employee.id=boundary.employee_id
      WHERE boundary.tenant_id=$1 AND boundary.store_id=$2 AND boundary.id=$3`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,boundaryId])).rows[0]
    if(!row)throw new Error('日结记录不存在')
    const amount=(value:string)=>{
      if(!/^-?\d+$/.test(value))throw new Error('日结金额无效')
      const n=BigInt(value),a=n<0n?-n:n
      return `${n<0n?'-':''}${a/100n}.${String(a%100n).padStart(2,'0')}`
    }
    const labels:Record<string,string>={cash:'现金',postar:'星驿',wechat:'微信',physical_pos:'实体POS',external_manual:'其他线下',simulation:'模拟'}
    const lines:PrintTicketLine[]=row.ledger_snapshot.map(receipt=>({name:labels[receipt.provider]??receipt.provider,quantity:1,
      note:`收款 ${amount(receipt.receivedMinor)} / 退款 ${amount(receipt.refundedMinor)} / 净收 ${amount(receipt.netMinor)}`}))
    if(!lines.length)lines.push({name:'本次快照无已入账收退款流水',quantity:1})
    if(typeof row.operating_snapshot.outstandingMinor==='string')lines.push({name:`未结订单 ${row.operating_snapshot.unsettledCount} 单`,quantity:1,
      note:`尚欠 ${amount(row.operating_snapshot.outstandingMinor)}；支付待确认 ${row.operating_snapshot.pendingPaymentCount} 笔；退款待处理 ${row.operating_snapshot.pendingRefundCount} 笔。未处理事项继续保留。`})
    return this.materializeDocument(sourceId,boundaryId,{kind:'daily_settlement',subtitle:'日结时已入账快照；晚到款项和退款另行核对',test:false,
      businessDate:row.business_date,issuedAt:row.ended_at,ticketReference:boundaryId,tableCode:null,guestCount:null,
      operatorLabel:row.employee_name,note:row.reason,payment:null,lines,totalAmountMinor:null,currency:'CNY'})
  }

  private async materializeDocument(sourceId: string, reference: string, snapshot: Omit<PrintTicketSnapshot, 'schemaVersion' | 'title'>, station: HardwareStation = 'cashier'): Promise<PrintJob[]> {
    const jobs: PrintJob[]=[]
    for(const [index,page] of paginatePrintTicket(snapshot).entries()) {
      jobs.push(...await this.hardware.materializeFromOutbox({manualRequest:this.manualRequest,sourceOutboxMessageId:sourceId,stationCode:station,sourceType:station === 'cashier' ? 'cashier' : 'kds',
        sourceReference:`${reference}:page${index+1}`,printSnapshot:ticketToJson(page),containsPriorityNote:page.note !== null || page.lines.some(l=>Boolean(l.note))}))
    }
    return jobs
  }

  async materializeProductionNotice(sourceId:string,aggregateId:string):Promise<readonly PrintJob[]>{
    const source=(await this.transaction.query<{payload:{stationCode:string;categoryCode:string|null;remakeBatchId?:string;ticket:unknown}}>(`SELECT payload FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND aggregate_id=$4 AND message_type='item.after_sales.production_notice.v1'`,[this.transaction.scope.tenantId,this.transaction.scope.storeId,sourceId,aggregateId])).rows[0]
    if(!source||!['bar','kitchen'].includes(source.payload.stationCode))throw new Error('商品处理通知缺少原岗位事实')
    let ticket=parsePrintTicketSnapshot(source.payload.ticket)
    if(ticket.kind!=='production_notice')throw new Error('商品处理通知不得冒充原制作单')
    if(source.payload.remakeBatchId){
      // Count the selected batch before table-context joins. Under RLS, poor
      // cardinality estimates otherwise repeat unit scans for unrelated orders.
      const current=(await this.transaction.query<{quantity:number;table_code:string;guest_count:number}>(`WITH eligible_remake AS MATERIALIZED (
        SELECT batch.tenant_id,batch.store_id,batch.order_item_id,count(*)::int AS quantity
        FROM mbox.quantity_remake_batches batch
        JOIN mbox.quantity_remake_units physical ON physical.tenant_id=batch.tenant_id AND physical.store_id=batch.store_id AND physical.batch_id=batch.id
        JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=physical.tenant_id AND unit.store_id=physical.store_id AND unit.id=physical.unit_id
        WHERE batch.tenant_id=$1 AND batch.store_id=$2 AND batch.id=$3
          AND physical.cancelled_at IS NULL AND physical.production_state IN ('unmade','started')
          AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped
        GROUP BY batch.tenant_id,batch.store_id,batch.order_item_id
       )
       SELECT eligible.quantity,venue.code AS table_code,visit.guest_count
        FROM eligible_remake eligible
        JOIN mbox.order_items item ON item.tenant_id=eligible.tenant_id AND item.store_id=eligible.store_id AND item.id=eligible.order_item_id
        JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
        JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
        JOIN mbox.tables venue ON venue.tenant_id=visit.tenant_id AND venue.store_id=visit.store_id AND venue.id=visit.table_id
        WHERE original.status<>'cancelled' AND visit.status IN ('open','closing')`,[this.transaction.scope.tenantId,this.transaction.scope.storeId,source.payload.remakeBatchId])).rows[0]
      if(!current?.quantity){this.explicitSkipReason='print_remake_no_remaining_quantity';return []}
      if(ticket.lines.length!==1)throw new Error('重做通知必须对应一个实际商品批次')
      ticket={...ticket,lines:[{...ticket.lines[0]!,quantity:current.quantity}],tableCode:current.table_code,guestCount:current.guest_count}
    }

    return this.hardware.materializeFromOutbox({sourceOutboxMessageId:sourceId,stationCode:source.payload.stationCode as 'bar'|'kitchen',productCategoryCode:source.payload.categoryCode,
      sourceType:'kds',sourceReference:`quantity-notice:${aggregateId}`,printSnapshot:ticketToJson(ticket),containsPriorityNote:true})
  }

  async materializeOrderProduction(
    sourceOutboxMessageId: string,
    orderId: string,
  ): Promise<readonly PrintJob[]> {
    const context = await this.loadOrderContext(orderId)
    if (context.order_status === 'cancelled' || context.order_status === 'draft') {this.explicitSkipReason='print_order_not_active';return []}
    const originals = await this.loadItems(orderId, true)
    const quantities=(await this.transaction.query<{order_item_id:string;quantity:number}>(`SELECT unit.order_item_id,count(*) FILTER(WHERE unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped AND unit.production_state IN ('unmade','started') AND NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units remake WHERE remake.tenant_id=unit.tenant_id AND remake.store_id=unit.store_id AND remake.unit_id=unit.id) AND NOT EXISTS(
      SELECT 1 FROM mbox.item_after_sales_case_units selected JOIN mbox.item_after_sales_events event ON event.tenant_id=selected.tenant_id AND event.store_id=selected.store_id AND event.case_id=selected.case_id AND event.event_type='operating.resume'
      WHERE selected.tenant_id=unit.tenant_id AND selected.store_id=unit.store_id AND selected.unit_id=unit.id))::int AS quantity
      FROM mbox.order_item_quantity_units unit JOIN mbox.order_items item ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id
      WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.order_id=$3 GROUP BY unit.order_item_id`,[this.transaction.scope.tenantId,this.transaction.scope.storeId,orderId])).rows
    const quantityByItem=new Map(quantities.map(row=>[row.order_item_id,row.quantity]))
    const items=originals.map(item=>({...item,quantity:quantityByItem.get(item.id)??item.quantity})).filter(item=>item.quantity>0)
    const jobs: PrintJob[] = []
    for (const station of ['bar', 'kitchen'] as const) {
      const operational = items.filter((item) => (
        item.fulfillmentStation === station && item.productKind !== 'bundle'
      ))
      if (operational.length === 0) continue
      const groups = await this.groupsForRoutes(station, operational)
      for (const group of groups) {
        const snapshot = productionSnapshot(context, station, group.items, group.categoryCode)
        const created = await this.hardware.materializeFromOutbox({
          sourceOutboxMessageId,
          stationCode: station,
          productCategoryCode: group.categoryCode,
          sourceType: 'kds',
          sourceReference: `${context.order_public_id}:${station}:${group.categoryCode ?? 'default'}`,
          printSnapshot: ticketToJson(snapshot),
          containsPriorityNote: group.items.some((item) => item.note !== null) || context.order_note !== null,
        })
        jobs.push(...created)
      }
    }
    return jobs
  }

  async materializeCashierSettlement(
    sourceOutboxMessageId: string,
    paymentId: string,
  ): Promise<readonly PrintJob[]> {
    const payment = await this.loadPaymentContext(paymentId)
    if (payment.payment_status_value !== 'pending' || payment.retry_released
      || payment.order_status === 'cancelled' || payment.order_status === 'draft') return []
    const items = await this.loadItems(payment.order_id)
    const remaining = Math.max(0, numeric(payment.total_amount_minor, 'order total') - numeric(payment.settled_amount_minor, 'settled amount'))
    if (remaining === 0) return []
    const snapshot = cashierSnapshot({...payment,total_amount_minor:remaining}, 'cashier_settlement', items, null)
    return this.materializeCashier(sourceOutboxMessageId, payment, snapshot)
  }

  async materializeCashierPayment(
    sourceOutboxMessageId: string,
    paymentId: string,
  ): Promise<readonly PrintJob[]> {
    const kind=(await this.transaction.query<{payable_kind:string}>('SELECT payable_kind FROM mbox.payments WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[this.transaction.scope.tenantId,this.transaction.scope.storeId,paymentId])).rows[0]?.payable_kind
    if(kind==='order_batch')return this.materializeBatchPayment(sourceOutboxMessageId,paymentId)
    const payment = await this.loadPaymentContext(paymentId)
    // A payment voucher states one committed payment, not the entire bill.
    // That keeps split settlements and post-refund replacement payments
    // printable without falsely labelling a partial collection as full payment.
    if (!['succeeded', 'partially_refunded', 'refunded'].includes(payment.payment_status_value)) {this.explicitSkipReason='print_payment_not_confirmed';return []}
    const snapshot = cashierPaymentSnapshot(payment,await this.loadItems(payment.order_id,false,true))
    return this.materializeCashier(sourceOutboxMessageId, payment, snapshot)
  }

  async materializeActivityCashierPayment(
    sourceOutboxMessageId: string,
    paymentId: string,
  ): Promise<readonly PrintJob[]> {
    const payment = await this.loadActivityPaymentContext(paymentId)
    if (!['succeeded', 'partially_refunded', 'refunded'].includes(payment.payment_status_value)) {this.explicitSkipReason='print_payment_not_confirmed';return []}
    const snapshot = createPrintTicketSnapshot({
      kind: 'cashier_payment',
      subtitle: 'M-BOX · 活动现场收款凭条',
      test: false,
      issuedAt: requiredTime(payment.succeeded_at, 'activity payment succeeded_at'),
      businessDate: payment.business_date,
      ticketReference: payment.payment_public_id,
      tableCode: null,
      guestCount: payment.party_size,
      operatorLabel: null,
      note: null,
      payment: paymentFromRow(payment),
      lines: [{
        name: `活动报名 · ${payment.activity_title}`,
        quantity: payment.party_size,
        totalAmountMinor: numeric(payment.payment_amount_minor, 'activity payment amount'),
      }],
      totalAmountMinor: numeric(payment.payment_amount_minor, 'activity payment amount'),
      currency: currency(payment.currency),
    })
    return this.materializeActivityCashier(sourceOutboxMessageId, payment.payment_public_id, snapshot)
  }

  async materializeCashierRefund(
    sourceOutboxMessageId: string,
    refundId: string,
  ): Promise<readonly PrintJob[]> {
    const refund = await this.loadRefundContext(refundId)
    if (refund.refund_status !== 'succeeded') {this.explicitSkipReason='print_refund_not_confirmed';return []}
    const snapshot = createPrintTicketSnapshot({
      kind: 'cashier_refund',
      subtitle: 'M-BOX · 退款已完成',
      test: false,
      issuedAt: refund.completed_at ?? refund.submitted_at,
      businessDate: refund.business_date,
      ticketReference: refund.refund_public_id,
      tableCode: refund.table_code,
      guestCount: refund.guest_count,
      operatorLabel: null,
      note: refund.order_note,
      payment: paymentFromRefund(refund),
      lines: [{ name: `订单退款 · ${refund.order_public_id}`, quantity: 1, totalAmountMinor: numeric(refund.refund_amount_minor, 'refund_amount_minor') }],
      totalAmountMinor: numeric(refund.refund_amount_minor, 'refund_amount_minor'),
      currency: currency(refund.currency),
    })
    if (!await this.hasActiveRoute('cashier')) return []
    return this.hardware.materializeFromOutbox({
      sourceOutboxMessageId,
      stationCode: 'cashier',
      sourceType: 'cashier',
      sourceReference: refund.refund_public_id,
      printSnapshot: ticketToJson(snapshot),
      containsPriorityNote: snapshot.note !== null,
    })
  }

  async materializeActivityCashierRefund(
    sourceOutboxMessageId: string,
    refundId: string,
  ): Promise<readonly PrintJob[]> {
    const refund = await this.loadActivityRefundContext(refundId)
    if (refund.refund_status !== 'succeeded') {this.explicitSkipReason='print_refund_not_confirmed';return []}
    const snapshot = createPrintTicketSnapshot({
      kind: 'cashier_refund',
      subtitle: 'M-BOX · 活动退款已完成',
      test: false,
      issuedAt: requiredTime(refund.completed_at, 'activity refund completed_at'),
      businessDate: refund.business_date,
      ticketReference: refund.refund_public_id,
      tableCode: null,
      guestCount: refund.party_size,
      operatorLabel: null,
      note: null,
      payment: paymentFromRow(refund),
      lines: [{
        name: `活动退款 · ${refund.activity_title}`,
        quantity: refund.party_size,
        totalAmountMinor: numeric(refund.refund_amount_minor, 'activity refund amount'),
      }],
      totalAmountMinor: numeric(refund.refund_amount_minor, 'activity refund amount'),
      currency: currency(refund.currency),
    })
    return this.materializeActivityCashier(sourceOutboxMessageId, refund.refund_public_id, snapshot)
  }


  private async materializeBatchPayment(sourceId:string,paymentId:string):Promise<readonly PrintJob[]>{
    const row=(await this.transaction.query<PaymentContextRow>(`SELECT p.public_id AS payment_public_id,p.provider AS payment_provider,p.method AS payment_method,p.amount_minor AS payment_amount_minor,p.status AS payment_status_value,p.succeeded_at::text,p.currency,t.code AS table_code,v.guest_count,COALESCE((SELECT e.business_date::text FROM mbox.reconciliation_entries e WHERE e.tenant_id=p.tenant_id AND e.store_id=p.store_id AND e.payment_id=p.id AND e.entry_type='payment' LIMIT 1),(p.succeeded_at AT TIME ZONE 'Asia/Shanghai')::date::text) AS business_date FROM mbox.payments p JOIN mbox.order_payment_batches b ON b.tenant_id=p.tenant_id AND b.store_id=p.store_id AND b.id=p.order_batch_id JOIN mbox.table_sessions v ON v.tenant_id=b.tenant_id AND v.store_id=b.store_id AND v.id=b.table_session_id JOIN mbox.tables t ON t.tenant_id=v.tenant_id AND t.store_id=v.store_id AND t.id=v.table_id WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=$3`,[this.transaction.scope.tenantId,this.transaction.scope.storeId,paymentId])).rows[0]
    if(!row)throw new Error('合并收款记录不存在')
    if(!['succeeded','partially_refunded','refunded'].includes(row.payment_status_value))return []
    const allocations=(await this.transaction.query<{order_id:string;public_id:string;amount_minor:string}>(`SELECT a.order_id,o.public_id,a.amount_minor::text FROM mbox.payments p JOIN mbox.order_payment_allocations a ON a.tenant_id=p.tenant_id AND a.store_id=p.store_id AND a.batch_id=p.order_batch_id JOIN mbox.orders o ON o.tenant_id=a.tenant_id AND o.store_id=a.store_id AND o.id=a.order_id WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=$3 ORDER BY a.position`,[this.transaction.scope.tenantId,this.transaction.scope.storeId,paymentId])).rows
    const lines:PrintTicketLine[]=[]
    for(const a of allocations){lines.push({name:`原订单 ${a.public_id}`,quantity:1,note:'以下为原消费明细；本次分摊见后行'},...(await this.loadItems(a.order_id,false,true)).map(toCashierLine),{name:'本次分摊收款',quantity:1,totalAmountMinor:numeric(a.amount_minor,'allocation')})}
    const snapshot:Omit<PrintTicketSnapshot,'schemaVersion'|'title'>={kind:'cashier_payment',subtitle:'M-BOX · 合并收款收据',test:false,issuedAt:requiredTime(row.succeeded_at,'succeeded_at'),businessDate:row.business_date,ticketReference:row.payment_public_id,tableCode:row.table_code,guestCount:row.guest_count,operatorLabel:null,note:'原订单分别保留。明细金额不代表本次重复收取；本次实收以合计为准。',payment:paymentFromRow(row),lines,totalAmountMinor:numeric(row.payment_amount_minor,'payment'),currency:currency(row.currency)}
    return this.materializeDocument(sourceId,row.payment_public_id,snapshot)
  }

  private async materializeCashier(
    sourceOutboxMessageId: string,
    payment: Readonly<PaymentContextRow>,
    snapshot: Readonly<PrintTicketSnapshot>,
  ): Promise<readonly PrintJob[]> {
    if (!await this.hasActiveRoute('cashier')) return []
    return this.hardware.materializeFromOutbox({
      sourceOutboxMessageId,
      stationCode: 'cashier',
      sourceType: 'cashier',
      sourceReference: payment.payment_public_id,
      printSnapshot: ticketToJson(snapshot),
      containsPriorityNote: snapshot.note !== null,
    })
  }

  private async materializeActivityCashier(
    sourceOutboxMessageId: string,
    sourceReference: string,
    snapshot: Readonly<PrintTicketSnapshot>,
  ): Promise<readonly PrintJob[]> {
    if (!await this.hasActiveRoute('cashier')) return []
    return this.hardware.materializeFromOutbox({
      sourceOutboxMessageId,
      stationCode: 'cashier',
      sourceType: 'cashier',
      sourceReference,
      printSnapshot: ticketToJson(snapshot),
      containsPriorityNote: false,
    })
  }

  private async withEffectiveReceivable<T extends OrderContextRow>(row:T):Promise<T>{
    // The preceding context read holds the order. Read the adjustment in a new
    // statement so a stop that committed while that lock was waiting is visible.
    const adjustment=(await this.transaction.query<{amount:string}>(`SELECT COALESCE(sum(amount_minor),0)::text AS amount
      FROM mbox.item_receivable_adjustment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3`,
      [this.transaction.scope.tenantId,this.transaction.scope.storeId,row.order_id])).rows[0]
    if(!adjustment)throw new Error('订单停止金额读取失败，未生成账单')
    const original=numeric(row.total_amount_minor,'original total'),stopped=signedAdjustment(adjustment.amount)
    if(stopped>original)throw new Error('订单停止金额超过原应付，未生成账单')
    return {...row,original_amount_minor:original,stopped_amount_minor:stopped,total_amount_minor:original-stopped}
  }

  private async loadOrderContext(orderId: string): Promise<OrderContextRow> {
    const result = await this.transaction.query<OrderContextRow>(`
      SELECT ordering.id AS order_id, ordering.public_id AS order_public_id,
        ordering.status AS order_status, ordering.settlement_mode, ordering.subtotal_amount_minor, ordering.discount_amount_minor,
        ordering.note AS order_note, ordering.total_amount_minor, ordering.currency,
        ordering.payment_status, venue_table.code AS table_code, session.guest_count,
        ordering.business_date::text, ordering.submitted_at::text
      FROM mbox.orders AS ordering
      JOIN mbox.table_sessions AS session
        ON session.tenant_id=ordering.tenant_id AND session.store_id=ordering.store_id
       AND session.id=ordering.table_session_id
      JOIN mbox.tables AS venue_table
        ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id
       AND venue_table.id=session.table_id
      WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid AND ordering.id=$3::uuid
      FOR SHARE OF ordering, session, venue_table
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    const row = result.rows[0]
    if (!row) throw new Error('打印源订单不存在或不可打印')
    return this.withEffectiveReceivable(row)
  }

  private async loadPaymentContext(paymentId: string): Promise<PaymentContextRow> {
    const result = await this.transaction.query<PaymentContextRow>(`
      SELECT ordering.id AS order_id, ordering.public_id AS order_public_id,
        ordering.status AS order_status, payment.retry_released_at IS NOT NULL AS retry_released,
        ordering.note AS order_note, ordering.total_amount_minor, ordering.currency,
        ordering.payment_status, venue_table.code AS table_code, session.guest_count,
        ordering.business_date::text, ordering.submitted_at::text,
        payment.id AS payment_id, payment.public_id AS payment_public_id,
        payment.provider AS payment_provider, payment.method AS payment_method,
        payment.amount_minor AS payment_amount_minor, payment.status AS payment_status_value,
        payment.succeeded_at::text,
        (SELECT count(*) FROM mbox.order_payment_facts AS settled
          WHERE settled.tenant_id=ordering.tenant_id AND settled.store_id=ordering.store_id
            AND settled.order_id=ordering.id AND settled.status='succeeded')::text AS settled_payment_count,
        (SELECT COALESCE(sum(settled.amount_minor - COALESCE((SELECT sum(r.amount_minor) FROM mbox.refunds r
          WHERE r.tenant_id=settled.tenant_id AND r.store_id=settled.store_id AND r.payment_id=settled.id AND (r.order_id IS NULL OR r.order_id=settled.order_id) AND r.status='succeeded'),0)),0) FROM mbox.order_payment_facts AS settled
          WHERE settled.tenant_id=ordering.tenant_id AND settled.store_id=ordering.store_id
            AND settled.order_id=ordering.id AND settled.status IN ('succeeded','partially_refunded','refunded'))::text AS settled_amount_minor
      FROM mbox.payments AS payment
      JOIN mbox.orders AS ordering
        ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
       AND ordering.id=payment.order_id
      JOIN mbox.table_sessions AS session
        ON session.tenant_id=ordering.tenant_id AND session.store_id=ordering.store_id
       AND session.id=ordering.table_session_id
      JOIN mbox.tables AS venue_table
        ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id
       AND venue_table.id=session.table_id
      WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid AND payment.id=$3::uuid
      FOR SHARE OF payment, ordering, session, venue_table
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const row = result.rows[0]
    if (!row) throw new Error('打印源支付不存在')
    return this.withEffectiveReceivable(row)
  }

  private async loadRefundContext(refundId: string): Promise<RefundContextRow> {
    const result = await this.transaction.query<RefundContextRow>(`
      SELECT ordering.id AS order_id, ordering.public_id AS order_public_id,
        ordering.note AS order_note, ordering.total_amount_minor, ordering.currency,
        ordering.payment_status, venue_table.code AS table_code, session.guest_count,
        ordering.business_date::text, ordering.submitted_at::text,
        refund.id AS refund_id, refund.public_id AS refund_public_id,
        refund.amount_minor AS refund_amount_minor, refund.status AS refund_status,
        refund.completed_at::text,
        payment.provider AS payment_provider, payment.method AS payment_method
      FROM mbox.refunds AS refund
      JOIN mbox.payments AS payment
        ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
       AND payment.id=refund.payment_id
      JOIN mbox.orders AS ordering
        ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
       AND ordering.id=COALESCE(refund.order_id,payment.order_id)
      JOIN mbox.table_sessions AS session
        ON session.tenant_id=ordering.tenant_id AND session.store_id=ordering.store_id
       AND session.id=ordering.table_session_id
      JOIN mbox.tables AS venue_table
        ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id
       AND venue_table.id=session.table_id
      WHERE refund.tenant_id=$1::uuid AND refund.store_id=$2::uuid AND refund.id=$3::uuid
      FOR SHARE OF refund,payment,ordering,session,venue_table
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, refundId])
    const row = result.rows[0]
    if (!row) throw new Error('打印源退款不存在')
    return this.withEffectiveReceivable(row)
  }

  private async loadActivityPaymentContext(paymentId: string): Promise<ActivityPaymentContextRow> {
    const result = await this.transaction.query<ActivityPaymentContextRow>(`
      SELECT payment.id AS payment_id,payment.public_id AS payment_public_id,
        payment.provider AS payment_provider,payment.method AS payment_method,
        payment.amount_minor AS payment_amount_minor,payment.status AS payment_status_value,
        payment.succeeded_at::text,
        COALESCE(reconciliation.business_date::text,(payment.succeeded_at AT TIME ZONE 'Asia/Shanghai')::date::text) AS business_date,
        activity.public_id AS activity_public_id,activity.title AS activity_title,
        registration.public_id AS registration_public_id,registration.party_size,registration.currency
      FROM mbox.payments payment
      JOIN mbox.community_activity_registrations registration
        ON registration.tenant_id=payment.tenant_id AND registration.store_id=payment.store_id
       AND registration.id=payment.activity_registration_id
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      LEFT JOIN LATERAL (
        SELECT entry.business_date
        FROM mbox.reconciliation_entries entry
        WHERE entry.tenant_id=payment.tenant_id AND entry.store_id=payment.store_id
          AND entry.payment_id=payment.id AND entry.entry_type='payment'
        ORDER BY entry.occurred_at DESC,entry.id DESC LIMIT 1
      ) reconciliation ON true
      WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid AND payment.id=$3::uuid
        AND payment.payable_kind='activity_registration'
      FOR SHARE OF payment,registration,activity
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const row = result.rows[0]
    if (!row) throw new Error('打印源活动支付不存在')
    return row
  }

  private async loadActivityRefundContext(refundId: string): Promise<ActivityRefundContextRow> {
    const result = await this.transaction.query<ActivityRefundContextRow>(`
      SELECT payment.id AS payment_id,payment.public_id AS payment_public_id,
        payment.provider AS payment_provider,payment.method AS payment_method,
        payment.amount_minor AS payment_amount_minor,payment.status AS payment_status_value,
        payment.succeeded_at::text,
        COALESCE(reconciliation.business_date::text,(refund.completed_at AT TIME ZONE 'Asia/Shanghai')::date::text) AS business_date,
        activity.public_id AS activity_public_id,activity.title AS activity_title,
        registration.public_id AS registration_public_id,registration.party_size,registration.currency,
        refund.id AS refund_id,refund.public_id AS refund_public_id,
        refund.amount_minor AS refund_amount_minor,refund.status AS refund_status,refund.completed_at::text
      FROM mbox.refunds refund
      JOIN mbox.payments payment
        ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
      JOIN mbox.community_activity_registrations registration
        ON registration.tenant_id=payment.tenant_id AND registration.store_id=payment.store_id
       AND registration.id=payment.activity_registration_id
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      LEFT JOIN LATERAL (
        SELECT entry.business_date
        FROM mbox.reconciliation_entries entry
        WHERE entry.tenant_id=refund.tenant_id AND entry.store_id=refund.store_id
          AND entry.refund_id=refund.id AND entry.entry_type='refund'
        ORDER BY entry.occurred_at DESC,entry.id DESC LIMIT 1
      ) reconciliation ON true
      WHERE refund.tenant_id=$1::uuid AND refund.store_id=$2::uuid AND refund.id=$3::uuid
        AND payment.payable_kind='activity_registration'
      FOR SHARE OF refund,payment,registration,activity
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, refundId])
    const row = result.rows[0]
    if (!row) throw new Error('打印源活动退款不存在')
    return row
  }

  private async loadItems(orderId: string, productionOnly = false, includeCancelled=false): Promise<readonly SourceItem[]> {
    const result = await this.transaction.query<OrderItemRow>(`
      SELECT item.id AS item_id, item.parent_order_item_id, item.quantity,
        item.unit_price_minor, item.total_amount_minor, item.fulfillment_station, item.product_snapshot, CASE WHEN item.status='cancelled' THEN concat_ws('；',item.note,'已取消，保留原消费记录') ELSE item.note END AS note
      FROM mbox.order_items AS item
      WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.order_id=$3::uuid
        AND ($5::boolean OR item.status<>'cancelled')
        AND (NOT $4::boolean OR item.status NOT IN ('ready','delivered'))
      ORDER BY item.created_at, item.id
      FOR SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId, productionOnly,includeCancelled])
    return result.rows.map(sourceItem)
  }

  private async groupsForRoutes(
    station: HardwareStation,
    items: readonly SourceItem[],
  ): Promise<readonly { categoryCode: string | null; items: readonly SourceItem[] }[]> {
    const routes = await this.transaction.query<RouteCategoryRow>(`
      SELECT route.product_category_code
      FROM mbox.printer_routes AS route
      JOIN mbox.devices AS device
        ON device.tenant_id=route.tenant_id AND device.store_id=route.store_id
       AND device.id=route.printer_device_id
      WHERE route.tenant_id=$1::uuid AND route.store_id=$2::uuid
        AND route.station_code=$3 AND route.status='active' AND device.status='active'
      FOR SHARE OF route, device
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, station])
    const exactCategories = new Set(routes.rows.flatMap((route) => route.product_category_code === null ? [] : [route.product_category_code]))
    const hasFallback = routes.rows.some((route) => route.product_category_code === null)
    const groups = new Map<string | null, SourceItem[]>()
    for (const item of items) {
      const categoryCode = item.categoryCode !== null && exactCategories.has(item.categoryCode)
        ? item.categoryCode
        : hasFallback ? null : null
      if (categoryCode === null && !hasFallback && !exactCategories.has(item.categoryCode ?? '')) continue
      const current = groups.get(categoryCode) ?? []
      current.push(item)
      groups.set(categoryCode, current)
    }
    return [...groups.entries()].map(([categoryCode, grouped]) => ({ categoryCode, items: grouped }))
  }

  private async hasActiveRoute(station: HardwareStation): Promise<boolean> {
    const result = await this.transaction.query<{ active: boolean }>(`
      SELECT EXISTS(
        SELECT 1
        FROM mbox.printer_routes AS route
        JOIN mbox.devices AS device
          ON device.tenant_id=route.tenant_id AND device.store_id=route.store_id
         AND device.id=route.printer_device_id
        WHERE route.tenant_id=$1::uuid AND route.store_id=$2::uuid
          AND route.station_code=$3 AND route.status='active' AND device.status='active'
      ) AS active
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, station])
    if(result.rows[0]?.active!==true)this.explicitSkipReason='print_route_missing'
    return result.rows[0]?.active === true
  }
}

function productionSnapshot(
  context: Readonly<OrderContextRow>,
  station: HardwareStation,
  items: readonly SourceItem[],
  categoryCode: string | null,
): PrintTicketSnapshot {
  return createPrintTicketSnapshot({
    kind: station === 'bar' ? 'bar_production' : 'kitchen_production',
    subtitle: categoryCode === null ? 'M-BOX · 现场出品' : `M-BOX · ${categoryCode}`,
    test: false,
    issuedAt: context.submitted_at,
    businessDate: context.business_date,
    ticketReference: context.order_public_id,
    tableCode: context.table_code,
    guestCount: context.guest_count,
    operatorLabel: null,
    note: context.order_note,
    payment: null,
    lines: items.map(toProductionLine),
    totalAmountMinor: null,
    currency: currency(context.currency),
  })
}

function receivableAdjustmentLines(context:Readonly<OrderContextRow>):PrintTicketLine[]{
  return (context.stopped_amount_minor??0)!==0?[
    {name:'原订单应付（停止前）',quantity:1,totalAmountMinor:context.original_amount_minor},
    {name:context.stopped_amount_minor!>0?'退菜减额（已扣除）':'套餐按单点价补差（已计入）',quantity:1,totalAmountMinor:Math.abs(context.stopped_amount_minor!)},
  ]:[]
}

function cashierSnapshot(
  context: Readonly<PaymentContextRow>,
  kind: Extract<PrintTicketKind, 'cashier_settlement' | 'cashier_payment'>,
  items: readonly SourceItem[],
  payment: PrintTicketPayment | null,
): PrintTicketSnapshot {
  const billable = items.filter((item) => item.parentOrderItemId === null)
  if (billable.length === 0) throw new Error('打印源订单没有计费明细')
  return createPrintTicketSnapshot({
    kind,
    subtitle: 'M-BOX · 现场结账服务',
    test: false,
    issuedAt: kind === 'cashier_payment' ? context.succeeded_at ?? context.submitted_at : context.submitted_at,
    businessDate: context.business_date,
    ticketReference: kind === 'cashier_payment' ? context.payment_public_id : context.order_public_id,
    tableCode: context.table_code,
    guestCount: context.guest_count,
    operatorLabel: null,
    note: context.order_note,
    payment,
    lines: [...billable.map(toCashierLine),...receivableAdjustmentLines(context)],
    totalAmountMinor: numeric(context.total_amount_minor, 'total_amount_minor'),
    currency: currency(context.currency),
  })
}

function cashierPaymentSnapshot(context: Readonly<PaymentContextRow>,items:readonly SourceItem[]): PrintTicketSnapshot {
  const amount = numeric(context.payment_amount_minor, 'payment_amount_minor')
  return createPrintTicketSnapshot({
    kind: 'cashier_payment',
    subtitle: 'M-BOX · 本次收款凭条',
    test: false,
    issuedAt: context.succeeded_at ?? context.submitted_at,
    businessDate: context.business_date,
    ticketReference: context.payment_public_id,
    tableCode: context.table_code,
    guestCount: context.guest_count,
    operatorLabel: null,
    note: context.order_note,
    payment: paymentFromRow(context),
    lines: [...items.map(toCashierLine),...receivableAdjustmentLines(context),{name:`订单应付 · ${context.order_public_id}`,quantity:1,totalAmountMinor:numeric(context.total_amount_minor,'order total')},{ name: '本次实际收款', quantity: 1, totalAmountMinor: amount }],
    totalAmountMinor: amount,
    currency: currency(context.currency),
  })
}

function sourceItem(row: Readonly<OrderItemRow>): SourceItem {
  const snapshot = jsonObject(row.product_snapshot, 'product_snapshot')
  const name = text(snapshot.name, 'product_snapshot.name')
  const categoryCode = optionalText(snapshot.categoryCode)
  const productKind = optionalText(snapshot.productKind) ?? 'single'
  return {
    id: row.item_id,
    name,
    quantity: integer(row.quantity, 'quantity'),
    note: row.note,
    totalAmountMinor: numeric(row.total_amount_minor, 'total_amount_minor'),
    unitAmountMinor: row.unit_price_minor === undefined ? null : numeric(row.unit_price_minor, 'unit_price_minor'),
    referenceUnitAmountMinor: typeof snapshot.singlePriceReferenceMinor==='number' && Number.isSafeInteger(snapshot.singlePriceReferenceMinor) && snapshot.singlePriceReferenceMinor>=0 ? snapshot.singlePriceReferenceMinor : null,
    categoryCode,
    parentOrderItemId: row.parent_order_item_id,
    fulfillmentStation: row.fulfillment_station,
    productKind,
  }
}

function toProductionLine(item: Readonly<SourceItem>): PrintTicketLine {
  return { name: item.name, quantity: item.quantity, note: item.note, totalAmountMinor: null }
}

function toCashierLine(item: Readonly<SourceItem>): PrintTicketLine {
  return { name: item.name, quantity: item.quantity,
    note: item.parentOrderItemId ? `套餐内商品，不另收费；${item.referenceUnitAmountMinor===null?'下单时单点参考价未留存':`单点参考单价 ¥${(item.referenceUnitAmountMinor/100).toFixed(2)}`} ${item.note??''}`.trim().slice(0,300) : item.note,
    unitAmountMinor: item.parentOrderItemId ? null : item.unitAmountMinor, totalAmountMinor: item.parentOrderItemId ? null : item.totalAmountMinor }
}

function paymentFromRow(row: Readonly<Pick<PaymentContextRow, 'payment_provider' | 'payment_method'>>): PrintTicketPayment {
  const provider = row.payment_provider
  const method = row.payment_method
  if (!['wechat', 'postar', 'cash', 'physical_pos', 'external_manual', 'simulation'].includes(provider)) throw new Error('支付方式无效')
  if (!['jsapi', 'native_qr', 'auth_code', 'cash', 'card', 'manual'].includes(method)) throw new Error('支付渠道无效')
  return { provider: provider as PrintTicketPayment['provider'], method: method as PrintTicketPayment['method'] }
}

function paymentFromRefund(row: Readonly<RefundContextRow>): PrintTicketPayment {
  const provider = row.payment_provider
  const method = row.payment_method
  if (!['wechat', 'postar', 'cash', 'physical_pos', 'external_manual', 'simulation'].includes(provider)) {
    throw new Error('退款支付方式无效')
  }
  if (!['jsapi', 'native_qr', 'auth_code', 'cash', 'card', 'manual'].includes(method)) {
    throw new Error('退款支付渠道无效')
  }
  return { provider: provider as PrintTicketPayment['provider'], method: method as PrintTicketPayment['method'] }
}

function jsonObject(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field}不是对象`)
  return value as JsonObject
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 120) throw new Error(`${field}无效`)
  return value.trim()
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function signedAdjustment(value:string|number){const amount=Number(value);if(!Number.isSafeInteger(amount))throw new Error('退菜重算金额无效');return amount}

function numeric(value: string | number, field: string): number {
  const numberValue = Number(value)
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) throw new Error(`${field}无效`)
  return numberValue
}

function integer(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999) throw new Error(`${field}无效`)
  return value
}

function currency(value: string): 'CNY' {
  if (value !== 'CNY') throw new Error('暂不支持非CNY打印票据')
  return 'CNY'
}

function requiredTime(value: string | null, field: string): string {
  if (value === null || Number.isNaN(Date.parse(value))) throw new Error(`${field}无效`)
  return value
}
