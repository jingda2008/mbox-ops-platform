import type { JsonObject } from './command-executor.js'
import {
  HardwareRepository,
  type HardwareStation,
  type PrintJob,
} from './hardware-repository.js'
import {
  createPrintTicketSnapshot,
  paginatePrintTicket,
  ticketToJson,
  type PrintTicketKind,
  type PrintTicketLine,
  type PrintTicketPayment,
  type PrintTicketSnapshot,
} from './print-ticket-layout.js'
import type { ScopedTransaction } from './transaction-runner.js'

interface OrderContextRow extends Record<string, unknown> {
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
  name: string
  quantity: number
  note: string | null
  totalAmountMinor: number
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
  private readonly hardware: HardwareRepository

  constructor(private readonly transaction: ScopedTransaction) {
    this.hardware = new HardwareRepository(transaction)
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
      lines: items.map(item => item.parentOrderItemId ? toProductionLine(item) : toCashierLine(item)),
      totalAmountMinor: numeric(context.total_amount_minor, 'order total'),
    }
    snapshot.lines = [...snapshot.lines,
      {name:'商品原价合计',quantity:1,totalAmountMinor:numeric(context.subtotal_amount_minor,'subtotal')},
      {name:'优惠减免（已扣除）',quantity:1,totalAmountMinor:numeric(context.discount_amount_minor,'discount')}]
    const jobs = await this.materializeDocument(sourceId, `${context.order_public_id}:summary`, snapshot)
    // A tab order needs a pre-bill before any collection has been initiated.
    // Immediate checkout does not grant this path permission to produce food.
    if (context.settlement_mode === 'table_tab' && ['unpaid', 'pending', 'partially_paid'].includes(context.payment_status)) {
      const amount = numeric(context.total_amount_minor, 'order total')
      const received = (await this.transaction.query<{ net: string }>(`
        SELECT COALESCE(sum(p.amount_minor - COALESCE((SELECT sum(r.amount_minor) FROM mbox.refunds r
          WHERE r.tenant_id=p.tenant_id AND r.store_id=p.store_id AND r.payment_id=p.id AND r.status='succeeded'),0)),0)::text net
        FROM mbox.payments p WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.order_id=$3
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
    if (!task || !await this.hasActiveRoute('cashier')) return []
    const context = await this.loadOrderContext(task.order_id)
    if (context.order_status === 'cancelled') return []
    const result = await this.transaction.query<OrderItemRow>(`SELECT item.id AS item_id,item.parent_order_item_id,
      item.quantity,item.total_amount_minor,item.fulfillment_station,item.product_snapshot,item.note
      FROM mbox.order_items item WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=$3`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,task.order_item_id])
    const item = sourceItem(result.rows[0]!)
    return this.materializeDocument(sourceId, taskId, createPrintTicketSnapshot({
      kind:'delivery',subtitle:`M-BOX · ${item.fulfillmentStation === 'kitchen' ? '后厨' : '吧台'}取货后送桌，不是制作单`,
      test:false,issuedAt:task.ready_at,businessDate:context.business_date,ticketReference:context.order_public_id,
      tableCode:context.table_code,guestCount:context.guest_count,operatorLabel:null,note:context.order_note,
      payment:null,lines:[toProductionLine(item)],totalAmountMinor:null,currency:'CNY',
    }))
  }

  async materializeTableSettlement(sourceId: string, sessionId: string): Promise<readonly PrintJob[]> {
    const session = (await this.transaction.query<{code:string;public_id:string;business_date:string;closed_at:string;guest_count:number}>(`
      SELECT t.code,s.public_id,s.business_date::text,s.closed_at::text,s.guest_count
      FROM mbox.table_sessions s JOIN mbox.tables t ON t.tenant_id=s.tenant_id AND t.store_id=s.store_id AND t.id=s.table_id
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.id=$3 AND s.status='closed' FOR SHARE OF s`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,sessionId])).rows[0]
    if (!session || !await this.hasActiveRoute('cashier')) return []
    const orders = (await this.transaction.query<{id:string;public_id:string;total_amount_minor:string;payment_status:string}>(`
      SELECT id,public_id,total_amount_minor::text,payment_status FROM mbox.orders
      WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3 AND status<>'cancelled' ORDER BY created_at,id`,
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
          WHERE r.tenant_id=p.tenant_id AND r.store_id=p.store_id AND r.payment_id=p.id AND r.status='succeeded')),0)::text refunded
      FROM mbox.payments p JOIN mbox.orders o ON o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.id=p.order_id
      WHERE p.tenant_id=$1 AND p.store_id=$2 AND o.table_session_id=$3 AND p.status IN ('succeeded','partially_refunded','refunded')`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,sessionId])).rows[0]!
    lines.push({name:'累计成功收款',quantity:1,totalAmountMinor:Number(amounts.received)},
      {name:'累计成功退款',quantity:1,totalAmountMinor:Number(amounts.refunded)})
    return this.materializeDocument(sourceId, sessionId, {
      kind:'table_settlement',subtitle:'M-BOX · 已关桌，合计为净收款；以生成时财务记录为准',test:false,
      issuedAt:session.closed_at,businessDate:session.business_date,ticketReference:session.public_id,
      tableCode:session.code,guestCount:session.guest_count,operatorLabel:null,note:null,payment:null,
      lines,totalAmountMinor:Math.max(0,Number(amounts.received)-Number(amounts.refunded)),currency:'CNY',
    })
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

