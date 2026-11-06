import assert from 'node:assert/strict'
import test from 'node:test'
import { pageFixture, deferred, tick } from './miniprogram-full-page-fixture.mjs'
const principal='mbox.wechat.identity.principal.v1',event=dataset=>({currentTarget:{dataset}})
const cases=[['correctCustomerPreference','declareCustomerPreference',event({key:'taste.note',value:'sweet'})],['withdrawCustomerPreference','withdrawCustomerPreferenceSource',event({id:'source'})],['withdrawRestriction','withdrawProductRestriction',event({id:'restriction'})],['redeemItem','createRedemption',event({id:'item'})],['cancelRedemption','cancelRedemption',event({id:'redemption'})]]
function profile(overrides={}){const f=pageFixture('profile',overrides);f.state.storage.set(principal,{principalId:'member-a'});Object.assign(f.page.data,{membership:{memberNo:'1'},hasTableContext:true,preferenceSources:[{publicId:'source'}],productRestrictions:[{publicId:'restriction',productName:'test'}],redemptionItems:[{publicId:'item',eligible:true,pointsRequired:10,name:'test'}]});f.page.load=async()=>{};return f}
for(const [method,api,input] of cases)for(const boundary of ['hide','identity'])test(`profile ${method} confirmation rejects ${boundary}`,async()=>{
 let writes=0,modal;const f=profile({[api]:async()=>{writes++;return {facts:[],sources:[]}}});f.wx.showModal=o=>{modal=o};const p=f.page[method](input);await tick();if(boundary==='hide')f.page.onHide();else f.state.storage.set(principal,{principalId:'member-b'});modal.success({confirm:true});await p;assert.equal(writes,0)
})
for(const [method,api,input] of cases)test(`profile ${method} coalesces pending confirmation`,async()=>{
 const modals=[];let writes=0;const f=profile({[api]:async()=>{writes++;return {facts:[],sources:[]}}});f.wx.showModal=o=>{if(o.showCancel===false)return;modals.push(o)}
 const a=f.page[method](input),b=f.page[method](input);await tick();modals.forEach(m=>m.success({confirm:true}));await Promise.all([a,b]);assert.equal(modals.length,1);assert.equal(writes,1)
})
test('daily snack late claim cannot resurrect QR after hide',async()=>{
 const gate=deferred(),f=pageFixture('member-center',{claimAnnualDailySnack:()=>gate.promise});const p=f.page.claimDailySnack();f.page.onHide();gate.resolve({claimCode:'private-code',expiresAt:'2030-01-01T12:00:00Z'});await p;assert.equal(f.page.data.dailySnackClaim,null);assert.equal(f.state.calls.filter(([k])=>k==='toast').length,0)
})
test('member center clears old private state before a failed reload',async()=>{
 const f=pageFixture('member-center',{getMiniBootstrap:async()=>{throw Error('offline')}});Object.assign(f.page.data,{membership:{memberNo:'old'},dailySnackClaim:{claimCode:'old'},points:[{id:'old'}]});await f.page.load();assert.equal(f.page.data.membership,null);assert.equal(f.page.data.dailySnackClaim,null);assert.equal(f.page.data.points.length,0)
})
test('daily snack rejects malformed success without claiming a QR exists',async()=>{
 const f=pageFixture('member-center',{claimAnnualDailySnack:async()=>({})});await f.page.claimDailySnack();assert.equal(f.page.data.dailySnackClaim,null);assert.equal(f.state.calls.filter(([k])=>k==='toast').length,0);assert.ok(f.page.data.error)
})
test('membership enrollment completed off-page does not navigate or reopen profile',async()=>{
 const gate=deferred(),f=profile({enrollMembership:()=>gate.promise});Object.assign(f.page.data,{membership:null,agreedToPolicies:true,membershipTerms:{version:1}});let continued=0;f.page.continuePendingMembershipAction=()=>{continued++}
 const p=f.page.quickLoginAndEnroll({detail:{code:'phone-code-test'}});f.page.onHide();gate.resolve({membership:{level:'member',memberNo:'new'}});await p;assert.equal(continued,0);assert.equal(f.page.data.membership,null)
})
test('membership recovery cannot verify after leaving during challenge creation',async()=>{
 const gate=deferred();let verified=0;const f=profile({startMembershipRecovery:()=>gate.promise,verifyMembershipRecovery:async()=>{verified++;return {status:'pending'}}});f.page.data.agreedToPolicies=true
 const p=f.page.recoverMembership({detail:{code:'phone-code-test'}});f.page.onHide();gate.resolve({challengePublicId:'challenge'});await p;assert.equal(verified,0)
})
test('old logout completion cannot clear a newly selected identity',async()=>{
 const gate=deferred(),f=profile({logoutWechatIdentity:()=>gate.promise});f.state.storage.set('mbox.member.displayName','new-user-name');const p=f.page.logoutMember();await tick();f.state.storage.set(principal,{principalId:'member-b'});gate.reject(Error('old response rejected'));await p.catch(()=>{});assert.equal(f.state.storage.get('mbox.member.displayName'),'new-user-name');assert.equal(f.state.storage.get(principal)?.principalId,'member-b')
})
test('coupon navigation cannot resume after leaving during prompt load',async()=>{
 const gate=deferred(),f=profile({getWechatNotificationPrompt:()=>gate.promise});let sheets=0;f.wx.requestSubscribeMessage=()=>{sheets++};const p=f.page.openCoupons();f.page.onHide();gate.resolve({presentation:[]});await p;assert.equal(f.state.calls.filter(([k])=>k==='navigate').length,0);assert.equal(sheets,0)
})
for(const kind of ['coupons','bottles','cards','gifts'])test(`${kind} repeated page cursor preserves existing page and reports failure`,async()=>{
 const overrides={getCustomerBenefitWallet:async()=>({items:[],nextCursor:'loop'}),getCustomerBottles:async()=>({items:[],nextCursor:'loop'}),getMemberCards:async()=>({activeMember:true,projects:[],cards:[],applications:[],nextCursors:{projects:'loop'}}),getMemberGiftJobs:async()=>({items:[],nextCursor:'loop'})}
 const f=pageFixture(kind==='coupons'?'profile-coupons':kind==='bottles'?'profile-bottles':'profile-cards',overrides),p=f.page
 if(kind==='coupons'){await p.load();await p.loadMore();assert.ok(p.data.moreError)}
 if(kind==='bottles'){await p.load();await p.loadMore();assert.ok(p.data.error)}
 if(kind==='cards'){await p.load();await p.load('projects');assert.ok(p.data.error)}
 if(kind==='gifts'){await p.loadGifts();await p.loadGifts(event({more:true}));assert.ok(p.data.giftError)}
})

