import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const attemptsKey='mbox.community.registration.attempts.v1'
const refundsKey='mbox.community.registration.refund-requests.v1'
const refundState=(status=null,id=null)=>({registrationStatus:'confirmed',resolutionState:status==='requested'?'refund_requested':['approved','processing'].includes(status)?'refunding':'confirmed',allowedActions:[],paidAmountMinor:5000,refundStatus:status,refundPublicId:id,canRequestFullRefund:status===null||['rejected','cancelled'].includes(status)})
const event=dataset=>({currentTarget:{dataset}})
const rawPackage={publicId:'pkg-five',name:'五人套餐',maxParticipants:5,includesAdmission:true,feeAmountMinor:5000,mealOnlyFeeAmountMinor:3000,feeBasis:'per_person',paymentMode:'full_required',paymentDeadlineMinutes:15,paymentAvailability:'available',availability:'available',remainingCapacity:20}
const rawActivity={publicId:'activity',title:'活动',feeAmountMinor:1000,feeBasis:'per_person',paymentMode:'full_required',paymentAvailability:'available',availablePaymentMethods:['jsapi','alipay_jsapi'],availablePaymentChoices:['full'],paymentDeadlineMinutes:15,remainingCapacity:50,packages:[rawPackage],safety:{policyVersion:'s1'},refundPolicy:{policyVersion:'r1'},endsAt:'2099-01-01T00:00:00Z'}
const confirmed={publicId:'old',activityPublicId:'activity',serviceVersion:3,purchaseKind:'admission_package',maxParticipants:5,partySize:2,status:'confirmed',resolutionState:'confirmed',paidAmountMinor:5000,canRequestFullRefund:true,allowedActions:[],activityPackage:{publicId:'pkg-five',name:'五人套餐',maxParticipants:5}}
const code=id=>({code:'server-code-'+id,qrDataUrl:'data:image/png;base64,cXI=',service:{registrationPublicId:id,purchaseKind:'admission_package',hasMeal:true,includesAdmission:true,partySize:2,admittedCount:0,meal:null}})
async function fixture(platform,overrides={}){
 let page,serial=0,timerSerial=0
 const storage=new Map(),calls=[],timers=new Map()
 const runtime={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),showModal:o=>{calls.push(['modal',o]);o.success?.({confirm:true})},showToast(){},showShareMenu(){},switchTab(){}}
 const api=new Proxy({getActivity:async()=>rawActivity,getMiniBootstrap:async()=>({membership:{}}),getActivityRegistrations:async()=>[confirmed],getActivityLoyaltyBenefits:async()=>[],getActivityRegistrationPayment:async()=>({registrationStatus:'confirmed',resolutionState:'confirmed',allowedActions:[],paidAmountMinor:5000,canRequestFullRefund:true}),getActivityRegistrationServiceCode:async id=>code(id),getWechatNotificationPrompt:async()=>({authorizations:[]}),getAlipayNotificationPrompt:async()=>({authorizations:[]}),...overrides},{get:(o,k)=>o[k]||(async()=>{throw Error('unexpected '+String(k))})})
 const context={wx:runtime,Date,console,Page:p=>{page=p},setTimeout:(callback,delay)=>{const id=++timerSerial;timers.set(id,{callback,delay});return id},clearTimeout:id=>timers.delete(id),require:name=>{
  if(name.endsWith('/platform'))return runtime
  if(name.endsWith('/api'))return api
  if(name.endsWith('/config/index'))return {getRuntimeConfig:()=>({alipayPaymentEnabled:true})}
  if(name.endsWith('/id'))return {randomId:prefix=>prefix+'-test-'+(++serial)}
  if(name.endsWith('/format'))return {money:n=>'¥'+(n/100).toFixed(2),dateTime:v=>v}
  if(name.endsWith('/media'))return {publicImageUrl:v=>v}
  if(name.endsWith('/customer-error'))return {customerErrorMessage:(e,f)=>e.message||f,isWechatCancellation:()=>false,isAlipayCancellation:()=>false}
  if(name.endsWith('/public-share'))return {enablePublicShareMenu(){}}
  if(name.endsWith('/wechat-subscription-presentation-cache')||name.endsWith('/alipay-subscription-presentation-cache'))return {rememberPresentationOptions(){}}
  if(name.endsWith('/wechat-subscription')||name.endsWith('/alipay-subscription'))return new Proxy({},{get:()=>()=>[]})
  return {}
 }}
 vm.runInNewContext(await readFile(new URL('../'+platform+'/pages/community-detail/index.js',import.meta.url),'utf8')+'\nglobalThis.helpers={viewRegistration,viewActivity,packageView,pricingFor};',context)
 page.data=structuredClone(page.data);page.setData=p=>Object.assign(page.data,p)
 page.preloadWechatSubscriptionPresentationOptions=async()=>[];page.preloadAlipaySubscriptionPresentationOptions=async()=>[]
 page.offerActivityRegistrationNotifications=async()=>{};page.showRegistrationOutcome=async()=>{};page.refreshActivityAvailability=async()=>{}
 Object.assign(page.data,{id:'activity',membership:{},activity:context.helpers.viewActivity(rawActivity),registration:context.helpers.viewRegistration(confirmed),registrations:[context.helpers.viewRegistration(confirmed)]})
 return {page,storage,api,runtime,timers,helpers:context.helpers}
}
for(const platform of ['miniprogram','alipay-miniprogram']){
 test(platform+': whole-package amount stays fixed at 1–5 attendees and legacy ticket additions retain original pricing',async()=>{
  const {helpers:h}=await fixture(platform),p=h.packageView(rawPackage)
  assert.equal(h.pricingFor(rawActivity,p,1).feeAmountMinor,5000);assert.equal(h.pricingFor(rawActivity,p,5).feeAmountMinor,5000)
  assert.equal(h.pricingFor(rawActivity,p,5,'meal_package').feeAmountMinor,3000)
  assert.equal(h.pricingFor(rawActivity,{...p,maxParticipants:null},2).feeAmountMinor,12000)
 })
 test(platform+': another package is explicit, limited to five actual attendees and independent of the old order',async()=>{
  const {page}=await fixture(platform);await page.beginPurchase(event({kind:'admission_package'}))
  assert.equal(page.data.creatingPurchase,true);assert.equal(page.data.registration.publicId,'old');assert.equal(page.data.partySizeLimit,5)
  for(let i=0;i<8;i++)page.changePartySize(event({delta:1}))
  assert.equal(page.data.partySize,5);assert.equal(page.data.selectedPricing.feeAmountMinor,5000)
 })
 test(platform+': pending payment blocks a second purchase and a failed history read cannot create a new order',async()=>{
  const {page}=await fixture(platform);page.data.registrations.push({publicId:'pending',status:'payment_pending'})
  await page.beginPurchase(event({kind:'admission_package'}));assert.equal(page.data.creatingPurchase,false);assert.match(page.data.error,/待付款/)
  page.data.registrations=[];page.data.registrationReadFailed=true
  await page.beginPurchase(event({kind:'admission_package'}));assert.equal(page.data.creatingPurchase,false);assert.match(page.data.error,/刷新/)
 })
 test(platform+': unknown submission keeps the exact request and never mistakes the first old order for the new order',async()=>{
  const {page,storage}=await fixture(platform);const attempt={idempotencyKey:'purchase-key-one',payload:{purchaseKind:'admission_package',activityPackagePublicId:'pkg-five'},previousRegistrationPublicId:'old'}
  storage.set(attemptsKey,{activity:attempt});assert.equal(await page.recoverRegistration('activity',attempt),false)
  assert.equal(storage.get(attemptsKey).activity.idempotencyKey,'purchase-key-one')
  page.choosePackage(event({packageId:'pkg-five'}));assert.equal(storage.get(attemptsKey).activity.idempotencyKey,'purchase-key-one')
 })
 test(platform+': exact replay recovers the matching new order even when older orders appear first',async()=>{
  const fresh={...confirmed,publicId:'new',registrationRequestIdempotencyKey:'purchase-key-two'}
  const {page,storage}=await fixture(platform,{getActivityRegistrations:async()=>[confirmed,fresh]})
  const attempt={idempotencyKey:'purchase-key-two',payload:{purchaseKind:'admission_package'},previousRegistrationPublicId:'old'};storage.set(attemptsKey,{activity:attempt})
  assert.equal(await page.recoverRegistration('activity',attempt),true);assert.equal(page.data.registration.publicId,'new');assert.equal(page.data.serviceCode.service.registrationPublicId,'new');assert.equal(storage.get(attemptsKey).activity,undefined)
 })
 test(platform+': a new purchase passes explicit kind, unchanged participant limit and a separate request key',async()=>{
  const writes=[];const {page,storage}=await fixture(platform,{registerActivity:async(...args)=>{writes.push(args);return {...confirmed,publicId:'new'}}})
  await page.beginPurchase(event({kind:'admission_package'}));page.data.contact='13800000000';page.data.ruleAcknowledged=true;page.choosePayment=async()=>({choice:'full',method:platform==='miniprogram'?'jsapi':'alipay_jsapi'})
  await page.register();assert.equal(writes.length,1);assert.equal(writes[0][10].purchaseKind,'admission_package');assert.equal(writes[0][10].parentRegistrationPublicId,null);assert.equal(writes[0][2],1)
  assert.equal(page.data.registration.publicId,'new');assert.equal(page.data.registrations.length,2);assert.equal(storage.get(attemptsKey).activity,undefined)
 })
 test(platform+': single dishes keep the parent identity and quantity price while meal add-ons use the distinct meal price',async()=>{
  const {page}=await fixture(platform,{getActivityAddonProducts:async()=>[{id:'dish',name:'小食',priceAmountMinor:1200}]})
  await page.loadServiceCode();await page.beginPurchase(event({kind:'single_dish'}));page.changeAddonQuantity(event({delta:1}))
  assert.equal(page.data.parentRegistrationPublicId,'old');assert.equal(page.data.addonQuantity,2);assert.equal(page.data.selectedPricing.feeAmountMinor,2400)
  page.stopCreatingPurchase();await page.beginPurchase(event({kind:'meal_package'}));assert.equal(page.data.parentRegistrationPublicId,'old');assert.equal(page.data.selectedPricing.feeAmountMinor,3000)
 })
 test(platform+': a pure admission ticket can buy its first dish without assigning a number or starting production',async()=>{
  const {page}=await fixture(platform,{getActivityRegistrationServiceCode:async id=>({...code(id),service:{...code(id).service,hasMeal:false}}),getActivityAddonProducts:async()=>[{id:'dish',name:'小食',priceAmountMinor:1200}]})
  await page.loadServiceCode();await page.beginPurchase(event({kind:'single_dish'}))
  assert.equal(page.data.creatingPurchase,true);assert.equal(page.data.parentRegistrationPublicId,'old');assert.equal(page.data.serviceCode.service.meal,null)
  const template=await readFile(new URL('../'+platform+'/pages/community-detail/index.'+(platform==='miniprogram'?'wxml':'axml'),import.meta.url),'utf8')
  assert.match(template,/首次加菜付款后，请到服务点出示原活动票核销码/);assert.match(template,/付款不会提前发号或制作/)
 })
 test(platform+': a paid single dish reads only delivery information without a redeemable QR',async()=>{
  const {page,helpers:h}=await fixture(platform,{getActivityRegistrationServiceCode:async id=>({service:{...code(id).service,purchaseKind:'single_dish',includesAdmission:false,meal:{number:9}}})})
  page.data.registration=h.viewRegistration({...confirmed,publicId:'child',purchaseKind:'single_dish',parentRegistrationPublicId:'other-buyer'})
  await page.loadServiceCode();assert.equal(page.data.serviceCode.service.meal.number,9);assert.equal(page.data.serviceError,'');assert.equal(page.data.ownParentRegistrationPublicId,'');assert.equal(page.data.serviceCode.code,undefined)
 })
 test(platform+': a scanned parent authorizes delivery association without persisting its credential or granting owner access',async()=>{
  const credential='MBOX_ACTIVITY_V3:foreign-parent:00000000-0000-0000-0000-000000000001',writes=[]
  const {page,runtime,storage}=await fixture(platform,{resolveActivityParent:async(activity,code)=>{assert.equal(activity,'activity');assert.equal(code,credential);return {registrationPublicId:'foreign-parent',activityPublicId:activity,packageName:'同行人套餐',number:12,plaqueState:'issued'}},getActivityAddonProducts:async()=>[{id:'dish',name:'小食',priceAmountMinor:1200}],registerActivity:async(...args)=>{writes.push(args);throw Error('lost receipt')}})
  runtime.scanCode=o=>o.success({result:credential})
  await page.scanParentForAddon();assert.equal(page.data.parentRegistrationPublicId,'foreign-parent');assert.equal(page.data.registration.publicId,'old');assert.equal(page.data.parentPreview.number,12)
  page.data.contact='13800000000';page.data.ruleAcknowledged=true;page.choosePayment=async()=>({choice:'full',method:platform==='miniprogram'?'jsapi':'alipay_jsapi'})
  await page.register();assert.equal(writes.length,1);assert.equal(writes[0][10].parentCredential,credential);assert.equal(writes[0][10].parentRegistrationPublicId,'foreign-parent')
  const originalKey=writes[0][9];assert.equal(storage.get(attemptsKey).activity.payload.parentCredentialRequired,true);assert.equal(JSON.stringify([...storage.values()]).includes(credential),false)
  page.parentPurchaseCredential=null;await page.register();assert.equal(writes.length,1);assert.match(page.data.error,/重新扫描/)
  await page.scanParentForAddon();await page.register();assert.equal(writes.length,2);assert.equal(writes[1][9],originalKey)
 })
 test(platform+': mismatched activity or parent cannot replace an unknown foreign-parent purchase',async()=>{
  const credential='MBOX_ACTIVITY_V3:foreign-parent:00000000-0000-0000-0000-000000000001'
  let resolvedActivity='another-activity';const {page,runtime,storage}=await fixture(platform,{resolveActivityParent:async()=>({registrationPublicId:'foreign-parent',activityPublicId:resolvedActivity})})
  runtime.scanCode=o=>o.success({result:credential});await page.scanParentForAddon();assert.equal(page.data.creatingPurchase,false);assert.match(page.data.error,/不是本场/)
  storage.set(attemptsKey,{activity:{idempotencyKey:'original-key',payload:{purchaseKind:'single_dish',parentCredentialRequired:true,parentRegistrationPublicId:'original-parent',productId:'dish'}}})
  resolvedActivity='activity';await page.scanParentForAddon();assert.match(page.data.error,/同一张/);assert.equal(storage.get(attemptsKey).activity.idempotencyKey,'original-key');assert.equal(page.parentPurchaseCredential,undefined)
 })
 test(platform+': returning from the native camera keeps the active scan while unloading cancels it',async()=>{
  const credential='MBOX_ACTIVITY_V3:foreign-parent:00000000-0000-0000-0000-000000000001';let finish
  const {page,runtime}=await fixture(platform,{resolveActivityParent:async()=>({registrationPublicId:'foreign-parent',activityPublicId:'activity',number:null}),getActivityAddonProducts:async()=>[]})
  runtime.scanCode=o=>{finish=o};const pending=page.scanParentForAddon();page.onHide();page.onShow();finish.success({result:credential});await pending
  assert.equal(page.data.creatingPurchase,true);assert.equal(page.parentPurchaseCredential,credential)
  page.stopCreatingPurchase();const discarded=page.scanParentForAddon();page.onUnload();page.pageVisible=true;finish.success({result:credential});await discarded;assert.equal(page.parentPurchaseCredential,null);assert.equal(page.data.creatingPurchase,false)
 })
 test(platform+': a delayed parent scan cannot apply after the page is hidden and membership QR is refused locally',async()=>{
  let finish,resolves=0;const {page,runtime}=await fixture(platform,{resolveActivityParent:async()=>{resolves++}})
  runtime.scanCode=o=>{finish=o};const pending=page.scanParentForAddon();page.onHide();finish.success({result:'MBOX_ACTIVITY_V3:foreign-parent:00000000-0000-0000-0000-000000000001'});await pending;assert.equal(resolves,0);assert.equal(page.parentPurchaseCredential,null)
  page.pageVisible=true;page.data.membership={};runtime.scanCode=o=>o.success({result:'MBOX_MEMBER:123'});await page.scanParentForAddon();assert.equal(resolves,0);assert.match(page.data.error,/会员码/)
 })
 test(platform+': compensation preserves original fulfillment access without offering repayment or treating the old order as a new admission',async()=>{
  const {page,helpers:h}=await fixture(platform)
  for(const disposition of ['retain_fulfillment','stop_unstarted']){
   page.data.registration=h.viewRegistration({...confirmed,serviceRefundDisposition:disposition,paymentStatus:'refunded',resolutionState:'refunded',refundStatus:'succeeded',allowedActions:['start_payment','cancel_registration']})
   assert.equal(page.data.registration.canUseService,true);assert.equal(page.data.registration.canAddPurchase,true);assert.equal(page.data.registration.canAttemptFullRefund,false);assert.equal(page.data.registration.canStartPayment,false);assert.equal(page.data.registration.canCancelDirectly,false);assert.equal(page.data.registration.canReRegister,false)
   await page.loadServiceCode();assert.equal(page.data.serviceCode.service.registrationPublicId,'old');assert.match(page.data.registration.stateGuide,/补偿退款/)
  }
 })
 test(platform+': attendee count may change after first arrivals but before meal redemption and cannot fall below admitted count',async()=>{
  const writes=[];const {page}=await fixture(platform,{getActivityRegistrationServiceCode:async id=>({...code(id),service:{...code(id).service,maxParticipants:5,admittedCount:2}}),updateActivityRegistrationPartySize:async(id,size,key)=>{writes.push({id,size,key});return {partySize:size}}})
  await page.loadServiceCode();page.data.registeredPartySizeDraft='1';await page.saveRegisteredPartySize();assert.equal(writes.length,0);assert.match(page.data.error,/不能少于已入场/)
  page.data.registeredPartySizeDraft='4';await page.saveRegisteredPartySize();assert.equal(writes.length,1);assert.equal(writes[0].size,4)
  page.data.serviceCode.service.meal={number:1};page.data.registeredPartySizeDraft='5';await page.saveRegisteredPartySize();assert.equal(writes.length,1)
 })
 test(platform+': refunded cancelled records can re-register only after complete refund, not while refunding',async()=>{
  const {helpers:h}=await fixture(platform)
  assert.equal(h.viewRegistration({...confirmed,status:'cancelled',resolutionState:'refunded',refundStatus:'succeeded'}).canReRegister,true)
  assert.equal(h.viewRegistration({...confirmed,status:'cancelled',resolutionState:'refunding',refundStatus:'processing'}).canReRegister,false)
  assert.equal(h.viewRegistration({...confirmed,resolutionState:'refunding'}).canAddPurchase,false)
 })
 test(platform+': QR refresh rejects a response for another order and clears refunded or unpaid codes',async()=>{
  let mismatch=true;const {page,helpers:h}=await fixture(platform,{getActivityRegistrationServiceCode:async id=>code(mismatch?'different':id)})
  await page.loadServiceCode();assert.equal(page.data.serviceCode,null);assert.ok(page.data.serviceError)
  mismatch=false;await page.loadServiceCode();assert.equal(page.data.serviceCode.service.registrationPublicId,'old')
  page.data.registration=h.viewRegistration({...confirmed,status:'refunded',resolutionState:'refunded'});await page.loadServiceCode();assert.equal(page.data.serviceCode,null)
 })
 test(platform+': a delayed QR response cannot return after the page is hidden',async()=>{
  let release;const {page}=await fixture(platform,{getActivityRegistrationServiceCode:()=>new Promise(r=>{release=r})})
  const pending=page.loadServiceCode();page.onHide();release(code('old'));await pending;assert.equal(page.data.serviceCode,null)
 })
 test(platform+': a history load selects the requested exact order and keeps every same-activity registration',async()=>{
  const {page}=await fixture(platform,{getActivityRegistrations:async()=>[confirmed,{...confirmed,publicId:'second'}]})
  page.onLoad({id:'activity',registrationId:'second'});await page.load();assert.equal(page.data.registration.publicId,'second');assert.equal(page.data.registrations.length,2)
 })
 test(platform+': expired admissions can still offer add-ons only until the separate add-on deadline',async()=>{
  const {helpers:h}=await fixture(platform)
  const active=h.viewActivity({...rawActivity,registrationClosedAt:'2020-01-01T00:00:00Z',addonEndsAt:'2099-01-01T00:00:00Z'});assert.equal(active.registrationBlocked,true);assert.equal(active.addonBlocked,false)
  assert.equal(h.viewActivity({...rawActivity,addonEndsAt:'2020-01-01T00:00:00Z'}).addonBlocked,true)
 })
 test(platform+': a lost new-purchase response retries the same payload and key, without another old-order recovery',async()=>{
  const writes=[];const {page,storage}=await fixture(platform,{registerActivity:async(...args)=>{writes.push(args);throw Error('网络断开')}})
  await page.beginPurchase(event({kind:'admission_package'}));page.data.contact='13800000000';page.data.ruleAcknowledged=true;page.choosePayment=async()=>({choice:'full',method:platform==='miniprogram'?'jsapi':'alipay_jsapi'})
  await page.register();const key=storage.get(attemptsKey).activity.idempotencyKey;await page.register()
  assert.equal(writes.length,2);assert.equal(writes[0][9],key);assert.equal(writes[1][9],key);assert.equal(page.data.registration.publicId,'old');assert.equal(page.data.creatingPurchase,true)
  assert.equal(storage.get(attemptsKey).activity.payload.contactSnapshot,undefined)
 })
 test(platform+': attendance modification validates the package bound and preserves a failed request until exact retry',async()=>{
  let quantity=2,fail=true;const writes=[]
  const {page}=await fixture(platform,{getActivityRegistrationServiceCode:async id=>{const r=code(id);r.service.partySize=quantity;r.service.maxParticipants=5;return r},updateActivityRegistrationPartySize:async(...args)=>{writes.push(args);if(fail)throw Error('网络断开');quantity=args[1];return {partySize:quantity}}})
  await page.loadServiceCode();page.data.registeredPartySizeDraft='6';await page.saveRegisteredPartySize();assert.equal(writes.length,0)
  page.data.registeredPartySizeDraft='4';await page.saveRegisteredPartySize();page.data.registeredPartySizeDraft='3';await page.saveRegisteredPartySize();assert.equal(writes.length,1)
  page.data.registeredPartySizeDraft='4';fail=false;await page.saveRegisteredPartySize();assert.equal(writes.length,2);assert.equal(writes[0][2],writes[1][2]);assert.equal(page.data.registration.partySize,4)
 })
 test(platform+': successful refund submission is requested rather than paid out, and removes the shown QR',async()=>{
  const writes=[];let state=refundState();const {page}=await fixture(platform,{getActivityRegistrationPayment:async()=>state,requestActivityRegistrationRefund:async(...args)=>{writes.push(args);state=refundState('requested','refund-one');return {refundPublicId:'refund-one',status:'requested',amountMinor:5000}}})
  await page.loadServiceCode();await page.requestRegistrationRefund()
  assert.equal(writes.length,1);assert.equal(writes[0][0],'old');assert.equal(page.data.registration.refundStatus,'requested');assert.equal(page.data.registration.canAddPurchase,false);assert.equal(page.data.serviceCode,null);assert.match(page.data.success,/尚未退款到账/)
 })
 test(platform+': lost refund receipt reuses the same request key and a cancelled confirmation does not submit',async()=>{
  let fail=true,state=refundState();const writes=[];const {page,runtime}=await fixture(platform,{getActivityRegistrationPayment:async()=>state,requestActivityRegistrationRefund:async(...args)=>{writes.push(args);if(fail)throw Error('网络断开');state=refundState('requested','refund-one');return {refundPublicId:'refund-one',status:'requested'}}})
  runtime.showModal=o=>o.success({confirm:false});await page.requestRegistrationRefund();assert.equal(writes.length,0)
  runtime.showModal=o=>o.success({confirm:true});await page.requestRegistrationRefund();fail=false;await page.requestRegistrationRefund()
  assert.equal(writes.length,2);assert.equal(writes[0][2],writes[1][2]);assert.equal(page.data.registration.refundStatus,'requested')
 })
 test(platform+': restoring an unknown add-on reselects its real parent instead of the newest other order',async()=>{
  const {page,storage}=await fixture(platform,{getActivityRegistrations:async()=>[{...confirmed,publicId:'other'},confirmed]})
  storage.set(attemptsKey,{activity:{idempotencyKey:'unknown-addon-key',payload:{purchaseKind:'meal_package',activityPackagePublicId:'pkg-five',parentRegistrationPublicId:'old',partySize:2}}})
  await page.load();assert.equal(page.data.registration.publicId,'old');assert.equal(page.data.parentRegistrationPublicId,'old');assert.equal(page.data.creatingPurchase,true)
 })
 test(platform+': fixed choices are required before payment and exact choices plus note survive an unknown submit',async()=>{
  const writes=[];const {page,helpers:h,storage}=await fixture(platform,{registerActivity:async(...args)=>{writes.push(args);throw Error('网络断开')}})
  page.data.activity=h.viewActivity({...rawActivity,packages:[{...rawPackage,choiceGroups:[{id:'drink',name:'饮品',quantity:2,options:[{productId:'juice',name:'果汁'},{productId:'tea',name:'茶'}]}]}]})
  await page.beginPurchase(event({kind:'admission_package'}));page.data.contact='13800000000';page.data.ruleAcknowledged=true;page.choosePayment=async()=>({choice:'full',method:platform==='miniprogram'?'jsapi':'alipay_jsapi'})
  await page.register();assert.equal(writes.length,0);assert.match(page.data.error,/请选择|请先选择饮品/)
  page.choosePackageOption(event({groupId:'drink',productId:'juice'}));page.onPackageNoteInput({detail:{value:'必要制作提醒'}});await page.register()
  const stored=storage.get(attemptsKey).activity;assert.deepEqual(JSON.parse(JSON.stringify(stored.payload.selections)),[{groupId:'drink',productId:'juice'}]);assert.equal(stored.payload.note,'必要制作提醒')
  page.choosePackageOption(event({groupId:'drink',productId:'tea'}));page.onPackageNoteInput({detail:{value:'不能替换原内容'}});await page.register()
  assert.equal(writes.length,2);assert.equal(writes[0][9],writes[1][9]);assert.equal(writes[1][10].selections[0].productId,'juice');assert.equal(writes[1][10].note,'必要制作提醒')
 })
 test(platform+': purchased selection summary uses the immutable registration names and quantities',async()=>{
  const {helpers:h}=await fixture(platform)
  const item=h.viewRegistration({...confirmed,selections:[{label:'饮品',productId:'juice',name:'购买时果汁',quantity:2}],note:'购买时备注'})
  assert.deepEqual(Array.from(item.selectionSummary),['饮品：购买时果汁 × 2']);assert.equal(item.note,'购买时备注')
 })
 test(platform+': participant and package selection cannot change during the payment consent continuation',async()=>{
  let finish;const {page}=await fixture(platform);await page.beginPurchase(event({kind:'admission_package'}));page.data.contact='13800000000';page.data.ruleAcknowledged=true
  page.offerActivityRegistrationNotifications=()=>new Promise(r=>{finish=r});page.choosePayment=async()=>null
  const pending=page.register();page.changePartySize(event({delta:1}));page.clearPackageSelection();assert.equal(page.data.partySize,1);assert.equal(page.data.selectedPackagePublicId,'pkg-five');finish();await pending
 })
 test(platform+': business API sends exact selections and note with the original purchase key',async()=>{
  const source=await readFile(new URL('../'+platform+'/utils/api.js',import.meta.url),'utf8'),start=source.indexOf('async function registerActivity('),end=source.indexOf('async function updateActivityRegistrationPartySize',start),requests=[]
  const submit=vm.runInNewContext('('+source.slice(start,end).trim()+')',{publicRequest:async(path,options)=>{requests.push({path,options});return {data:{publicId:'exact'}}},randomId:()=>{throw Error('must retain key')}})
  const purchase={purchaseKind:'meal_package',parentRegistrationPublicId:'original',parentCredential:'transient-authority',selections:[{groupId:'drink',productId:'juice'}],note:'少冰'}
  await submit('activity','pkg-five',2,{contact:'13800000000'},true,'s1','r1','full','jsapi','stable-key',purchase)
  assert.equal(requests[0].path,'/api/public/mini/activities/activity/registrations');assert.equal(requests[0].options.headers['idempotency-key'],'stable-key')
  assert.equal(requests[0].options.data.parentCredential,'transient-authority');assert.equal(requests[0].options.data.note,'少冰');assert.equal(requests[0].options.data.selections[0].productId,'juice');assert.equal(requests[0].options.data.parentRegistrationPublicId,'original')
 })
 test(platform+': package QR binds its real image URL and never exposes a single-dish redemption code',async()=>{
  const {page}=await fixture(platform);await page.loadServiceCode()
  const template=await readFile(new URL('../'+platform+'/pages/community-detail/index.'+(platform==='miniprogram'?'wxml':'axml'),import.meta.url),'utf8')
  const tag=template.match(/<image\b[^>]*class="activity-service-qr"[^>]*>/)[0]
  const expression=tag.match(/src="{{([^}]+)}}"/)[1]
  assert.equal(vm.runInNewContext(expression,page.data),code('old').qrDataUrl)
  const condition=tag.match(/(?:wx|a):if="{{([^}]+)}}"/)[1]
  assert.equal(vm.runInNewContext(condition,{...page.data,registration:{purchaseKind:'single_dish'}}),false)
 })
 test(platform+': a meal-only package uses its configured full price and is selectable without a secondary meal-only price',async()=>{
  const writes=[];const {page,helpers:h}=await fixture(platform,{registerActivity:async(...args)=>{writes.push(args);return {...confirmed,publicId:'meal-new',purchaseKind:'meal_package'}}})
  const meal={...rawPackage,publicId:'meal-only',includesAdmission:false,mealOnlyFeeAmountMinor:null,feeAmountMinor:2500}
  page.data.activity=h.viewActivity({...rawActivity,packages:[meal]})
  await page.beginPurchase(event({kind:'meal_package'}));assert.equal(page.data.selectedPackagePublicId,'meal-only');assert.equal(page.data.selectedPricing.feeAmountMinor,2500)
  assert.equal(page.data.selectedPackage.mealOnlyFeeText,'¥25.00/份')
  page.data.selectedPackagePublicId='';page.choosePackage(event({packageId:'meal-only'}));assert.equal(page.data.selectedPackagePublicId,'meal-only')
  const template=await readFile(new URL('../'+platform+'/pages/community-detail/index.'+(platform==='miniprogram'?'wxml':'axml'),import.meta.url),'utf8')
  const condition=template.match(/(?:wx|a):if="{{(purchaseKind === 'meal_package'[^}]+)}}"/)[1]
  assert.equal(vm.runInNewContext(condition,{purchaseKind:'meal_package',item:page.data.selectedPackage}),true)
  page.data.contact='13800000000';page.data.ruleAcknowledged=true;page.choosePayment=async()=>({choice:'full',method:platform==='miniprogram'?'jsapi':'alipay_jsapi'})
  await page.register();assert.equal(writes.length,1);assert.equal(writes[0][1],'meal-only');assert.equal(writes[0][10].purchaseKind,'meal_package');assert.equal(writes[0][10].parentRegistrationPublicId,'old');assert.equal(page.data.registration.publicId,'meal-new')
 })
 test(platform+': visible but unavailable dishes stay visible without a free price, and selection defaults to the first sellable item',async()=>{
  const rows=[{id:'later',name:'稍后供应',sellable:false,statusText:'当前未开售或已结束',priceAmountMinor:null,purchaseDeadline:null},{id:'available',name:'正在供应',sellable:true,priceAmountMinor:1800}]
  const {page}=await fixture(platform,{getActivityAddonProducts:async()=>rows})
  await page.loadServiceCode();await page.beginPurchase(event({kind:'single_dish'}))
  assert.equal(page.data.addonProducts.length,2);assert.equal(page.data.addonProducts[0].priceText,'');assert.match(page.data.addonProducts[0].statusText,/未开售/);assert.equal(page.data.selectedAddonProduct.id,'available')
  page.chooseAddonProduct(event({productId:'later'}));assert.equal(page.data.selectedAddonProduct.id,'available')
  rows.pop();await page.loadAddonProducts();assert.equal(page.data.selectedAddonProduct,null);assert.equal(page.data.selectedPricing.paymentAvailability,'blocked');assert.notEqual(page.data.selectedPricing.feeText,'¥0.00')
  await page.register();assert.match(page.data.error,/当前可售/)
  const template=await readFile(new URL('../'+platform+'/pages/community-detail/index.'+(platform==='miniprogram'?'wxml':'axml'),import.meta.url),'utf8')
  const button=template.match(/<button\b[^>]*(?:bindtap|onTap)="chooseAddonProduct"[^>]*>/)[0]
  const disabled=button.match(/disabled="{{([^}]+)}}"/)[1]
  assert.equal(vm.runInNewContext(disabled,{busy:false,item:page.data.addonProducts[0]}),true)
 })
 for(const terminal of ['rejected','cancelled'])test(platform+': an acknowledged '+terminal+' refund starts a new request only after fresh matching server status',async()=>{
  let state=refundState(terminal,'refund-old');const writes=[]
  const {page,storage}=await fixture(platform,{getActivityRegistrationPayment:async()=>state,requestActivityRegistrationRefund:async(...args)=>{writes.push(args);state=refundState('requested','refund-new');return {refundPublicId:'refund-new',status:'requested'}}})
  storage.set(refundsKey,{old:{idempotencyKey:'old-refund-key',refundPublicId:'refund-old',reason:'原申请'}})
  await page.requestRegistrationRefund();assert.equal(writes.length,1);assert.notEqual(writes[0][2],'old-refund-key');assert.equal(storage.get(refundsKey).old.refundPublicId,'refund-new');assert.equal(page.data.registration.refundStatus,'requested')
 })
 test(platform+': an old rejected refund cannot replace the unknown newer refund key',async()=>{
  let state=refundState('rejected','older-refund');const writes=[]
  const {page,storage}=await fixture(platform,{getActivityRegistrationPayment:async()=>state,requestActivityRegistrationRefund:async(...args)=>{writes.push(args);state=refundState('requested','current-refund');return {refundPublicId:'current-refund',status:'requested'}}})
  storage.set(refundsKey,{old:{idempotencyKey:'unknown-current-key',reason:'原申请'}})
  await page.requestRegistrationRefund();assert.equal(writes[0][2],'unknown-current-key');assert.equal(storage.get(refundsKey).old.refundPublicId,'current-refund')
 })
 test(platform+': replaying a lost refund receipt shows its current rejection before a subsequent explicit request',async()=>{
  let state=refundState('rejected','refund-lost');const writes=[]
  const {page,storage}=await fixture(platform,{getActivityRegistrationPayment:async()=>state,requestActivityRegistrationRefund:async(...args)=>{writes.push(args);if(args[2]==='lost-key')return {refundPublicId:'refund-lost',status:'requested'};state=refundState('requested','refund-new');return {refundPublicId:'refund-new',status:'requested'}}})
  storage.set(refundsKey,{old:{idempotencyKey:'lost-key',reason:'原申请'}})
  await page.requestRegistrationRefund();assert.equal(writes[0][2],'lost-key');assert.equal(page.data.registration.refundStatus,'rejected');assert.match(page.data.success,/原申请已被拒绝/)
  await page.requestRegistrationRefund();assert.notEqual(writes[1][2],'lost-key');assert.equal(page.data.registration.refundStatus,'requested')
 })
 test(platform+': stale local rejection cannot replace an authoritative pending refund and a failed read cannot rotate the key',async()=>{
  let fail=false;const writes=[];const {page,storage,helpers:h}=await fixture(platform,{getActivityRegistrationPayment:async()=>{if(fail)throw Error('读取失败');return refundState('approved','refund-old')},requestActivityRegistrationRefund:async(...args)=>{writes.push(args)}})
  storage.set(refundsKey,{old:{idempotencyKey:'original-refund-key',refundPublicId:'refund-old',reason:'原申请'}})
  page.data.registration=h.viewRegistration({...confirmed,...refundState('rejected','refund-old')});await page.requestRegistrationRefund();assert.equal(writes.length,0);assert.equal(page.data.registration.refundStatus,'approved')
  fail=true;page.data.registration=h.viewRegistration(confirmed);await page.requestRegistrationRefund();assert.equal(writes.length,0);assert.equal(storage.get(refundsKey).old.idempotencyKey,'original-refund-key');assert.match(page.data.error,/读取失败/)
 })
 test(platform+': a visible activity add-on menu refreshes every minute and preserves selection, quantity and an unknown original intent',async()=>{
  let sellable=true;const {page,storage,timers}=await fixture(platform,{getActivityAddonProducts:async()=>[{id:'dish',name:'原菜',sellable,priceAmountMinor:sellable?1200:null,statusText:sellable?'':'当前未开售或已结束'},{id:'other',name:'其他菜',sellable:true,priceAmountMinor:1000}]})
  await page.loadServiceCode();await page.beginPurchase(event({kind:'single_dish'}));page.changeAddonQuantity(event({delta:1}))
  const original={idempotencyKey:'unknown-dish-key',payload:{purchaseKind:'single_dish',productId:'dish',quantity:2,parentRegistrationPublicId:'old'}};storage.set(attemptsKey,{activity:original})
  const first=page.addonMenuTimer,firstCallback=timers.get(first).callback;assert.equal(timers.get(first).delay,60000);sellable=false;timers.delete(first);await firstCallback()
  assert.equal(page.data.selectedAddonProduct.id,'dish');assert.equal(page.data.selectedAddonProduct.sellable,false);assert.equal(page.data.addonQuantity,2);assert.equal(page.data.selectedPricing.paymentAvailability,'blocked');assert.equal(storage.get(attemptsKey).activity.idempotencyKey,'unknown-dish-key')
  const next=page.addonMenuTimer,callback=timers.get(next).callback;timers.delete(next);sellable=true;await callback();assert.equal(page.data.selectedAddonProduct.id,'dish');assert.equal(page.data.selectedAddonProduct.sellable,true);assert.equal(page.data.addonQuantity,2);assert.ok(page.addonMenuTimer)
  page.onHide();assert.equal(page.addonMenuTimer,null);assert.equal(timers.size,0)
 })
 test(platform+': a disappeared selected dish is never replaced automatically and late menu reads cannot restart a hidden page timer',async()=>{
  let rows=[{id:'dish',name:'原菜',priceAmountMinor:1200},{id:'other',name:'其他菜',priceAmountMinor:1000}],release,deferred=false
  const {page,timers}=await fixture(platform,{getActivityAddonProducts:async()=>deferred?new Promise(resolve=>{release=resolve}):rows})
  await page.loadServiceCode();await page.beginPurchase(event({kind:'single_dish'}));rows=rows.slice(1);await page.loadAddonProducts(page.data.selectedAddonProductId)
  assert.equal(page.data.selectedAddonProduct,null);assert.equal(page.data.selectedAddonProductId,'dish')
  const timer=page.addonMenuTimer,callback=timers.get(timer).callback;timers.delete(timer);await callback();assert.equal(page.data.selectedAddonProduct,null);assert.equal(page.data.selectedAddonProductId,'dish')
  deferred=true;const pending=page.loadAddonProducts('dish');page.onUnload();release([{id:'dish',name:'晚到菜',priceAmountMinor:1200}]);await pending
  assert.equal(page.data.selectedAddonProduct,null);assert.equal(page.addonMenuTimer,null);assert.equal(timers.size,0)
 })
 test(platform+': switching away during a refund confirmation cannot submit later',async()=>{
  let confirm,writes=0;const {page,runtime}=await fixture(platform,{requestActivityRegistrationRefund:async()=>{writes++},registerActivity:async()=>{writes++}})
  runtime.showModal=o=>{confirm=o};const pending=page.requestRegistrationRefund();page.onHide();confirm.success({confirm:true});await pending;assert.equal(writes,0)
 })

}

