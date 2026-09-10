import { matchesCardAudience, type CardAudienceRule } from './member-card-policy.js'

export class MemberGiftCampaignError extends Error {
  constructor(message:string){super(message);this.name='MemberGiftCampaignError'}
}
export interface MemberGiftCampaignRule {
  pricingKind:'free'|'fixed_price'
  fixedPriceMinor:number|null
  stackingVersionId:string|null
  trigger:'card_entry'|'targeted'
  cardProjectId:string|null
  audience:CardAudienceRule
  quantityPerCustomer:number
  maximumQuantity:number
  maximumDailyQuantity:number
  maximumCostMinor:number
  maximumDailyCostMinor:number
  maximumUnitCostMinor:number
  budgetDateBasis:'natural'|'business'
  budgetDayStartMinute:number
  currency:'CNY'
  availableFrom:string
  availableUntil:string
  couponCalendarVersionId:string
  productIds:string[]
}
function integer(value:unknown,label:string,max:number,min=0):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new MemberGiftCampaignError(`${label}必须是${min}至${max}的整数`)
  return value
}
function uuid(value:unknown,label:string):string{
  if(typeof value!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))throw new MemberGiftCampaignError(`${label}编号无效`)
  return value
}
function instant(value:unknown):string{
  if(typeof value!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)||!Number.isFinite(Date.parse(value)))throw new MemberGiftCampaignError('发放时间必须含明确时区')
  return new Date(value).toISOString()
}
export function parseMemberGiftCampaign(value:unknown):MemberGiftCampaignRule{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new MemberGiftCampaignError('发券活动规则无效')
  const input=value as Record<string,unknown>
  const pricingKind=input.pricingKind??'free'
  if(pricingKind!=='free'&&pricingKind!=='fixed_price')throw new MemberGiftCampaignError('券价格方式无效')
  const fixedPriceMinor=pricingKind==='fixed_price'?integer(input.fixedPriceMinor,'单份固定兑换价（分）',Number.MAX_SAFE_INTEGER,1):null
  const stackingVersionId=pricingKind==='fixed_price'?uuid(input.stackingVersionId,'叠加规则版本'):null
  if(pricingKind==='free'&&(input.fixedPriceMinor!=null||input.stackingVersionId!=null))throw new MemberGiftCampaignError('免费赠品不能同时填写固定兑换价或低价叠加规则')
  if(input.trigger!=='card_entry'&&input.trigger!=='targeted')throw new MemberGiftCampaignError('请选择入卡礼或定向发放')
  const cardProjectId=input.cardProjectId===null?null:uuid(input.cardProjectId,'卡项目')
  if((input.trigger==='card_entry')!==(cardProjectId!==null))throw new MemberGiftCampaignError('入卡礼须绑定卡项目，定向活动不能冒用入卡触发')
  if(!input.audience||typeof input.audience!=='object')throw new MemberGiftCampaignError('须明确目标人群')
  const audience=input.audience as CardAudienceRule
  // Validation only. Actual eligibility must use the current authoritative
  // member identity, grade period and active card facts inside the grant tx.
  matchesCardAudience(audience,{tier:'member',activeCardCodes:[]})
  if(input.currency!=='CNY')throw new MemberGiftCampaignError('当前活动预算仅支持人民币分，不进行隐含汇率换算')
  if(input.budgetDateBasis!=='natural'&&input.budgetDateBasis!=='business')throw new MemberGiftCampaignError('每日发放预算须明确按自然日或营业日计算')
  const budgetDayStartMinute=integer(input.budgetDayStartMinute,'预算换日分钟',1439)
  if(input.budgetDateBasis==='natural'&&budgetDayStartMinute!==0)throw new MemberGiftCampaignError('自然日预算必须零点换日')
  if(!Array.isArray(input.productIds)||input.productIds.length<1||input.productIds.length>100)throw new MemberGiftCampaignError('请选择1至100个已核实商品')
  const productIds=input.productIds.map(id=>uuid(id,'商品')).sort()
  if(new Set(productIds).size!==productIds.length)throw new MemberGiftCampaignError('商品池不能重复')
  const availableFrom=instant(input.availableFrom),availableUntil=instant(input.availableUntil)
  if(availableUntil<=availableFrom)throw new MemberGiftCampaignError('发放结束必须晚于开始')
  const result:MemberGiftCampaignRule={trigger:input.trigger,cardProjectId,audience:{...audience,cardCodes:[...audience.cardCodes].sort()},
    pricingKind,fixedPriceMinor,stackingVersionId,
    quantityPerCustomer:integer(input.quantityPerCustomer,'每人份数',100,1),maximumQuantity:integer(input.maximumQuantity,'活动总份数',1_000_000,1),
    maximumDailyQuantity:integer(input.maximumDailyQuantity,'每日总份数',1_000_000,1),maximumCostMinor:integer(input.maximumCostMinor,'活动成本预算',Number.MAX_SAFE_INTEGER),
    maximumDailyCostMinor:integer(input.maximumDailyCostMinor,'每日成本预算',Number.MAX_SAFE_INTEGER),maximumUnitCostMinor:integer(input.maximumUnitCostMinor,'单份最高成本',Number.MAX_SAFE_INTEGER),
    currency:'CNY',budgetDateBasis:input.budgetDateBasis,budgetDayStartMinute,availableFrom,availableUntil,couponCalendarVersionId:uuid(input.couponCalendarVersionId,'券时间规则'),productIds}
  if(result.quantityPerCustomer>result.maximumDailyQuantity||result.maximumDailyQuantity>result.maximumQuantity||result.maximumDailyCostMinor>result.maximumCostMinor)throw new MemberGiftCampaignError('每人、每日和活动总上限互相矛盾')
  return result
}
export interface GiftBudgetUsage{quantity:number;dailyQuantity:number;costMinor:number;dailyCostMinor:number}
export function giftBudgetDate(rule:Pick<MemberGiftCampaignRule,'budgetDayStartMinute'>,at:Date){
  if(!Number.isFinite(at.getTime()))throw new MemberGiftCampaignError('预算计数时间无效')
  return new Date(at.getTime()+8*3600000-integer(rule.budgetDayStartMinute,'预算换日分钟',1439)*60000).toISOString().slice(0,10)
}
/** No side effects. The repository must serialize this check and recording the
 * promise; passing a preview is never issuance authority. Cost is an estimated
 * ingredient obligation, not retail value, revenue, or realized redemption. */
