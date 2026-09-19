import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const storage = new Map(), calls = [], requests = new Map()
  const config = { wechatIdentityEnabled: true, identityTenantId: 'tenant', identityStoreId: 'store', wechatAppId: 'wx-test' }
  let login, id = 0
  const request = (path, options) => {
    calls.push({ path, options, token: storage.get('mbox.wechat.identity.accessToken.v1') })
    const pending = deferred(); requests.set(path, pending); return pending.promise
  }
  const authModule = { exports: {} }
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key,value) => storage.set(key,value), removeStorageSync: key => storage.delete(key), login: options => { login=options } }
  vm.runInNewContext(readFileSync(new URL('../miniprogram/utils/auth.js',import.meta.url),'utf8'), {
    module: authModule, wx, require: name => {
      if(name==='../config/index')return {getRuntimeConfig:()=>config}
      if(name==='./id')return {randomId:()=>`test-${++id}`}
      if(name==='./request')return {request, deviceKey:()=> 'test-device', storeWechatIdentityToken:value=>storage.set('mbox.wechat.identity.accessToken.v1',value), clearWechatIdentityToken:()=>storage.delete('mbox.wechat.identity.accessToken.v1'), clearReservationCookie:()=>undefined}
      throw Error(name)
    }
  })
  const auth = authModule.exports, apiModule={exports:{}}
  const session={tableToken:'test-table-token',scanNonce:'test-scan'}
  vm.runInNewContext(readFileSync(new URL('../miniprogram/utils/api.js',import.meta.url),'utf8'), {
    module:apiModule, wx, setTimeout, require:name=>{
      if(name==='./auth')return auth
      if(name==='./request')return {request,deviceKey:()=> 'test-device'}
      if(name==='./session')return {getTableSession:()=>session, rememberTableConnection:()=>undefined}
      if(name==='./table-request-scope')return {tableRequestScope:()=> 'test-scope'}
      if(name==='./id')return {randomId:()=>`test-${++id}`}
      if(name==='./recoverable-command'||name==='./recommendation-attribution')return {}
      throw Error(name)
    }
  })
  return {auth,api:apiModule.exports,storage,calls,requests,config,get login(){return login}}
}
const token='t'.repeat(64), expiry=()=>new Date(Date.now()+3600000).toISOString()
async function finishIdentity(f) {
  f.requests.get('/api/wechat/challenges').resolve({state:'state',nonce:'nonce'})
  await flush()
  f.login.success({code:'wx-code'})
  await flush()
  f.requests.get('/api/wechat/code-authentication').resolve({accessToken:token,expiresAt:expiry(),principal:{}})
  await flush()
}

test('cold scan overlaps wx.login and challenge instead of serial round trips',async()=>{
  const f=fixture(), pending=f.auth.ensureCustomerSession()
  assert.ok(f.login, 'wx.login must start before challenge response')
  assert.ok(f.requests.has('/api/wechat/challenges'))
  await finishIdentity(f)
  f.requests.get('/api/public/reservation/session').resolve({data:{expiresAt:expiry()}})
  await pending
  const authentication=f.calls.find(row=>row.path==='/api/wechat/code-authentication')
  assert.equal(authentication.options.data.state,'state')
  assert.equal(authentication.options.data.nonce,'nonce')
  assert.equal(authentication.options.data.code,'wx-code')
})

test('scan waits for verified identity but not the unrelated reservation session',async()=>{
  const f=fixture(), customer=f.auth.ensureCustomerSession(), scan=f.api.getGuestSession()
  await flush()
  assert.equal(f.requests.has('/api/guest/session/scan'),false)
  await finishIdentity(f)
  assert.ok(f.requests.has('/api/public/reservation/session'))
  assert.ok(f.requests.has('/api/guest/session/scan'),'slow reservation session must not block table scan')
  assert.equal(f.calls.filter(row=>row.path==='/api/wechat/challenges').length,1)
  assert.equal(f.calls.find(row=>row.path==='/api/guest/session/scan').token,token)
  f.requests.get('/api/guest/session/scan').resolve({data:{status:'active'}})
  await scan
  f.requests.get('/api/public/reservation/session').resolve({data:{expiresAt:expiry()}})
  await customer
})

test('valid cached identity scans without waiting for reservation renewal',async()=>{
  const f=fixture()
  f.storage.set('mbox.wechat.identity.accessToken.v1',token)
  f.storage.set('mbox.wechat.identity.expiresAt.v1',expiry())
  const customer=f.auth.ensureCustomerSession(),scan=f.api.getGuestSession()
  await flush()
  assert.equal(f.login,undefined)
  assert.ok(f.requests.has('/api/guest/session/scan'))
  f.requests.get('/api/guest/session/scan').resolve({data:{status:'active'}});await scan
  f.requests.get('/api/public/reservation/session').resolve({data:{expiresAt:expiry()}});await customer
})

test('identity failure retains existing scan fallback and a later attempt can retry',async()=>{
  const f=fixture(),scan=f.api.getGuestSession()
  f.requests.get('/api/wechat/challenges').reject(new Error('identity offline'))
  await flush()
  assert.ok(f.requests.has('/api/guest/session/scan'))
  assert.equal(f.calls.find(row=>row.path==='/api/guest/session/scan').token,undefined)
  f.requests.get('/api/guest/session/scan').resolve({data:{status:'waiting_for_table'}});await scan
  const retry=f.api.getGuestSession();await finishIdentity(f)
  assert.equal(f.calls.filter(row=>row.path==='/api/wechat/challenges').length,2)
  f.requests.get('/api/guest/session/scan').resolve({data:{status:'active'}});await retry
})

test('explicit member logout does not silently authenticate again on table scan',async()=>{
  const f=fixture();f.storage.set('mbox.membership.loggedOut.v1','1')
  const scan=f.api.getGuestSession();await flush()
  assert.equal(f.login,undefined)
  assert.equal(f.requests.has('/api/wechat/challenges'),false)
  assert.ok(f.requests.has('/api/guest/session/scan'))
  f.requests.get('/api/guest/session/scan').resolve({data:{status:'active'}});await scan
})
