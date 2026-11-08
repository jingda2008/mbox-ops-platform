import {randomUUID} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'
import {minimumSpendSummary} from './table-minimum-spend.js'
import {PaymentRepository} from './payment-repository.js'

export class TablePrepaymentError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='TablePrepaymentError'}
}
export class TablePrepaymentRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}
  async lock(sessionId:string,allowClosed=false){
    const row=(await this.tx.query<{status:string;minimum_spend_mode:string;minimum_spend_minor:string;minimum_spend_waiver_minor:string}>(`SELECT status,minimum_spend_mode,COALESCE(transfer_minimum_minor,minimum_spend_minor) AS minimum_spend_minor,minimum_spend_waiver_minor-transfer_waiver_baseline_minor AS minimum_spend_waiver_minor FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,sessionId])).rows[0]
    if(!row||(row.status!=='open'&&!(allowClosed&&['closing','closed'].includes(row.status))))throw new TablePrepaymentError('TABLE_PREPAYMENT_SESSION_CLOSED','桌次已经结束，请联系服务员')
    return row
  }
  async snapshot(sessionId:string,customerId?:string){
    const session=(await this.tx.query<{minimum_spend_mode:string;minimum_spend_minor:string;minimum_spend_waiver_minor:string;location_version:number;table_code:string;table_name:string}>(`SELECT minimum_spend_mode,COALESCE(transfer_minimum_minor,minimum_spend_minor) AS minimum_spend_minor,minimum_spend_waiver_minor-transfer_waiver_baseline_minor AS minimum_spend_waiver_minor,location_version,(SELECT code FROM mbox.tables t WHERE(t.tenant_id,t.store_id,t.id)=(s.tenant_id,s.store_id,s.table_id)) table_code,(SELECT display_name FROM mbox.tables t WHERE(t.tenant_id,t.store_id,t.id)=(s.tenant_id,s.store_id,s.table_id)) table_name FROM mbox.table_sessions s WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,sessionId])).rows[0]
    if(!session)throw new TablePrepaymentError('TABLE_PREPAYMENT_SESSION_CLOSED','桌次不存在')
    if(session.minimum_spend_mode!=='prepaid')return null
    const receipts=(await this.tx.query<{id:string;public_id:string;status:string;amount_minor:string;available:string;mine:boolean;revoked:boolean}>(`SELECT p.id,p.public_id,p.status,p.amount_minor::text,mbox.prepayment_available(p.tenant_id,p.store_id,p.id)::text available,mbox.canonical_customer_id(p.tenant_id,p.store_id,p.prepaid_customer_id)=mbox.canonical_customer_id(p.tenant_id,p.store_id,$4::uuid) mine,EXISTS(SELECT 1 FROM mbox.table_prepayment_revocations revoked WHERE (revoked.tenant_id,revoked.store_id,revoked.payment_id)=(p.tenant_id,p.store_id,p.id)) revoked FROM mbox.payments p WHERE tenant_id=$1 AND store_id=$2 AND prepaid_table_session_id=$3 ORDER BY created_at,id`,[...this.scope,sessionId,customerId??null])).rows
    const goods=Number((await this.tx.query<{amount:string}>('SELECT mbox.table_qualifying_goods($1,$2,$3)::text amount',[...this.scope,sessionId])).rows[0]?.amount??0)
    const summary=minimumSpendSummary(Number(session.minimum_spend_minor)-Number(session.minimum_spend_waiver_minor),goods,0)
    const captured=receipts.filter(p=>['succeeded','partially_refunded','refunded'].includes(p.status))
    const receivedMinor=safeSum(captured.map(p=>p.amount_minor)),availableMinor=safeSum(captured.filter(p=>!p.revoked).map(p=>p.available)),refundableBalanceMinor=safeSum(captured.map(p=>p.available))
    const funds=(await this.tx.query<{net:string;pending:string}>(`SELECT
      (COALESCE((SELECT sum(p.amount_minor) FROM mbox.payments p WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.prepaid_table_session_id=$3 AND p.status IN('succeeded','partially_refunded','refunded')),0)
       +COALESCE((SELECT sum(p.amount_minor) FROM mbox.order_payment_facts p JOIN mbox.orders o ON(o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.order_id) WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.table_session_id=$3 AND p.payable_kind<>'table_prepayment' AND p.status IN('succeeded','partially_refunded','refunded')),0)
       -COALESCE((SELECT sum(r.amount_minor) FROM mbox.refunds r JOIN mbox.payments p ON(p.tenant_id,p.store_id,p.id)=(r.tenant_id,r.store_id,r.payment_id) WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.prepaid_table_session_id=$3 AND r.status NOT IN('cancelled','rejected')),0)
       -COALESCE((SELECT sum(r.amount_minor) FROM mbox.order_refund_facts r JOIN mbox.orders o ON(o.tenant_id,o.store_id,o.id)=(r.tenant_id,r.store_id,r.order_id) JOIN mbox.payments p ON(p.tenant_id,p.store_id,p.id)=(r.tenant_id,r.store_id,r.payment_id) WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.table_session_id=$3 AND p.payable_kind<>'table_prepayment' AND r.status NOT IN('cancelled','rejected')),0))::text net,
      COALESCE((SELECT sum(GREATEST(0,mbox.order_financial_receivable_amount(o.tenant_id,o.store_id,o.id)-COALESCE((SELECT sum(p.amount_minor) FROM mbox.order_payment_facts p WHERE(p.tenant_id,p.store_id,p.order_id)=(o.tenant_id,o.store_id,o.id) AND p.status IN('succeeded','partially_refunded','refunded')),0))) FROM mbox.table_credit_order_links l JOIN mbox.orders o ON(o.tenant_id,o.store_id,o.id)=(l.tenant_id,l.store_id,l.order_id) WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.table_session_id=$3 AND o.status NOT IN('draft','cancelled')),0)::text pending`,[...this.scope,sessionId])).rows[0]
    const netReceivedMinor=Math.max(0,Number(funds?.net??receivedMinor)),pendingOrderDueMinor=Number(funds?.pending??0)
    return {mode:'prepaid' as const,tableCode:session.table_code,tableDisplayName:session.table_name,locationVersion:Number(session.location_version),netReceivedMinor,pendingOrderDueMinor,minimumMinor:Number(session.minimum_spend_minor),waiverMinor:Number(session.minimum_spend_waiver_minor),qualifyingGoodsMinor:summary.consumedMinor,shortfallMinor:summary.shortfallMinor,receivedMinor,availableMinor,refundableBalanceMinor,initialFundingRequiredMinor:Math.max(0,summary.minimumMinor-netReceivedMinor),differenceChargingEnabled:false as const,
      mySharedReceipts:receipts.filter(p=>p.mine&&!p.revoked&&['created','pending','succeeded','partially_refunded'].includes(p.status)).map(p=>({id:p.id,publicId:p.public_id,availableMinor:Number(p.available)})),
      myPendingReceipts:receipts.filter(p=>p.mine&&['created','pending'].includes(p.status)).map(p=>({id:p.id,publicId:p.public_id,amountMinor:Number(p.amount_minor)})),
      message:`本桌按优惠前商品金额累计，当前 ¥${(summary.consumedMinor/100).toFixed(2)} / ¥${(summary.minimumMinor/100).toFixed(2)}；可用预收款 ¥${(availableMinor/100).toFixed(2)}；未结清商品 ¥${(pendingOrderDueMinor/100).toFixed(2)}。余额不足需补款，余款不自动转服务费。`}
  }
  async assertCurrent(sessionId:string,locationVersion?:number,minimumMinor?:number){
    const row=(await this.tx.query<{location:number;minimum:string}>(`SELECT location_version::int location,effective_minimum_spend_minor::text minimum FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,sessionId])).rows[0]
    if(!row||(locationVersion!==undefined&&row.location!==locationVersion)||(minimumMinor!==undefined&&Number(row.minimum)!==minimumMinor))throw new TablePrepaymentError('TABLE_CREDIT_CHANGED','桌位或低消已经变化，请刷新核对后再付款')
  }
  async holdCartBalance(sessionId:string,cart:{id:string;version:number;totalAmountMinor:number|null},paymentId:string){
    await this.lock(sessionId)
    const existing=await this.tx.query('SELECT 1 FROM mbox.guest_credit_holds WHERE tenant_id=$1 AND store_id=$2 AND topup_payment_id=$3',[...this.scope,paymentId])
    if(existing.rowCount)return
    const snapshot=await this.snapshot(sessionId)
    let remaining=Math.min(cart.totalAmountMinor??0,Math.max(0,(snapshot?.availableMinor??0)-(snapshot?.pendingOrderDueMinor??0)))
    const sources=(await this.tx.query<{id:string;available:string}>(`SELECT id,mbox.prepayment_available(tenant_id,store_id,id)::text available FROM mbox.payments p WHERE tenant_id=$1 AND store_id=$2 AND prepaid_table_session_id=$3 AND status IN('succeeded','partially_refunded') AND NOT EXISTS(SELECT 1 FROM mbox.table_prepayment_revocations r WHERE(r.tenant_id,r.store_id,r.payment_id)=(p.tenant_id,p.store_id,p.id)) ORDER BY created_at,id FOR UPDATE`,[...this.scope,sessionId])).rows
    for(const source of sources){const amount=Math.min(remaining,Number(source.available));if(amount<=0)continue;await this.tx.query('INSERT INTO mbox.guest_credit_holds(tenant_id,store_id,cart_id,cart_version,payment_id,topup_payment_id,amount_minor) VALUES($1,$2,$3,$4,$5,$6,$7)',[...this.scope,cart.id,cart.version,source.id,paymentId,amount]);remaining-=amount;if(!remaining)break}
  }
  async allocate(sessionId:string,orderId:string,partial=false):Promise<{paymentIds:string[];amountMinor:number}>{
    const session=await this.lock(sessionId)
    if(session.minimum_spend_mode!=='prepaid')throw new TablePrepaymentError('TABLE_PREPAYMENT_NOT_ENABLED','本桌未启用预收款')
    const summary=await this.snapshot(sessionId)
    if(!summary||(!partial&&summary.initialFundingRequiredMinor>0))throw new TablePrepaymentError('TABLE_PREPAYMENT_REQUIRED',`请先补足本桌预收款，还需 ¥${((summary?.initialFundingRequiredMinor??0)/100).toFixed(2)}，购物车已保留`)
    const order=(await this.tx.query<{amount:string;currency:string;status:string}>(`SELECT GREATEST(0,mbox.order_financial_receivable_amount(tenant_id,store_id,id)-COALESCE((SELECT sum(p.amount_minor) FROM mbox.order_payment_facts p WHERE(p.tenant_id,p.store_id,p.order_id)=(orders.tenant_id,orders.store_id,orders.id) AND p.status IN('succeeded','partially_refunded','refunded')),0))::text amount,currency,status FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND table_session_id=$4 FOR UPDATE`,[...this.scope,orderId,sessionId])).rows[0]
    if(!order||order.status==='cancelled'||order.currency!=='CNY')throw new TablePrepaymentError('TABLE_PREPAYMENT_ORDER_INVALID','订单不属于本桌或已经取消')
    const amountMinor=Number(order.amount)
    if(!Number.isSafeInteger(amountMinor)||amountMinor<0)throw new TypeError('订单金额无效')
    if(amountMinor===0){
      if(partial)return{paymentIds:[],amountMinor:0}
      const result=await this.tx.query(`UPDATE mbox.orders SET payment_status='paid' WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND mbox.order_fully_settled_by_checkout_quote($1,$2,$3)`,[...this.scope,orderId])
      if(result.rowCount!==1)throw new TablePrepaymentError('TABLE_PREPAYMENT_ZERO_ORDER','零金额订单需通过已确认的积分结算')
      return{paymentIds:[],amountMinor:0}
    }
    if(!partial&&summary.availableMinor<amountMinor)throw new TablePrepaymentError('TABLE_PREPAYMENT_INSUFFICIENT',`预收款还差 ¥${((amountMinor-summary.availableMinor)/100).toFixed(2)}，请补充后提交，购物车已保留`)
    const sources=(await this.tx.query<{id:string;available:string}>(`SELECT id,mbox.prepayment_available(tenant_id,store_id,id)::text available FROM mbox.payments WHERE tenant_id=$1 AND store_id=$2 AND prepaid_table_session_id=$3 AND status IN ('succeeded','partially_refunded') AND NOT EXISTS(SELECT 1 FROM mbox.table_prepayment_revocations revoked WHERE (revoked.tenant_id,revoked.store_id,revoked.payment_id)=(payments.tenant_id,payments.store_id,payments.id)) ORDER BY created_at,id FOR UPDATE`,[...this.scope,sessionId])).rows
    const allocating=partial?Math.min(amountMinor,summary.availableMinor):amountMinor
    let remaining=allocating;const paymentIds:string[]=[]
    for(const source of sources){const amount=Math.min(remaining,Number(source.available));if(amount<=0)continue
      await this.tx.query('INSERT INTO mbox.table_prepayment_allocations(tenant_id,store_id,payment_id,order_id,amount_minor) VALUES($1,$2,$3,$4,$5)',[...this.scope,source.id,orderId,amount]);paymentIds.push(source.id);remaining-=amount;if(remaining===0)break
    }
    if(remaining!==0)throw new TablePrepaymentError('TABLE_PREPAYMENT_INSUFFICIENT','预收款余额已变化，请刷新后重试')
    await new PaymentRepository(this.tx).syncOrderPaymentStatus(orderId)
    return{paymentIds,amountMinor:allocating}
  }
  async revoke(sessionId:string,customerId:string,paymentId:string){
    await this.lock(sessionId)
    const inserted=await this.tx.query(`INSERT INTO mbox.table_prepayment_revocations(tenant_id,store_id,payment_id,customer_id,reason) SELECT tenant_id,store_id,id,prepaid_customer_id,'付款人撤销未来共享使用' FROM mbox.payments WHERE tenant_id=$1 AND store_id=$2 AND prepaid_table_session_id=$3 AND mbox.canonical_customer_id(tenant_id,store_id,prepaid_customer_id)=mbox.canonical_customer_id(tenant_id,store_id,$4) AND id=$5 ON CONFLICT DO NOTHING RETURNING payment_id`,[...this.scope,sessionId,customerId,paymentId])
    if(inserted.rowCount!==1&&!((await this.tx.query(`SELECT payment_id FROM mbox.table_prepayment_revocations WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3 AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=mbox.canonical_customer_id(tenant_id,store_id,$4)`,[...this.scope,paymentId,customerId])).rowCount))throw new TablePrepaymentError('TABLE_PREPAYMENT_OWNER_REQUIRED','仅原付款人可撤销这笔共享授权')
    return this.snapshot(sessionId,customerId)
  }
  async waive(sessionId:string,employeeId:string,amountMinor:number,reason:string){
    const session=await this.lock(sessionId,true)
    if(!Number.isSafeInteger(amountMinor)||amountMinor<=0||amountMinor>Number(session.minimum_spend_minor)-Number(session.minimum_spend_waiver_minor)||reason.trim().length<2||reason.length>500)throw new TablePrepaymentError('TABLE_MINIMUM_WAIVER_INVALID','请填写有效减免金额及原因')
    await this.tx.query(`INSERT INTO mbox.table_minimum_spend_waivers(tenant_id,store_id,table_session_id,employee_id,amount_minor,reason) VALUES($1,$2,$3,$4,$5,$6)`,[...this.scope,sessionId,employeeId,amountMinor,reason.trim()])
    await this.tx.query('UPDATE mbox.table_sessions SET minimum_spend_waiver_minor=minimum_spend_waiver_minor+$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,sessionId,amountMinor])
    return this.snapshot(sessionId)
  }
  async requestUnusedRefunds(sessionId:string,employeeId:string,reason:string){
    await this.lock(sessionId,true)
    const summary=await this.snapshot(sessionId)
    if(!summary)throw new TablePrepaymentError('TABLE_PREPAYMENT_NOT_ENABLED','本桌未启用预收款')
    if(summary.shortfallMinor>0)throw new TablePrepaymentError('TABLE_MINIMUM_REVIEW_REQUIRED','本桌商品金额尚未达标，差额收费未启用。请继续点单或由授权员工记录减免后结算')
    if(reason.trim().length<2||reason.length>500)throw new TablePrepaymentError('TABLE_PREPAYMENT_REFUND_REASON','请填写退款原因')
    const pending=(await this.tx.query<{n:string}>(`SELECT count(*)::text n FROM mbox.payments WHERE tenant_id=$1 AND store_id=$2 AND prepaid_table_session_id=$3 AND status IN ('created','pending')`,[...this.scope,sessionId])).rows[0]
    if(Number(pending?.n)>0)throw new TablePrepaymentError('TABLE_PREPAYMENT_PENDING','存在待确认的预付款，请先查询渠道结果')
    const afterSales=(await this.tx.query<{pending:boolean}>(`SELECT EXISTS(
      SELECT 1 FROM mbox.item_after_sales_cases c JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(c.tenant_id,c.store_id,c.order_id)
      WHERE c.tenant_id=$1 AND c.store_id=$2 AND o.table_session_id=$3 AND c.status IN ('requested','approved')
    ) pending`,[...this.scope,sessionId])).rows[0]
    if(afterSales?.pending)throw new TablePrepaymentError('TABLE_PREPAYMENT_PENDING','存在尚未处理完成的退菜，请先完成退菜和原渠道退款，再结算剩余预收款')
    const sources=(await this.tx.query<{id:string;available:string;currency:string}>(`SELECT id,currency,mbox.prepayment_available(tenant_id,store_id,id)::text available FROM mbox.payments WHERE tenant_id=$1 AND store_id=$2 AND prepaid_table_session_id=$3 ORDER BY created_at,id FOR UPDATE`,[...this.scope,sessionId])).rows
    const refundIds:string[]=[]
    for(const source of sources){const amount=Number(source.available);if(amount<=0)continue
      const refund=(await this.tx.query<{id:string}>(`INSERT INTO mbox.refunds(tenant_id,store_id,payment_id,public_id,amount_minor,currency,status,reason,requested_by_employee_id,provider_snapshot) VALUES($1,$2,$3,$4,$5,$6,'requested',$7,$8,'{"source":"unused_table_prepayment","originalPayerOnly":true}'::jsonb) RETURNING id`,[...this.scope,source.id,`prepay-refund-${randomUUID()}`,amount,source.currency,reason.trim(),employeeId])).rows[0]!
      refundIds.push(refund.id)
    }
    return {refundIds,differenceChargingEnabled:false,amountMinor:summary.refundableBalanceMinor}
  }
}
function safeSum(values:readonly string[]):number{const sum=values.reduce((n,v)=>n+BigInt(v),0n);if(sum>BigInt(Number.MAX_SAFE_INTEGER)||sum<0n)throw new TypeError('预收款金额超出范围');return Number(sum)}