test('Alipay activity package recovery remains compatible with the official Babel 6 compiler',async()=>{
 const source=await readFile(new URL('../alipay-miniprogram/pages/community-detail/index.js',import.meta.url),'utf8')
 assert.doesNotMatch(source,/chosenPackage\?\./)
})

for(const platform of ['miniprogram','alipay-miniprogram']){
 test(platform+': eligible refund has a single application path and missing authority stays unknown after repeated mapping',async()=>{
  const {helpers:h}=await fixture(platform)
  const eligible=h.viewRegistration({...confirmed,canRequestFullRefund:true,refundRequestBlockReason:null})
  assert.equal(eligible.showFullRefundRequest,true);assert.equal(eligible.showRefundContact,false);assert.match(eligible.refundGuidance,/等待门店审核/)
  const missing=h.viewRegistration({...confirmed,canRequestFullRefund:undefined})
  const repeated=h.viewRegistration(missing)
  assert.equal(repeated.showFullRefundRequest,false);assert.equal(repeated.canRequestFullRefund,undefined);assert.match(repeated.refundGuidance,/资格暂未确认/)
  const nested=h.viewRegistration({...confirmed,canRequestFullRefund:undefined,payment:{canRequestFullRefund:true}})
  assert.equal(nested.showFullRefundRequest,false)
  const template=await readFile(new URL('../'+platform+'/pages/community-detail/index.'+(platform==='miniprogram'?'wxml':'axml'),import.meta.url),'utf8')
  assert.match(template,/registration\.showFullRefundRequest/);assert.match(template,/registration\.showRefundContact/);assert.match(template,/未通过原因：\{\{registration\.refundRejectionReason\}\}/)
  assert.doesNotMatch(template,/registration\.requiresManualCancellation/)
 })
 test(platform+': review and processing refund labels never claim funds have arrived',async()=>{
  const {helpers:h}=await fixture(platform)
  for(const status of ['requested','approved','processing']){
   const value=h.viewRegistration({...confirmed,...refundState(status,'refund'),canRequestFullRefund:false,refundRequestBlockReason:'refund_in_progress'})
   assert.equal(value.showFullRefundRequest,false);assert.equal(value.showRefundContact,false)
   assert.match(value.refundStatusText,status==='requested'?/等待门店审核/:status==='approved'?/退款已批准，待执行，尚未确认到账/:/退款处理中，尚未确认到账/)
   assert.doesNotMatch(value.refundStatusText,/已经到账|已完成/)
  }
  const failed=h.viewRegistration({...confirmed,...refundState('failed','refund'),canRequestFullRefund:false})
  assert.match(failed.refundStatusText,/尚未确认到账/);assert.doesNotMatch(failed.refundStatusText,/已经到账|已完成/)
 })
 test(platform+': used rights or dependent purchases guide the customer to arrange after-sales with the store',async()=>{
  const {helpers:h}=await fixture(platform)
  for(const reason of ['rights_used','active_addons','compensation_review_required']){
   const value=h.viewRegistration({...confirmed,canRequestFullRefund:false,refundRequestBlockReason:reason})
   assert.equal(value.showFullRefundRequest,false);assert.equal(value.showRefundContact,true);assert.match(value.refundGuidance,/联系门店核对已使用内容及退款安排/)
  }
  const legacy=h.viewRegistration({...confirmed,serviceVersion:2,maxParticipants:null,purchaseKind:null,activityPackage:null,canRequestFullRefund:false,refundRequestBlockReason:'legacy_registration'})
  assert.equal(legacy.showFullRefundRequest,false);assert.equal(legacy.showRefundContact,true);assert.match(legacy.refundGuidance,/旧版报名.*联系门店办理/)
 })
 test(platform+': full refund re-registration and retained compensation remain distinct',async()=>{
  const {helpers:h}=await fixture(platform)
  const full=h.viewRegistration({...confirmed,status:'refunded',resolutionState:'refunded',refundStatus:'succeeded',canRequestFullRefund:false})
  assert.equal(full.refundStatusText,'退款已完成');assert.equal(full.canReRegister,true);assert.match(full.refundGuidance,/仍需符合当前活动名额、时间和报名规则/)
  for(const serviceRefundDisposition of ['retain_fulfillment','stop_unstarted']){
   const partial=h.viewRegistration({...confirmed,resolutionState:'refunded',refundStatus:'succeeded',serviceRefundDisposition,canRequestFullRefund:false})
   assert.equal(partial.canReRegister,false);assert.equal(partial.showFullRefundRequest,false);assert.match(partial.refundStatusText,/补偿退款已完成/);assert.doesNotMatch(partial.refundGuidance,/重新报名/)
  }
 })
 test(platform+': latest rejected reason survives repeated mapping and reapplication still requires authoritative eligibility',async()=>{
  const {helpers:h}=await fixture(platform)
  for(const eligible of [true,false]){
   const first=h.viewRegistration({...confirmed,...refundState('rejected','refund'),refundRejectionReason:'本份有已确认的同行加餐',canRequestFullRefund:eligible,refundRequestBlockReason:eligible?null:'active_addons'})
   const again=h.viewRegistration(first)
   assert.equal(again.refundRejectionReason,'本份有已确认的同行加餐');assert.equal(again.canRequestFullRefund,eligible);assert.equal(again.showFullRefundRequest,eligible)
  }
 })
 test(platform+': fresh ineligible authority prevents a new refund but cannot replace an unknown original request',async()=>{
  const writes=[];let state={...refundState(),canRequestFullRefund:false,refundRequestBlockReason:'active_addons'}
  const {page,storage,helpers:h}=await fixture(platform,{getActivityRegistrationPayment:async()=>state,requestActivityRegistrationRefund:async(...args)=>{writes.push(args);return {refundPublicId:'original-receipt',status:'requested'}}})
  await page.requestRegistrationRefund();assert.equal(writes.length,0);assert.equal(storage.get(refundsKey),undefined);assert.equal(page.data.registration.showFullRefundRequest,false)
  storage.set(refundsKey,{old:{idempotencyKey:'original-unknown-key',reason:'原申请'}})
  state={...refundState('processing','original-receipt'),canRequestFullRefund:false,refundRequestBlockReason:'refund_in_progress'}
  page.data.registration=h.viewRegistration({...confirmed,...state})
  assert.equal(page.data.registration.hasUnconfirmedRefundAttempt,true);assert.match(page.data.registration.refundStatusText,/结果待核对/)
  await page.requestRegistrationRefund();assert.equal(writes.length,1);assert.equal(writes[0][2],'original-unknown-key');assert.equal(page.data.registration.refundStatus,'processing');assert.equal(page.data.registration.hasUnconfirmedRefundAttempt,false)
 })
 test(platform+': cancelled records still read authoritative refund status and missing read fields cannot reuse cached eligibility',async()=>{
  let reads=0,state={...refundState('succeeded','full-refund'),registrationStatus:'refunded',resolutionState:'refunded',canRequestFullRefund:false}
  const {page}=await fixture(platform,{getActivityRegistrationPayment:async()=>{reads++;return state}})
  const completed=await page.readPaymentState({...confirmed,status:'cancelled'})
  assert.equal(reads,1);assert.equal(completed.refundStatusText,'退款已完成');assert.equal(completed.canReRegister,true)
  state={registrationStatus:'confirmed',resolutionState:'confirmed',allowedActions:[],paidAmountMinor:5000}
  const missing=await page.readPaymentState({...confirmed,canRequestFullRefund:true})
  assert.equal(missing.showFullRefundRequest,false);assert.match(missing.refundGuidance,/资格暂未确认/)
 })
}

