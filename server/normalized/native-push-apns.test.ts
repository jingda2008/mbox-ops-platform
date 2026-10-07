import { generateKeyPairSync,randomBytes,randomUUID,verify } from 'node:crypto'
import { mkdtempSync,writeFileSync,chmodSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe,it,expect } from 'vitest'
import { OfficialApnsAdapter,sendApnsHttp2,type ApnsWireRequest,type ApnsWireResult } from './native-push-apns.js'
import { readNativePushConfig,type NativePushConfig } from './native-push-config.js'
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'})
const cfg:NativePushConfig={environment:'sandbox',topic:'com.mbox.staff',teamId:'ABCDEFGHIJ',keyId:'KLMNOPQRST',privateKey:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),tokenKey:randomBytes(32),tokenKeyId:'test-v1',eventTtlSeconds:300}
const request=()=>({token:randomBytes(32).toString('hex'),requestId:randomUUID(),deliveryId:randomUUID(),expiresAt:new Date(Date.now()+300_000).toISOString()})
describe('official APNs protocol and closed-by-default configuration',()=>{
 it('signs valid ES256 claims, pins Apple host and sends only generic minimum payload',async()=>{
  let captured!:ApnsWireRequest;const input=request();const adapter=new OfficialApnsAdapter(cfg,async wire=>{captured=wire;return {kind:'response',status:200,headers:{'apns-id':input.requestId},body:''}})
  expect(await adapter.send(input)).toEqual({status:'provider_accepted'});expect(captured.origin).toBe('https://api.sandbox.push.apple.com');expect(captured.headers).toMatchObject({':path':'/3/device/'+input.token,'apns-topic':cfg.topic,'apns-push-type':'alert','apns-priority':'10','apns-id':input.requestId,'apns-expiration':String(Math.floor(Date.parse(input.expiresAt)/1000))})
  const parts=captured.headers.authorization!.slice(7).split('.');expect(JSON.parse(Buffer.from(parts[0]!,'base64url').toString())).toEqual({alg:'ES256',kid:cfg.keyId});expect(JSON.parse(Buffer.from(parts[1]!,'base64url').toString()).iss).toBe(cfg.teamId)
  expect(verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key:pair.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2]!,'base64url'))).toBe(true)
  expect(JSON.parse(captured.body)).toEqual({aps:{alert:{title:'M-BOX 服务待办',body:'有待处理事项，请打开工作台核对最新状态'},sound:'default'},mbox:{protocol:1,kind:'service_task',deliveryId:input.deliveryId}});expect(captured.body).not.toContain(input.token);expect(Buffer.byteLength(captured.body)).toBeLessThan(4096)
 })
 it('reuses JWT until the documented 20–60 minute renewal window',async()=>{
  let now=Date.now();const tokens:string[]=[];const adapter=new OfficialApnsAdapter(cfg,async wire=>{tokens.push(wire.headers.authorization!);return {kind:'response',status:200,headers:{},body:''}},()=>now)
  const send=()=>adapter.send({...request(),expiresAt:new Date(now+300_000).toISOString()});await send();now+=49*60_000;await send();now+=60_000;await send();expect(tokens[1]).toBe(tokens[0]);expect(tokens[2]).not.toBe(tokens[1])
 })
 it.each<[ApnsWireResult,object]>([
  [{kind:'not_sent'},{status:'retry',code:'APNS_NOT_SENT'}],
  [{kind:'unknown'},{status:'unknown',code:'APNS_TRANSPORT_UNKNOWN'}],
  [{kind:'response',status:429,headers:{'retry-after':'45'},body:'{}'},{status:'retry',retryAfterSeconds:45}],
  [{kind:'response',status:503,headers:{},body:'{}'},{status:'retry'}],
  [{kind:'response',status:410,headers:{},body:'{"reason":"Unregistered"}'},{status:'rejected',invalidToken:true}],
  [{kind:'response',status:400,headers:{},body:'{"reason":"BadDeviceToken"}'},{status:'rejected',invalidToken:true}],
  [{kind:'response',status:403,headers:{},body:'{"reason":"InvalidProviderToken"}'},{status:'rejected',configurationFailure:true}],
  [{kind:'response',status:400,headers:{},body:'{"reason":"PayloadTooLarge"}'},{status:'rejected',code:'APNS_REQUEST_REJECTED'}],
  [{kind:'response',status:200,headers:{},body:''},{status:'unknown',code:'APNS_RECEIPT_MISSING'}],
  [{kind:'response',status:200,headers:{'apns-id':randomUUID()},body:''},{status:'unknown',code:'APNS_RECEIPT_MISMATCH'}],
 ])('keeps acceptance, known retry and uncertain outcomes distinct %#',async(response,expected)=>{
  expect(await new OfficialApnsAdapter(cfg,async()=>response).send(request())).toMatchObject(expected)
 })
 it('does not send expired events or allow configured arbitrary transport hosts',async()=>{
  let calls=0;expect(await new OfficialApnsAdapter(cfg,async()=>{calls++;throw new Error('unexpected')}).send({...request(),expiresAt:'2000-01-01T00:00:00Z'})).toEqual({status:'rejected',code:'EVENT_EXPIRED'});expect(calls).toBe(0)
  expect(await sendApnsHttp2({origin:'http://localhost:1234',headers:{},body:''})).toEqual({kind:'not_sent'})
 })
 it('defaults disabled and rejects incomplete/unsafe enabled keys without secret-bearing errors',()=>{
  expect(readNativePushConfig({})).toBeNull();expect(()=>readNativePushConfig({MBOX_NATIVE_PUSH_ENABLED:'yes'})).toThrow();expect(()=>readNativePushConfig({MBOX_NATIVE_PUSH_ENABLED:'true'})).toThrow('incomplete or invalid')
  const dir=mkdtempSync(join(tmpdir(),'mbox-push-test-')),path=join(dir,'key.p8');writeFileSync(path,cfg.privateKey,{mode:0o600})
  const env={MBOX_NATIVE_PUSH_ENABLED:'true',MBOX_APNS_ENVIRONMENT:'production',MBOX_APNS_TOPIC:cfg.topic,MBOX_APNS_TEAM_ID:cfg.teamId,MBOX_APNS_KEY_ID:cfg.keyId,MBOX_APNS_PRIVATE_KEY_FILE:path,MBOX_NATIVE_PUSH_TOKEN_KEY_BASE64:cfg.tokenKey.toString('base64'),MBOX_NATIVE_PUSH_TOKEN_KEY_ID:cfg.tokenKeyId}
  try{expect(readNativePushConfig(env)?.eventTtlSeconds).toBe(300);expect(readNativePushConfig({...env,MBOX_NATIVE_PUSH_EVENT_TTL_SECONDS:'900'})?.eventTtlSeconds).toBe(900);expect(()=>readNativePushConfig({...env,MBOX_NATIVE_PUSH_EVENT_TTL_SECONDS:'901'})).toThrow();chmodSync(path,0o644);expect(()=>readNativePushConfig(env)).toThrow('incomplete or invalid')}finally{rmSync(dir,{recursive:true,force:true})}
 })
})

