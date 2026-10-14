import type {ScopedTransaction} from './transaction-runner.js'
import {LoyaltyOperationalControlRepository} from './loyalty-operational-control-repository.js'
import {CustomerRepository} from './customer-repository.js'
import {CheckoutCartPricingError} from './checkout-cart-pricing.js'

interface Account extends Record<string,unknown>{id:string;membership_id:string;customer_id:string;available_points:number;pending_recovery_points:number;redemption_status:string}
/** Points are removed from spendable lots in the same transaction as order
 * authorization. An unknown provider outcome never releases this reservation. */
export class CheckoutPointsRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}
  private async account(customerId:string,lock=false){
    const customer=await new CustomerRepository(this.tx).resolveCanonical(customerId)
    const account=(await this.tx.query<Account>(`SELECT a.* FROM mbox.loyalty_accounts a JOIN mbox.customer_memberships m ON (m.tenant_id,m.store_id,m.id)=(a.tenant_id,a.store_id,a.membership_id)
      WHERE a.tenant_id=$1 AND a.store_id=$2 AND mbox.canonical_customer_id(a.tenant_id,a.store_id,a.customer_id)=$3 AND m.status='active'
      ORDER BY m.joined_at,m.id LIMIT 1 ${lock?'FOR UPDATE OF a,m':''}`,[...this.scope,customer.id])).rows[0]
    if(!account)throw new CheckoutCartPricingError('请先登录有效会员再使用积分')
    if(account.redemption_status!=='active'||account.pending_recovery_points>0)throw new CheckoutCartPricingError('积分账户暂不可抵扣，请联系门店核对')
    return account
  }
  async available(customerId:string){
    const control=await new LoyaltyOperationalControlRepository(this.tx).state('points_redemption',true)
    if(control.state==='paused')throw new CheckoutCartPricingError('门店已暂停新增积分抵扣，原订单仍可查询和处理')
    const account=await this.account(customerId)
    const policy=(await this.tx.query<{id:string}>(`SELECT id FROM mbox.loyalty_policy_versions WHERE tenant_id=$1 AND store_id=$2 AND policy_code='BASE' AND status='published' AND points_rounding_scope='order' AND cash_redemption_enabled AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()) ORDER BY version DESC LIMIT 1`,this.scope)).rows[0]
    if(!policy)throw new CheckoutCartPricingError('积分抵扣规则尚未发布或已停用')
    const lots=(await this.tx.query<{points:string}>(`SELECT COALESCE(sum(remaining_points),0)::text AS points FROM mbox.loyalty_point_lots WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3 AND status='available' AND available_at<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp())`,[...this.scope,account.membership_id])).rows[0]!
    return {availablePoints:Math.min(account.available_points,Number(lots.points)),policyId:policy.id,minorPerPoint:100,minimumPayableMinor:0,allowCoupons:false,earnMinorPerPoint:1000}
  }
  async reserve(quoteId:string,customerId:string){
    const account=await this.account(customerId,true)
    const quote=(await this.tx.query<{points_used:number;customer_id:string;points_policy_id:string}>(`SELECT points_used,customer_id,points_policy_id FROM mbox.checkout_coupon_quotes WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND points_used>0`,[...this.scope,quoteId])).rows[0]
    if(!quote)throw new CheckoutCartPricingError('积分报价不存在')
    const current=await this.available(customerId)
    if(quote.points_policy_id!==current.policyId)throw new CheckoutCartPricingError('积分规则已变化，请重新核对')
    const previous=await this.tx.query('SELECT 1 FROM mbox.checkout_point_holds WHERE tenant_id=$1 AND store_id=$2 AND quote_id=$3',[...this.scope,quoteId])
    if(previous.rowCount)throw new CheckoutCartPricingError('积分报价已使用，请核对原订单')
    if(current.availablePoints<quote.points_used)throw new CheckoutCartPricingError('积分余额不足或已被其他订单占用，请重新核对')
    await this.tx.query(`INSERT INTO mbox.checkout_point_holds(tenant_id,store_id,quote_id,membership_id,customer_id,points) VALUES($1,$2,$3,$4,$5,$6)`,[...this.scope,quoteId,account.membership_id,account.customer_id,quote.points_used])
    const lots=(await this.tx.query<{id:string;remaining_points:number}>(`SELECT id,remaining_points FROM mbox.loyalty_point_lots WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3 AND status='available' AND remaining_points>0 AND available_at<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY expires_at NULLS LAST,available_at,id FOR UPDATE`,[...this.scope,account.membership_id])).rows
    let remaining=quote.points_used
    for(const lot of lots){
      if(!remaining)break
      const used=Math.min(remaining,lot.remaining_points),after=lot.remaining_points-used
      await this.tx.query(`UPDATE mbox.loyalty_point_lots SET remaining_points=$4,status=CASE WHEN $4=0 THEN 'consumed' ELSE 'available' END WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,lot.id,after])
      await this.tx.query('INSERT INTO mbox.checkout_point_lots(tenant_id,store_id,quote_id,lot_id,points) VALUES($1,$2,$3,$4,$5)',[...this.scope,quoteId,lot.id,used])
      await this.tx.query(`INSERT INTO mbox.loyalty_point_lot_movements(tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,source_type,source_id,idempotency_key) VALUES($1,$2,$3,'redeem',$4,$5,'redemption',$6,$7)`,[...this.scope,lot.id,-used,after,quoteId,`checkout-points:${quoteId}:${lot.id}`])
      remaining-=used
    }
    if(remaining)throw new CheckoutCartPricingError('积分批次发生变化，请重新核对')
    await this.balance(account,account.available_points-quote.points_used)
    await this.tx.query(`INSERT INTO mbox.loyalty_point_ledger(tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,source_type,source_id,reason,idempotency_key) VALUES($1,$2,$3,$4,'redeem',$5,$6,'redemption',$7,'结账积分占用；每积分抵一元，待结清确认',$8)`,[...this.scope,account.membership_id,account.customer_id,-quote.points_used,account.available_points-quote.points_used,quoteId,`checkout-points:${quoteId}`])
  }
  async consume(orderId:string){
    await this.tx.query(`UPDATE mbox.checkout_point_holds h SET status='consumed' FROM mbox.checkout_coupon_order_links l WHERE (h.tenant_id,h.store_id,h.quote_id)=(l.tenant_id,l.store_id,l.quote_id) AND l.tenant_id=$1 AND l.store_id=$2 AND l.order_id=$3 AND h.status='held' AND mbox.order_consumption_settled($1,$2,$3)`,[...this.scope,orderId])
  }
  async releaseCancelled(orderId:string){
    const order=(await this.tx.query<{quote_id:string;points:number}>(`SELECT h.quote_id,h.points FROM mbox.orders o JOIN mbox.checkout_coupon_order_links l ON (l.tenant_id,l.store_id,l.order_id)=(o.tenant_id,o.store_id,o.id) JOIN mbox.checkout_point_holds h ON (h.tenant_id,h.store_id,h.quote_id)=(l.tenant_id,l.store_id,l.quote_id)
      WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.id=$3 AND o.status='cancelled' AND o.fulfillment_state='cancelled' AND h.status='held'
      AND NOT EXISTS(SELECT 1 FROM mbox.order_payment_facts p WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id AND p.status IN('created','pending'))
      AND NOT EXISTS(SELECT 1 FROM mbox.order_payment_facts p WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id AND p.status IN('succeeded','partially_refunded','refunded') AND p.amount_minor>COALESCE((SELECT sum(r.amount_minor) FROM mbox.order_refund_facts r WHERE r.tenant_id=p.tenant_id AND r.store_id=p.store_id AND r.order_id=p.order_id AND r.payment_id=p.id AND r.status='succeeded'),0))
      FOR UPDATE OF o`,[...this.scope,orderId])).rows[0]
    if(!order)return 0
    const restored=await this.restoreTo(order.quote_id,order.points,'cancelled')
    await this.tx.query("UPDATE mbox.checkout_point_holds SET status='released' WHERE tenant_id=$1 AND store_id=$2 AND quote_id=$3",[...this.scope,order.quote_id])
    return restored
  }
  async restoreRefund(orderId:string,refundId:string){
    if(!(await this.tx.query<{present:boolean}>("SELECT to_regclass('mbox.checkout_point_holds') IS NOT NULL AS present")).rows[0]?.present)return 0
    const hold=(await this.tx.query<{quote_id:string}>(`SELECT l.quote_id FROM mbox.checkout_coupon_order_links l JOIN mbox.checkout_point_holds h ON (h.tenant_id,h.store_id,h.quote_id)=(l.tenant_id,l.store_id,l.quote_id) WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.order_id=$3 AND h.status='consumed' AND EXISTS(SELECT 1 FROM mbox.order_refund_facts r WHERE r.tenant_id=l.tenant_id AND r.store_id=l.store_id AND r.order_id=l.order_id AND r.id=$4 AND r.status='succeeded')`,[...this.scope,orderId,refundId])).rows[0]
    if(!hold)return 0
    const target=await this.restorationTarget(orderId)
    return this.restoreTo(hold.quote_id,target,`refund:${refundId}:${target}`)
  }
  private async restorationTarget(orderId:string){
    const value=(await this.tx.query<{points:string}>(`WITH returned_units AS (
      SELECT u.* FROM mbox.order_item_quantity_units u JOIN mbox.item_after_sales_cases c ON (c.tenant_id,c.store_id,c.id)=(u.tenant_id,u.store_id,u.stopped_by_case_id)
      WHERE u.tenant_id=$1 AND u.store_id=$2 AND c.order_id=$3 AND u.operationally_stopped
        AND c.status IN('approved','completed') AND c.decided_by_employee_id IS NOT NULL AND c.decided_by_employee_id<>c.requested_by_employee_id
        AND (c.amount_minor=0 OR c.amount_minor=(SELECT COALESCE(sum(r.amount_minor),0) FROM mbox.item_after_sales_case_refunds link JOIN mbox.refunds r ON (r.tenant_id,r.store_id,r.id)=(link.tenant_id,link.store_id,link.refund_id) WHERE (link.tenant_id,link.store_id,link.case_id)=(c.tenant_id,c.store_id,c.id) AND r.status='succeeded'))
    ) SELECT COALESCE(floor(sum(CASE
      WHEN EXISTS(SELECT 1 FROM mbox.order_items child WHERE (child.tenant_id,child.store_id,child.parent_order_item_id)=(i.tenant_id,i.store_id,i.id)) THEN
        CASE WHEN EXISTS(SELECT 1 FROM returned_units u JOIN mbox.order_items child ON child.id=u.order_item_id AND child.tenant_id=u.tenant_id AND child.store_id=u.store_id WHERE child.parent_order_item_id=i.id)
          AND NOT EXISTS(SELECT 1 FROM mbox.order_items child WHERE (child.tenant_id,child.store_id,child.parent_order_item_id)=(i.tenant_id,i.store_id,i.id) AND child.quantity>(SELECT count(*) FROM returned_units u WHERE u.order_item_id=child.id) AND COALESCE(child.product_snapshot->>'singlePriceReferenceMinor','')!~'^[0-9]{1,15}$') THEN
          GREATEST(0,i.discount_amount_minor-COALESCE((SELECT sum(CASE WHEN child.quantity=(SELECT count(*) FROM returned_units u WHERE u.order_item_id=child.id) THEN 0 ELSE (child.quantity-(SELECT count(*) FROM returned_units u WHERE u.order_item_id=child.id))*(child.product_snapshot->>'singlePriceReferenceMinor')::bigint END) FROM mbox.order_items child WHERE (child.tenant_id,child.store_id,child.parent_order_item_id)=(i.tenant_id,i.store_id,i.id)),0)) ELSE 0 END
      WHEN i.total_amount_minor>0 THEN
        i.discount_amount_minor::numeric*LEAST(i.total_amount_minor,COALESCE((SELECT sum(ri.amount_minor) FROM mbox.refund_items ri JOIN mbox.refunds r ON (r.tenant_id,r.store_id,r.id)=(ri.tenant_id,ri.store_id,ri.refund_id) WHERE ri.tenant_id=i.tenant_id AND ri.store_id=i.store_id AND ri.order_item_id=i.id AND r.status='succeeded' AND r.purpose IS DISTINCT FROM 'service_compensation'),0))/i.total_amount_minor
      ELSE i.discount_amount_minor::numeric*(SELECT count(*) FROM returned_units u WHERE u.order_item_id=i.id)/i.quantity
      END)/100),0)::text AS points FROM mbox.order_items i WHERE i.tenant_id=$1 AND i.store_id=$2 AND i.order_id=$3 AND i.parent_order_item_id IS NULL`,[...this.scope,orderId])).rows[0]!
    return Number(value.points)
  }
  async fullySettled(orderId:string){
    if(!(await this.tx.query<{present:boolean}>("SELECT to_regprocedure('mbox.order_fully_settled_by_points(uuid,uuid,uuid)') IS NOT NULL AS present")).rows[0]?.present)return false
    return (await this.tx.query<{settled:boolean}>('SELECT mbox.order_fully_settled_by_points($1,$2,$3) AS settled',[...this.scope,orderId])).rows[0]?.settled===true
  }
  async casePoints(caseId:string){
    const header=(await this.tx.query<{order_id:string;requested_by_employee_id:string}>('SELECT order_id,requested_by_employee_id FROM mbox.item_after_sales_cases WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,caseId])).rows[0]
    if(!header || !(await this.tx.query<{present:boolean}>("SELECT to_regclass('mbox.checkout_point_holds') IS NOT NULL AS present")).rows[0]?.present)return null
    if(!(await this.tx.query('SELECT 1 FROM mbox.checkout_coupon_order_links l JOIN mbox.checkout_point_holds h ON (h.tenant_id,h.store_id,h.quote_id)=(l.tenant_id,l.store_id,l.quote_id) WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.order_id=$3 AND h.status=\'consumed\'',[...this.scope,header.order_id])).rowCount)return null
    const value=(await this.tx.query<{minor:string}>(`SELECT COALESCE(ceil(CASE WHEN bool_or(i.parent_order_item_id IS NOT NULL) THEN max((SELECT root.discount_amount_minor FROM mbox.order_items root WHERE (root.tenant_id,root.store_id,root.id)=(i.tenant_id,i.store_id,i.parent_order_item_id))) ELSE sum(i.discount_amount_minor::numeric/i.quantity) END),0)::text AS minor
      FROM mbox.item_after_sales_case_units s JOIN mbox.order_item_quantity_units u ON (u.tenant_id,u.store_id,u.id)=(s.tenant_id,s.store_id,s.unit_id)
      JOIN mbox.order_items i ON (i.tenant_id,i.store_id,i.id)=(u.tenant_id,u.store_id,u.order_item_id)
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.case_id=$3`,[...this.scope,caseId])).rows[0]!
    return {orderId:header.order_id,requester:header.requested_by_employee_id,approvalAmountMinor:Number(value.minor)}
  }
  async restoreStoppedCase(caseId:string){
    const info=await this.casePoints(caseId)
    if(!info)return 0
    const hold=(await this.tx.query<{quote_id:string}>(`SELECT h.quote_id FROM mbox.checkout_point_holds h JOIN mbox.checkout_coupon_order_links l ON (l.tenant_id,l.store_id,l.quote_id)=(h.tenant_id,h.store_id,h.quote_id)
      WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.order_id=$3 AND h.status='consumed'`,[...this.scope,info.orderId])).rows[0]
    if(!hold)return 0
    const target=await this.restorationTarget(info.orderId)
    return this.restoreTo(hold.quote_id,target,`case:${caseId}:${target}`)
  }
  private async restoreTo(quoteId:string,targetPoints:number,sourceKey:string){
    const row=(await this.tx.query<Account & {points:number;restored_points:number}>(`SELECT a.*,h.points,h.restored_points FROM mbox.checkout_point_holds h JOIN mbox.loyalty_accounts a ON (a.tenant_id,a.store_id,a.membership_id)=(h.tenant_id,h.store_id,h.membership_id) WHERE h.tenant_id=$1 AND h.store_id=$2 AND h.quote_id=$3 FOR UPDATE OF a,h`,[...this.scope,quoteId])).rows[0]
    if(!row)return 0
    if(!Number.isSafeInteger(targetPoints)||targetPoints<0||targetPoints>row.points)throw new Error('Points restoration exceeds original deduction')
    const delta=targetPoints-row.restored_points
    if(delta<=0)return 0
    const lots=(await this.tx.query<{lot_id:string;points:number;restored_points:number;unexpired:boolean}>(`SELECT a.*,l.expires_at IS NULL OR l.expires_at>clock_timestamp() AS unexpired FROM mbox.checkout_point_lots a JOIN mbox.loyalty_point_lots l ON (l.tenant_id,l.store_id,l.id)=(a.tenant_id,a.store_id,a.lot_id) WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.quote_id=$3 ORDER BY l.expires_at NULLS LAST,l.available_at,l.id FOR UPDATE OF a,l`,[...this.scope,quoteId])).rows
    let left=delta,credited=0
    for(const lot of lots){
      const count=Math.min(left,lot.points-lot.restored_points)
      if(count<=0)continue
      left-=count
      await this.tx.query('UPDATE mbox.checkout_point_lots SET restored_points=restored_points+$5 WHERE tenant_id=$1 AND store_id=$2 AND quote_id=$3 AND lot_id=$4',[...this.scope,quoteId,lot.lot_id,count])
      if(lot.unexpired){
        const changed=await this.tx.query(`UPDATE mbox.loyalty_point_lots SET remaining_points=remaining_points+$4,status='available' WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND remaining_points+$4<=original_points RETURNING remaining_points`,[...this.scope,lot.lot_id,count])
        if(changed.rowCount!==1)throw new Error('Original points lot restoration exceeds its issued amount')
        await this.tx.query(`INSERT INTO mbox.loyalty_point_lot_movements(tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,source_type,source_id,idempotency_key) VALUES($1,$2,$3,'restore',$4,$5,'redemption',$6,$7)`,[...this.scope,lot.lot_id,count,changed.rows[0]!.remaining_points,quoteId,`checkout-restore:${quoteId}:${targetPoints}:${lot.lot_id}`])
        credited+=count
      }
    }
    if(left)throw new Error('Original points lots cannot cover restoration')
    await this.tx.query('INSERT INTO mbox.checkout_point_restorations(tenant_id,store_id,quote_id,source_key,points,credited_points) VALUES($1,$2,$3,$4,$5,$6)',[...this.scope,quoteId,sourceKey,delta,credited])
    await this.tx.query('UPDATE mbox.checkout_point_holds SET restored_points=$4 WHERE tenant_id=$1 AND store_id=$2 AND quote_id=$3',[...this.scope,quoteId,targetPoints])
    if(credited){
      await this.balance(row,row.available_points+credited)
      await this.tx.query(`INSERT INTO mbox.loyalty_point_ledger(tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,source_type,source_id,reason,idempotency_key) VALUES($1,$2,$3,$4,'restore',$5,$6,'redemption',$7,'结账取消或退款，按原积分批次和有效期返还',$8)`,[...this.scope,row.membership_id,row.customer_id,credited,row.available_points+credited,quoteId,`checkout-restore:${quoteId}:${targetPoints}`])
    }
    return delta
  }
  private async balance(account:Account,points:number){
    await this.tx.query('UPDATE mbox.loyalty_accounts SET available_points=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,account.id,points])
    await this.tx.query('UPDATE mbox.customer_memberships SET points_balance=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,account.membership_id,points])
  }
}
