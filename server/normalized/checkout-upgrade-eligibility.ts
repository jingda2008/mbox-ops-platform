// Eligibility is a hard gate, not a popularity score. All monetary inputs
// must come from the same authoritative checkout quote, including coupons.
export interface UpgradeQualificationRule{
  maximumAddMinor:number;maximumAddBasisPoints:number|null
  minimumContributionMinor:number;minimumIncrementalContributionMinor:number
  minimumMarginBasisPoints:number
  minimumPartySize:number;maximumPartySize:number
  requiredOccasions:string[];requiredAlcoholPreferences:string[]
  maximumQuantitiesPerPerson:Array<{productId:string;quantity:number}>
  excludedProductIds:string[]
  positiveFitReason:string
}
export interface UpgradeComposition{productId:string;specificationId:string;optionKey:string;quantity:number}
export interface UpgradeQualificationFacts{
  published:boolean;available:boolean;inventoryKnownAndSufficient:boolean;productionAvailable:boolean
  partySize:number|null;occasion:string|null;alcoholPreference:string|null
  originalPayableMinor:number|null;upgradedPayableMinor:number|null
  originalCostMinor:number|null;upgradedCostMinor:number|null
  // Full-checkout totals above capture all coupon effects. These explicit
  // portion figures prevent another profitable line subsidizing eligibility.
  sourcePortionPayableMinor:number|null;targetPortionPayableMinor:number|null
  sourcePortionCostMinor:number|null;targetPortionCostMinor:number|null
  originalComposition:UpgradeComposition[];upgradedComposition:UpgradeComposition[]
  // Whole table's other ordered/current-cart portions, excluding the source
  // portion being replaced. Keep paid/served facts according to time scope.
  otherTableComposition:UpgradeComposition[]|null
  restrictionsVerified:boolean;restrictionsSatisfied:boolean
  choicesComplete:boolean;quoteComparable:boolean
}
export class UpgradeQualificationError extends Error{}
const nonnegative=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0
const money=(value:unknown):value is number=>nonnegative(value)
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
function integer(value:unknown,label:string,min=0,max=Number.MAX_SAFE_INTEGER){if(!nonnegative(value)||value<min||value>max)throw new UpgradeQualificationError(`${label}须为${min}至${max}的整数`);return value}
function strings(value:unknown,label:string,max=100){if(!Array.isArray(value)||value.length>max||value.some(v=>typeof v!=='string'||!v.trim()||v.length>120)||new Set(value).size!==value.length)throw new UpgradeQualificationError(`${label}无效或重复`);return value as string[]}
export function parseUpgradeQualificationRule(value:unknown):UpgradeQualificationRule{
  if(!object(value))throw new UpgradeQualificationError('须明确高匹配资格规则')
  if(typeof value.positiveFitReason!=='string'||value.positiveFitReason.trim().length<2||value.positiveFitReason.length>500)throw new UpgradeQualificationError('须明确适配依据，不能只填优先级')
  if(!Array.isArray(value.maximumQuantitiesPerPerson)||value.maximumQuantitiesPerPerson.length>100)throw new UpgradeQualificationError('份量上限无效')
  const limits=value.maximumQuantitiesPerPerson.map(raw=>{if(!object(raw)||typeof raw.productId!=='string'||!raw.productId||raw.productId.length>120)throw new UpgradeQualificationError('份量商品无效');return{productId:raw.productId,quantity:integer(raw.quantity,'每人最多份数',1,100)}})
  if(new Set(limits.map(l=>l.productId)).size!==limits.length)throw new UpgradeQualificationError('份量上限商品重复')
  const rule={maximumAddMinor:integer(value.maximumAddMinor,'最多加价（分）'),maximumAddBasisPoints:value.maximumAddBasisPoints===null?null:integer(value.maximumAddBasisPoints,'相对加价万分比',0,1000000),minimumContributionMinor:integer(value.minimumContributionMinor,'最低贡献额（分）'),minimumIncrementalContributionMinor:integer(value.minimumIncrementalContributionMinor,'最低新增贡献额（分）'),minimumMarginBasisPoints:integer(value.minimumMarginBasisPoints,'最低毛利万分比',0,10000),minimumPartySize:integer(value.minimumPartySize,'最少人数',1,1000),maximumPartySize:integer(value.maximumPartySize,'最多人数',1,1000),requiredOccasions:strings(value.requiredOccasions,'适配场景'),requiredAlcoholPreferences:strings(value.requiredAlcoholPreferences,'酒精偏好'),maximumQuantitiesPerPerson:limits,excludedProductIds:strings(value.excludedProductIds,'排除商品'),positiveFitReason:value.positiveFitReason.trim()}
  if(rule.minimumPartySize>rule.maximumPartySize)throw new UpgradeQualificationError('人数范围倒置')
  return rule
}
function composition(items:UpgradeComposition[]){
  if(!Array.isArray(items)||items.length>1000)throw new UpgradeQualificationError('套餐组成范围无效')
  const exact=new Map<string,bigint>(),byProduct=new Map<string,bigint>()
  for(const item of items){
    if(!item||[item.productId,item.specificationId,item.optionKey].some(value=>typeof value!=='string'||value.length>500)||!item.productId||!nonnegative(item.quantity)||item.quantity<1)throw new UpgradeQualificationError('套餐具体商品、规格或份次无效')
    const key=JSON.stringify([item.productId,item.specificationId,item.optionKey]),quantity=BigInt(item.quantity)
    exact.set(key,(exact.get(key)??0n)+quantity);byProduct.set(item.productId,(byProduct.get(item.productId)??0n)+quantity)
  }
  return{exact,byProduct}
}
export function qualifyCheckoutUpgrade(ruleInput:unknown,facts:UpgradeQualificationFacts){
  const rule=parseUpgradeQualificationRule(ruleInput)
  const reject=(reason:string)=>({eligible:false as const,reason})
  if(!facts.published)return reject('rule_not_published')
  if(!facts.quoteComparable)return reject('quote_not_comparable')
  if(!facts.available||!facts.inventoryKnownAndSufficient||!facts.productionAvailable)return reject('cannot_fulfill')
  if(!facts.restrictionsVerified||!facts.restrictionsSatisfied)return reject('restriction_not_verified_or_failed')
  if(!facts.choicesComplete)return reject('choices_incomplete')
  if(!nonnegative(facts.partySize)||facts.partySize<rule.minimumPartySize||facts.partySize>rule.maximumPartySize)return reject('party_size_missing_or_mismatch')
  if(rule.requiredOccasions.length&&(!facts.occasion||!rule.requiredOccasions.includes(facts.occasion)))return reject('occasion_missing_or_mismatch')
  if(rule.requiredAlcoholPreferences.length&&(!facts.alcoholPreference||!rule.requiredAlcoholPreferences.includes(facts.alcoholPreference)))return reject('preference_missing_or_mismatch')
  if(!money(facts.originalPayableMinor)||!money(facts.upgradedPayableMinor)||!money(facts.originalCostMinor)||!money(facts.upgradedCostMinor)||!money(facts.sourcePortionPayableMinor)||!money(facts.targetPortionPayableMinor)||!money(facts.sourcePortionCostMinor)||!money(facts.targetPortionCostMinor))return reject('price_or_cost_unknown')
  if(facts.sourcePortionPayableMinor>facts.originalPayableMinor||facts.targetPortionPayableMinor>facts.upgradedPayableMinor||facts.sourcePortionCostMinor>facts.originalCostMinor||facts.targetPortionCostMinor>facts.upgradedCostMinor)return reject('inconsistent_portion_totals')
  const before=BigInt(facts.originalPayableMinor),after=BigInt(facts.upgradedPayableMinor),added=after-before
  if(added<=0n||added>BigInt(rule.maximumAddMinor))return reject('absolute_added_price_limit')
  // Both ceilings must hold. An original zero payable amount cannot define a
  // ratio; it is not treated as infinite budget or skipped silently.
  const sourcePayable=BigInt(facts.sourcePortionPayableMinor),targetPayable=BigInt(facts.targetPortionPayableMinor)
  if(rule.maximumAddBasisPoints!==null&&(sourcePayable===0n||added*10000n>sourcePayable*BigInt(rule.maximumAddBasisPoints)))return reject('relative_added_price_limit')
  const contribution=targetPayable-BigInt(facts.targetPortionCostMinor)
  const incremental=after-BigInt(facts.upgradedCostMinor)-(before-BigInt(facts.originalCostMinor))
  if(incremental>BigInt(Number.MAX_SAFE_INTEGER))return reject('amount_out_of_safe_range')
  if(contribution<BigInt(rule.minimumContributionMinor)||incremental<BigInt(rule.minimumIncrementalContributionMinor)||contribution*10000n<targetPayable*BigInt(rule.minimumMarginBasisPoints))return reject('contribution_or_margin_limit')
  const source=composition(facts.originalComposition),target=composition(facts.upgradedComposition)
  if(!source.exact.size)return reject('source_composition_missing')
  for(const [key,quantity] of source.exact)if((target.exact.get(key)??0n)<quantity)return reject('core_or_option_changed')
  if([...source.exact].every(([key,quantity])=>target.exact.get(key)===quantity)&&target.exact.size===source.exact.size)return reject('no_meaningful_addition')
  if(facts.otherTableComposition===null)return reject('table_portions_unknown')
  const other=composition(facts.otherTableComposition)
  for(const id of rule.excludedProductIds)if(target.byProduct.has(id)||other.byProduct.has(id))return reject('excluded_product_present')
  for(const [id,quantity] of target.byProduct){
    if(quantity<=(source.byProduct.get(id)??0n))continue
    const limit=rule.maximumQuantitiesPerPerson.find(limit=>limit.productId===id)
    // Every added product needs a positive, approved portion bound. A lower
    // ranking cannot admit unbounded/redundant additions.
    if(!limit)return reject('added_portion_rule_missing')
    if(quantity+(other.byProduct.get(id)??0n)>BigInt(limit.quantity)*BigInt(facts.partySize))return reject('redundant_or_excessive_portions')
  }
  return{eligible:true as const,addedPayableMinor:Number(added),contributionMinor:Number(contribution),incrementalContributionMinor:Number(incremental),reason:rule.positiveFitReason}
}
