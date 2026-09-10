import type {ScopedTransaction} from './transaction-runner.js'
import {parseUpgradeQualificationRule,UpgradeQualificationError,type UpgradeQualificationRule} from './checkout-upgrade-eligibility.js'

export type UpgradeQualificationBounds=Pick<UpgradeQualificationRule,'maximumAddMinor'|'maximumAddBasisPoints'|'minimumContributionMinor'|'minimumIncrementalContributionMinor'|'maximumQuantitiesPerPerson'|'excludedProductIds'|'positiveFitReason'>
const keys=['maximumAddMinor','maximumAddBasisPoints','minimumContributionMinor','minimumIncrementalContributionMinor','maximumQuantitiesPerPerson','excludedProductIds','positiveFitReason'] as const
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
export function qualificationBounds(rule:UpgradeQualificationRule):UpgradeQualificationBounds{
 return Object.fromEntries(keys.map(key=>[key,rule[key]])) as unknown as UpgradeQualificationBounds
}
interface Row extends Record<string,unknown>{rule_id:string;maximum_add_minor:string;maximum_add_basis_points:number|null;minimum_contribution_minor:string;minimum_incremental_contribution_minor:string;positive_fit_reason:string;minimum_party_size:number;maximum_party_size:number;occasion_tags:string[];alcohol_preference_tags:string[];minimum_gross_margin_basis_points:number}
export class CheckoutUpgradeQualificationRepository{
 constructor(private readonly tx:ScopedTransaction){}
 private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
 async save(ruleId:string,raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!keys.includes(key as typeof keys[number])))throw new UpgradeQualificationError('须使用明确的升级准入字段，不能提交自由配置')
  const source=(await this.tx.query<{minimum_party_size:number;maximum_party_size:number;occasion_tags:string[];alcohol_preference_tags:string[];minimum_gross_margin_basis_points:number}>(`SELECT minimum_party_size,maximum_party_size,occasion_tags,alcohol_preference_tags,minimum_gross_margin_basis_points FROM mbox.checkout_upgrade_rules WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='draft' FOR UPDATE`,[...this.scope,ruleId])).rows[0]
  if(!source)throw new UpgradeQualificationError('只有当前草稿可保存升级准入条件')
  const rule=parseUpgradeQualificationRule({...raw,minimumPartySize:source.minimum_party_size,maximumPartySize:source.maximum_party_size,requiredOccasions:source.occasion_tags,requiredAlcoholPreferences:source.alcohol_preference_tags,minimumMarginBasisPoints:source.minimum_gross_margin_basis_points})
  if(!rule.maximumQuantitiesPerPerson.length||[...rule.maximumQuantitiesPerPerson.map(item=>item.productId),...rule.excludedProductIds].some(id=>!uuid.test(id)))throw new UpgradeQualificationError('至少明确一种新增商品的人均份量上限，并使用本店商品编号')
  const productIds=[...new Set([...rule.maximumQuantitiesPerPerson.map(item=>item.productId),...rule.excludedProductIds])]
  const products=await this.tx.query('SELECT id FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])',[...this.scope,productIds])
  if(products.rowCount!==productIds.length)throw new UpgradeQualificationError('准入规则包含其他门店或不存在的商品')
  await this.tx.query(`INSERT INTO mbox.checkout_upgrade_qualifications(tenant_id,store_id,rule_id,maximum_add_minor,maximum_add_basis_points,minimum_contribution_minor,minimum_incremental_contribution_minor,positive_fit_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[...this.scope,ruleId,rule.maximumAddMinor,rule.maximumAddBasisPoints,rule.minimumContributionMinor,rule.minimumIncrementalContributionMinor,rule.positiveFitReason])
  for(const item of rule.maximumQuantitiesPerPerson)await this.tx.query('INSERT INTO mbox.checkout_upgrade_portion_limits(tenant_id,store_id,rule_id,product_id,maximum_per_person) VALUES($1,$2,$3,$4,$5)',[...this.scope,ruleId,item.productId,item.quantity])
  for(const productId of rule.excludedProductIds)await this.tx.query('INSERT INTO mbox.checkout_upgrade_excluded_products(tenant_id,store_id,rule_id,product_id) VALUES($1,$2,$3,$4)',[...this.scope,ruleId,productId])
  return rule
 }
 async many(ruleIds:readonly string[]){
  const result=new Map<string,UpgradeQualificationRule>();if(!ruleIds.length)return result
  const rows=(await this.tx.query<Row>(`SELECT q.*,r.minimum_party_size,r.maximum_party_size,r.occasion_tags,r.alcohol_preference_tags,r.minimum_gross_margin_basis_points FROM mbox.checkout_upgrade_qualifications q JOIN mbox.checkout_upgrade_rules r ON r.tenant_id=q.tenant_id AND r.store_id=q.store_id AND r.id=q.rule_id WHERE q.tenant_id=$1 AND q.store_id=$2 AND q.rule_id=ANY($3::uuid[])`,[...this.scope,ruleIds])).rows
  if(!rows.length)return result
  const ids=rows.map(row=>row.rule_id)
  const limits=(await this.tx.query<{rule_id:string;product_id:string;maximum_per_person:number}>('SELECT rule_id,product_id,maximum_per_person FROM mbox.checkout_upgrade_portion_limits WHERE tenant_id=$1 AND store_id=$2 AND rule_id=ANY($3::uuid[]) ORDER BY rule_id,product_id',[...this.scope,ids])).rows
  const excluded=(await this.tx.query<{rule_id:string;product_id:string}>('SELECT rule_id,product_id FROM mbox.checkout_upgrade_excluded_products WHERE tenant_id=$1 AND store_id=$2 AND rule_id=ANY($3::uuid[]) ORDER BY rule_id,product_id',[...this.scope,ids])).rows
  for(const row of rows)result.set(row.rule_id,parseUpgradeQualificationRule({maximumAddMinor:Number(row.maximum_add_minor),maximumAddBasisPoints:row.maximum_add_basis_points,minimumContributionMinor:Number(row.minimum_contribution_minor),minimumIncrementalContributionMinor:Number(row.minimum_incremental_contribution_minor),positiveFitReason:row.positive_fit_reason,minimumPartySize:row.minimum_party_size,maximumPartySize:row.maximum_party_size,requiredOccasions:row.occasion_tags,requiredAlcoholPreferences:row.alcohol_preference_tags,minimumMarginBasisPoints:row.minimum_gross_margin_basis_points,maximumQuantitiesPerPerson:limits.filter(item=>item.rule_id===row.rule_id).map(item=>({productId:item.product_id,quantity:item.maximum_per_person})),excludedProductIds:excluded.filter(item=>item.rule_id===row.rule_id).map(item=>item.product_id)}))
  return result
 }
 async find(ruleId:string){return(await this.many([ruleId])).get(ruleId)??null}
}
