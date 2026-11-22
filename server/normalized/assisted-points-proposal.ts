import {randomUUID} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'
import {CheckoutCartPricingError} from './checkout-cart-pricing.js'
import {CheckoutPointsRepository} from './checkout-points-repository.js'
import {OrderRepository,type SubmitOrderLineInput} from './order-repository.js'
import {GuestSharedCartRepository} from './guest-shared-cart-repository.js'
import {assertEmployeeTableSessionAccess} from './employee-table-access.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {MAX_CART_QUANTITY,MAX_LINE_QUANTITY} from './guest-shared-cart-limits.js'
import {CheckoutCouponQuoteRepository} from './checkout-coupon-quote-repository.js'

export async function staffPointsProposal(tx:ScopedTransaction,employee:string,session:string,memberNo:string,lines:SubmitOrderLineInput[],points:number|null){
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  await new StaffAccessRepository(tx).assertPermission(employee,'order.create')
  await assertEmployeeTableSessionAccess(tx,{employeeId:employee,tableSessionId:session,allTablePermissionCodes:['payment.collect.all_tables'],lockTableSession:true})
  if(lines.some(l=>l.quantity>MAX_LINE_QUANTITY)||lines.reduce((sum,l)=>sum+l.quantity,0)>MAX_CART_QUANTITY)
    throw new CheckoutCartPricingError('已超出顾客小程序单次可提交的商品份数')
  const member=(await tx.query<{customer_id:string;location_version:string}>(`SELECT m.customer_id,s.location_version
    FROM mbox.table_session_customers tc JOIN mbox.table_sessions s ON (s.tenant_id,s.store_id,s.id)=(tc.tenant_id,tc.store_id,tc.table_session_id)
    JOIN mbox.customer_memberships m ON (m.tenant_id,m.store_id)=(s.tenant_id,s.store_id) AND
      mbox.canonical_customer_id(s.tenant_id,s.store_id,tc.customer_id)=mbox.canonical_customer_id(s.tenant_id,s.store_id,m.customer_id)
    WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.id=$3 AND s.status='open' AND m.status='active' AND m.member_no=$4 LIMIT 1`,
    [...scope,session,memberNo])).rows[0]
  if(!member)throw new CheckoutCartPricingError('请让购餐会员先扫码加入本桌，并核对会员号')
  const price=await new OrderRepository(tx,member.customer_id).quoteCurrent(lines,'guest_qr',false)
  const balance=await new CheckoutPointsRepository(tx).available(member.customer_id)
  const maximumPoints=Math.min(Math.floor(price.subtotalAmountMinor/100),balance.availablePoints)
  if(points===null)return {maximumPoints,subtotalMinor:price.subtotalAmountMinor,id:null}
  if(!Number.isSafeInteger(points)||points<1||points>maximumPoints)throw new CheckoutCartPricingError('请按本单最新可用积分重新填写')
  const carts=new GuestSharedCartRepository(tx,member.customer_id)
  const cart=await carts.getOrCreateOpen(session,'GSC'+randomUUID().replaceAll('-','').toUpperCase())
  if(cart.lines.length || cart.guestWritesFrozen)throw new CheckoutCartPricingError('本桌已有待结菜品或正在核对，请先处理原购物车')
  await tx.query("UPDATE mbox.assisted_points_proposals SET status='superseded' WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3 AND status='pending'",[...scope,session])
  const result=(await tx.query<{id:string}>(`INSERT INTO mbox.assisted_points_proposals(tenant_id,store_id,table_session_id,
    customer_id,employee_id,lines,points,subtotal_minor,location_version,cart_generation,cart_version)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11) RETURNING id`,[...scope,session,member.customer_id,employee,
    JSON.stringify(lines.map((l,i)=>({...l,name:price.items[i]!.name}))),points,price.subtotalAmountMinor,member.location_version,cart.generation,cart.version])).rows[0]!
  return {maximumPoints,subtotalMinor:price.subtotalAmountMinor,id:result.id}
}

export async function readAssistedPoints(tx:ScopedTransaction,session:string,customer:string,lock=false){
  return (await tx.query<{id:string;points:number;lines:(SubmitOrderLineInput&{name:string})[];subtotal_minor:string;cart_version:string;cart_generation:string}>(`
    SELECT p.id,p.points,p.lines,p.subtotal_minor,p.cart_version,p.cart_generation FROM mbox.assisted_points_proposals p JOIN mbox.table_sessions s
      ON (s.tenant_id,s.store_id,s.id)=(p.tenant_id,p.store_id,p.table_session_id)
    WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.table_session_id=$3 AND p.customer_id=mbox.canonical_customer_id($1,$2,$4)
      AND p.status='pending' AND p.expires_at>clock_timestamp() AND s.status='open' AND s.location_version=p.location_version
      ${lock?'FOR UPDATE OF p':''}`,[tx.scope.tenantId,tx.scope.storeId,session,customer])).rows[0]??null
}

export async function adoptAssistedPoints(tx:ScopedTransaction,ctx:{customerId:string;tableSessionId:string;actorRef:string},id:string){
  const p=await readAssistedPoints(tx,ctx.tableSessionId,ctx.customerId,true)
  if(!p||p.id!==id)throw new CheckoutCartPricingError('当前会员、桌次或代点单已变化，请核对原单')
  const carts=new GuestSharedCartRepository(tx,ctx.customerId)
  const ref='GSC'+randomUUID().replaceAll('-','').toUpperCase()
  let cart=await carts.getOrCreateOpen(ctx.tableSessionId,ref)
  if(cart.lines.length||cart.generation!==Number(p.cart_generation)||cart.version!==Number(p.cart_version))throw new CheckoutCartPricingError('本桌购物车已变化，请重新核对')
  const notes:Record<string,string>={}
  for(const [index,line] of p.lines.entries()){
    const previous=new Set(cart.lines.find(item=>item.productId===line.productId)?.portionIds??[])
    cart=await carts.adjust(ctx.tableSessionId,ref,{productId:line.productId,delta:line.quantity,expectedGeneration:cart.generation,
      expectedVersion:cart.version,actorSessionRef:ctx.actorRef,operationId:'assist-'+id+'-'+index,...(line.bundleSelections?{bundleSelections:line.bundleSelections}:{})})
    if(line.note){
      for(const portion of cart.lines.find(item=>item.productId===line.productId)?.portionIds??[]){
        if(!previous.has(portion))notes[portion]=line.note
      }
    }
  }
  const q=await new CheckoutCouponQuoteRepository(tx).prepare({customerId:ctx.customerId,tableSessionId:ctx.tableSessionId,
    expectedGeneration:cart.generation,expectedVersion:cart.version,selections:[],points:p.points,requestKey:'assisted-'+id})
  if(q.subtotalMinor!==Number(p.subtotal_minor))throw new CheckoutCartPricingError('菜品金额已变化，请服务员重新核价')
  await tx.query("UPDATE mbox.assisted_points_proposals SET status='adopted' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[tx.scope.tenantId,tx.scope.storeId,id])
  return {cart,notes,quote:{id:q.id,generation:q.generation,version:q.version,current:q.current,expiresAt:q.expiresAt,pointsUsed:q.pointsUsed,
    subtotalMinor:q.subtotalMinor,discountMinor:q.discountMinor,payableMinor:q.payableMinor,currency:q.currency}}
}
