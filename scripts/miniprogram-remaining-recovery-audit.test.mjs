import assert from 'node:assert/strict'
import test from 'node:test'
import { liveMiniHarness } from './miniprogram-live-contract-harness.mjs'
import { pageFixture, deferred, tick } from './miniprogram-full-page-fixture.mjs'
const principal='mbox.wechat.identity.principal.v1'
const option={apiKind:'loyalty',notificationType:'loyalty_points_expiring',policyId:'policy-a',policyVersion:1,templateId:'template-a',authorizationVersion:0,usesRemaining:0}
function live(respond=async()=>({data:{data:{saved:true}}})) {
 const f=liveMiniHarness('miniprogram',respond);f.storage.set(principal,{principalId:'member-a'});return f
}
for(const phase of ['platform','between-recordings'])test(`subscription cannot write another identity after ${phase}`,async()=>{
 const gate=deferred(),f=live(async()=>{await gate.promise;return {data:{data:{saved:true}}}})
 let sheet;f.runtime.requestSubscribeMessage=o=>{sheet=o}
 const helper=f.load(f.root+'/utils/wechat-subscription.js')
 const p=helper.requestWechatSubscription([option,{...option,templateId:'template-b',policyId:'policy-b',notificationType:'loyalty_points_credited'}])
 if(phase==='platform')f.storage.set(principal,{principalId:'member-b'})
 sheet.success({'template-a':'accept','template-b':'accept'});await tick()
 if(phase==='between-recordings')f.storage.set(principal,{principalId:'member-b'})
 gate.resolve();const result=await p
 assert.equal(f.calls.length,phase==='platform'?0:1);assert.ok(result.recordingResults.some(r=>r?.writebackError))
})
test('subscription callback uses the policy reviewed before native prompt',async()=>{
 const f=live();let sheet;f.runtime.requestSubscribeMessage=o=>{sheet=o};const original={...option}
 const p=f.load(f.root+'/utils/wechat-subscription.js').requestWechatSubscription([original]);original.policyId='changed-policy'
 sheet.success({'template-a':'accept'});await p;assert.equal(f.calls[0].data.policyId,'policy-a')
})
for(const change of ['identity','logout','store','empty-refresh','legacy'])test(`subscription cache does not reuse stale ${change} evidence`,()=>{
 const f=live(),cache=f.load(f.root+'/utils/wechat-subscription-presentation-cache.js')
 cache.rememberPresentationOptions('coupon_open',[option])
 if(change==='identity')f.storage.set(principal,{principalId:'member-b'})
 if(change==='logout')f.storage.set('mbox.membership.loggedOut.v1','yes')
 if(change==='store')f.config.storeId='another-store'
 if(change==='empty-refresh')cache.rememberPresentationOptions('coupon_open',[])
 if(change==='legacy'){for(const k of [...f.storage.keys()])if(k.includes('subscription.presentation'))f.storage.delete(k);f.storage.set('mbox.wechat.subscription.presentation.v1',{coupon_open:[option],latest:[option]})}
 assert.equal(cache.resolvePresentationOptions('coupon_open').some(o=>o.policyId==='policy-a'),false)
})
test('subscription cache reuses current owner presentation without storing credentials',()=>{
 const f=live(),cache=f.load(f.root+'/utils/wechat-subscription-presentation-cache.js');cache.rememberPresentationOptions('coupon_open',[option])
 assert.equal(cache.resolvePresentationOptions('coupon_open')[0].policyId,'policy-a')
 const persisted=[...f.storage].filter(([key])=>key.includes('subscription.presentation'));assert.equal(JSON.stringify(persisted).includes('member-a'),false);assert.equal(JSON.stringify(persisted).includes('mbox_reservation_session'),false)
})
for(const failure of [403,503,'network'])test(`reservation fallback ${failure} is not an empty successful history`,async()=>{
 const f=live(async c=>c.path.endsWith('/mine')?{status:404,data:{error:{code:'NOT_FOUND'}}}:failure==='network'?{networkError:true}:{status:failure,data:{error:{code:'READ_DENIED'}}})
 f.storage.set('mbox.reservation.public.ids',['reservation-a']);await assert.rejects(f.api.getReservations())
})
test('reservation fallback only omits authoritative missing records',async()=>{
 const f=live(async c=>c.path.endsWith('/mine')?{status:404,data:{error:{code:'NOT_FOUND'}}}:c.path.endsWith('missing')?{status:404,data:{error:{code:'RESERVATION_NOT_FOUND'}}}:{data:{data:{publicId:'found'}}})
 f.storage.set('mbox.reservation.public.ids',['missing','found']);const r=await f.api.getReservations();assert.equal(r.reservations.length,1);assert.equal(r.reservations[0].publicId,'found')
})
test('reservation aggregate cannot mix records across identity changes',async()=>{
 const gate=deferred();const f=live(async c=>{if(c.path.endsWith('/mine'))return {status:404,data:{error:{code:'NOT_FOUND'}}};if(c.path.endsWith('slow')){await gate.promise;return {data:{data:{publicId:'slow'}}}};return {data:{data:{publicId:'fast'}}}})
 f.storage.set('mbox.reservation.public.ids',['fast','slow']);const p=f.api.getReservations();await tick();f.storage.set(principal,{principalId:'member-b'});gate.resolve();await assert.rejects(p)
})
const payment={status:'pending',presentation:'jsapi',payload:{timeStamp:'1',nonceStr:'n',package:'prepay_id=p',signType:'RSA',paySign:'signed'}}
function activity(overrides={}) {
 const f=pageFixture('community-detail',overrides),p=f.page;p.onLoad({id:'activity-one'});p.pageVisible=true
 p.data.registration={publicId:'registration-a',canStartPayment:true,canQueryPayment:true,canCancelDirectly:true};p.data.registrations=[p.data.registration]
 p.refreshActivityAvailability=async()=>{};p.loadServiceCode=async()=>{};f.wx.requestPayment=o=>{f.state.calls.push(['pay',o]);o.success({})}
 return f
}
for(const boundary of ['hide','unload','selection','identity'])test(`activity late payment cannot open native sheet after ${boundary}`,async()=>{
 const gate=deferred(),f=activity({startActivityRegistrationPayment:()=>gate.promise,getActivityRegistrationPayment:async()=>({registrationStatus:'payment_pending'})}),p=f.page
 f.state.storage.set(principal,{principalId:'member-a'});const run=p.startPayment();await tick()
 if(boundary==='hide')p.onHide();if(boundary==='unload')p.onUnload();if(boundary==='selection')p.data.registration={publicId:'registration-b'};if(boundary==='identity')f.state.storage.set(principal,{principalId:'member-b'})
 gate.resolve({providerAction:payment});await run;assert.equal(f.state.calls.filter(c=>c[0]==='pay').length,0)
 assert.ok(f.state.storage.get('mbox.community.payment.actions.v1')['registration-a'])
})
for(const method of ['performPaymentQuery','refreshPaymentState'])test(`activity ${method} ignores delayed state for previous selection`,async()=>{
 const gate=deferred(),f=activity({queryActivityRegistrationPayment:()=>gate.promise,getActivityRegistrationPayment:()=>gate.promise}),p=f.page
 const run=p[method]();await tick();p.data.registration={publicId:'registration-b'};gate.resolve({registrationStatus:'confirmed',resolutionState:'confirmed',allowedActions:[]});await run
 assert.equal(p.data.registration.publicId,'registration-b');assert.equal(p.data.success,'')
})
test('activity cancel confirmation is single-flight and invalidated on hide',async()=>{
 const modals=[];let writes=0;const f=activity({cancelActivityRegistration:async()=>{writes++;return {status:'cancelled'}}}),p=f.page
 f.wx.showModal=o=>{modals.push(o);f.state.calls.push(['modal',o])};const a=p.cancelRegistration(),b=p.cancelRegistration();await tick();p.onHide();modals.forEach(m=>m.success({confirm:true}));await Promise.all([a,b]);assert.equal(modals.length,1);assert.equal(writes,0)
})
for(const value of [{bad:true},'',{key:'original-request',amount:-1},{key:'original-request',amount:100,createdAt:0}])test(`prepayment malformed or expired journal ${JSON.stringify(value)} blocks new request`,async()=>{
 const f=live(),p=f.page('order',['onPrepayTable'],{commandIdentityScope:()=>f.load(f.root+'/utils/recoverable-command.js').commandIdentityScope(),isPresentableWechatJsapiAction:()=>false,isWechatCancellation:()=>false})
 p.data={prepayment:{},prepaymentConsent:true,prepaymentAmount:'10'};p.currentTableRequest=()=>({});p.isCurrentTableRequest=()=>true;p.refreshSharedCart=async()=>{}
 f.storage.set('mbox.table-prepayment.v1:table-one',value);await p.onPrepayTable();assert.equal(f.calls.length,0);assert.deepEqual(f.storage.get('mbox.table-prepayment.v1:table-one'),value);assert.ok(p.data.error)
})
test('prepayment failed presentation cannot erase a previous unknown receipt',async()=>{
 let n=0;const f=live(async()=>++n===1?{networkError:true}:{data:{data:{status:'failed'}}}),p=f.page('order',['onPrepayTable'],{commandIdentityScope:()=>f.load(f.root+'/utils/recoverable-command.js').commandIdentityScope(),isPresentableWechatJsapiAction:()=>false,isWechatCancellation:()=>false})
 p.data={prepayment:{},prepaymentConsent:true,prepaymentAmount:'10'};p.currentTableRequest=()=>({});p.isCurrentTableRequest=()=>true;p.refreshSharedCart=async()=>{}
 await p.onPrepayTable();const key='mbox.table-prepayment.v1:table-one',original=f.storage.get(key);await p.onPrepayTable();assert.equal(f.storage.get(key)?.key,original.key)
})

