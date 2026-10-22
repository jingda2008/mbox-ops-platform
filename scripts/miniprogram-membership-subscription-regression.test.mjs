import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const token = 'verified-wechat-token-'.repeat(3)
function authFixture({ loggedOut = false, cached = false, enabled = true, fail = false } = {}) {
  const storage = new Map(), calls = []
  if (loggedOut) storage.set('mbox.membership.loggedOut.v1', '1')
  if (cached) { storage.set('mbox.wechat.identity.accessToken.v1', token); storage.set('mbox.wechat.identity.expiresAt.v1', new Date(Date.now()+3600000).toISOString()) }
  const module = { exports: {} }
  vm.runInNewContext(read('miniprogram/utils/auth.js'), { module, wx: {
    getStorageSync: k => storage.get(k), setStorageSync: (k,v) => storage.set(k,v), removeStorageSync: k => storage.delete(k),
    login: ({ success, fail: reject }) => { calls.push('login'); fail ? reject({errMsg:'offline'}) : success({code:'fresh-code'}) },
  }, require: name => {
    if (name === '../config/index') return { getRuntimeConfig: () => ({ wechatIdentityEnabled: enabled, identityTenantId:'tenant', identityStoreId:'store', wechatAppId:'app' }) }
    if (name === './id') return { randomId: () => 'random-id' }
    if (name === './request') return { request: async path => { calls.push(path); return path.endsWith('challenges') ? {state:'state',nonce:'nonce'} : {accessToken:token,expiresAt:new Date(Date.now()+3600000).toISOString()} }, storeWechatIdentityToken: v => storage.set('mbox.wechat.identity.accessToken.v1',v), clearWechatIdentityToken: () => {}, clearReservationCookie: () => {} }
    throw Error(name)
  } })
  return { auth: module.exports, calls, storage }
}
test('member claim reuses a valid verified identity', async () => {
  const h=authFixture({cached:true}); assert.equal(await h.auth.obtainWechatIdentityForMembership(),token); assert.equal(h.calls.length,0)
})
test('logged-out member claim obtains a fresh identity without clearing logout before enrollment', async () => {
  const h=authFixture({loggedOut:true,cached:true}); assert.equal(await h.auth.obtainWechatIdentityForMembership(),token)
  assert.ok(h.calls.includes('login')); assert.ok(h.calls.includes('/api/wechat/code-authentication')); assert.equal(h.storage.get('mbox.membership.loggedOut.v1'),'1')
})
test('unavailable identity remains optional and does not fabricate a binding', async () => {
  const h=authFixture({fail:true}); assert.equal(await h.auth.obtainWechatIdentityForMembership(),null)
  const disabled=authFixture({enabled:false}); assert.equal(await disabled.auth.obtainWechatIdentityForMembership(),null); assert.equal(disabled.calls.length,0)
})
function apiFixture(identity = token) {
  const module={exports:{}}, storage=new Map(), requests=[]; let fail=true, clears=0
  vm.runInNewContext(read('miniprogram/utils/api.js'), { module, wx: {getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k)}, require:name=> {
    if(name==='./auth') return { obtainWechatIdentityForMembership:async()=>identity, ensureCustomerSession:async()=>{}, isCustomerSessionInvalid:()=>false, clearMembershipLoggedOut:()=>{clears++} }
    if(name==='./request') return { request:async(path,options)=> { requests.push({path,...options}); if(fail) throw Object.assign(Error('offline'),{code:'NETWORK_ERROR'}); return {data:{memberNo:'100001'}} } }
    if(name==='./id') return { randomId:()=> 'stable-attempt-id' }
    return {}
  } })
  return {api:module.exports, requests, storage, succeed:()=>{fail=false}, clears:()=>clears}
}
test('phone enrollment carries verified identity, preserves retry key, and only clears logout on success', async()=>{
  const h=apiFixture(); await assert.rejects(h.api.enrollMembership(1,'mini_profile','phone-code'))
  assert.equal(h.clears(),0); const key=h.requests[0].headers['idempotency-key']; h.succeed()
  assert.equal((await h.api.enrollMembership(1,'mini_profile','phone-code')).memberNo,'100001')
  assert.equal(h.requests[1].headers['x-mbox-wechat-identity'],token); assert.equal(h.requests[1].headers['idempotency-key'],key)
  assert.equal(h.requests[1].data.phoneAuthorizationProvider,'wechat'); assert.equal(h.clears(),1); assert.equal(h.storage.size,0)
})
test('optional identity failure sends no invented identity header', async()=>{
  const h=apiFixture(null);h.succeed();await h.api.enrollMembership(1,'mini_profile','phone-code');assert.equal(h.requests[0].headers['x-mbox-wechat-identity'],undefined)
})
const option = {apiKind:'loyalty',notificationType:'loyalty_points_expiring',policyId:'policy',policyVersion:2,templateId:'expiry',authorizationVersion:3,usesRemaining:0}
function subscriptionFixture(record, result='accept') {
  const module={exports:{}}, calls=[]
  vm.runInNewContext(read('miniprogram/utils/wechat-subscription.js'), {module, console:{error:()=>{}}, require:()=>({recordWechatNotificationAuthorization:record}), wx:{requestSubscribeMessage:args=>{calls.push(args.tmplIds);args.success({expiry:result});args.complete();}}})
  return {helper:module.exports,calls}
}
test('subscription completion waits for durable writeback, even after the platform complete callback', async()=>{
  const saving=deferred();let completed=false,count=0
  const h=subscriptionFixture(()=>{count++;return saving.promise})
  const pending=h.helper.requestWechatSubscription([option]).then(result=>{completed=true;return result})
  await tick();assert.equal(completed,false);assert.equal(count,1)
  saving.resolve({saved:true});const result=await pending;assert.equal(result.recordingResults[0].saved,true)
})
test('subscription save failure is reported distinctly from WeChat consent', async()=>{
  const h=subscriptionFixture(async()=>{throw Object.assign(Error('offline'),{code:'NETWORK_ERROR'})})
  const result=await h.helper.requestWechatSubscription([option]);assert.equal(result.outcomes[0].platformResult,'accept');assert.equal(result.recordingResults[0].writebackError.code,'NETWORK_ERROR')
})
test('subscription rejection is recorded, but banned templates are not prompted', async()=>{
  const recorded=[];const h=subscriptionFixture(async x=>recorded.push(x),'reject')
  await h.helper.requestWechatSubscription([option]);assert.equal(recorded[0].platformResult,'reject')
  const banned=await h.helper.requestWechatSubscription([{...option,platformResult:'ban'}]);assert.equal(banned.presented,false);assert.equal(h.calls.length,1)
})
function expiryPage(recordingResult, platformResult='accept') {
  const source=read('miniprogram/pages/profile/index.js'); const start=source.indexOf('  async enableExpiryReminder() {');const end=source.indexOf('  async recoverMembership(',start)
  const toast=[];const page=vm.runInNewContext('({' + source.slice(start,end) + '})',{wx:{requestSubscribeMessage:()=>{},showToast:x=>toast.push(x.title)},getWechatNotificationAuthorizations:async()=>({authorizations:[option]}),mergeWechatNotificationPromptOptions:x=>x,requestWechatSubscription:async()=>({outcomes:[{option,platformResult}],recordingResults:[recordingResult]})})
  page.data={expiryNotificationOption:option};page.setData=patch=>Object.assign(page.data,patch);return {page,toast}
}
test('expiry reminder save failure stays retryable and never displays success', async()=>{
  const h=expiryPage({writebackError:{code:'NETWORK_ERROR'}});await h.page.enableExpiryReminder()
  assert.ok(h.page.data.expiryNotificationOption);assert.match(h.toast[0],/保存失败/);assert.doesNotMatch(h.toast[0],/已申请/)
})
test('expiry reminder only displays success once consent is saved', async()=>{
  const h=expiryPage({saved:true});await h.page.enableExpiryReminder();assert.equal(h.page.data.expiryNotificationOption,null);assert.equal(h.toast[0],'到期提醒已申请')
})