for(const platform of ['miniprogram','alipay-miniprogram'])test(platform+': initial load, order switch and payment query refresh the same authoritative refund display',async()=>{
 const reads=[]
 const raw=[{...confirmed,publicId:'first',status:'cancelled'},{...confirmed,publicId:'second'}]
 const {page}=await fixture(platform,{getActivityRegistrations:async()=>raw,getActivityRegistrationPayment:async id=>{
  reads.push(id);return id==='first'?{...refundState('succeeded','refund-first'),resolutionState:'refunded',canRequestFullRefund:false}:{...refundState('rejected','refund-second'),refundRejectionReason:'门店已核对，请补充退订原因',canRequestFullRefund:true}
 },queryActivityRegistrationPayment:async()=>({...refundState('approved','refund-second'),refundRejectionReason:null,canRequestFullRefund:false})})
 await page.load();assert.deepEqual(reads,['first']);assert.equal(page.data.registration.refundStatusText,'退款已完成')
 await page.selectRegistration(event({registrationId:'second'}));assert.deepEqual(reads,['first','second']);assert.equal(page.data.registration.refundRejectionReason,'门店已核对，请补充退订原因');assert.equal(page.data.registration.showFullRefundRequest,true)
 await page.performPaymentQuery();assert.match(page.data.registration.refundStatusText,/退款已批准，待执行，尚未确认到账/);assert.equal(page.data.registration.refundRejectionReason,'');assert.equal(page.data.registration.showFullRefundRequest,false)
})

