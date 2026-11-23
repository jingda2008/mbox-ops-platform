import {TablePrepaymentRepository} from './table-prepayment-repository.js'
import {LoyaltyAccrualRepository} from './loyalty-accrual-repository.js'
import {orderHasPendingTableCreditSql,orderHasUnpostedCaptureSql} from './verified-capture-sql.js'
import {allocateMinorAmount} from './stacking-pricing.js'
import {createHash} from 'node:crypto'
import {CheckoutCartPricingError} from './checkout-cart-pricing.js'
import {CheckoutPointsRepository} from './checkout-points-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {assertEmployeeTableSessionAccess} from './employee-table-access.js'
import {assertCarryoverCollectionScope} from './payment-security-policy.js'
import {readCarryoverDebt} from './carryover-debt.js'
import type {ScopedTransaction} from './transaction-runner.js'

type Line={id:string;productId:string;name:string;quantity:number;amount:number}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail=(reason:string)=>new CheckoutCartPricingError(reason)

async function facts(tx:ScopedTransaction,orderNo:string){
  const args=[tx.scope.tenantId,tx.scope.storeId,orderNo]
  const o=(await tx.query<{id:string;customer_id:string|null;session:string;closed:boolean;prepaid:boolean;version:string;total:number}>(`SELECT o.id,o.created_by_customer_id customer_id,
      t.id session,t.minimum_spend_mode='prepaid' prepaid,t.status='closed' closed,t.location_version::text version,o.total_amount_minor::int total
    FROM mbox.orders o JOIN mbox.table_sessions t ON t.id=o.table_session_id
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.public_id=$3 AND o.settlement_mode='table_tab' AND (o.status NOT IN('draft','cancelled') OR (t.status='closed' AND mbox.carryover_collection_eligibility(o.tenant_id,o.store_id,o.id)='confirmed'))
    FOR UPDATE OF t,o`,args)).rows[0]
  if(!o)throw fail('请核对原挂桌订单号')
  const scope=[tx.scope.tenantId,tx.scope.storeId,o.id]
  const debt=await readCarryoverDebt(tx,o.id)
  if(o.closed && debt?.eligibility!=='confirmed')throw fail('原闭桌账须先按原流程确认实际消费')
  const financial=(await tx.query<{due:string;receipts:string[];blocked:boolean}>(`SELECT mbox.order_collection_due_amount($1,$2,$3)::text due,
    ARRAY(SELECT id::text FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN('succeeded','refunded','partially_refunded') ORDER BY id) receipts,
    EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN('created','pending'))
    OR EXISTS(SELECT 1 FROM mbox.orders orders WHERE orders.id=$3 AND (${orderHasPendingTableCreditSql}))
    OR EXISTS(SELECT 1 FROM mbox.orders o WHERE o.id=$3 AND ${orderHasUnpostedCaptureSql})
    OR EXISTS(SELECT 1 FROM mbox.order_refund_facts WHERE order_id=$3 AND status NOT IN('rejected','cancelled'))
    OR EXISTS(SELECT 1 FROM mbox.item_after_sales_cases WHERE order_id=$3 AND status NOT IN('rejected','cancelled'))
    OR EXISTS(SELECT 1 FROM mbox.checkout_coupon_order_links WHERE order_id=$3)
    OR EXISTS(SELECT 1 FROM mbox.loyalty_order_awards WHERE order_id=$3)
    OR EXISTS(SELECT 1 FROM mbox.order_items WHERE order_id=$3 AND (status='cancelled' OR discount_amount_minor<>0))
    OR EXISTS(SELECT 1 FROM mbox.order_items child JOIN mbox.order_items parent ON parent.id=child.parent_order_item_id
      WHERE child.order_id=$3 AND (parent.quantity<>1 OR child.total_amount_minor<>0 OR
        coalesce(child.product_snapshot->>'singlePriceReferenceMinor','')!~'^[0-9]{1,15}$')) blocked`,scope)).rows[0]!
  if(financial.blocked)throw fail('原单存在缺少逐份凭证的套餐、优惠、在途款项或售后，请从原账核对')
  const lines=(await tx.query<Line>(`SELECT id,product_id "productId",coalesce(product_snapshot->>'name','原菜品') name,
    quantity,total_amount_minor::int amount FROM mbox.order_items WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND parent_order_item_id IS NULL ORDER BY id`,scope)).rows
  const due=Number(financial.due)
  if(!Number.isSafeInteger(due)||due<=0||due>o.total || !lines.length || lines.length>100 || lines.some(l=>l.amount<=0) || lines.reduce((sum,l)=>sum+l.amount,0)!==o.total)throw fail('原单剩余菜款无法核对')
  if(due<o.total && (lines.length!==1 || lines[0]!.quantity!==1))throw fail('此前已收款项缺少逐份归属，请从原收款明细核对')
  return {o,lines,due,fingerprint:digest([o.id,o.version,o.closed,lines,due,financial.receipts])}
}

