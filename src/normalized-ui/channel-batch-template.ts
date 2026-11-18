import { channelManagementSchemas, channelRuleSchema, type ChannelRule } from '../shared/channel-distribution'

export type ChannelBatchTemplate = {
  id:string; campaignId:string; rule:ChannelRule
  contract:{version:string;settlementSubject:string;terms:string}
}
// Copy only configuration. Dates, identities, receipts and approval never become draft fields.
export function channelBatchDraft(template:ChannelBatchTemplate) {
  const r=channelRuleSchema.parse(template.rule),offer=r.offer
  const contract=channelManagementSchemas.batch.shape.contract.parse(template.contract),campaignId=channelManagementSchemas.batch.shape.campaignId.parse(template.campaignId)
  return {
    fields:{title:r.title,N:String(r.totalClaims),K:String(r.perCustomerClaims),L:String(r.perVisitUses),
      claimFrom:'',claimUntil:'',useFrom:'',useUntil:'',minimum:String(r.minimumMinor/100),
      value:offer.kind==='credit'?String(offer.amountMinor/100):offer.kind==='discount'?String(offer.discountBps/100):'',
      maximum:offer.kind==='discount'?String(offer.maximumMinor/100):'',giftProductId:offer.kind==='gift'?offer.productId:'',
      quantity:offer.kind==='gift'?String(offer.quantity):'1',commission:String(r.commissionBps/100),observationDays:String(r.observationDays),
      contractVersion:contract.version,terms:contract.terms,reason:'复制上一批配置，重新确认本次活动',
      visitDiscountCap:r.visitDiscountCapMinor===null?'':String(r.visitDiscountCapMinor/100)},
    kind:offer.kind,allowStacking:r.allowStacking,productIds:[...r.eligibleProductIds],commissionProducts:[...(r.commissionProductIds??[])],campaignId,
  }
}
