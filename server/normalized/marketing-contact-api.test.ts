import Fastify from 'fastify'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {marketingContactApiPlugin} from './marketing-contact-api.js'
import {MarketingContactRepository} from './marketing-contact-repository.js'
import {MarketingDeliveryRepository} from './marketing-delivery-repository.js'
import {StaffAccessDeniedError,StaffAccessRepository} from './staff-access-repository.js'
import {NormalizedAuthenticationRequiredError} from './normalized-request-context.js'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import type {NormalizedCommandExecutor} from './command-executor.js'
const apps:ReturnType<typeof Fastify>[]=[]
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.restoreAllMocks()})
function setup(mode='allowed'){
  const app=Fastify();apps.push(app)
  const scope={tenantId:'11111111-1111-4111-8111-111111111111',storeId:'22222222-2222-4222-8222-222222222222'},query=vi.fn(async()=>({rows:[],rowCount:0})),run=vi.fn(async(scope,action)=>action({scope,query}))
  const permission=vi.spyOn(StaffAccessRepository.prototype,'assertPermission').mockImplementation(async()=>{if(mode==='denied')throw new StaffAccessDeniedError('denied')})
  const execute=vi.fn(async(input,action)=>({value:(await action({scope:input.scope,query})).result,replayed:false}))
  app.register(marketingContactApiPlugin,{transactions:{run} as CustomerBenefitApiOptions['transactions'],commands:{execute} as unknown as Pick<NormalizedCommandExecutor,'execute'>,
    resolveStaffContext:async()=>{if(mode==='anonymous')throw new NormalizedAuthenticationRequiredError();return{scope,employeeId:'employee-current',businessDate:'2026-09-09'}},
    resolveSelfContext:async()=>{if(mode==='anonymous')throw new NormalizedAuthenticationRequiredError();return{scope,customerId:'customer-current',businessDate:'2026-09-09',tableSessionId:null,actorRef:'test'}}})
  return{app,run,execute,permission}
}
const headers={'idempotency-key':'marketing-command-1234'}
describe('marketing preference HTTP actor and purpose isolation',()=>{
  it('records a staff-scoped history query with audit permission, never a body-supplied actor',async()=>{
    const history=vi.spyOn(MarketingContactRepository.prototype,'consentHistory').mockResolvedValue({customerId:'customer',items:[],nextCursor:null}),{app,permission}=setup()
    const response=await app.inject({method:'POST',url:'/staff/marketing/consent-history/query',payload:{customerId:'customer',reason:'核查客户许可',cursor:'123'}})
    expect(response.statusCode).toBe(200);expect(permission).toHaveBeenCalledWith('employee-current','marketing.consent.audit')
    expect(history).toHaveBeenCalledWith({employeeId:'employee-current',customerId:'customer',businessDate:'2026-09-09',reason:'核查客户许可',cursor:'123'})
    expect(response.headers['cache-control']).toContain('no-store')
  })
  it('does not disclose history without its dedicated permission',async()=>{
    const history=vi.spyOn(MarketingContactRepository.prototype,'consentHistory'),{app}=setup('denied')
    expect((await app.inject({method:'POST',url:'/staff/marketing/consent-history/query',payload:{customerId:'customer',reason:'核查客户许可'}})).statusCode).toBe(403)
    expect(history).not.toHaveBeenCalled()
  })
  it.each(['/public/mini/marketing-preferences','/staff/marketing/notices'])('requires an authenticated identity for %s',async url=>{
    const {app,run}=setup('anonymous'),response=await app.inject(url);expect(response.statusCode).toBe(401);expect(run).not.toHaveBeenCalled();expect(response.headers['cache-control']).toContain('no-store')
  })
  it('stop-all needs neither notice, consent revision, subscription nor membership approval',async()=>{
    const stop=vi.spyOn(MarketingContactRepository.prototype,'stopAll').mockResolvedValue({stopped:true,customerId:'customer-current'}),{app,execute}=setup()
    const response=await app.inject({method:'POST',url:'/public/mini/marketing-preferences/stop-all',headers,payload:{}})
    expect(response.statusCode).toBe(200);expect(stop).toHaveBeenCalledWith({customerId:'customer-current',businessDate:'2026-09-09'})
    expect(JSON.parse(execute.mock.calls[0]![0].requestFingerprint).customerId).toBe('customer-current')
  })
  it.each([{customerId:'victim'},{employeeId:'boss'},{decision:'granted'}])('rejects impersonation or mixed action in stop-all %j',async payload=>{
    const {app,execute}=setup(),response=await app.inject({method:'POST',url:'/public/mini/marketing-preferences/stop-all',headers,payload});expect(response.statusCode).toBe(400);expect(execute).not.toHaveBeenCalled()
  })
  it.each([null,{channel:'sms',purpose:'transactional_service',decision:'granted'},{channel:'phone',purpose:'all_partners',decision:'granted'},{channel:'sms',purpose:'own_activities',decision:true},{channel:'sms',purpose:'own_activities',decision:'granted',platformResult:'accept'}])('rejects invalid or fake platform choices %j',async choice=>{
    const {app,execute}=setup(),response=await app.inject({method:'POST',url:'/public/mini/marketing-preferences/choices',headers,payload:{noticeId:'notice',expectedRevision:'none',choices:[choice]}});expect(response.statusCode).toBe(400);expect(execute).not.toHaveBeenCalled()
  })
  it('requires distinct refusal-recording permission before replaying a staff action',async()=>{
    const {app,execute,permission}=setup('denied'),response=await app.inject({method:'POST',url:'/staff/marketing/refusals',headers,payload:{customerId:'customer',reason:'客户明确拒绝'}})
    expect(response.statusCode).toBe(403);expect(execute).not.toHaveBeenCalled();expect(permission).toHaveBeenCalledWith('employee-current','marketing.refusal.record')
  })
  it('rejects implicit acceptance without a recoverable command identity',async()=>{
    const {app,execute}=setup(),response=await app.inject({method:'POST',url:'/public/mini/marketing-preferences/choices',payload:{noticeId:'notice',expectedRevision:'none',choices:[{channel:'sms',purpose:'own_activities',decision:'granted'}]}})
    expect(response.statusCode).toBe(400);expect(execute).not.toHaveBeenCalled()
  })
  it.each(['channelReady','verifiedRecipient','platformPermissionVerified','consentId','providerReceiptRef'])('rejects client-supplied send authority %s',async key=>{
    const {app,execute}=setup(),response=await app.inject({method:'POST',url:'/staff/marketing/jobs',headers,payload:{customerId:'customer',noticeId:'notice',channel:'sms',purpose:'own_activities',campaignKey:'campaign-123',content:'活动说明',expiresAt:'2026-09-30T00:00:00+08:00',[key]:true}})
    expect(response.statusCode).toBe(400);expect(execute).not.toHaveBeenCalled()
  })
  it('requires current sender permission even for task replay',async()=>{
    const {app,execute,permission}=setup('denied'),response=await app.inject({method:'POST',url:'/staff/marketing/jobs',headers,payload:{}})
    expect(response.statusCode).toBe(403);expect(execute).not.toHaveBeenCalled();expect(permission).toHaveBeenCalledWith('employee-current','marketing.send')
  })
  it('queues an intent with server employee scope, never an actual provider send',async()=>{
    const queue=vi.spyOn(MarketingDeliveryRepository.prototype,'queue').mockResolvedValue({jobId:'job',status:'queued',replayed:false}),{app}=setup()
    const response=await app.inject({method:'POST',url:'/staff/marketing/jobs',headers,payload:{customerId:'customer',noticeId:'notice',channel:'sms',purpose:'own_activities',campaignKey:'campaign-123',content:'活动说明',expiresAt:'2026-09-30T00:00:00+08:00'}})
    expect(response.statusCode).toBe(200);expect(queue).toHaveBeenCalledWith(expect.objectContaining({employeeId:'employee-current',businessDate:'2026-09-09'}));expect(response.json().data.status).toBe('queued')
  })
})
