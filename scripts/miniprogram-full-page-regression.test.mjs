import assert from 'node:assert/strict'
import test from 'node:test'
import { pageFixture, deferred, tick } from './miniprogram-full-page-fixture.mjs'
const hide = page => {page.onHide?.()}
const emptyLedger = {points:[],growth:[],processing:[]}
test('points: a slow former member response cannot replace the latest member balance', async()=>{
  const old=deferred();let n=0
  const {page}=pageFixture('points',{getMiniBootstrap:()=>++n===1?old.promise:Promise.resolve({membership:{pointsBalance:2,growthValue:0}}),getMiniLoyaltyLedger:async()=>emptyLedger})
  const first=page.load();await page.load();old.resolve({membership:{pointsBalance:99,growthValue:0}});await first
  assert.equal(page.data.membership.pointsBalance,2)
})
test('points: leaving clears private ledger and ignores delayed reads', async()=>{
  const d=deferred();const {page}=pageFixture('points',{getMiniBootstrap:()=>d.promise,getMiniLoyaltyLedger:async()=>emptyLedger})
  page.data.membership={pointsBalance:40};const loading=page.load();hide(page);d.resolve({membership:{pointsBalance:99}});await loading
  assert.equal(page.data.membership,null);assert.equal(page.data.points.length,0)
})
test('community: hidden-page response cannot restore the former membership',async()=>{
  const d=deferred();const {page}=pageFixture('community',{getActivities:async()=>[],getActivityRegistrations:async()=>[],getMiniBootstrap:()=>d.promise})
  const loading=page.load();hide(page);d.resolve({membership:{memberNo:'100001'}});await loading;assert.equal(page.data.membership,null)
})
test('songs: repeated tap creates one request and changing table isolates completion',async()=>{
  const d=deferred();let writes=0;const {page,state}=pageFixture('songs',{getTodayPerformances:async()=>({schedules:[]}),submitSongRequest:()=>{writes++;return d.promise}})
  page.onLoad();page.data.loading=false;page.data.schedules=[{id:'show-one'}];page.data.songTitle='第一桌点歌';const first=page.submitIntent();await tick();const second=page.submitIntent();assert.equal(writes,1)
  state.session={tableCode:'W02',tableToken:'table-two',cartScope:'session-two'};page.onShow();page.data.songTitle='第二桌草稿';d.resolve({data:{}});await Promise.all([first,second]);assert.equal(page.data.tableCode,'W02');assert.equal(page.data.songTitle,'第二桌草稿');assert.equal(page.data.success,'')
})
test('preferences: invalid birthday picker cannot crash or write preferences',async()=>{
  let writes=0;const {page}=pageFixture('profile-preferences',{updatePreferences:async()=>{writes++}})
  page.data.loading=false;page.data.profile={preferences:{}};page.onBirthdayChange({detail:{value:9999}});await page.save();assert.equal(writes,0);assert.match(page.data.error,/生日/)
})
test('preferences: delayed profile from a hidden page is discarded',async()=>{
  const d=deferred();const {page}=pageFixture('profile-preferences',{getCustomerProfile:()=>d.promise});const loading=page.load();hide(page);d.resolve({displayName:'旧会员',preferences:{}});await loading;assert.equal(page.data.profile,null)
})
test('privacy: hidden-page contact read cannot repopulate a former phone number',async()=>{
  const d=deferred();const {page}=pageFixture('privacy',{getVerifiedPhones:()=>d.promise,getActivityRegistrations:async()=>[]})
  const loading=page.loadContactTools();hide(page);d.resolve([{publicId:'old',phone:'13800000000'}]);await loading;assert.equal(page.data.verifiedPhones.length,0)
})
test('privacy: rapid repeated phone change is sent once',async()=>{
  const d=deferred();let writes=0;const {page}=pageFixture('privacy',{replaceVerifiedPhone:()=>{writes++;return d.promise},getVerifiedPhones:async()=>[],getActivityRegistrations:async()=>[]})
  const event={detail:{code:'verified-phone-code'}};const first=page.replacePhone(event);const second=page.replacePhone(event);assert.equal(writes,1);d.resolve({});await Promise.all([first,second])
})
test('notifications: completion of a hidden save cannot unlock a newer save',async()=>{
  const old=deferred(),fresh=deferred();let n=0
  const {page}=pageFixture('profile-notifications',{setOfficialPointsNotifications:()=>++n===1?old.promise:fresh.promise,getOfficialPointsNotifications:async()=>({accountId:'new'}),getWechatNotificationAuthorizations:async()=>({authorizations:[]}),getWechatMemberServiceNotificationAuthorizations:async()=>({authorizations:[]})})
  page.data.official={accountId:'old'};page.loadGeneration=1;const first=page.changeOfficial({detail:{value:true}});hide(page);await page.load();const second=page.changeOfficial({detail:{value:false}})
  assert.equal(n,2);old.resolve({});await first;assert.equal(page.data.saving,true);fresh.resolve({});await second;assert.equal(page.data.saving,false)
})
test('reservation: a former page load cannot repopulate personal bookings after hiding',async()=>{
  const d=deferred();const {page}=pageFixture('reservations',{getReservations:()=>d.promise,getReservationPerformanceImpacts:async()=>({impacts:[]}),getReservationPerformanceNotificationAuthorizations:async()=>({authorizations:[]}),getPendingCustomerReservation:async()=>null})
  page.preloadWechatSubscriptionPresentationOptions=async()=>[];const first=page.loadData();hide(page);d.resolve({reservations:[{publicId:'private-old',status:'confirmed',arrivalAt:'2035-01-01T20:00:00Z'}]});await first;assert.equal(page.data.reservations.length,0)
})
const reminderOption={templateId:'reservation-reminder',policyId:'policy-one',policyVersion:1,authorizationVersion:0,usesRemaining:0}
test('reservation: accepted WeChat choice with failed server recording is not reported as enabled',async()=>{
  const {page,wx}=pageFixture('reservations',{recordReservationPerformanceNotificationAuthorization:async()=>{throw Object.assign(Error('offline'),{code:'NETWORK_ERROR'})}})
  wx.requestSubscribeMessage=o=>o.success({'reservation-reminder':'accept'})
  page.data.reservations=[{publicId:'booking-one',performanceNotificationOption:reminderOption}];page.loadData=async()=>{}
  await page.enablePerformanceNotification({currentTarget:{dataset:{reservation:'booking-one'}}})
  assert.doesNotMatch(page.data.notificationNotice,/已申请/);assert.match(page.data.notificationNotice,/保存|记录|同步|确认/)
})
test('reservation: leaving during the subscription sheet cannot submit a booking later',async()=>{
  const {page,wx}=pageFixture('reservations');let consent,writes=0
  wx.requestSubscribeMessage=o=>{consent=o};page.completeReservationSubmit=async()=>{writes++}
  Object.assign(page.data,{reservationRecoveryReady:true,customerName:'测试',contact:'13800000000',wechatSubscriptionPresentationOptions:[reminderOption]})
  page.submitReservation();hide(page);consent.success({'reservation-reminder':'reject'});await tick();assert.equal(writes,0)
})
test('reservation: leaving during capacity recheck cannot create a booking',async()=>{
  const d=deferred();let writes=0;const {page}=pageFixture('reservations',{getReservationAvailability:()=>d.promise,createCustomerReservation:async()=>{writes++}})
  Object.assign(page.data,{reservationRecoveryReady:true,customerName:'测试',contact:'13800000000',reservationDate:'2035-01-01'})
  page.loadData=async()=>{};const pending=page.completeReservationSubmit();hide(page);d.resolve({acceptingReservations:true,depositRule:{policyVersion:1}});await pending;assert.equal(writes,0)
})
test('membership terms: delayed success cannot navigate away from a different page',async()=>{
  const {page,state}=pageFixture('membership-terms',{enrollMembership:async()=>({membership:{}})})
  Object.assign(page.data,{terms:{version:1},allowEnrollment:true,enrollmentReady:true,agreedToPolicies:true})
  await page.acceptAndEnroll({detail:{code:'phone-code'}});hide(page);for(const callback of state.timers)callback?.()
  assert.equal(state.calls.filter(([kind])=>kind==='back'||kind==='tab').length,0)
})
test('membership terms: hidden enrollment response cannot toast success on a different page',async()=>{
  const d=deferred();const {page,state}=pageFixture('membership-terms',{enrollMembership:()=>d.promise})
  Object.assign(page.data,{terms:{version:1},allowEnrollment:true,enrollmentReady:true,agreedToPolicies:true})
  const pending=page.acceptAndEnroll({detail:{code:'phone-code'}});hide(page);d.resolve({membership:{}});await pending
  assert.equal(state.calls.filter(([kind,o])=>kind==='toast'&&o.title==='入会成功').length,0)
})
test('activity detail: hidden response cannot restore private member details',async()=>{
  const d=deferred();const {page}=pageFixture('community-detail',{getMiniBootstrap:()=>d.promise})
  page.onLoad({id:'public-activity'});const pending=page.load();hide(page);d.resolve({membership:{memberNo:'old'}});await pending;assert.equal(page.data.membership,null)
})
test('activity detail: rapid registration taps cannot open parallel consent flows',async()=>{
  const d=deferred();let prompts=0;const {page}=pageFixture('community-detail')
  Object.assign(page.data,{membership:{},activity:{publicId:'activity-one',paymentMode:'none',safetyPolicyVersion:1,refundPolicyVersion:1},partySize:1,contact:'13800000000',ruleAcknowledged:true})
  page.offerActivityRegistrationNotifications=()=>{prompts++;return d.promise};page.choosePayment=async()=>null
  const first=page.register();const second=page.register();assert.equal(prompts,1);d.resolve();await Promise.all([first,second])
})
test('reservation: changed form during capacity check must be reviewed before submission',async()=>{
  const d=deferred();let writes=0;const {page}=pageFixture('reservations',{getReservationAvailability:()=>d.promise,createCustomerReservation:async()=>{writes++}})
  Object.assign(page.data,{reservationRecoveryReady:true,customerName:'测试',contact:'13800000000',reservationDate:'2035-01-01',partySize:2})
  page.loadData=async()=>{};const pending=page.completeReservationSubmit();page.onPartySizeInput({detail:{value:'20'}});d.resolve({acceptingReservations:true,depositRule:{policyVersion:1}});await pending
  assert.equal(writes,0);assert.match(page.data.error,/变化|变更|核对/)
})
test('privacy: successful phone replacement remains visibly confirmed after refresh',async()=>{
  const {page}=pageFixture('privacy',{replaceVerifiedPhone:async()=>({}),getVerifiedPhones:async()=>[{publicId:'new'}],getActivityRegistrations:async()=>[]})
  await page.replacePhone({detail:{code:'phone-code'}});assert.match(page.data.contactMessage,/已更新/);assert.equal(page.data.verifiedPhones[0].publicId,'new')
})
for (const decision of ['accept','reject','ban']) test(`reservation: ${decision} is recorded once and shown truthfully`,async()=>{
  const records=[];const {page,wx}=pageFixture('reservations',{recordReservationPerformanceNotificationAuthorization:async payload=>{records.push(payload);return {}}})
  wx.requestSubscribeMessage=o=>{o.success({'reservation-reminder':decision});o.complete?.()}
  page.data.reservations=[{publicId:'booking-one',performanceNotificationOption:reminderOption}];page.loadData=async()=>{}
  await page.enablePerformanceNotification({currentTarget:{dataset:{reservation:'booking-one'}}})
  assert.equal(records.length,1);assert.equal(records[0].platformResult,decision);assert.equal(records[0].reservationPublicId,'booking-one')
  assert.match(page.data.notificationNotice,decision==='accept'?/已申请/:/未开启/);assert.equal(page.data.notificationBusyId,'')
})
test('reservation: valid form creates exactly one booking with capacity policy and selected show',async()=>{
  const d=deferred(),writes=[];const {page}=pageFixture('reservations',{getReservationAvailability:async()=>({acceptingReservations:true,depositRule:{policyVersion:7}}),createCustomerReservation:payload=>{writes.push(payload);return d.promise}})
  Object.assign(page.data,{reservationRecoveryReady:true,customerName:'测试顾客',contact:'13800000000',reservationDate:'2035-01-01',partySize:3,selectedPerformanceId:'show-one',performances:[{id:'show-one'}]})
  page.loadData=async()=>{};page.preloadWechatSubscriptionPresentationOptions=async()=>[]
  const first=page.completeReservationSubmit();await tick();await page.completeReservationSubmit();assert.equal(writes.length,1)
  assert.equal(writes[0].reservationPolicyVersion,7);assert.equal(writes[0].partySize,3);assert.equal(writes[0].preferredScheduleId,'show-one');d.resolve({});await first;assert.match(page.data.success,/已提交/)
})
test('reservation: cancellation declined does not write and a confirmed cancellation refreshes',async()=>{
  let writes=0;const {page,wx}=pageFixture('reservations',{cancelCustomerReservation:async()=>{writes++}})
  page.data.reservations=[{publicId:'booking-one',canCancel:true}];page.loadData=async()=>{}
  const event={currentTarget:{dataset:{id:'booking-one'}}};wx.showModal=o=>o.success({confirm:false});await page.cancelReservation(event)
  assert.equal(writes,0);assert.equal(page.data.cancelBusyId,'');wx.showModal=o=>o.success({confirm:true});await page.cancelReservation(event);assert.equal(writes,1);assert.match(page.data.success,/已取消/)
})
test('points: real zero, reversal, expiry, debt and growth are displayed without fabricating a balance',async()=>{
  const {page}=pageFixture('points',{getMiniBootstrap:async()=>({membership:{pointsBalance:0,growthValue:25,pendingRecoveryPoints:2,pointsExpiry:{expiringWithin30Days:3,nextExpiryAt:'2035-01-01'}}}),getMiniLoyaltyLedger:async()=>({points:[{id:'refund',entryType:'reverse',pointsDelta:-3,balanceAfter:0}],growth:[{id:'growth',entryType:'earn',growthDelta:25,balanceAfter:25}],processing:[]})})
  await page.load();assert.equal(page.data.membership.pointsBalance,0);assert.match(page.data.membership.expiryText,/3 积分/);assert.match(page.data.membership.debtText,/2 积分欠额/)
  assert.equal(page.data.points[0].amountText,'-3');assert.equal(page.data.growth[0].amountText,'+25');page.switchTab({currentTarget:{dataset:{tab:'growth'}}});assert.equal(page.data.tab,'growth')
})
test('points: read failure clears old totals and a later retry recovers',async()=>{
  let fail=true;const {page}=pageFixture('points',{getMiniBootstrap:async()=>{if(fail)throw Error('offline');return {membership:{pointsBalance:8,growthValue:10}}},getMiniLoyaltyLedger:async()=>emptyLedger})
  page.data.membership={pointsBalance:99};await page.load();assert.equal(page.data.membership,null);assert.ok(page.data.error);fail=false;await page.load();assert.equal(page.data.membership.pointsBalance,8);assert.equal(page.data.error,'')
})
test('preferences: native avatar hide preserves unsaved draft and birthday/dietary consent still save',async()=>{
  const writes=[];const {page}=pageFixture('profile-preferences',{getCustomerProfile:async()=>({displayName:'原昵称',preferences:{}}),updatePreferences:async(...args)=>writes.push(args),recordBirthdayBenefitConsent:async date=>writes.push(date)})
  await page.load();page.onNameInput({detail:{value:'新昵称'}});page.onDietaryInput({detail:{value:'不吃花生'}});await page.save();assert.equal(writes.length,0)
  hide(page);page.onChooseAvatar({detail:{avatarUrl:'wxfile://chosen-avatar'}});page.onShow();assert.equal(page.data.displayName,'新昵称');assert.equal(page.data.avatarUrl,'wxfile://chosen-avatar')
  page.onDietaryConsentChange({detail:{value:['dietary']}});page.onBirthdayChange({detail:{value:1}});await page.save();assert.equal(writes.length,2);assert.equal(writes[0][1],'新昵称');assert.equal(writes[0][2].granted,true);assert.equal(writes[1],'01-01')
})
test('privacy: denied native phone permission never sends a replacement',async()=>{
  let writes=0;const {page}=pageFixture('privacy',{replaceVerifiedPhone:async()=>{writes++}});await page.replacePhone({detail:{errMsg:'getPhoneNumber:fail user deny'}});assert.equal(writes,0);assert.ok(page.data.contactMessage)
})
test('privacy: invalid activity phone cannot write; valid phone and revocation refresh the tools',async()=>{
  const writes=[];const {page}=pageFixture('privacy',{updateActivityRegistrationContact:async(...args)=>writes.push(args),revokeVerifiedPhone:async id=>writes.push(id),getVerifiedPhones:async()=>[],getActivityRegistrations:async()=>[]})
  page.startActivityContactEdit({currentTarget:{dataset:{publicId:'registration-one'}}});page.onActivityContactInput({detail:{value:'123'}});await page.saveActivityContact();assert.equal(writes.length,0)
  page.onActivityContactInput({detail:{value:'13800000000'}});await page.saveActivityContact();assert.deepEqual(writes[0],['registration-one','13800000000']);assert.match(page.data.contactMessage,/已更正/)
  await page.revokePhone({currentTarget:{dataset:{publicId:'phone-one'}}});assert.equal(writes[1],'phone-one');assert.match(page.data.contactMessage,/已停用/)
})
test('contact: unavailable bootstrap keeps phone fallback and an unconfigured service explains its state',async()=>{
  const {page,state,wx}=pageFixture('profile-contact',{getMiniBootstrap:async()=>{throw Error('offline')}});let phone='';wx.makePhoneCall=async o=>{phone=o.phoneNumber}
  await page.load();page.callStore();assert.equal(phone,page.data.contact.phone);assert.match(phone,/^\d{11}$/);page.openCustomerService();assert.match(state.calls.at(-1)[1].title,/暂未开通/)
})
test('brand story: shared entry contains no table/member credentials and can return home',()=>{
  const {page,state}=pageFixture('brand-story');const share=page.onShareAppMessage();assert.equal(share.path,'/pages/brand-story/index');assert.doesNotMatch(JSON.stringify(share),/table-one|session-one/);page.closeArticle();assert.equal(state.calls.at(-1)[1].url,'/pages/home/index')
})
test('activity detail: leaving during subscription does not register and releases the tap lock',async()=>{
  const d=deferred();let writes=0;const {page}=pageFixture('community-detail',{registerActivity:async()=>{writes++}})
  Object.assign(page.data,{membership:{},activity:{publicId:'activity-one',paymentMode:'none',safetyPolicyVersion:1,refundPolicyVersion:1},partySize:1,contact:'13800000000',ruleAcknowledged:true})
  page.offerActivityRegistrationNotifications=()=>d.promise;page.choosePayment=async()=>({choice:'none'});const pending=page.register();hide(page);d.resolve();await pending;assert.equal(writes,0);assert.equal(page._registrationPending,false)
})
test('songs: confirmed request displays success and clears only its submitted draft',async()=>{
  const {page}=pageFixture('songs',{submitSongRequest:async()=>({data:{request:{publicId:'SONG-001'}}})});page.onLoad()
  Object.assign(page.data,{loading:false,schedules:[{id:'show-one'}],songTitle:'测试歌曲',note:'测试备注'})
  await page.submitIntent();assert.equal(page.data.error,'');assert.match(page.data.success,/已提交/);assert.equal(page.data.songTitle,'');assert.equal(page.data.submitting,false)
})
const paidActivity={publicId:'activity-paid',paymentMode:'full_required',paymentAvailability:'available',availablePaymentMethods:['jsapi'],feeAmountMinor:100,feeBasis:'per_booking',safetyPolicyVersion:1,refundPolicyVersion:1}
const pendingRegistration={publicId:'registration-paid',status:'payment_pending',allowedActions:['start_payment','query_payment'],payment:{publicId:'payment-one',amountMinor:100,method:'jsapi'}}
test('activity detail: required paid registration opens one native payment and confirms only from the query',async()=>{
  let registrations=0,payments=0,queries=0;const {page,wx}=pageFixture('community-detail',{
    registerActivity:async()=>{registrations++;return pendingRegistration},getActivityRegistrationPayment:async()=>pendingRegistration,
    startActivityRegistrationPayment:async()=>({providerAction:{status:'pending',presentation:'jsapi',payload:{timeStamp:'1',nonceStr:'nonce',package:'prepay_id=test',signType:'RSA',paySign:'test'}}}),
    queryActivityRegistrationPayment:async()=>{queries++;return {registrationStatus:'confirmed',resolutionState:'confirmed',allowedActions:[],paidAmountMinor:100}},
  })
  Object.assign(page.data,{membership:{},activity:paidActivity,partySize:1,contact:'13800000000',ruleAcknowledged:true})
  page.offerActivityRegistrationNotifications=async()=>{};page.refreshActivityAvailability=async()=>{};wx.requestPayment=o=>{payments++;o.success({})}
  await page.register();assert.equal(registrations,1);assert.equal(payments,1);assert.equal(queries,1);assert.equal(page.data.registration.resolutionState,'confirmed');assert.equal(page.data.busy,false)
})
test('activity detail: leaving after registration was sent keeps its recovered identity without opening payment',async()=>{
  const d=deferred();let payments=0;const {page,state,wx}=pageFixture('community-detail',{registerActivity:()=>d.promise,getActivityRegistrationPayment:async()=>pendingRegistration})
  Object.assign(page.data,{membership:{},activity:paidActivity,partySize:1,contact:'13800000000',ruleAcknowledged:true})
  page.offerActivityRegistrationNotifications=async()=>{};page.refreshActivityAvailability=async()=>{};wx.requestPayment=()=>{payments++}
  const pending=page.register();await tick();hide(page);d.resolve(pendingRegistration);await pending;assert.equal(payments,0)
  assert.equal(state.storage.get('mbox.community.registrations.v1')['activity-paid'].publicId,'registration-paid');assert.equal(page.data.busy,false)
})
test('activity detail: an old result dialog cannot navigate away after leaving',async()=>{
  const {page,state,wx}=pageFixture('community-detail');let modal;wx.showModal=o=>{modal=o}
  const pending=page.showRegistrationOutcome({status:'confirmed'});hide(page);modal.success({confirm:true});await pending;assert.equal(state.calls.filter(([kind])=>kind==='tab').length,0)
})
