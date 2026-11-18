import {channelCampaignSwitchSchema,channelPromoterSwitchSchema,channelPublishSwitchSchema} from '../shared/channel-distribution'
export type ChannelSwitchDirectory={
 campaigns:{id:string;acceptingClaims?:boolean;staffEntryEnabled?:boolean;selfEntryEnabled?:boolean}[]
 batches:{id:string;acceptingClaims?:boolean}[]
 partners:{promoterId:string;status?:string;canConfirmStatement?:boolean;restaurantScope?:boolean;contactEmployeeId?:string|null}[]
}
export function channelSwitchState(action:string,id:string,data:ChannelSwitchDirectory):Record<string,boolean|string|null>|null {
 if(action==='campaign'){
  const row=data.campaigns.find(c=>c.id===id),result=channelCampaignSwitchSchema.safeParse({enabled:row?.acceptingClaims,staff:row?.staffEntryEnabled,self:row?.selfEntryEnabled})
  return result.success?result.data:null
 }
 if(action==='publish'){
  const row=data.batches.find(b=>b.id===id),result=channelPublishSwitchSchema.safeParse({enabled:row?.acceptingClaims})
  return result.success?result.data:null
 }
 if(action==='promoter'){
  const row=data.partners.find(p=>p.promoterId===id),result=channelPromoterSwitchSchema.safeParse({enabled:row?.status==='active'?true:row?.status==='disabled'?false:undefined,confirm:row?.canConfirmStatement,restaurantScope:row?.restaurantScope,contactEmployeeId:row?.contactEmployeeId})
  return result.success?result.data:null
 }
 return null
}
