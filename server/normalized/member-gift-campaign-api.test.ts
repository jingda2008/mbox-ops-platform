import Fastify from 'fastify'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {memberGiftCampaignApiPlugin} from './member-gift-campaign-api.js'
import {MemberGiftCampaignRepository} from './member-gift-campaign-repository.js'
import {StaffAccessDeniedError,StaffAccessRepository} from './staff-access-repository.js'
import {NormalizedAuthenticationRequiredError} from './normalized-request-context.js'
import {CheckoutCouponRefundReviewRepository} from './checkout-coupon-refund-review-repository.js'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import type {NormalizedCommandExecutor} from './command-executor.js'
const apps:ReturnType<typeof Fastify>[]=[]
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.restoreAllMocks()})
function setup(mode='allowed'){
  const app=Fastify();apps.push(app)
  const scope={tenantId:'11111111-1111-4111-8111-111111111111',storeId:'22222222-2222-4222-8222-222222222222'}
  const query=vi.fn(async()=>({rows:[],rowCount:0})),run=vi.fn(async(scope,action)=>action({scope,query}))
  const permission=vi.spyOn(StaffAccessRepository.prototype,'assertPermission').mockImplementation(async()=>{if(mode==='denied')throw new StaffAccessDeniedError('denied')})
  const execute=vi.fn(async(input,action)=>({value:(await action({scope:input.scope,query})).result,replayed:false}))
  app.register(memberGiftCampaignApiPlugin,{transactions:{run} as CustomerBenefitApiOptions['transactions'],commands:{execute} as unknown as Pick<NormalizedCommandExecutor,'execute'>,
    resolveStaffContext:async()=>{if(mode==='anonymous')throw new NormalizedAuthenticationRequiredError();return{scope,employeeId:'employee-current',businessDate:'2026-09-09'}},
    resolveSelfContext:async()=>{if(mode==='anonymous')throw new NormalizedAuthenticationRequiredError();return{scope,customerId:'customer-current',businessDate:'2026-09-09',tableSessionId:null,actorRef:'test'}}})
  return{app,run,execute,permission}
}
const headers={'idempotency-key':'gift-command-1234'}
describe('gift campaign HTTP authority',()=>{
  it('resolves replacement choices from the original refund, never a client customer override',async()=>{
    const list=vi.spyOn(CheckoutCouponRefundReviewRepository.prototype,'replacementOptions').mockResolvedValue({items:[],nextCursor:null}),{app,permission}=setup()
    const response=await app.inject('/staff/member-gifts/refund-replacement-options?refundId=refund-a&reservationId=hold-a&customerId=victim')
    expect(response.statusCode).toBe(200);expect(list).toHaveBeenCalledWith('employee-current','refund-a','hold-a',null)
    expect(permission).toHaveBeenCalledWith('employee-current','loyalty.policy.publish')
  })
  it.each(['anonymous','denied'])('protects replacement choices from %s access',async mode=>{
    const list=vi.spyOn(CheckoutCouponRefundReviewRepository.prototype,'replacementOptions'),{app}=setup(mode)
    const response=await app.inject('/staff/member-gifts/refund-replacement-options?refundId=refund-a&reservationId=hold-a')
    expect(response.statusCode).toBe(mode==='anonymous'?401:403);expect(list).not.toHaveBeenCalled()
  })
  it('separates refund review from money operations and binds it to the signed-in reviewer',async()=>{
    const decide=vi.spyOn(CheckoutCouponRefundReviewRepository.prototype,'decide').mockResolvedValue({recorded:true,replayed:false}),{app,execute,permission}=setup()
    const payload={refundId:'refund-id',reservationId:'reservation-id',action:'no_return',reason:'按原规则处理',evidenceReference:'原规则版本及客服记录'}
    const response=await app.inject({method:'POST',url:'/staff/member-gifts/refund-reviews',headers,payload})
    expect(response.statusCode).toBe(200)
    expect(permission).toHaveBeenCalledWith('employee-current','loyalty.policy.publish')
    expect(decide).toHaveBeenCalledWith({...payload,employeeId:'employee-current',businessDate:'2026-09-09'})
    expect(execute.mock.calls[0]?.[0].operationScope).toBe('member.gift.refund-review')
  })
  it.each(['anonymous','denied'])('does not replay a refund-review command for %s staff',async mode=>{
    const {app,execute}=setup(mode),response=await app.inject({method:'POST',url:'/staff/member-gifts/refund-reviews',headers,payload:{refundId:'a',reservationId:'b',action:'no_return',reason:'复核',evidenceReference:'规则'}})
    expect(response.statusCode).toBe(mode==='anonymous'?401:403);expect(execute).not.toHaveBeenCalled()
  })
  it.each([{amountMinor:100},{employeeId:'admin'},{action:'restore_coupon'}])('rejects financial or unsupported refund-review changes %j',async extra=>{
    const {app,execute}=setup(),response=await app.inject({method:'POST',url:'/staff/member-gifts/refund-reviews',headers,payload:{refundId:'a',reservationId:'b',action:'no_return',reason:'复核',evidenceReference:'规则',...extra}})
    expect(response.statusCode).toBe(400);expect(execute).not.toHaveBeenCalled()
  })
  it.each(['/public/mini/member-gift-jobs','/staff/member-gifts/campaigns','/staff/member-gifts/jobs'])('requires authentication for %s',async url=>{
    const {app,run}=setup('anonymous'),response=await app.inject({method:'GET',url})
    expect(response.statusCode).toBe(401);expect(run).not.toHaveBeenCalled();expect(response.headers['cache-control']).toContain('no-store')
  })
  it('ignores an impersonated customer in self history queries',async()=>{
    const self=vi.spyOn(MemberGiftCampaignRepository.prototype,'selfJobs').mockResolvedValue({items:[],nextCursor:null}),{app}=setup()
    const response=await app.inject('/public/mini/member-gift-jobs?customerId=victim')
    expect(response.statusCode).toBe(200);expect(self).toHaveBeenCalledWith('customer-current',null)
  })
  it.each(['decision','target'])('checks live publication authority before %s command replay',async operation=>{
    const {app,execute,permission}=setup('denied')
    const response=await app.inject({method:'POST',url:`/staff/member-gifts/campaigns/test/${operation}`,headers,payload:operation==='decision'?{action:'publish',reason:'发布活动'}:{customerIds:['customer'],cycleKey:'launch',reason:'定向发放'}})
    expect(response.statusCode).toBe(403);expect(execute).not.toHaveBeenCalled();expect(permission).toHaveBeenCalledWith('employee-current','loyalty.policy.publish')
  })
  it.each([{employeeId:'admin'},{status:'issued'},{benefitId:'fake'},{quantity:100}])('rejects task overposting %j',async extra=>{
    const {app,execute}=setup(),response=await app.inject({method:'POST',url:'/staff/member-gifts/jobs/test/control',headers,payload:{action:'retry',reason:'查询后重试',...extra}})
    expect(response.statusCode).toBe(400);expect(execute).not.toHaveBeenCalled()
  })
  it('requires an idempotency key and binds recipient list to current staff identity',async()=>{
    const target=vi.spyOn(MemberGiftCampaignRepository.prototype,'target').mockResolvedValue({items:[]}),{app,execute}=setup(),payload={customerIds:['customer-a'],cycleKey:'launch',reason:'选定人群发放'}
    expect((await app.inject({method:'POST',url:'/staff/member-gifts/campaigns/test/target',payload})).statusCode).toBe(400)
    expect(execute).not.toHaveBeenCalled()
    expect((await app.inject({method:'POST',url:'/staff/member-gifts/campaigns/test/target',headers,payload})).statusCode).toBe(200)
    expect(target).toHaveBeenCalledWith({...payload,versionId:'test',employeeId:'employee-current',businessDate:'2026-09-09'})
    expect(JSON.parse(execute.mock.calls[0]![0].requestFingerprint).employeeId).toBe('employee-current')
  })
})
