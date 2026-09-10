import {describe,it,expect} from 'vitest'
import {parseMarketingNotice,assessMarketingContact,type MarketingExecutionFacts} from './marketing-contact-policy.js'
const input={operatorName:'测试运营主体',operatorContact:'测试客服电话',summary:'门店活动和由门店负责联系的联合活动，不向合作方提供名单。',withdrawalInstructions:'在联系偏好随时停止全部，或通过已公布客服提出拒绝。',purposes:['own_activities','mbox_joint_activities'],channels:['wechat','sms','phone'],dataCategories:['本人联系地址','选择的兴趣卡'],validFrom:'2026-09-01T00:00:00+08:00',validUntil:'2026-10-01T00:00:00+08:00',consentDays:30,contactStartMinute:600,contactEndMinute:1200,weekdays:[1,2,3,4,5,6,7],maximumPerDay:1,maximumPerMonth:4,sharingMode:'no_partner_list'}
const facts=():MarketingExecutionFacts=>({channel:'wechat',purpose:'own_activities',now:new Date('2026-09-09T12:00:00+08:00'),noticeId:'notice',noticePublished:true,consent:{decision:'granted',noticeId:'notice',consentId:'consent',validUntil:'2026-10-01T00:00:00+08:00',afterLatestStop:true},queuedConsentId:'consent',channelReady:true,platformPermissionVerified:true,verifiedRecipient:true,sentOrSubmittedToday:0,sentOrSubmittedMonth:0,unknownAttempt:false})
describe('independent marketing contact authority',()=>{
  it('requires separate proof instead of treating legacy service consent as marketing',()=>{
    expect(assessMarketingContact(parseMarketingNotice(input),{...facts(),consent:null})).toEqual({allowed:false,reason:'not_consented'})
  })
  it.each(['wechat','sms','phone'] as const)('permits %s only when all current independent facts allow it',channel=>{
    expect(assessMarketingContact(parseMarketingNotice(input),{...facts(),channel})).toEqual({allowed:true,consentId:'consent'})
  })
  it.each([
    [{noticePublished:false},'notice_unavailable'],[{channelReady:false},'channel_not_configured'],[{verifiedRecipient:false},'recipient_not_verified'],[{platformPermissionVerified:false},'channel_authority_missing'],[{unknownAttempt:true},'previous_delivery_unknown'],[{queuedConsentId:'older-consent'},'consent_changed_since_queue'],[{sentOrSubmittedToday:1},'frequency_limit'],[{sentOrSubmittedMonth:4},'frequency_limit'],[{now:new Date('2026-09-09T20:00:00+08:00')},'outside_contact_window'],
  ] as const)('fails closed on missing or changed send authority %j', (change,reason)=>{
    expect(assessMarketingContact(parseMarketingNotice(input),{...facts(),...change})).toEqual({allowed:false,reason})
  })
  it.each(['withdrawn','denied'] as const)('does not turn %s into granted after an account or card event',decision=>{
    const f=facts();f.consent!.decision=decision
    expect(assessMarketingContact(parseMarketingNotice(input),f)).toEqual({allowed:false,reason:'not_consented'})
  })
  it('rejects an earlier grant after stop-all, expired consent, and a new notice scope',()=>{
    for(const change of [{afterLatestStop:false},{validUntil:'2026-09-09T12:00:00+08:00'},{noticeId:'old-notice'}]){
      const f=facts();Object.assign(f.consent!,change);expect(assessMarketingContact(parseMarketingNotice(input),f).allowed).toBe(false)
    }
  })
  it('does not infer joint-activity or another-channel scope',()=>{
    const notice=parseMarketingNotice({...input,purposes:['own_activities'],channels:['sms']})
    expect(assessMarketingContact(notice,facts())).toEqual({allowed:false,reason:'scope_not_covered'})
    expect(assessMarketingContact(notice,{...facts(),channel:'sms',purpose:'mbox_joint_activities'})).toEqual({allowed:false,reason:'scope_not_covered'})
  })
  it.each([{operatorName:''},{operatorContact:''},{withdrawalInstructions:''},{sharingMode:'all_partners'},{channels:[]},{maximumPerDay:5,maximumPerMonth:4},{contactStartMinute:1200,contactEndMinute:600},{consentDays:0}])('rejects undisclosed or contradictory notice %j',change=>{
    expect(()=>parseMarketingNotice({...input,...change})).toThrow()
  })
  it('does not mutate the notice form and uses Beijing contact boundaries',()=>{
    const before=JSON.stringify(input),notice=parseMarketingNotice(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(assessMarketingContact(notice,{...facts(),now:new Date('2026-09-09T02:00:00Z')}).allowed).toBe(true)
    expect(assessMarketingContact(notice,{...facts(),now:new Date('2026-09-09T01:59:59Z')}).allowed).toBe(false)
  })
})
