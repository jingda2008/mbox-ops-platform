import type { ScopedTransaction } from './transaction-runner.js'
import type { ChannelRule } from '../../src/shared/channel-distribution.js'
import { ChannelDistributionError, ChannelBusinessError } from './channel-distribution-policy.js'

/** Marketing commitment is backed by the SAME balances ordinary orders use. */
export class ChannelGiftInventory {
 constructor(private readonly tx:ScopedTransaction){}
 private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
 async reserve(claimId:string,offer:Extract<ChannelRule['offer'],{kind:'gift'}>){
  const old=(await this.tx.query<{state:string;generation:number}>(`SELECT state,generation FROM mbox.channel_gift_promises WHERE tenant_id=$1 AND store_id=$2 AND claim_id=$3 FOR UPDATE`,[...this.scope,claimId])).rows[0]
  if(old&&old.state!=='released')throw new ChannelDistributionError('NOT_REVERSIBLE')
  const generation=(old?.generation??0)+1
  const product=(await this.tx.query<{sale_remaining_quantity:number|null;sale_quantity_generation:string;cost_amount_minor:string|null}>(`SELECT sale_remaining_quantity,sale_quantity_generation::text,cost_amount_minor::text FROM mbox.products
   WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active' AND product_kind='single' AND inventory_control_mode='tracked' FOR UPDATE`,[...this.scope,offer.productId])).rows[0]
  if(!product||product.cost_amount_minor===null||BigInt(product.cost_amount_minor)*BigInt(offer.quantity)>BigInt(offer.costMinor))throw new ChannelDistributionError('CAPACITY')
  const recipe=(await this.tx.query<{id:string}>(`SELECT id FROM mbox.recipes WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND status='active' AND effective_at<=clock_timestamp() FOR SHARE`,[...this.scope,offer.productId])).rows[0]
  if(!recipe)throw new ChannelDistributionError('CAPACITY')
  const demand=(await this.tx.query<{inventory_item_id:string;quantity:string}>(`SELECT i.inventory_item_id,(((i.quantity+i.expected_waste_quantity)*$4::integer)/r.yield_quantity)::numeric(18,6)::text AS quantity
   FROM mbox.recipe_items i JOIN mbox.recipes r ON (r.tenant_id,r.store_id,r.id)=(i.tenant_id,i.store_id,i.recipe_id)
   JOIN mbox.inventory_items n ON (n.tenant_id,n.store_id,n.id)=(i.tenant_id,i.store_id,i.inventory_item_id) AND n.status='active'
   WHERE i.tenant_id=$1 AND i.store_id=$2 AND i.recipe_id=$3 ORDER BY i.inventory_item_id FOR SHARE OF i,n`,[...this.scope,recipe.id,offer.quantity])).rows
  const recipeCount=(await this.tx.query<{n:number}>(`SELECT count(*)::integer AS n FROM mbox.recipe_items WHERE tenant_id=$1 AND store_id=$2 AND recipe_id=$3`,[...this.scope,recipe.id])).rows[0]!.n
  if(!demand.length||demand.length!==recipeCount||demand.some(d=>Number(d.quantity)<=0))throw new ChannelDistributionError('CAPACITY')
  if(product.sale_remaining_quantity!==null){
   const changed=await this.tx.query(`UPDATE mbox.products SET sale_remaining_quantity=sale_remaining_quantity-$4,sale_quantity_version=sale_quantity_version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND sale_remaining_quantity>=$4`,[...this.scope,offer.productId,offer.quantity])
   if(changed.rowCount!==1)throw new ChannelDistributionError('CAPACITY')
  }
  await this.tx.query(`INSERT INTO mbox.channel_gift_promises(tenant_id,store_id,claim_id,product_id,recipe_id,quantity,cost_minor,sale_generation,generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,store_id,claim_id) DO UPDATE SET product_id=EXCLUDED.product_id,recipe_id=EXCLUDED.recipe_id,quantity=EXCLUDED.quantity,cost_minor=EXCLUDED.cost_minor,sale_generation=EXCLUDED.sale_generation,generation=EXCLUDED.generation,state='reserved',completed_at=NULL`,[...this.scope,claimId,offer.productId,recipe.id,offer.quantity,offer.costMinor,product.sale_remaining_quantity===null?null:product.sale_quantity_generation,generation])
  for(const d of demand){
   const changed=await this.tx.query(`UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity+$4::numeric,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 AND on_hand_quantity-reserved_quantity>=$4::numeric`,[...this.scope,d.inventory_item_id,d.quantity])
   if(changed.rowCount!==1)throw new ChannelDistributionError('CAPACITY')
   await this.tx.query(`INSERT INTO mbox.channel_gift_stock(tenant_id,store_id,claim_id,inventory_item_id,quantity,generation) VALUES($1,$2,$3,$4,$5,$6)`,[...this.scope,claimId,d.inventory_item_id,d.quantity,generation])
  }
  await this.tx.query(`INSERT INTO mbox.channel_gift_versions(tenant_id,store_id,claim_id,generation,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)`,[...this.scope,claimId,generation,JSON.stringify({offer,recipeId:recipe.id,demand})])
 }
 async release(claimId:string,convert=false){
  const promise=(await this.tx.query<{product_id:string;recipe_id:string;quantity:number;sale_generation:string|null;state:string;generation:number}>(`SELECT product_id,recipe_id,quantity,sale_generation::text,state,generation FROM mbox.channel_gift_promises WHERE tenant_id=$1 AND store_id=$2 AND claim_id=$3 FOR UPDATE`,[...this.scope,claimId])).rows[0]
  if(!promise||promise.state!=='reserved')return false
  if(!convert){const claim=(await this.tx.query<{status:string}>(`SELECT status FROM mbox.channel_claims WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,claimId])).rows[0];if(!claim||!['expired','revoked'].includes(claim.status))throw new ChannelDistributionError('NOT_REVERSIBLE')}
  // Acquire product lock before balance locks, matching ordinary order submission.
  const product=(await this.tx.query<{sale_quantity_generation:string;recipe_id:string|null}>(`SELECT p.sale_quantity_generation::text,r.id AS recipe_id FROM mbox.products p LEFT JOIN mbox.recipes r
   ON (r.tenant_id,r.store_id,r.product_id)=(p.tenant_id,p.store_id,p.id) AND r.status='active' AND r.effective_at<=clock_timestamp()
   WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=$3 FOR UPDATE OF p`,[...this.scope,promise.product_id])).rows[0]!
  if(convert&&product.recipe_id!==promise.recipe_id)throw new ChannelBusinessError('原赠品配方已变化，请由主管核对替换方案，原库存承诺仍保留')
  const stock=(await this.tx.query<{inventory_item_id:string;quantity:string}>(`SELECT inventory_item_id,quantity::text FROM mbox.channel_gift_stock WHERE tenant_id=$1 AND store_id=$2 AND claim_id=$3 AND generation=$4 ORDER BY inventory_item_id`,[...this.scope,claimId,promise.generation])).rows
  if(convert){
   const current=(await this.tx.query<{inventory_item_id:string;quantity:string}>(`SELECT i.inventory_item_id,(((i.quantity+i.expected_waste_quantity)*$4::integer)/r.yield_quantity)::numeric(18,6)::text AS quantity FROM mbox.recipe_items i JOIN mbox.recipes r ON (r.tenant_id,r.store_id,r.id)=(i.tenant_id,i.store_id,i.recipe_id) JOIN mbox.inventory_items n ON (n.tenant_id,n.store_id,n.id)=(i.tenant_id,i.store_id,i.inventory_item_id) AND n.status='active' WHERE i.tenant_id=$1 AND i.store_id=$2 AND i.recipe_id=$3 ORDER BY i.inventory_item_id FOR SHARE OF i,r,n`,[...this.scope,promise.recipe_id,promise.quantity])).rows
   if(JSON.stringify(current)!==JSON.stringify(stock))throw new ChannelBusinessError('原赠品配方已变化，请由主管核对替换方案，原库存承诺仍保留')
  }
  for(const h of stock){const released=await this.tx.query(`UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity-$4::numeric,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 AND reserved_quantity>=$4::numeric`,[...this.scope,h.inventory_item_id,h.quantity]);if(released.rowCount!==1)throw new ChannelBusinessError('渠道库存承诺与库存余额不一致')}
  await this.tx.query(`UPDATE mbox.channel_gift_promises SET state=$4,completed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND claim_id=$3`,[...this.scope,claimId,convert?'converted':'released'])
  if(promise.sale_generation!==null){
   if(promise.sale_generation!==product.sale_quantity_generation)throw new ChannelBusinessError('渠道可售数量承诺版本不一致')
   await this.tx.query(`UPDATE mbox.products SET sale_remaining_quantity=sale_remaining_quantity+$4,sale_quantity_version=sale_quantity_version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,promise.product_id,promise.quantity])
  }
  return true
 }
}
