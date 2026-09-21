import type {ScopedTransaction} from './transaction-runner.js'
import {RecollectionAuthorizationConflictError} from './recollection-authorization-repository.js'

export function localUnpresentedPaymentSql(payment='payment',session='session'):string {
  if(![payment,session].every(alias=>/^[a-z_]+$/.test(alias)))throw new TypeError('Invalid SQL alias')
  return `(${payment}.payable_kind IN ('order','order_batch') AND ${payment}.status IN ('created','pending')
    AND ${payment}.amount_minor<=9007199254740991
    AND ${session}.status='closed'
    AND (${payment}.payable_kind='order' OR EXISTS(SELECT 1 FROM mbox.order_payment_batches history_batch
      WHERE (history_batch.tenant_id,history_batch.store_id,history_batch.id) = (${payment}.tenant_id,${payment}.store_id,${payment}.order_batch_id)
        AND history_batch.table_session_id=${session}.id AND history_batch.currency=${payment}.currency AND history_batch.amount_minor=${payment}.amount_minor))
    AND (SELECT sum(history_fact.amount_minor) FROM mbox.order_payment_facts history_fact
      WHERE (history_fact.tenant_id,history_fact.store_id,history_fact.id)=(${payment}.tenant_id,${payment}.store_id,${payment}.id))=${payment}.amount_minor
    AND NOT EXISTS(SELECT 1 FROM mbox.order_payment_facts history_fact
      LEFT JOIN mbox.orders history_order ON (history_order.tenant_id,history_order.store_id,history_order.id)=(history_fact.tenant_id,history_fact.store_id,history_fact.order_id)
      WHERE (history_fact.tenant_id,history_fact.store_id,history_fact.id)=(${payment}.tenant_id,${payment}.store_id,${payment}.id)
        AND (history_order.id IS NULL OR history_order.table_session_id<>${session}.id OR history_order.currency<>${payment}.currency
          OR NOT ${closedDebtEligibilitySql('history_order',session)}
          OR mbox.order_collection_due_amount(history_order.tenant_id,history_order.store_id,history_order.id)<0))
    AND EXISTS(SELECT 1 FROM mbox.order_payment_facts history_fact
      WHERE (history_fact.tenant_id,history_fact.store_id,history_fact.id)=(${payment}.tenant_id,${payment}.store_id,${payment}.id)
        AND mbox.order_collection_due_amount(history_fact.tenant_id,history_fact.store_id,history_fact.order_id)>0)
    AND ${payment}.created_at<=${session}.closed_at AND ${payment}.provider IN ('postar','wechat','simulation')
    AND ${payment}.provider_transaction_id IS NULL AND ${payment}.provider_snapshot='{}'::jsonb
    AND NOT EXISTS(SELECT 1 FROM mbox.payment_provider_actions action WHERE (action.tenant_id,action.store_id,action.payment_id)=(${payment}.tenant_id,${payment}.store_id,${payment}.id))
    AND NOT EXISTS(SELECT 1 FROM mbox.verified_provider_observations observation WHERE (observation.tenant_id,observation.store_id,observation.payment_id)=(${payment}.tenant_id,${payment}.store_id,${payment}.id))
    AND NOT EXISTS(SELECT 1 FROM mbox.payment_reconciliation_states state WHERE (state.tenant_id,state.store_id,state.payment_id)=(${payment}.tenant_id,${payment}.store_id,${payment}.id) AND state.lease_until>clock_timestamp()))`
}

export function preCloseObligationSql(order='orders',session='session'):string {
  if(![order,session].every(alias=>/^[a-z_]+$/.test(alias)))throw new TypeError('Invalid SQL alias')
  return `EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
    JOIN mbox.order_recollection_authorizations original ON (original.tenant_id,original.store_id,original.id)=(obligation.tenant_id,obligation.store_id,obligation.authorization_id)
    WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id)=(${order}.tenant_id,${order}.store_id,${order}.id)
      AND original.created_at<=${session}.closed_at)`
}

