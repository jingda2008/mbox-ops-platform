import type {ScopedTransaction} from './transaction-runner.js'
import {MemberGiftCampaignError} from './member-gift-campaign-policy.js'

/** Conservative cost commitment, not a sale or a stock reservation. Select the
 * costliest permitted distinct options in each independent group. This avoids
 * enumerating a Cartesian product and never prices a coupon by its cheapest
 * choice. Daily selling hours and live stock are checked at redemption, not
 * used to prevent issuing a coupon for a future visit. */
export class GiftProductBudgetRepository {
  constructor(private readonly tx:ScopedTransaction){}
  async maximumCost(productId:string,catalogCost:number,kind:'single'|'bundle'):Promise<number>{
    if(!Number.isSafeInteger(catalogCost)||catalogCost<0)throw new MemberGiftCampaignError('商品成本未知，不能发券')
    if(kind==='single')return catalogCost
    const scope=[this.tx.scope.tenantId,this.tx.scope.storeId]
    const rows=(await this.tx.query<{group_id:string;selection_count:number;product_id:string|null;quantity:number|null;cost:string|null}>(`
      SELECT g.id AS group_id,g.selection_count,o.component_product_id AS product_id,o.quantity,p.cost_amount_minor::text AS cost
      FROM mbox.product_bundle_choice_groups g
      LEFT JOIN mbox.product_bundle_choice_options o ON o.tenant_id=g.tenant_id AND o.store_id=g.store_id AND o.choice_group_id=g.id
      LEFT JOIN mbox.products p ON p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.id=o.component_product_id
      WHERE g.tenant_id=$1 AND g.store_id=$2 AND g.bundle_product_id=$3 ORDER BY g.id,o.component_product_id`,[...scope,productId])).rows
    const groups=new Map<string,{groupId:string;selectionCount:number;options:{productId:string;cost:number}[]}>()
    for(const row of rows){
      const group=groups.get(row.group_id)??{groupId:row.group_id,selectionCount:row.selection_count,options:[]}
      if(!row.product_id)throw new MemberGiftCampaignError('套餐可选组为空，无法核定发券预算')
      group.options.push({productId:row.product_id,cost:weightedCost(row.cost,row.quantity)})
      groups.set(row.group_id,group)
    }
    if(groups.size>10)throw new MemberGiftCampaignError('套餐可选组超出核价范围')
    let componentCost=0
    for(const group of groups.values()){
      if(!Number.isSafeInteger(group.selectionCount)||group.selectionCount<1||group.selectionCount>group.options.length||group.options.length>100)throw new MemberGiftCampaignError('套餐可选数量不完整，无法核定预算')
      const selected=group.options.sort((a,b)=>b.cost-a.cost||a.productId.localeCompare(b.productId)).slice(0,group.selectionCount)
      for(const option of selected)componentCost=add(componentCost,option.cost)
    }
    const fixed=(await this.tx.query<{cost:string|null;quantity:number}>(`SELECT p.cost_amount_minor::text AS cost,c.quantity FROM mbox.product_bundle_components c JOIN mbox.products p ON p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.id=c.component_product_id WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.bundle_product_id=$3`,[...scope,productId])).rows
    for(const component of fixed)componentCost=add(componentCost,weightedCost(component.cost,component.quantity))
    if(!groups.size&&!fixed.length)throw new MemberGiftCampaignError('套餐没有具体商品，不能承诺发券')
    return Math.max(catalogCost,componentCost)
  }
}
function weightedCost(value:string|null,quantity:number|null){
  if(value===null||quantity===null||!/^\d+$/.test(value)||!Number.isSafeInteger(quantity)||quantity<1)throw new MemberGiftCampaignError('套餐组成成本或数量未知，不能发券')
  const result=Number(value)*quantity
  if(!Number.isSafeInteger(result)||result<0)throw new MemberGiftCampaignError('套餐组成成本超出安全金额范围')
  return result
}
function add(a:number,b:number){const sum=a+b;if(!Number.isSafeInteger(sum))throw new MemberGiftCampaignError('套餐总成本超出安全金额范围');return sum}