for(const platform of ['miniprogram','alipay-miniprogram'])test(platform+': payment-only refresh changes a confirmed full refund to refunded but leaves compensation fulfillment active',async()=>{
 let state={registrationPublicId:'old',registrationStatus:'refunded',paymentPublicId:'payment',resolutionState:'refunded',paymentStatus:'refunded',amountDueMinor:0,paidAmountMinor:5000,currency:'CNY',expiresAt:null,allowedActions:[],refundStatus:'succeeded',refundPublicId:'refund-full',refundRejectionReason:null,canRequestFullRefund:false,refundRequestBlockReason:'payment_not_refundable',serviceRefundDisposition:null}
 const {page,helpers:h}=await fixture(platform,{getActivityRegistrationPayment:async()=>state})
 await page.refreshPaymentState(false)
 assert.equal(page.data.registration.status,'refunded');assert.equal(page.data.registration.canReRegister,true);assert.equal(page.data.registration.refundStatusText,'退款已完成')
 state={...state,registrationStatus:'confirmed',refundPublicId:'refund-compensation',serviceRefundDisposition:'retain_fulfillment',refundRequestBlockReason:'compensation_review_required'}
 page.data.registration=h.viewRegistration(confirmed)
 await page.refreshPaymentState(false)
 assert.equal(page.data.registration.status,'confirmed');assert.equal(page.data.registration.canReRegister,false);assert.equal(page.data.registration.canUseService,true);assert.equal(page.data.registration.refundStatusText,'补偿退款已完成')
})

