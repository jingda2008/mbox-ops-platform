import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memberVisitRewardApiPlugin } from './member-visit-reward-api.js'
import { MemberVisitRewardRepository } from './member-visit-reward-repository.js'
import { StaffAccessRepository, StaffAccessDeniedError } from './staff-access-repository.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import type { CustomerBenefitApiOptions } from './customer-benefit-api.js'
import type { NormalizedCommandExecutor } from './command-executor.js'
const apps:ReturnType<typeof Fastify>[]=[]
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.restoreAllMocks()})
const id='33333333-3333-4333-8333-333333333333',scope={tenantId:id,storeId:id},headers={'idempotency-key':'visit-reward-approval-0001'}
const payload={action:'approve',ids:[id],reason:'管理确认发放'}
function setup(denied:string|null=null){
  const app=Fastify();apps.push(app)
  const tx={scope},run=vi.fn(async(_scope,operation)=>operation(tx))
  const execute=vi.fn(async(_input,operation)=>({value:(await operation(tx)).result,replayed:false}))
  const permission=vi.spyOn(StaffAccessRepository.prototype,'assertPermission').mockImplementation(async(_employee,code)=>{if(code===denied)throw new StaffAccessDeniedError('denied');return {} as never})
  const decide=vi.spyOn(MemberVisitRewardRepository.prototype,'decide').mockResolvedValue({items:[{id,status:'issued'}]})
  const create=vi.spyOn(MemberVisitRewardRepository.prototype,'create').mockResolvedValue({id})
  vi.spyOn(MemberVisitRewardRepository.prototype,'rules').mockResolvedValue([])
  const list=vi.spyOn(MemberVisitRewardRepository.prototype,'list').mockResolvedValue({items:[],nextCursor:null})
  app.register(memberVisitRewardApiPlugin,{transactions:{run} as CustomerBenefitApiOptions['transactions'],commands:{execute} as unknown as Pick<NormalizedCommandExecutor,'execute'>,
    resolveStaffContext:async()=>{if(denied==='anonymous')throw new NormalizedAuthenticationRequiredError();return {scope,employeeId:'manager',businessDate:'2026-09-26'}}})
  return {app,run,execute,permission,decide,create,list}
}
describe('attendance reward management API',()=>{
  it('keeps reads scoped, private and read-only with date and state filters',async()=>{
    const value=setup(),r=await value.app.inject({method:'GET',url:'/staff/member-visit-rewards?date=2026-09-25&status=pending'})
    expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toContain('no-store')
    expect(value.run).toHaveBeenCalledWith(scope,expect.any(Function),{readOnly:true})
    expect(value.list).toHaveBeenCalledWith('2026-09-25','pending',null);expect(value.decide).not.toHaveBeenCalled()
  })
  it.each(['anonymous','loyalty.policy.publish','loyalty.configuration.approve'])('rejects %s before command replay or execution',async denied=>{
    const value=setup(denied),r=await value.app.inject({method:'POST',url:'/staff/member-visit-rewards',headers,payload})
    expect(r.statusCode).toBe(denied==='anonymous'?401:403);expect(value.execute).not.toHaveBeenCalled()
  })
  it.each([{employeeId:id},{customerId:id},{ids:[id,id]},{ids:[]},{action:'configure',campaignVersionId:id,requiredVisits:0},{action:'configure',campaignVersionId:id,requiredVisits:3.5},{action:'configure',campaignVersionId:id,requiredVisits:366}])('rejects overposting or invalid batch and threshold %j',async extra=>{
    const value=setup(),r=await value.app.inject({method:'POST',url:'/staff/member-visit-rewards',headers,payload:{...('action' in extra&&extra.action==='configure'?{reason:payload.reason}:payload),...extra}})
    expect(r.statusCode).toBe(400);expect(value.execute).not.toHaveBeenCalled()
  })
  it('requires a key and checks manager permissions again inside the transaction',async()=>{
    const value=setup()
    expect((await value.app.inject({method:'POST',url:'/staff/member-visit-rewards',payload})).statusCode).toBe(400)
    const r=await value.app.inject({method:'POST',url:'/staff/member-visit-rewards',headers,payload})
    expect(r.statusCode).toBe(200);expect(value.decide).toHaveBeenCalledWith([id],'approve','manager','2026-09-26','管理确认发放')
    expect(value.permission.mock.calls.filter(c=>c[1]==='loyalty.configuration.approve')).toHaveLength(2)
    expect(value.execute.mock.calls[0]?.[0].requestFingerprint).toContain('manager')
  })
  it('does not trust permission that was revoked after the initial authorization',async()=>{
    const value=setup();let calls=0
    value.permission.mockImplementation(async()=>{if(++calls>2)throw new StaffAccessDeniedError('revoked');return {} as never})
    const r=await value.app.inject({method:'POST',url:'/staff/member-visit-rewards',headers,payload})
    expect(r.statusCode).toBe(403);expect(value.decide).not.toHaveBeenCalled()
  })
  it('accepts a configurable threshold with server-controlled identity',async()=>{
    const value=setup(),r=await value.app.inject({method:'POST',url:'/staff/member-visit-rewards',headers,payload:{action:'configure',campaignVersionId:id,requiredVisits:5,reason:'五次兑换一轮'}})
    expect(r.statusCode).toBe(200);expect(value.create).toHaveBeenCalledWith(expect.objectContaining({requiredVisits:5,employeeId:'manager',businessDate:'2026-09-26'}))
  })
})
