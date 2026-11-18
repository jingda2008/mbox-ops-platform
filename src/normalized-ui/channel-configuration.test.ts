import {describe,it,expect} from 'vitest'
import {channelBatchDraft,type ChannelBatchTemplate} from './channel-batch-template'
import {channelSwitchState} from './channel-operation-state'
const id='11111111-1111-4111-8111-111111111111'
const source:ChannelBatchTemplate={id,campaignId:id,rule:{title:'上一批',totalClaims:10,perCustomerClaims:1,perVisitUses:2,allowStacking:true,visitDiscountCapMinor:2500,claimFrom:'2026-11-12T10:00:00Z',claimUntil:'2026-11-12T15:00:00Z',useFrom:'2026-11-12T10:00:00Z',useUntil:'2026-11-12T18:00:00Z',minimumMinor:20000,eligibleProductIds:[id],commissionProductIds:[id],offer:{kind:'discount',discountBps:1500,maximumMinor:2000},commissionBps:1000,observationDays:7},contract:{version:'v1',settlementSubject:'川菜公司',terms:'净消费计佣'}}
describe('channel configuration drafts',()=>{
 it('copies rule and contract in yuan, clears all windows, and never copies publishing identity',()=>{
  const draft=channelBatchDraft(source)
  expect(draft.fields).toMatchObject({N:'10',K:'1',L:'2',value:'15',maximum:'20',minimum:'200',commission:'10',visitDiscountCap:'25',contractVersion:'v1',terms:'净消费计佣',claimFrom:'',claimUntil:'',useFrom:'',useUntil:''})
  expect(draft).toMatchObject({kind:'discount',allowStacking:true,productIds:[id],commissionProducts:[id]})
  expect(JSON.stringify(draft)).not.toMatch(/offerCode|publicToken|approved|acceptingClaims|settlementSubject|2026-11-12/)
  draft.productIds.push('changed');expect(source.rule.eligibleProductIds).toEqual([id])
 })
 it.each(['credit','gift'] as const)('copies only the selected %s offer configuration',kind=>{
  const draft=channelBatchDraft({...source,rule:{...source.rule,offer:kind==='credit'?{kind,amountMinor:1234}:{kind,productId:id,quantity:2,costMinor:9999}}})
  expect(draft.fields).toMatchObject(kind==='credit'?{value:'12.34',maximum:'',giftProductId:''}:{value:'',maximum:'',giftProductId:id,quantity:'2'})
  expect(draft.fields).not.toHaveProperty('costMinor')
 })
 it('returns exact switch states including false and null, and refuses incomplete readback',()=>{
  const data={campaigns:[{id,acceptingClaims:true,staffEntryEnabled:false,selfEntryEnabled:true}],batches:[{id,acceptingClaims:false}],partners:[{promoterId:id,status:'disabled',canConfirmStatement:false,restaurantScope:true,contactEmployeeId:null}]}
  expect(channelSwitchState('campaign',id,data)).toEqual({enabled:true,staff:false,self:true})
  expect(channelSwitchState('publish',id,data)).toEqual({enabled:false})
  expect(channelSwitchState('promoter',id,data)).toEqual({enabled:false,confirm:false,restaurantScope:true,contactEmployeeId:null})
  expect(channelSwitchState('campaign','missing',data)).toBeNull()
  expect(channelSwitchState('campaign',id,{...data,campaigns:[{id,acceptingClaims:true}]})).toBeNull()
  expect(channelSwitchState('promoter',id,{...data,partners:[{promoterId:id,status:'active'}]})).toBeNull()
 })
})
