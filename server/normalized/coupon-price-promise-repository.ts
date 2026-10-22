import type {ScopedTransaction} from './transaction-runner.js'
import type {MenuBundleChoiceGroup} from '../../src/shared/contracts.js'
import {legacyProductDeadlineSql} from './issued-coupon-product-promise.js'

export interface CouponPricePromiseView {
  kind:'fixed_price'
  fixedPriceMinor:number
  currency:'CNY'
  campaignVersionId:string
  stackingVersionId:string
  products:Array<{id:string;name:string;productKind:string;bundleChoiceGroups:MenuBundleChoiceGroup[]}>
}

/** Read immutable promises, including stopped campaigns. Stopping new issuance
 * must never erase terms on a customer's already issued coupon. */
export class CouponPricePromiseRepository {
  constructor(private readonly tx:ScopedTransaction){}
  async views(benefitIds:readonly string[]):Promise<Map<string,CouponPricePromiseView>>{
    if(benefitIds.length===0)return new Map()
    const rows=await this.tx.query<{benefit_id:string;fixed_price_minor:string;campaign_version_id:string;stacking_version_id:string;products:Array<{id:string;name:string;productKind:string;bundleChoiceGroups:MenuBundleChoiceGroup[]}>}>(`
      SELECT p.benefit_id,p.fixed_price_minor,p.campaign_version_id,p.stacking_version_id,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',product.id,'name',product.name,'productKind',product.product_kind,
            'bundleChoiceGroups',COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'id',g.id,'code',g.code,'name',g.display_name,'selectionCount',g.selection_count,
              'options',(SELECT jsonb_agg(jsonb_build_object('productId',option.id,'name',option.name,'quantity',choice.quantity,
                'available',option.status='active' AND 'guest_qr'=ANY(option.allowed_channels) AND (${legacyProductDeadlineSql('option')}) IS NOT NULL)
                ORDER BY choice.sort_order,choice.id)
                FROM mbox.product_bundle_choice_options choice JOIN mbox.products option
                  ON option.tenant_id=choice.tenant_id AND option.store_id=choice.store_id AND option.id=choice.component_product_id
                JOIN mbox.stores store ON store.tenant_id=option.tenant_id AND store.id=option.store_id
                WHERE choice.tenant_id=g.tenant_id AND choice.store_id=g.store_id AND choice.choice_group_id=g.id)) ORDER BY g.sort_order,g.id)
              FROM mbox.product_bundle_choice_groups g WHERE g.tenant_id=product.tenant_id AND g.store_id=product.store_id AND g.bundle_product_id=product.id),'[]'::jsonb)) ORDER BY product.id)
          FROM mbox.member_gift_campaign_products pool JOIN mbox.products product
            ON product.tenant_id=pool.tenant_id AND product.store_id=pool.store_id AND product.id=pool.product_id
          WHERE pool.tenant_id=p.tenant_id AND pool.store_id=p.store_id AND pool.campaign_version_id=p.campaign_version_id),'[]'::jsonb) AS products
      FROM mbox.benefit_coupon_price_promises p
      WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.benefit_id=ANY($3::uuid[])
    `,[this.tx.scope.tenantId,this.tx.scope.storeId,[...new Set(benefitIds)]])
    return new Map(rows.rows.map(row=>[row.benefit_id,{kind:'fixed_price' as const,fixedPriceMinor:Number(row.fixed_price_minor),currency:'CNY' as const,campaignVersionId:row.campaign_version_id,stackingVersionId:row.stacking_version_id,products:row.products}]))
  }
}
