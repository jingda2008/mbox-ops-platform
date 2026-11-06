import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8')
const methods=[['recordWechatNotificationAuthorization','loyalty_points_credited','mbox.wechat.notification.authorization.loyalty_points_credited.policy'],['recordWechatMemberServiceNotificationAuthorization','member_benefit_issued','mbox.wechat.member-service-notification.authorization.member_benefit_issued.policy'],['recordReservationPerformanceNotificationAuthorization',null,'mbox.reservation.performance.notification.reservation.policy']]
const input=type=>({...(type?{notificationType:type}:{reservationPublicId:'reservation'}),policyId:'policy',policyVersion:1,templateId:'template',expectedVersion:0,platformResult:'accept'})
function fixture(storage=new Map()){
 let serial=0,fail=null,table='table-a',hold=null;const requests=[]
 if(!storage.has('mbox.wechat.identity.principal.v1'))storage.set('mbox.wechat.identity.principal.v1',{principalId:'customer-a'})
 const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k)}
 const request=async(path,options)=>{requests.push({path,...options});if(hold)await hold;if(fail)throw fail;return {data:{saved:true}}}
 const modules=new Map()
 function load(file){if(modules.has(file))return modules.get(file);const module={exports:{}};vm.runInNewContext(read(file),{module,wx,require:name=>{
  if(name==='../config/index')return{getRuntimeConfig:()=>({apiBaseUrl:'https://audit.example.test',storeId:'audit'})}
  if(name==='./id')return{randomId:prefix=>prefix+'-'+(++serial)}
  if(name==='./session')return{getTableSession:()=>({cartScope:table})}
  if(name==='./request')return{request}
  if(name==='./auth')return{ensureCustomerSession:async()=>{},isCustomerSessionInvalid:()=>false}
  if(name==='./recoverable-command')return load('miniprogram/utils/recoverable-command.js')
  return{}
 }});modules.set(file,module.exports);return module.exports}
 return{api:load('miniprogram/utils/api.js'),storage,requests,setFail:error=>{fail=error},setTable:value=>{table=value},hold:value=>{hold=value}}
}
for(const [method,type,legacy] of methods){
 for(const status of [408,409,425,429,500,502,503,504])test(`${method} preserves its exact request after ${status}`,async()=>{
  const f=fixture(),body=input(type);f.setFail(Object.assign(Error('ambiguous'),{code:'HTTP_ERROR',statusCode:status}))
  await assert.rejects(f.api[method](body));f.setTable('table-b');f.setFail(null);await f.api[method](body)
  assert.equal(f.requests[0].headers['idempotency-key'],f.requests[1].headers['idempotency-key']);assert.deepEqual(f.requests[0].data,f.requests[1].data)
 })
 test(`${method} persists recovery across app restart and isolates identities`,async()=>{
  const f=fixture(),body=input(type);f.setFail(Object.assign(Error('lost'),{code:'NETWORK_ERROR'}));await assert.rejects(f.api[method](body))
  const g=fixture(f.storage);await g.api[method](body);assert.equal(g.requests[0].headers['idempotency-key'],f.requests[0].headers['idempotency-key']);assert.deepEqual(JSON.parse(JSON.stringify(g.requests[0].data)),JSON.parse(JSON.stringify(f.requests[0].data)))
  f.storage.set('mbox.wechat.identity.principal.v1',{principalId:'customer-b'});f.setFail(null);await f.api[method](body);assert.notEqual(f.requests[1].headers['idempotency-key'],f.requests[0].headers['idempotency-key'])
 })
 test(`${method} coalesces concurrent submissions and clears confirmed success`,async()=>{
  const f=fixture(),body=input(type);let release;f.hold(new Promise(resolve=>{release=resolve}));const a=f.api[method](body),b=f.api[method](body);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.requests.length,1);release();await Promise.all([a,b]);f.hold(null);await f.api[method](body);assert.notEqual(f.requests[0].headers['idempotency-key'],f.requests[1].headers['idempotency-key'])
 })
 test(`${method} refuses an unbound legacy attempt rather than replacing its key`,async()=>{
  const f=fixture();f.storage.set(legacy,{...input(type),idempotencyKey:'old-key'});await assert.rejects(f.api[method](input(type)),{code:'NOTIFICATION_LEGACY_ATTEMPT_REVIEW_REQUIRED'});assert.equal(f.requests.length,0);assert.equal(f.storage.get(legacy).idempotencyKey,'old-key')
 })
 test(`${method} binds content and clears a definitive rejected request`,async()=>{
  const f=fixture(),body=input(type);f.setFail(Object.assign(Error('invalid'),{statusCode:400}));await assert.rejects(f.api[method](body));f.setFail(null);await f.api[method](body);assert.notEqual(f.requests[0].headers['idempotency-key'],f.requests[1].headers['idempotency-key'])
 })
}
for(const [method,arg] of [['recordBirthdayBenefitConsent','02-10'],['withdrawBirthdayBenefitConsent','撤回'],['recordNotificationConsent',{channel:'wechat',purpose:'service',decision:'revoked',expectedVersion:1}]])test(`${method} also preserves unknown consent outcomes`,async()=>{
 const f=fixture();f.setFail(Object.assign(Error('unknown'),{statusCode:503}));await assert.rejects(f.api[method](arg));f.setFail(null);await f.api[method](arg);assert.equal(f.requests[0].headers['idempotency-key'],f.requests[1].headers['idempotency-key'])
})