  private async materializeDocument(sourceId: string, reference: string, snapshot: Omit<PrintTicketSnapshot, 'schemaVersion' | 'title'>): Promise<PrintJob[]> {
    const jobs: PrintJob[]=[]
    for(const [index,page] of paginatePrintTicket(snapshot).entries()) {
      jobs.push(...await this.hardware.materializeFromOutbox({sourceOutboxMessageId:sourceId,stationCode:'cashier',sourceType:'cashier',
        sourceReference:`${reference}:page${index+1}`,printSnapshot:ticketToJson(page),containsPriorityNote:page.note !== null || page.lines.some(l=>Boolean(l.note))}))
    }
    return jobs
  }

  async materializeOrderProduction(
    sourceOutboxMessageId: string,
    orderId: string,
  ): Promise<readonly PrintJob[]> {
    const context = await this.loadOrderContext(orderId)
    if (context.order_status === 'cancelled' || context.order_status === 'draft') return []
    const items = await this.loadItems(orderId, true)
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
    const payment = await this.loadPaymentContext(paymentId)
    // A payment voucher states one committed payment, not the entire bill.
    // That keeps split settlements and post-refund replacement payments
    // printable without falsely labelling a partial collection as full payment.
    if (!['succeeded', 'partially_refunded', 'refunded'].includes(payment.payment_status_value)) return []
    const snapshot = cashierPaymentSnapshot(payment)
    return this.materializeCashier(sourceOutboxMessageId, payment, snapshot)
  }

  async materializeActivityCashierPayment(
    sourceOutboxMessageId: string,
    paymentId: string,
  ): Promise<readonly PrintJob[]> {
    const payment = await this.loadActivityPaymentContext(paymentId)
    if (!['succeeded', 'partially_refunded', 'refunded'].includes(payment.payment_status_value)) return []
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
    if (refund.refund_status !== 'succeeded') return []
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
    if (refund.refund_status !== 'succeeded') return []
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
    return row
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
        (SELECT count(*) FROM mbox.payments AS settled
          WHERE settled.tenant_id=ordering.tenant_id AND settled.store_id=ordering.store_id
            AND settled.order_id=ordering.id AND settled.status='succeeded')::text AS settled_payment_count,
        (SELECT COALESCE(sum(settled.amount_minor - COALESCE((SELECT sum(r.amount_minor) FROM mbox.refunds r
          WHERE r.tenant_id=settled.tenant_id AND r.store_id=settled.store_id AND r.payment_id=settled.id AND r.status='succeeded'),0)),0) FROM mbox.payments AS settled
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
    return row
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
       AND ordering.id=payment.order_id
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
    return row
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

  private async loadItems(orderId: string, productionOnly = false): Promise<readonly SourceItem[]> {
    const result = await this.transaction.query<OrderItemRow>(`
      SELECT item.id AS item_id, item.parent_order_item_id, item.quantity,
        item.total_amount_minor, item.fulfillment_station, item.product_snapshot, item.note
      FROM mbox.order_items AS item
      WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.order_id=$3::uuid
        AND item.status<>'cancelled'
        AND (NOT $4::boolean OR item.status NOT IN ('ready','delivered'))
      ORDER BY item.created_at, item.id
      FOR SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId, productionOnly])
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
    lines: billable.map(toCashierLine),
    totalAmountMinor: numeric(context.total_amount_minor, 'total_amount_minor'),
    currency: currency(context.currency),
  })
}

function cashierPaymentSnapshot(context: Readonly<PaymentContextRow>): PrintTicketSnapshot {
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
    lines: [{ name: `本次收款 · ${context.order_public_id}`, quantity: 1, totalAmountMinor: amount }],
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
    name,
    quantity: integer(row.quantity, 'quantity'),
    note: row.note,
    totalAmountMinor: numeric(row.total_amount_minor, 'total_amount_minor'),
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
  return { name: item.name, quantity: item.quantity, note: item.note, totalAmountMinor: item.totalAmountMinor }
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