async function eligibleMember(tx:ScopedTransaction,o:Awaited<ReturnType<typeof facts>>['o'],employee:string,memberNo:string){
  await new StaffAccessRepository(tx).assertPermission(employee,'order.create')
  if(o.closed)await assertCarryoverCollectionScope(tx,employee,o.id)
  else await assertEmployeeTableSessionAccess(tx,{employeeId:employee,tableSessionId:o.session,allTablePermissionCodes:['payment.collect.all_tables'],lockTableSession:true})
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const member=(await tx.query<{id:string}>(`SELECT m.customer_id id FROM mbox.customer_memberships m WHERE m.tenant_id=$1 AND m.store_id=$2
    AND m.member_no=$3 AND m.status='active' AND (($5::uuid IS NOT NULL AND mbox.canonical_customer_id($1,$2,m.customer_id)=mbox.canonical_customer_id($1,$2,$5))
      OR ($5 IS NULL AND EXISTS(SELECT 1 FROM mbox.table_session_customers tc WHERE tc.table_session_id=$4 AND mbox.canonical_customer_id($1,$2,tc.customer_id)=mbox.canonical_customer_id($1,$2,m.customer_id))))`,
    [...scope,memberNo,o.session,o.customer_id])).rows[0]
  if(!member)throw fail('请核对原单会员或已加入本桌的实际付款会员')
  return member
}

export async function offerTabPoints(tx:ScopedTransaction,employee:string,orderNo:string,memberNo:string,points:number|null,key:string){
  const {o,lines,due,fingerprint}=await facts(tx,orderNo)
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const member=await eligibleMember(tx,o,employee,memberNo)
  const available=await new CheckoutPointsRepository(tx).available(member.id)
  const maximumPoints=Math.min(available.availablePoints,Math.floor(due/100))
  if(points===null)return {maximumPoints,due,lines}
  if(!Number.isSafeInteger(points)||points<1||points>maximumPoints)throw fail('请按最新可用积分重新填写')
  const prior=(await tx.query<{id:string;same:boolean}>(`SELECT id,order_id=$4 AND customer_id=$5 AND points=$6 AND order_fingerprint=$7 AS same
    FROM mbox.tab_points_requests WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 AND request_key=$8`,[...scope,employee,o.id,member.id,points,fingerprint,key])).rows[0]
  if(prior){if(!prior.same)throw fail('该请求已用于其他原单');return {id:prior.id,maximumPoints,due,lines}}
  await tx.query("UPDATE mbox.tab_points_requests SET state='superseded' WHERE order_id=$1 AND state='pending'",[o.id])
  const saved=(await tx.query<{id:string}>(`INSERT INTO mbox.tab_points_requests(tenant_id,store_id,order_id,customer_id,employee_id,points,due_minor,lines,order_fingerprint,request_key,location_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING id`,[...scope,o.id,member.id,employee,points,due,JSON.stringify(lines),fingerprint,key,o.version])).rows[0]!
  return {id:saved.id,maximumPoints,due,lines}
}

