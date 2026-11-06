import assert from 'node:assert/strict'
import nodeTest from 'node:test'
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn)
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const tick=()=>new Promise(setImmediate)
for(const phase of ['challenge','authenticate','reservation'])test(`logout during ${phase} cannot revive old identity`,async()=>{
 const storage=new Map(),requests=[];let finish
 const module={exports:{}}
 const response=path=>path.endsWith('challenges')?{state:'state',nonce:'nonce'}:path.endsWith('code-authentication')?{accessToken:'old-identity-token'.repeat(3),principal:{principalId:'old-user'},expiresAt:'2030-01-01T00:00:00Z'}:{data:{expiresAt:'2030-01-01T00:00:00Z'}}
 const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),login:o=>o.success({code:'login-code'})}
 vm.runInNewContext(readFileSync('miniprogram/utils/auth.js','utf8'),{module,wx,require:name=>{
  if(name==='../config/index')return {getRuntimeConfig:()=>({wechatIdentityEnabled:true,identityTenantId:'tenant',identityStoreId:'store',wechatAppId:'app'})}
  if(name==='./id')return {randomId:()=> 'audit-random-key'}
  return {deviceKey:()=> 'audit-device',storeWechatIdentityToken:t=>storage.set('token',t),clearWechatIdentityToken:()=>storage.delete('token'),clearReservationCookie:()=>{},request:(path,options)=>{
   requests.push({path,options});const wait=phase==='challenge'?path.endsWith('challenges'):phase==='authenticate'?path.endsWith('code-authentication'):path.endsWith('/reservation/session')
   return wait?new Promise(resolve=>{finish=()=>resolve(response(path))}):Promise.resolve(response(path))
  }}
 }})
 const p=module.exports.ensureCustomerSession(false);await tick();module.exports.clearCustomerSession();module.exports.markMembershipLoggedOut();finish()
 await assert.rejects(p,{code:'COMMAND_RECOVERY_SCOPE_CHANGED'});assert.equal(storage.has('token'),false);assert.equal(storage.has('mbox.public.session.expiresAt'),false);assert.equal(storage.has('mbox.wechat.identity.principal.v1'),false)
})