describe('optional APNs failure isolation and operator health',()=>{
 it('keeps APNs configuration rejection visible without hiding database/program failures',async()=>{
  const {NormalizedBackgroundWorkerCoordinator}=await import('./background-worker-coordinator.js')
  const {NormalizedWorkerHealthTracker}=await import('./normalized-worker-runtime.js')
  const batch={workerId:'test:push',projected:0,claimed:1,accepted:0,unknown:0,rejected:1,retry:0,cancelled:0,expired:0,configurationRejected:1}
  const run=async(fail=false)=>{
   const errors:string[]=[]
   const noop={runBatch:async()=>null,run:async()=>null,cleanupExpired:async()=>0}
   const ports=new Proxy({nativePush:{runBatch:async()=>{if(fail)throw new Error('database unavailable');return batch}}},{get:(target,key)=>key==='nativePush'?target.nativePush:key==='promotionalLoyalty'?undefined:noop})
   const coordinator=new NormalizedBackgroundWorkerCoordinator({tenantId:randomUUID(),storeId:randomUUID()},ports as unknown as ConstructorParameters<typeof NormalizedBackgroundWorkerCoordinator>[1],{}, {workerId:'test-push',onError:worker=>{errors.push(worker)}})
   return {result:await coordinator.runOnce(),errors}
  }
  const provider=await run();expect(provider.result.failures).toEqual([]);expect(provider.errors).toContain('native-push');expect(provider.result.workers.nativePush?.configurationRejected).toBe(1)
  const tracker=new NormalizedWorkerHealthTracker(2000,false,[],true);tracker.report(provider.result);expect(tracker.snapshot()).toMatchObject({status:'healthy',nativePush:{status:'degraded',lastErrorCode:'NATIVE_PUSH_CONFIGURATION_REJECTED'}})
  tracker.report({...provider.result,workers:{...provider.result.workers,nativePush:{...batch,claimed:0,rejected:0,configurationRejected:0}}});expect(tracker.snapshot().nativePush?.lastErrorCode).toBe('NATIVE_PUSH_CONFIGURATION_REJECTED')
  tracker.report({...provider.result,workers:{...provider.result.workers,nativePush:{...batch,accepted:1,rejected:0,configurationRejected:0}}});expect(tracker.snapshot().nativePush).toMatchObject({status:'healthy',lastErrorCode:null})
  const database=await run(true);expect(database.result.failures).toContain('native-push');tracker.report(database.result);expect(tracker.snapshot()).toMatchObject({status:'degraded',nativePush:{status:'degraded',lastErrorCode:'NATIVE_PUSH_WORKER_FAILED'}})
 })
})