test('expiry reminder cannot open native prompt after leaving during authorization refresh', async () => {
  const gate=deferred(),f=profile({getWechatNotificationAuthorizations:()=>gate.promise});let prompts=0
  f.page.data.expiryNotificationOption={templateId:'expiry',notificationType:'loyalty_points_expiring',usesRemaining:0}
  f.wx.requestSubscribeMessage=o=>{prompts++;o.success?.({expiry:'accept'});o.complete?.()}
  const pending=f.page.enableExpiryReminder();f.page.onHide();gate.resolve({authorizations:[]});await pending;assert.equal(prompts,0)
})
test('preferences cannot send birthday consent under a different identity after saving preferences',async()=>{
  const gate=deferred();let birthday=0;const f=pageFixture('profile-preferences',{updatePreferences:()=>gate.promise,recordBirthdayBenefitConsent:async()=>{birthday++}})
  f.state.storage.set(principal,{principalId:'a'});Object.assign(f.page.data,{loading:false,profile:{preferences:{}},birthdayIndex:1})
  const pending=f.page.save();f.state.storage.set(principal,{principalId:'b'});gate.resolve({});await pending;assert.equal(birthday,0);assert.equal(f.state.storage.get('mbox.member.displayName'),undefined)
})
test('card withdrawal confirmation cannot execute as a new identity',async()=>{
  let modal,writes=0;const f=pageFixture('profile-cards',{submitMemberCardAction:async()=>{writes++},getMemberCards:async()=>({projects:[],cards:[],applications:[]})});f.state.storage.set(principal,{principalId:'a'});f.wx.showModal=o=>{modal=o}
  const pending=f.page.withdraw(event({id:'card',action:'withdraw-card'}));f.state.storage.set(principal,{principalId:'b'});modal.success({confirm:true});await pending;assert.equal(writes,0)
})
test('history detects an unchanged full page cursor and keeps previous rows',async()=>{
  const orders=Array.from({length:30},(_,i)=>({publicId:'order-'+i,items:[]}));const f=pageFixture('account',{getCustomerOrderHistory:async()=>orders});f.page.historyMode=true
  await f.page.loadData();await f.page.loadMoreHistory();assert.equal(f.page.data.orders.length,30);assert.ok(f.page.data.error)
})

