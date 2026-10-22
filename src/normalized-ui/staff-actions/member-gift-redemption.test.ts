import {describe,it,expect,vi} from 'vitest'
import {StaffActionsApi} from './staff-actions-api'
import {giftChoicesComplete} from './GiftBundleChoices'
import type {MenuBundleChoiceGroup} from '../../shared/contracts'
import type {MemberGiftCommand} from '../../shared/member-gift-redemption'
const group:MenuBundleChoiceGroup={id:'g',code:'g',name:'任选',selectionCount:1,options:[{productId:'a',code:'a',name:'A',quantity:1,available:true},{productId:'b',code:'b',name:'B',quantity:1,available:false}]}
describe('counted gift bundle entry',()=>{
  it('requires distinct valid choices on every physical reserved unit',()=>{
    expect(giftChoicesComplete([group],2,[{groups:[{groupId:'g',productIds:['a']}]}])).toBe(false)
    expect(giftChoicesComplete([group],1,[{groups:[{groupId:'g',productIds:['b']}]}])).toBe(false)
    expect(giftChoicesComplete([group],1,[{groups:[{groupId:'g',productIds:['a','a']}]}])).toBe(false)
    expect(giftChoicesComplete([group],2,[{groups:[{groupId:'g',productIds:['a']}]},{groups:[{groupId:'g',productIds:['a']}]}])).toBe(true)
    expect(giftChoicesComplete([],2,[])).toBe(true)
  })
  it('preserves original choice body and request key while rejecting receipts for another employee or customer',async()=>{
    const command:MemberGiftCommand={action:'redeem',body:{customerId:'customer',benefitId:'benefit',tableSessionId:'table',reservationId:'reservation',quantity:2,selectedProductId:'bundle',bundleSelections:[{groups:[{groupId:'g',productIds:['a']}]},{groups:[{groupId:'g',productIds:['b']}]}]}}
    const key='11111111-1111-4111-8111-111111111111'
    const receipt={employeeId:'employee',customerId:'customer',requestKey:`native-business-${key}`,action:'redeem',result:{id:'redemption'}}
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({data:{...receipt,employeeId:'other'}})))
      .mockResolvedValueOnce(new Response(JSON.stringify({data:{...receipt,customerId:'other'}})))
      .mockResolvedValueOnce(new Response(JSON.stringify({data:receipt})))
    const api=new StaffActionsApi({fetch:send,staffSessionId:'original-login'})
    await expect(api.runMemberGiftCommand('employee',command,key)).rejects.toMatchObject({code:'INVALID_RESPONSE'})
    await expect(api.runMemberGiftCommand('employee',command,key)).rejects.toMatchObject({code:'INVALID_RESPONSE'})
    await expect(api.runMemberGiftCommand('employee',command,key)).resolves.toEqual(receipt)
    for(const [url,init] of send.mock.calls){expect(String(url)).toBe('/api/staff/native-benefit-wallet/commands/redeem');expect(JSON.parse(String(init?.body))).toEqual(command.body);expect(new Headers(init?.headers).get('idempotency-key')).toBe(receipt.requestKey)}
  })
})
