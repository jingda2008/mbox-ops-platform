export interface ChannelActivationReceipt { claimId:string; activationId:string; visitId:string }

// Keep the same identity checks as miniprogram/utils/api.js. Validation must
// happen inside the durable send callback, before its journal can be completed.
export function parseChannelActivationReceipt(value:unknown,expectedClaimId?:string):ChannelActivationReceipt {
  const row=value as Partial<ChannelActivationReceipt>|null
  if(!row || typeof row!=='object' || Array.isArray(row)
    || ![row.claimId,row.activationId,row.visitId].every(id=>typeof id==='string'&&id.trim().length>0)
    || (expectedClaimId!==undefined&&row.claimId!==expectedClaimId)) {
    throw Object.assign(new Error('优惠操作回执不完整，结果待核对，请恢复原操作或联系门店'),{code:'CHANNEL_RECEIPT_INVALID'})
  }
  return {claimId:row.claimId!,activationId:row.activationId!,visitId:row.visitId!}
}