/** Original authorization time, not the migration backfill time, proves old debt. */
export function closedDebtEligibilitySql(order='orders',session='session'):string {
  if(![order,session].every(alias=>/^[a-z_]+$/.test(alias)))throw new TypeError('Invalid SQL alias')
  return `(${order}.status NOT IN ('draft','cancelled') AND ${session}.closed_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
      JOIN mbox.order_recollection_authorizations original ON (original.tenant_id,original.store_id,original.id)=(obligation.tenant_id,obligation.store_id,obligation.authorization_id)
      WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id)=(${order}.tenant_id,${order}.store_id,${order}.id)
        AND original.created_at<=${session}.closed_at)
    AND NOT EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
      JOIN mbox.order_recollection_authorizations original ON (original.tenant_id,original.store_id,original.id)=(obligation.tenant_id,obligation.store_id,obligation.authorization_id)
      WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id)=(${order}.tenant_id,${order}.store_id,${order}.id)
        AND original.created_at>${session}.closed_at)
    AND NOT EXISTS(SELECT 1 FROM mbox.order_refund_facts refund
      JOIN mbox.refunds original ON (original.tenant_id,original.store_id,original.id)=(refund.tenant_id,refund.store_id,refund.id)
      WHERE (refund.tenant_id,refund.store_id,refund.order_id)=(${order}.tenant_id,${order}.store_id,${order}.id)
        AND refund.status='succeeded' AND original.purpose IS DISTINCT FROM 'service_compensation'
        AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds quantity WHERE (quantity.tenant_id,quantity.store_id,quantity.refund_id)=(refund.tenant_id,refund.store_id,refund.id))
        AND NOT EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
          WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id,obligation.refund_id)=(refund.tenant_id,refund.store_id,refund.order_id,refund.id)))
    AND mbox.order_collection_due_amount(${order}.tenant_id,${order}.store_id,${order}.id)
      =mbox.order_collection_due_amount_for_mode(${order}.tenant_id,${order}.store_id,${order}.id,true))`
}

export interface ClosedDebtRecovery {
  orderId:string;tableSessionId:string;originalBusinessDate:string;closedAt:string
  outstandingAmountMinor:number;pendingPaymentIds:string[];authorizationId:string|null;eligible:boolean;hasPreCloseObligation:boolean
}

export interface ClosedDebtPaymentTargets {
  paymentId:string;payableKind:'order'|'order_batch';totalAmountMinor:number;currency:string;tableSessionId:string
  orders:Array<ClosedDebtRecovery & {publicId:string;allocationAmountMinor:number}>
}

/** Resolve the entire immutable payable, then lock session -> sorted orders.
 * This also authorizes receipt reads, so current debt and provider state belong
 * in the mutation predicate, not in this identity/scope check. */