export async function confirmTabPoints(tx:ScopedTransaction,id:string,customer:string){
  const args=[tx.scope.tenantId,tx.scope.storeId,id,customer]
  const find=()=>tx.query<{order_no:string;points:number;order_fingerprint:string;state:string;customer_id:string;employee_id:string;member_no:string;fresh:boolean}>(`SELECT o.public_id order_no,r.points,r.order_fingerprint,r.state,r.customer_id,r.employee_id,m.member_no,
    r.created_at+interval '10 minutes'>clock_timestamp() fresh FROM mbox.tab_points_requests r JOIN mbox.orders o ON o.id=r.order_id JOIN mbox.customer_memberships m ON (m.tenant_id,m.store_id,m.customer_id)=(r.tenant_id,r.store_id,r.customer_id)
    WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.id=$3 AND mbox.canonical_customer_id($1,$2,r.customer_id)=mbox.canonical_customer_id($1,$2,$4)`,args)
  let request=(await find()).rows[0]
  if(!request)throw fail('请使用原单指定的购餐会员')
  // Serialize replays with the cashier's order lock before reading the applied state.
  await tx.query('SELECT o.id FROM mbox.orders o JOIN mbox.tab_points_requests r ON r.order_id=o.id JOIN mbox.table_sessions s ON s.id=o.table_session_id WHERE r.id=$1 FOR UPDATE OF s,o',[id])
  request=(await find()).rows[0]!
  if(request.state==='applied')return {id,orderNo:request.order_no}
  if(request.state!=='pending'||!request.fresh)throw fail('申请已变化或已过期，请门店重新核对')
  const {o,lines,due,fingerprint}=await facts(tx,request.order_no)
  if(fingerprint!==request.order_fingerprint)throw fail('桌次、原菜款或已付款发生变化，请重新核对')
  const member=await eligibleMember(tx,o,request.employee_id,request.member_no)
  const points=new CheckoutPointsRepository(tx),available=await points.available(member.id)
  if(request.points>available.availablePoints || request.points*100>due)throw fail('本单可用积分已变化')
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const amount=request.points*100
  const quote=(await tx.query<{id:string}>(`INSERT INTO mbox.checkout_coupon_quotes(tenant_id,store_id,tab_request_id,cart_generation,cart_version,table_session_id,customer_id,
    subtotal_minor,discount_minor,payable_minor,currency,expires_at,request_key,request_fingerprint,points_used,points_policy_id)
    VALUES($1,$2,$3,1,1,$4,$5,$6,$7,$6::bigint-$7::bigint,'CNY',clock_timestamp()+interval '2 minutes',$8,$9,$10,$11) RETURNING id`,
    [...scope,id,o.session,request.customer_id,due,amount,'existing-tab:'+id,fingerprint,request.points,available.policyId])).rows[0]!
  const shares=allocateMinorAmount(amount,lines.map(line=>({id:line.id,amountMinor:lines.length===1?due:line.amount})))
  for(const [index,line] of lines.entries()){
    const remaining=lines.length===1?due:line.amount
    await tx.query(`INSERT INTO mbox.checkout_coupon_quote_lines(tenant_id,store_id,quote_id,request_index,portion_id,tab_item_id,product_id,standard_minor,discount_minor,line_fingerprint)
      VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9)`,[...scope,quote.id,index,line.id,line.productId,remaining,shares.get(line.id)!,digest(line)])
  }
  await tx.query('INSERT INTO mbox.checkout_coupon_quote_seals(tenant_id,store_id,quote_id) VALUES($1,$2,$3)',[...scope,quote.id])
  await points.reserve(quote.id,member.id)
  await tx.query("UPDATE mbox.tab_points_requests SET state='applied',confirmed_at=clock_timestamp() WHERE id=$1",[id])
  await tx.query('INSERT INTO mbox.checkout_coupon_order_links(tenant_id,store_id,quote_id,order_id) VALUES($1,$2,$3,$4)',[...scope,quote.id,o.id])
  for(const line of lines)await tx.query('INSERT INTO mbox.checkout_portion_order_items(tenant_id,store_id,quote_id,portion_id,order_item_id) VALUES($1,$2,$3,$4,$4)',[...scope,quote.id,line.id])
  if(o.prepaid && !o.closed && due>amount)await new TablePrepaymentRepository(tx).allocate(o.session,o.id,true)
  const paymentStatus=await new PaymentRepository(tx).syncOrderPaymentStatus(o.id)
  await points.consume(o.id)
  if(paymentStatus==='paid'){
    const receipt=(await tx.query<{id:string}>(`SELECT id FROM mbox.order_payment_facts WHERE order_id=$1 AND status='succeeded'
      ORDER BY succeeded_at DESC,id LIMIT 1`,[o.id])).rows[0]
    if(receipt)await new LoyaltyAccrualRepository(tx).recordPaidOrder({orderId:o.id,paymentId:receipt.id,occurredAt:new Date().toISOString()})
  }
  return {id,orderNo:request.order_no}
}
