import type {ScopedTransaction} from './transaction-runner.js'

export interface CouponPricePromiseView {
  kind:'fixed_price'
  fixedPriceMinor:number
  currency:'CNY'
  campaignVersionId:string
  stackingVersionId:string
  products:Array<{id:string;name:string}>
}

/** Read immutable promises, including stopped campaigns. Stopping new issuance
 * must never erase terms on a customer's already issued coupon. */
export class CouponPricePromiseRepository {
  constructor(private readonly tx:ScopedTransaction){}
  async views(benefitIds:readonly string[]):Promise<Map<string,CouponPricePromiseView>>{
    if(benefitIds.length===0)return new Map()
    const rows=await this.tx.query<{benefit_id:string;fixed_price_minor:string;campaign_version_id:string;stacking_version_id:string;products:Array<{id:string;name:string}>}>(`
      SELECT p.benefit_id,p.fixed_price_minor,p.campaign_version_id,p.stacking_version_id,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',product.id,'name',product.name) ORDER BY product.id)
          FROM mbox.member_gift_campaign_products pool JOIN mbox.products product
            ON product.tenant_id=pool.tenant_id AND product.store_id=pool.store_id AND product.id=pool.product_id
          WHERE pool.tenant_id=p.tenant_id AND pool.store_id=p.store_id AND pool.campaign_version_id=p.campaign_version_id),'[]'::jsonb) AS products
      FROM mbox.benefit_coupon_price_promises p
      WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.benefit_id=ANY($3::uuid[])
    `,[this.tx.scope.tenantId,this.tx.scope.storeId,[...new Set(benefitIds)]])
    return new Map(rows.rows.map(row=>[row.benefit_id,{kind:'fixed_price' as const,fixedPriceMinor:Number(row.fixed_price_minor),currency:'CNY' as const,campaignVersionId:row.campaign_version_id,stackingVersionId:row.stacking_version_id,products:row.products}]))
  }
}