for(const [method,api,input] of cases)test(`profile ${method} cancellation leaves retry available`,async()=>{
  let writes=0;const f=profile({[api]:async()=>{writes++;return {facts:[],sources:[]}}});f.wx.showModal=o=>o.success?.({confirm:false})
  await f.page[method](input);f.wx.showModal=o=>o.success?.({confirm:true});await f.page[method](input);assert.equal(writes,1)
})
for(const boundary of ['hide','identity','table'])test(`daily snack response rejects ${boundary} and allows a later valid claim`,async()=>{
  const gate=deferred();let count=0;const receipt={claimCode:'valid',expiresAt:'2099-01-01T12:00:00Z'}
  const f=pageFixture('member-center',{claimAnnualDailySnack:()=>++count===1?gate.promise:Promise.resolve(receipt)});f.state.storage.set(principal,{principalId:'a'})
  const pending=f.page.claimDailySnack();if(boundary==='hide')f.page.onHide();if(boundary==='identity')f.state.storage.set(principal,{principalId:'b'});if(boundary==='table')f.state.session.cartScope='new-table'
  gate.resolve(receipt);await pending;assert.equal(f.page.data.dailySnackClaim,null)
  f.page._pageHidden=false;await f.page.claimDailySnack();assert.equal(f.page.data.dailySnackClaim.claimCode,'valid');assert.equal(count,2)
})
test('enrollment permits intended identity establishment and normal pending navigation',async()=>{
  const f=profile({enrollMembership:async()=>{f.state.storage.set(principal,{principalId:'new'});return {membership:{memberNo:'123456',level:'member'}}}})
  Object.assign(f.page.data,{membership:null,agreedToPolicies:true,membershipTerms:{version:1}});let continued=0;f.page.continuePendingMembershipAction=()=>continued++
  await f.page.quickLoginAndEnroll({detail:{code:'phone-code-test'}});assert.equal(continued,1);assert.equal(f.page.data.membership.memberNo,'123456')
})
test('enrollment reload cannot restore an old membership after identity changes',async()=>{
  const gate=deferred(),f=profile({enrollMembership:async()=>({membership:{memberNo:'123456',level:'member'}})})
  Object.assign(f.page.data,{membership:null,agreedToPolicies:true,membershipTerms:{version:1}});let continued=0;f.page.continuePendingMembershipAction=()=>continued++;f.page.load=()=>gate.promise
  const pending=f.page.quickLoginAndEnroll({detail:{code:'phone-code-test'}});await tick();f.state.storage.set(principal,{principalId:'new'});f.page.data.membership=null;gate.resolve();await pending;assert.equal(continued,0);assert.equal(f.page.data.membership,null)
})
test('normal recovery still verifies once and navigates after refreshed membership',async()=>{
  let verified=0,continued=0;const f=profile({startMembershipRecovery:async()=>({challengePublicId:'c'}),verifyMembershipRecovery:async()=>{verified++;return {status:'completed',membership:{memberNo:'123456',level:'member'}}}})
  f.page.data.agreedToPolicies=true;f.page.continuePendingMembershipAction=()=>continued++;await f.page.recoverMembership({detail:{code:'phone-code-test'}});assert.equal(verified,1);assert.equal(continued,1)
})
test('recovery challenge cannot continue after identity changes',async()=>{
  const gate=deferred();let verified=0;const f=profile({startMembershipRecovery:()=>gate.promise,verifyMembershipRecovery:async()=>{verified++;return {status:'pending'}}});f.page.data.agreedToPolicies=true
  const pending=f.page.recoverMembership({detail:{code:'phone-code-test'}});f.state.storage.set(principal,{principalId:'new'});gate.resolve({challengePublicId:'c'});await pending;assert.equal(verified,0)
})
test('old preference completion cannot unlock a newer flight after leaving and returning',async()=>{
  const old=deferred(),fresh=deferred();let writes=0;const f=profile({declareCustomerPreference:()=>++writes===1?old.promise:fresh.promise})
  const first=f.page.correctCustomerPreference(event({key:'taste.note',value:'first'}));await tick();f.page.onHide();f.page._pageHidden=false
  const second=f.page.correctCustomerPreference(event({key:'taste.note',value:'second'}));await tick();old.resolve({facts:[],sources:[]});await first
  assert.equal(f.page.data.preferenceBusyId,'correct:taste.note:second');fresh.resolve({facts:[],sources:[]});await second;assert.equal(f.page.data.preferenceBusyId,'')
})
test('same member token renewal does not suppress a valid preference result',async()=>{
  const f=profile({declareCustomerPreference:async()=>{f.state.storage.set('mbox.wechat.identity.accessToken.v1','renewed');return {facts:[],sources:[]}}})
  await f.page.correctCustomerPreference(event({key:'taste.note',value:'sweet'}));assert.ok(f.state.calls.some(([kind,o])=>kind==='toast'&&o.title==='已记录纠正'))
})
test('coupon normal navigation still succeeds when optional prompt lookup fails',async()=>{
  const f=profile({getWechatNotificationPrompt:async()=>{throw Error('offline')}});await f.page.openCoupons();assert.equal(f.state.calls.filter(([k])=>k==='navigate').length,1)
})
for(const kind of ['coupons','bottles','cards','gifts'])test(`${kind} changing member before pagination clears prior private rows without reading next page`,async()=>{
  let reads=0;const response=()=>{reads++;return {items:[{id:'old'}],nextCursor:'next',activeMember:true,projects:[{id:'old'}],cards:[],applications:[],nextCursors:{projects:'next'}}}
  const f=pageFixture(kind==='coupons'?'profile-coupons':kind==='bottles'?'profile-bottles':'profile-cards',{getCustomerBenefitWallet:async()=>response(),getCustomerBottles:async()=>response(),getMemberCards:async()=>response(),getMemberGiftJobs:async()=>response()}),p=f.page
  f.state.storage.set(principal,{principalId:'a'});if(kind==='gifts')await p.loadGifts();else await p.load();assert.equal(reads,1)
  f.state.storage.set(principal,{principalId:'b'});if(kind==='coupons'||kind==='bottles')await p.loadMore();if(kind==='cards')await p.load('projects');if(kind==='gifts')await p.loadGifts(event({more:true}))
  assert.equal(reads,1);assert.equal(p.data[{coupons:'coupons',bottles:'items',cards:'projects',gifts:'giftJobs'}[kind]].length,0)
})
test('pagination rejects a two-cursor cycle but permits terminal duplicate rows',async()=>{
  let calls=0;const f=pageFixture('profile-coupons',{getCustomerBenefitWallet:async()=>({items:[{id:'a'}],nextCursor:['first','second','first',null][calls++]})})
  await f.page.load();await f.page.loadMore();await f.page.loadMore();assert.ok(f.page.data.moreError);assert.equal(f.page.data.nextCursor,'second');assert.equal(f.page.data.coupons.length,1)
  await f.page.loadMore();assert.equal(f.page.data.moreError,'');assert.equal(f.page.data.nextCursor,null);assert.equal(f.page.data.coupons.length,1)
})
test('preferences normal sequence persists birthday once then navigates',async()=>{
  let saves=0,birthdays=0;const f=pageFixture('profile-preferences',{updatePreferences:async()=>{saves++},recordBirthdayBenefitConsent:async()=>{birthdays++}})
  Object.assign(f.page.data,{loading:false,profile:{preferences:{}},birthdayIndex:1,displayName:'name'});await f.page.save();f.state.timers.filter(Boolean).forEach(fn=>fn());assert.equal(saves,1);assert.equal(birthdays,1);assert.equal(f.state.storage.get('mbox.member.displayName'),'name');assert.equal(f.state.calls.filter(([k])=>k==='back').length,1)
})
test('card confirmation is singleflight and normal confirmed withdrawal still executes',async()=>{
  const pendingModals=[];let writes=0,modals=0;const f=pageFixture('profile-cards',{submitMemberCardAction:async()=>{writes++},getMemberCards:async()=>({projects:[],cards:[],applications:[]})});f.wx.showModal=o=>{pendingModals.push(o);modals++}
  const first=f.page.withdraw(event({id:'card',action:'withdraw-card'})),second=f.page.withdraw(event({id:'card',action:'withdraw-card'}));pendingModals.forEach(modal=>modal.success({confirm:true}));await Promise.all([first,second]);assert.equal(writes,1);assert.equal(modals,1)
})