for(const platform of ['miniprogram','alipay-miniprogram'])test(platform+': unknown newer refund never shows an older rejected reason as its own',async()=>{
 const {helpers:h,storage}=await fixture(platform)
 storage.set(refundsKey,{old:{idempotencyKey:'unknown-new-request',reason:'新申请'}})
 const value=h.viewRegistration({...confirmed,...refundState('rejected','old-refund'),refundRejectionReason:'上一笔未通过原因'})
 assert.equal(value.hasUnconfirmedRefundAttempt,true);assert.equal(value.refundRejectionReason,'');assert.match(value.refundStatusText,/原退订申请结果待核对/)
 assert.equal(storage.get(refundsKey).old.idempotencyKey,'unknown-new-request')
 storage.set(refundsKey,{old:{idempotencyKey:'unknown-new-request',refundPublicId:'exact-new-refund',reason:'新申请'}})
 const resolved=h.viewRegistration({...confirmed,...refundState('rejected','exact-new-refund'),refundRejectionReason:'已核对本次原因'})
 assert.equal(resolved.hasUnconfirmedRefundAttempt,false);assert.equal(resolved.refundRejectionReason,'已核对本次原因')
})
for(const platform of ['miniprogram','alipay-miniprogram'])test(platform+': add-on cutoff uses the earliest applicable boundary and preserves image and supply explanation',async()=>{
 const {page,helpers:h}=await fixture(platform,{getActivityAddonProducts:async()=>[{id:'dish',name:'小食',imageUrl:'/menu/snack.jpg',sellable:true,priceAmountMinor:1200,supplyDescription:'周五 18:00–次日02:00'}]})
 const activity=h.viewActivity({...rawActivity,remainingCapacity:0,addonEndsAt:'2099-01-01T00:00:00Z',mealServiceEndsAt:'2000-01-01T00:00:00Z'})
 assert.equal(activity.addonBlocked,true);assert.equal(activity.addonCutoffText,'2000-01-01T00:00:00.000Z')
 page.setData({creatingPurchase:true,purchaseKind:'single_dish',addonQuantity:2});await page.loadAddonProducts()
 assert.equal(page.data.selectedAddonProduct.imageUrl,'/menu/snack.jpg');assert.match(page.data.selectedAddonProduct.supplyDescription,/次日02:00/)
 const source=await readFile(new URL('../'+platform+'/pages/community-detail/index.'+(platform==='miniprogram'?'wxml':'axml'),import.meta.url),'utf8')
 assert.match(source,/purchaseKind !== 'admission_package' \? '本次仅加餐，不增加入场名额'/)
 assert.match(source,/activity-addon-image/)
})