for(const method of ['updatePreferences','recordBirthdayBenefitConsent','recordNotificationConsent','createRedemption'])test(`${method}: identity change during initial preflight sends no business request`,async()=>{
 const storage=new Map([[principal,{principalId:'member-a'}]])
 const f=liveMiniHarness('miniprogram',async()=>({data:{data:{saved:true}}}),{storage,ensureCustomerSession:async()=>{storage.set(principal,{principalId:'member-b'});return true}})
 await assert.rejects(f.api[method](method==='recordBirthdayBenefitConsent'?'01-01':{}));assert.equal(f.calls.length,0)
})
test('first anonymous session establishment still permits a normal member write',async()=>{
 const storage=new Map();const f=liveMiniHarness('miniprogram',async()=>({data:{data:{saved:true}}}),{storage,ensureCustomerSession:async()=>{storage.set(principal,{principalId:'member-a'});return true}})
 await f.api.updatePreferences({},'test',{});assert.equal(f.calls.length,1)
})
for(const result of [null,{}, {resolutionState:'invented',registrationStatus:'confirmed'}, {resolutionState:'confirmed',registrationStatus:'confirmed',registrationPublicId:'another'}])test(`activity query malformed receipt ${JSON.stringify(result)} retains original key`,async()=>{
 const f=activity({queryActivityRegistrationPayment:async()=>result}),p=f.page;await p.performPaymentQuery()
 assert.ok(f.state.storage.get('mbox.community.payment.queries.v1')['registration-a']);assert.equal(p.data.success,'');assert.ok(p.data.error)
})
for(const result of [null,{}, {publicId:'other',status:'cancelled'}])test(`activity cancellation does not claim success for ${JSON.stringify(result)}`,async()=>{
 const f=activity({cancelActivityRegistration:async()=>result}),p=f.page;await p.cancelRegistration()
 assert.ok(f.state.storage.get('mbox.community.registration.cancellations.v1')['registration-a']);assert.equal(p.data.success,'');assert.ok(p.data.error)
})
test('activity native payment hide and return reconciles original registration without repeating charge',async()=>{
 let queries=0;const f=activity({startActivityRegistrationPayment:async()=>({providerAction:payment}),queryActivityRegistrationPayment:async()=>{queries++;return {registrationPublicId:'registration-a',registrationStatus:'confirmed',resolutionState:'confirmed',allowedActions:[]}}}),p=f.page
 f.wx.requestPayment=o=>{f.state.calls.push(['pay']);p.onHide();p.onShow();o.success({})}
 await p.startPayment();assert.equal(queries,1);assert.equal(f.state.calls.filter(c=>c[0]==='pay').length,1);assert.match(p.data.success,/支付通道确认/);assert.equal(p.data.busy,false)
})
test('activity normal cancellation requires matching authoritative receipt',async()=>{
 const f=activity({cancelActivityRegistration:async()=>({publicId:'registration-a',status:'cancelled'})}),p=f.page;await p.cancelRegistration()
 assert.equal(p.data.registration.status,'cancelled');assert.equal(f.state.storage.get('mbox.community.registration.cancellations.v1')['registration-a'],undefined)
})
const activityCommands=[
 ['startPayment','payment.actions','startActivityRegistrationPayment'],
 ['performPaymentQuery','payment.queries','queryActivityRegistrationPayment'],
 ['cancelRegistration','registration.cancellations','cancelActivityRegistration'],
 ['saveRegisteredPartySize','registration.party-size','updateActivityRegistrationPartySize'],
 ['requestRegistrationRefund','registration.refund-requests','requestActivityRegistrationRefund'],
]
for(const [method,suffix,api] of activityCommands)for(const fault of ['corrupt-map','corrupt-key','silent-write'])test(`activity ${method} ${fault} never invents a request`,async()=>{
 let writes=0;const f=activity({[api]:async()=>{writes++;throw Error('should not send')},getActivityRegistrationPayment:async()=>({registrationStatus:'confirmed',resolutionState:'confirmed',canRequestFullRefund:true,paidAmountMinor:5000,allowedActions:[]})}),p=f.page
 Object.assign(p.data.registration,{hasServiceFlow:true,canAttemptFullRefund:true,paidAmountMinor:5000,status:'confirmed',resolutionState:'confirmed',serviceVersion:3,maxParticipants:5,activityPackage:{maxParticipants:5},purchaseKind:'admission_package'})
 p.data.serviceCode={service:{includesAdmission:true,meal:null,maxParticipants:5,admittedCount:0}};p.data.registeredPartySizeDraft='3'
 const key='mbox.community.'+suffix+'.v1'
 if(fault==='corrupt-map')f.state.storage.set(key,'corrupt')
 if(fault==='corrupt-key')f.state.storage.set(key,{'registration-a':{idempotencyKey:'bad',partySize:3,reason:'old'}})
 if(fault==='silent-write')f.wx.setStorageSync=()=>{}
 await p[method]();assert.equal(writes,0);assert.ok(p.data.error);assert.equal(p.data.busy,false)
})
test('activity changed payment cannot replace original unknown action',async()=>{
 let calls=0;const f=activity({startActivityRegistrationPayment:async()=>{calls++;throw Error('lost')},getActivityRegistrationPayment:async()=>{throw Error('unavailable')}}),p=f.page
 p.data.registration.payment={publicId:'payment-a'};await p.startPayment();const key='mbox.community.payment.actions.v1',first=structuredClone(f.state.storage.get(key))
 p.data.registration.payment={publicId:'payment-b'};await p.startPayment();assert.equal(calls,1);assert.deepEqual(structuredClone(f.state.storage.get(key)),first)
})
test('reservation history failure keeps booking creation disabled',async()=>{
 const f=pageFixture('reservations',{getReservations:async()=>{throw Error('history unavailable')},getReservationPerformanceImpacts:async()=>({impacts:[]}),getReservationPerformanceNotificationAuthorizations:async()=>({authorizations:[]}),getPendingCustomerReservation:async()=>null})
 f.page.preloadWechatSubscriptionPresentationOptions=async()=>[];await f.page.loadData();assert.equal(f.page.data.reservationRecoveryReady,false);assert.match(f.page.data.error,/history/)
})
test('bottle photo finishing after hide is removed and cannot reappear',async()=>{
 const f=pageFixture('profile-bottle-detail',{getCustomerBottlePhoto:async()=>({base64:'private-photo'})}),p=f.page;let writing;const removed=[]
 f.wx.env={USER_DATA_PATH:'/synthetic'};f.wx.getFileSystemManager=()=>({writeFile:o=>{writing=o},unlink:o=>removed.push(o.filePath)})
 p.onLoad({id:'bottle-a'});p.data.deposits=[{id:'deposit-a'}];const run=p.loadPhoto('deposit-a');await tick();p.onHide();writing.success();await run
 assert.equal(p.data.deposits.length,0);assert.deepEqual(removed,[writing.filePath])
})