test('benefit reservation completed off-page cannot show a success modal',async()=>{
  const gate=deferred(),f=profile({reserveCustomerBenefit:()=>gate.promise});const pending=f.page.requestBenefitUse(event({id:'benefit'}));f.page.onHide();gate.resolve({});await pending;assert.equal(f.state.calls.filter(([k])=>k==='modal').length,0)
})
test('preference creation completed off-page cannot reopen an old snapshot',async()=>{
  const gate=deferred(),f=profile({declareCustomerPreference:()=>gate.promise});Object.assign(f.page.data,{preferenceTypeOptions:[{key:'taste.note'}],preferenceTypeIndex:0,preferenceUsesPicker:false,preferenceTextValue:'test'});let applied=0;f.page.applyCustomerPreferenceSnapshot=()=>applied++
  const pending=f.page.submitCustomerPreference();f.page.onHide();gate.resolve({facts:[],sources:[]});await pending;assert.equal(applied,0)
})
test('activity entry still navigates after an authoritative empty registration list',async()=>{
  const f=profile({getActivityRegistrations:async()=>[]});await f.page.openSuperhighService();assert.equal(f.state.calls.filter(([k])=>k==='tab').length,1)
})
test('activity entry cannot navigate after a hidden page receives empty registrations',async()=>{
  const gate=deferred(),f=profile({getActivityRegistrations:()=>gate.promise});const pending=f.page.openSuperhighService();f.page.onHide();gate.resolve([]);await pending;assert.equal(f.state.calls.filter(([k])=>k==='tab').length,0)
})
test('activity entry waits for asynchronous view commit and scrolls to existing registrations',async()=>{
  const f=profile({getActivityRegistrations:async()=>[{publicId:'registration',status:'confirmed'}],getActivityRegistrationPayment:async()=>({})});let scrolls=0;const callbacks=[]
  f.page.setData=(patch,callback)=>{Object.assign(f.page.data,patch);if(callback)callbacks.push(callback)};f.wx.pageScrollTo=()=>scrolls++
  const pending=f.page.openSuperhighService();await tick();callbacks.forEach(fn=>fn());await pending;assert.equal(scrolls,1);assert.equal(f.state.calls.filter(([k])=>k==='tab').length,0)
})

test('history fresh reload failure does not retain another members old orders',async()=>{
  let fail=false;const f=pageFixture('account',{getCustomerOrderHistory:async()=>{if(fail)throw Error('offline');return [{publicId:'old',items:[]}]}});f.page.historyMode=true
  await f.page.loadData();assert.equal(f.page.data.orders.length,1);fail=true;f.state.storage.set(principal,{principalId:'new'});await f.page.loadData();assert.equal(f.page.data.orders.length,0);assert.ok(f.page.data.error)
})