export function assessGiftBudget(rule:MemberGiftCampaignRule,usage:GiftBudgetUsage,unitCostMinor:number|null){
  if(unitCostMinor===null)return{allowed:false as const,reason:'cost_unknown' as const}
  integer(unitCostMinor,'商品成本',Number.MAX_SAFE_INTEGER)
  for(const [key,value] of Object.entries(usage))integer(value,key,Number.MAX_SAFE_INTEGER)
  if(unitCostMinor>rule.maximumUnitCostMinor)return{allowed:false as const,reason:'unit_cost_exceeded' as const}
  const cost=BigInt(unitCostMinor)*BigInt(rule.quantityPerCustomer)
  if(BigInt(usage.quantity)+BigInt(rule.quantityPerCustomer)>BigInt(rule.maximumQuantity))return{allowed:false as const,reason:'campaign_quantity_exceeded' as const}
  if(BigInt(usage.dailyQuantity)+BigInt(rule.quantityPerCustomer)>BigInt(rule.maximumDailyQuantity))return{allowed:false as const,reason:'daily_quantity_exceeded' as const}
  if(BigInt(usage.costMinor)+cost>BigInt(rule.maximumCostMinor))return{allowed:false as const,reason:'campaign_cost_exceeded' as const}
  if(BigInt(usage.dailyCostMinor)+cost>BigInt(rule.maximumDailyCostMinor))return{allowed:false as const,reason:'daily_cost_exceeded' as const}
  return{allowed:true as const,estimatedCostMinor:Number(cost),quantity:rule.quantityPerCustomer}
}