export async function lockClosedDebtPaymentTargets(tx:ScopedTransaction,paymentId:string):Promise<ClosedDebtPaymentTargets>{
  const args=[tx.scope.tenantId,tx.scope.storeId,paymentId]
  const selected=await tx.query<{payable_kind:'order'|'order_batch';amount_minor:string;currency:string;table_session_id:string;batch_amount:string|null;batch_currency:string|null}>(`
    SELECT payment.payable_kind,payment.amount_minor::text,payment.currency,
      COALESCE(batch.table_session_id,orders.table_session_id) table_session_id,batch.amount_minor::text batch_amount,batch.currency batch_currency
    FROM mbox.payments payment
    LEFT JOIN mbox.orders orders ON (orders.tenant_id,orders.store_id,orders.id)=(payment.tenant_id,payment.store_id,payment.order_id)
    LEFT JOIN mbox.order_payment_batches batch ON (batch.tenant_id,batch.store_id,batch.id)=(payment.tenant_id,payment.store_id,payment.order_batch_id)
    WHERE payment.tenant_id=$1 AND payment.store_id=$2 AND payment.id=$3 AND payment.payable_kind IN ('order','order_batch')`,args)
  const payment=selected.rows[0]
  if(!payment?.table_session_id)throw new RecollectionAuthorizationConflictError('原订单付款不存在')
  const session=await tx.query<{status:string}>(`SELECT status FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[args[0],args[1],payment.table_session_id])
  if(session.rows[0]?.status!=='closed')throw new RecollectionAuthorizationConflictError('该入口仅用于已关桌历史订单')
  const targets=await tx.query<{id:string;public_id:string;table_session_id:string;currency:string;amount_minor:string}>(`
    SELECT orders.id,orders.public_id,orders.table_session_id,orders.currency,fact.amount_minor::text
    FROM mbox.order_payment_facts fact JOIN mbox.orders orders
      ON (orders.tenant_id,orders.store_id,orders.id)=(fact.tenant_id,fact.store_id,fact.order_id)
    WHERE fact.tenant_id=$1 AND fact.store_id=$2 AND fact.id=$3 ORDER BY orders.id FOR UPDATE OF orders`,args)
  const totalAmount=BigInt(payment.amount_minor),allocationAmounts=targets.rows.map(row=>BigInt(row.amount_minor))
  const safeAmount=(amount:bigint)=>amount>0n&&amount<=BigInt(Number.MAX_SAFE_INTEGER)
  if(!targets.rows.length || !safeAmount(totalAmount) || allocationAmounts.some(amount=>!safeAmount(amount))
    || targets.rows.some(row=>row.table_session_id!==payment.table_session_id||row.currency!==payment.currency)
    || allocationAmounts.reduce((total,amount)=>total+amount,0n)!==totalAmount
    || (payment.payable_kind==='order_batch'&&(payment.batch_amount!==payment.amount_minor||payment.batch_currency!==payment.currency))){
    throw new RecollectionAuthorizationConflictError('原付款全部订单归属或分配不一致，请交财务核对')
  }
  const orders:ClosedDebtPaymentTargets['orders']=[]
  for(const row of targets.rows){
    const recovery=await lockClosedDebtRecovery(tx,row.id)
    if(!recovery?.hasPreCloseObligation||!Number.isSafeInteger(recovery.outstandingAmountMinor))throw new RecollectionAuthorizationConflictError('原付款含无关桌前历史义务或金额不可安全表示的订单，请交财务核对')
    orders.push({...recovery,publicId:row.public_id,allocationAmountMinor:Number(row.amount_minor)})
  }
  return {paymentId,payableKind:payment.payable_kind,totalAmountMinor:Number(payment.amount_minor),currency:payment.currency,tableSessionId:payment.table_session_id,orders}
}

/** Called before payment creation. Session -> order locks serialize all staff recovery. */
export async function lockClosedDebtRecovery(tx:ScopedTransaction,orderId:string):Promise<ClosedDebtRecovery|null>{
  const args=[tx.scope.tenantId,tx.scope.storeId,orderId]
  const location=await tx.query<{table_session_id:string}>(`SELECT table_session_id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,args)
  const sessionId=location.rows[0]?.table_session_id
  if(!sessionId)return null
  const session=await tx.query<{status:string}>(`SELECT status FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...args.slice(0,2),sessionId])
  if(session.rows[0]?.status!=='closed')return null
  await tx.query(`SELECT id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND table_session_id=$4 FOR UPDATE`,[...args,sessionId])
  const result=await tx.query<{original_business_date:string;closed_at:string;due:string;eligible:boolean;has_pre_close_obligation:boolean;pending_ids:string[];authorization_id:string|null}>(`
    SELECT orders.business_date::text original_business_date,session.closed_at::text,
      mbox.order_collection_due_amount(orders.tenant_id,orders.store_id,orders.id)::text due,
      ${closedDebtEligibilitySql()} eligible,${preCloseObligationSql()} has_pre_close_obligation,
      ARRAY(SELECT payment.id FROM mbox.order_payment_facts payment WHERE (payment.tenant_id,payment.store_id,payment.order_id)=(orders.tenant_id,orders.store_id,orders.id)
        AND (payment.status IN ('created','pending') OR EXISTS(SELECT 1 FROM mbox.verified_provider_observations observation
          WHERE (observation.tenant_id,observation.store_id,observation.payment_id)=(payment.tenant_id,payment.store_id,payment.id)
            AND observation.observed_status='payment_succeeded' AND observation.consumed_at IS NULL)) ORDER BY payment.id) pending_ids,
      (SELECT approval.id FROM mbox.order_recollection_authorizations approval
       WHERE (approval.tenant_id,approval.store_id,approval.order_id)=(orders.tenant_id,orders.store_id,orders.id)
         AND approval.status='active' AND approval.expires_at>clock_timestamp() AND approval.currency=orders.currency
         AND approval.amount_minor=mbox.order_collection_due_amount(orders.tenant_id,orders.store_id,orders.id)
       ORDER BY approval.created_at DESC LIMIT 1) authorization_id
    FROM mbox.orders orders JOIN mbox.table_sessions session
      ON (session.tenant_id,session.store_id,session.id)=(orders.tenant_id,orders.store_id,orders.table_session_id)
    WHERE orders.tenant_id=$1 AND orders.store_id=$2 AND orders.id=$3 AND session.id=$4`,[...args,sessionId])
  const row=result.rows[0]
  if(!row)throw new RecollectionAuthorizationConflictError('原订单归属已变化，请刷新后核对')
  return {orderId,tableSessionId:sessionId,originalBusinessDate:row.original_business_date,closedAt:row.closed_at,
    outstandingAmountMinor:Number(row.due),eligible:row.eligible,hasPreCloseObligation:row.has_pre_close_obligation,pendingPaymentIds:row.pending_ids,authorizationId:row.authorization_id}
}

export function assertClosedDebtWritable(recovery:ClosedDebtRecovery):void{
  if(!recovery.eligible||recovery.outstandingAmountMinor<=0)throw new RecollectionAuthorizationConflictError('已关桌订单仅可补收关桌前已确认的历史欠款，请交财务核对')
  if(recovery.pendingPaymentIds.length)throw new RecollectionAuthorizationConflictError('原付款结果尚未明确，请先查询原付款；已关桌历史欠款不能并行收款或释放重试')
}