for(const platform of ['miniprogram','alipay-miniprogram']) {
 test(platform+': a stopped add-on retains an explicit read-only original-result query and finds only its exact request',async()=>{
  let records=[{...confirmed,publicId:'different',registrationRequestIdempotencyKey:'other-key'}],writes=0,outcomes=0
  const {page,storage}=await fixture(platform,{getActivityAddonProducts:async()=>[{id:'dish',name:'已关窗菜',sellable:false,priceAmountMinor:null}],getActivityRegistrations:async()=>records,registerActivity:async()=>{writes++},startActivityRegistrationPayment:async()=>{writes++}})
  const original={idempotencyKey:'original-closed-dish-key',payload:{purchaseKind:'single_dish',productId:'dish',quantity:2,parentRegistrationPublicId:'old',partySize:1}}
  storage.set(attemptsKey,{activity:original});await page.restorePurchaseAttempt(original);page.showRegistrationOutcome=async()=>{outcomes++}
  assert.equal(page.data.pendingPurchaseRecovery,true);assert.equal(page.data.selectedAddonProduct.sellable,false)
  const template=await readFile(new URL('../'+platform+'/pages/community-detail/index.'+(platform==='miniprogram'?'wxml':'axml'),import.meta.url),'utf8')
  const button=template.match(/<button\b[^>]*(?:bindtap|onTap)="queryOriginalPurchase"[^>]*>/)[0]
  assert.equal(vm.runInNewContext(button.match(/disabled="{{([^}]+)}}"/)[1],page.data),false)
  await page.queryOriginalPurchase();assert.equal(storage.get(attemptsKey).activity,original);assert.match(page.data.error,/暂未查到原提交结果/);assert.equal(writes,0)
  records=[{...confirmed,publicId:'original-result',purchaseKind:'single_dish',registrationRequestIdempotencyKey:original.idempotencyKey}]
  await page.queryOriginalPurchase();assert.equal(page.data.registration.publicId,'original-result');assert.equal(page.data.pendingPurchaseRecovery,false);assert.equal(storage.get(attemptsKey).activity,undefined);assert.equal(writes,0);assert.equal(outcomes,0)
 })
 test(platform+': a failed or late original-result query keeps its old body and key without exposing another page result',async()=>{
  let release,fail=true
  const {page,storage}=await fixture(platform,{getActivityRegistrations:async()=>{if(fail)throw Error('offline');return new Promise(resolve=>{release=resolve})}})
  const original={idempotencyKey:'original-unknown-key',payload:{purchaseKind:'single_dish',productId:'dish',quantity:2,parentRegistrationPublicId:'old',partySize:1}}
  storage.set(attemptsKey,{activity:original});page.data.pendingPurchaseRecovery=true
  await page.queryOriginalPurchase();assert.equal(storage.get(attemptsKey).activity,original);assert.match(page.data.error,/原请求已保留/)
  fail=false;const pending=page.queryOriginalPurchase();page.onHide();release([{...confirmed,publicId:'old-late',registrationRequestIdempotencyKey:original.idempotencyKey}]);await pending
  assert.equal(storage.get(attemptsKey).activity,original);assert.notEqual(page.data.registration?.publicId,'old-late');assert.equal(page.data.busy,false)
 })
}