for(const resolution of ['confirmed','unknown','different-payment'])test(`activity authoritative ${resolution} clears only the settled original action`,async()=>{
 const state={registrationPublicId:'registration-a',registrationStatus:'confirmed',resolutionState:resolution==='unknown'?'unknown':'confirmed',paymentPublicId:resolution==='different-payment'?'payment-b':'payment-a',allowedActions:[]}
 const f=activity({getActivityRegistrationPayment:async()=>state}),p=f.page
 const key='mbox.community.payment.actions.v1';f.state.storage.set(key,{'registration-a':{idempotencyKey:'original-payment-key',paymentPublicId:'payment-a',createdAt:new Date().toISOString()}})
 await p.refreshPaymentState();assert.equal(Boolean(f.state.storage.get(key)['registration-a']),resolution!=='confirmed')
})

test('late prepayment terminal receipt cannot delete a newer pending intent',async()=>{
 const gate=deferred(),f=live(async()=>{await gate.promise;return {data:{data:{status:'resolved',terminalPaymentStatus:'closed'}}}}),p=f.page('order',['onPrepayTable'],{commandIdentityScope:()=>f.load(f.root+'/utils/recoverable-command.js').commandIdentityScope(),isPresentableWechatJsapiAction:()=>false,isWechatCancellation:()=>false})
 p.data={prepayment:{},prepaymentConsent:true,prepaymentAmount:'10'};p.currentTableRequest=()=>({});p.isCurrentTableRequest=()=>true;p.refreshSharedCart=async()=>{}
 const run=p.onPrepayTable();await tick();const key='mbox.table-prepayment.v1:table-one',newer={...f.storage.get(key),key:'newer-confirmed-intent'};f.storage.set(key,newer)
 gate.resolve();await run;assert.deepEqual(f.storage.get(key),newer);assert.equal(p.data.success,'')
})
