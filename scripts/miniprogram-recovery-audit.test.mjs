import assert from 'node:assert/strict'
import nodeTest from 'node:test'
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn)
import { liveMiniHarness } from './miniprogram-live-contract-harness.mjs'
const principal='mbox.wechat.identity.principal.v1'
function fixture(respond=async()=>({data:{data:{saved:true}}}),options={}) {
 const h=liveMiniHarness('miniprogram',respond,options);h.storage.set(principal,{principalId:'audit-a'})
 return {...h,command:h.load(h.root+'/utils/recoverable-command.js').recoverableGuestCommand}
}
const fail=status=>Object.assign(Error('unknown'),{statusCode:status,code:status?'HTTP_ERROR':'NETWORK_ERROR'})
for(const status of [400,401,403,404,422,500])test(`unknown command then ${status} retains original key after restart`,async()=>{
 const f=fixture(),keys=[];await assert.rejects(f.command('audit',{value:1},key=>{keys.push(key);throw fail()}))
 await assert.rejects(f.command('audit',{value:1},key=>{keys.push(key);throw fail(status)}))
 const g=fixture(undefined,{storage:f.storage});await g.command('audit',{value:1},async key=>{keys.push(key);return {data:{saved:true}}})
 assert.equal(new Set(keys).size,1)
})
test('pending operation cannot be replaced by changed input',async()=>{
 const f=fixture();let sent=0;await assert.rejects(f.command('audit',{value:1},()=>{sent++;throw fail()}))
 await assert.rejects(f.command('audit',{value:2},async()=>{sent++;return {ok:true}}));assert.equal(sent,1)
})
for(const mode of ['read','write','corrupt','empty'])test(`recovery ${mode} failure blocks transmission`,async()=>{
 const f=fixture();await assert.rejects(f.command('audit',{},()=>{throw fail()}));let sent=0
 if(mode==='read')f.runtime.getStorageSync=k=>{if(k.startsWith('mbox.command'))throw Error('storage unavailable');return f.storage.get(k)}
 if(mode==='write')f.state.storageFailure=true
 if(mode==='corrupt'||mode==='empty')for(const key of f.storage.keys())if(key.startsWith('mbox.command'))f.storage.set(key,mode==='empty'?'':{bad:true})
 const g=mode==='corrupt'||mode==='empty'?fixture(undefined,{storage:f.storage}):f
 await assert.rejects(g.command('audit',{},async()=>{sent++;return {ok:true}}));assert.equal(sent,0)
})
test('late command success cannot clear or report success under another identity',async()=>{
 const f=fixture();let done;const p=f.command('audit',{},()=>new Promise(resolve=>{done=resolve}));await new Promise(setImmediate)
 f.storage.set(principal,{principalId:'audit-b'});done({data:{saved:true}});await assert.rejects(p);assert.ok([...f.storage.keys()].some(k=>k.startsWith('mbox.command')))
})
test('empty success response keeps original command pending',async()=>{
 const f=fixture();await assert.rejects(f.command('audit',{},async()=>null));assert.ok([...f.storage.keys()].some(k=>k.startsWith('mbox.command')))
})
const cases=[
 ['declareCustomerPreference',[{key:'service.intensity',value:'quiet',polarity:'prefer'}]],
 ['withdrawCustomerPreferenceSource',['preference-one','withdraw']],
 ['createRedemption',['catalog-one']],['cancelRedemption',['redemption-one','cancel']],
 ['updateActivityRegistrationContact',['registration-one','13800000000']],
 ['revokeVerifiedPhone',['contact-one']],['updatePreferences',[{seatPreference:'quiet'},'test',{}]],
 ['withdrawProductRestriction',['restriction-one','withdraw']],['claimAnnualDailySnack',[]],
 ['cancelCustomerReservation',['reservation-one']],
 ['acknowledgeReservationPerformanceImpact',['impact-one','keep',null]],
]
for(const [method,args] of cases)test(`${method}: network loss then 503 then success retains exact key`,async()=>{
 let count=0;const f=fixture(async()=>++count===1?{networkError:true}:count===2?{status:503,data:{error:{code:'UNAVAILABLE'}}}:{data:{data:{saved:true}}})
 await assert.rejects(f.api[method](...args));await assert.rejects(f.api[method](...args));await f.api[method](...args)
 assert.equal(new Set(f.calls.map(c=>c.headers['idempotency-key'])).size,1)
})
test('public write must not renew and resend after identity switches',async()=>{
 const f=fixture(async()=>{f.storage.set(principal,{principalId:'audit-b'});return {status:401,data:{error:{code:'RESERVATION_SESSION_INVALID'}}}})
 await assert.rejects(f.api.updatePreferences({},'test',{}));assert.equal(f.calls.length,1)
})
for(const method of ['enrollMembership','replaceVerifiedPhone','startMembershipRecovery','verifyMembershipRecovery'])test(`${method}: damaged legacy journal blocks mutation`,async()=>{
 const f=fixture();const legacy={enrollMembership:'mbox.membership.enroll.attempt.v1',replaceVerifiedPhone:'mbox.verified.phone.replace.v1',startMembershipRecovery:'mbox.membership.recovery.attempt.v1',verifyMembershipRecovery:'mbox.membership.recovery.attempt.v1'}[method]
 f.storage.set(legacy,{idempotencyKey:'old-unknown-key'});await assert.rejects(f.api[method]('test','test','test'));assert.equal(f.calls.length,0);assert.ok(f.storage.has(legacy))
})
test('expired or future-dated generic journal is never resubmitted',async()=>{
 for(const delta of [-24*3600*1000,3600*1000]){
  const f=fixture();await assert.rejects(f.command('audit',{},()=>{throw fail()}));const key=[...f.storage.keys()].find(k=>k.startsWith('mbox.command.v2:'));const value=f.storage.get(key);f.storage.set(key,{...value,createdAt:Date.now()+delta});let calls=0
  await assert.rejects(f.command('audit',{},async()=>{calls++;return {ok:true}}));assert.equal(calls,0)
 }
})
test('different concurrent input is rejected while identical input shares original flight',async()=>{
 const f=fixture(),resolvers=[];let calls=0;const send=()=>{calls++;return new Promise(resolve=>{resolvers.push(resolve)})};const a=f.command('audit',{value:1},send);const b=f.command('audit',{value:1},send)
 assert.equal(a,b);const different=f.command('audit',{value:2},send);const denied=assert.rejects(different);await new Promise(setImmediate);resolvers.forEach(resolve=>resolve({ok:true}));await a;await denied;assert.equal(calls,1)
})
test('member pending intent survives table changes but isolates store',async()=>{
 const f=fixture();let first;await assert.rejects(f.command('audit',{},key=>{first=key;throw fail()},{customerOnly:true}))
 f.load(f.root+'/utils/session.js').getTableSession().cartScope='other-table';let restored
 await f.command('audit',{},async key=>{restored=key;return {ok:true}},{customerOnly:true});assert.equal(first,restored)
 await assert.rejects(f.command('audit',{},key=>{first=key;throw fail()},{customerOnly:true}));f.config.storeId='other-store'
 await f.command('audit',{},async key=>{assert.notEqual(key,first);return {ok:true}},{customerOnly:true})
})
test('late request cannot restore logged-out reservation cookie or return private response',async()=>{
 const f=fixture();const transport=f.load(f.root+'/utils/request.js');let pending
 f.runtime.request=input=>{pending=input};const action=transport.request('/api/public/mini/customer/profile',{requireTableSession:false})
 transport.clearReservationCookie();f.storage.set('mbox.http.cookie.reservation.v2','mbox_reservation_session=new-user')
 pending.success({statusCode:200,data:{data:{private:'old-user'}},header:{'set-cookie':'mbox_reservation_session=old-user'}})
 await assert.rejects(action,{code:'COMMAND_RECOVERY_SCOPE_CHANGED'});assert.equal(f.storage.get('mbox.http.cookie.reservation.v2'),'mbox_reservation_session=new-user')
})
test('cookie persistence failure rejects instead of leaving a permanently pending request',async()=>{
 const f=fixture();const transport=f.load(f.root+'/utils/request.js');let pending
 f.runtime.request=input=>{pending=input};const action=transport.request('/api/public/mini/customer/profile',{requireTableSession:false});f.state.storageFailure=true
 assert.doesNotThrow(()=>pending.success({statusCode:200,data:{data:{}},header:{'set-cookie':'mbox_reservation_session=test-cookie'}}));await assert.rejects(action)
})
for(const code of ['PRODUCT_UNAVAILABLE','SHARED_CART_VERSION_CONFLICT','CHECKOUT_COUPON_RECONFIRM_REQUIRED','GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED'])test(`checkout unknown then ${code} keeps original recovery`,async()=>{
 let turn=0;const f=fixture(async()=>++turn===1?{networkError:true}:{status:409,data:{error:{code}}})
 const p=f.page('order',['submitOrder'],{checkoutRecommendationAttribution:()=>null,CHECKOUT_ATTEMPT_KEY:'checkout-attempt',PENDING_PAYMENT_KEY:'payment',CHECKOUT_REJECTED_BEFORE_ORDER:new Set(['PRODUCT_UNAVAILABLE'])})
 Object.assign(p,{isCurrentTableRequest:()=>true,recordOrderTiming(){},updateCart(){},invalidateCheckoutCoupons(){},recoverSharedCart:async()=>{},confirmDuplicateCheckout:async()=>{},couponCheckoutReady:()=>true,checkoutDraftMatches:()=>true})
 p.data={paymentStateReady:true,busy:false,cart:[]};const draft={tableScope:'table-one',expectedGeneration:2,expectedVersion:3}
 await p.submitOrder(null,false,null,{},draft);const original=f.storage.get('checkout-attempt');assert.ok(original)
 await p.submitOrder(null,false,original,{});assert.equal(p.data.checkoutLocked,true);assert.equal(f.storage.get('checkout-attempt').idempotencyKey,original.idempotencyKey);assert.equal(f.nativePayments.length,0)
})
test('reservation unknown followed by policy rejection remains pending',async()=>{
 let turn=0;const f=fixture(async call=>call.path.endsWith('/customer/profile')?{data:{data:{publicId:'customer-a'}}}:call.method==='GET'?{status:404,data:{error:{code:'RESERVATION_NOT_FOUND'}}}:++turn===1?{networkError:true}:{status:409,data:{error:{code:'RESERVATION_POLICY_CHANGED'}}})
 const input={customerName:'test',contact:'test',partySize:2,scheduledAt:'2030-01-01T12:00:00Z',reservationPolicyVersion:1}
 await assert.rejects(f.api.createCustomerReservation(input));await assert.rejects(f.api.recoverCustomerReservation());assert.ok(await f.api.getPendingCustomerReservation())
})
for(const result of [{},{data:null},{data:'unexpected'}])test(`malformed command receipt ${JSON.stringify(result)} preserves recovery`,async()=>{
 const f=fixture();await assert.rejects(f.command('audit',{},async()=>result));assert.ok([...f.storage.keys()].some(k=>k.startsWith('mbox.command')))
})
for(const mode of ['changed-orders','malformed-action'])test(`batch payment ${mode} retains original request without new payment`,async()=>{
 const f=fixture(async()=>mode==='changed-orders'?{networkError:true}:{data:{data:{}}})
 const p=f.page('account',['paySelectedOrders'],{isPresentableWechatJsapiAction:()=>false});p.data={selectedPublicIds:['order-a'],payingBatch:false};p.loadData=async()=>{}
 await p.paySelectedOrders();const key='mbox.table-batch-attempt:table-one',original=f.storage.get(key);assert.ok(original)
 if(mode==='changed-orders'){p.data.selectedPublicIds=['order-b'];await p.paySelectedOrders();assert.equal(f.calls.length,1)}
 assert.equal(f.storage.get(key).key,original.key);assert.equal(f.nativePayments.length,0)
})
test('distinct notification topics remain independent while unknown first topic retains its key',async()=>{
 const f=fixture(async call=>call.data.notificationType==='loyalty_points_credited'?{networkError:true}:{data:{data:{saved:true}}})
 const base={policyId:'policy',policyVersion:1,templateId:'template',expectedVersion:0,platformResult:'accept'}
 await assert.rejects(f.api.recordWechatNotificationAuthorization({...base,notificationType:'loyalty_points_credited'}))
 await f.api.recordWechatNotificationAuthorization({...base,notificationType:'loyalty_points_expiring'});assert.equal(f.calls.length,2)
})

import { pageFixture } from './miniprogram-full-page-fixture.mjs'
for(const state of ['settled','missing','unpaid'])test(`batch original readback ${state} releases only confirmed settled journal`,async()=>{
 const rows=state==='missing'?[]:[{publicId:'original',payableAmountMinor:state==='settled'?0:100,paymentAccess:state==='settled'?'not_required':'available',items:[]}]
 const f=pageFixture('account',{getTableOrders:async()=>rows}),p=f.page;p.onLoad({})
 const key='mbox.table-batch-attempt:'+JSON.stringify(f.state.session);f.state.storage.set(key,{ids:['original'],key:'original-request-key'})
 await p.loadData();assert.equal(f.state.storage.has(key),state!=='settled')
})
