import { MemberVisitRewardRepository } from './member-visit-reward-repository.js'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memberVisitApiPlugin } from './member-visit-api.js'
import { MemberVisitRepository } from './member-visit-repository.js'
import { StaffAccessRepository, StaffAccessDeniedError } from './staff-access-repository.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import type { NormalizedCommandExecutor } from './command-executor.js'
import type { CustomerBenefitApiOptions } from './customer-benefit-api.js'

const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app=>app.close())); vi.restoreAllMocks() })
const scope = { tenantId: '11111111-1111-4111-8111-111111111111', storeId: '22222222-2222-4222-8222-222222222222' }
const payload = { code: 'MBOX_MEMBER_V1:MBX-100000', businessDate: '2026-09-26' }
const headers = { 'idempotency-key': 'visit-test-command-0001' }
const visit = { id: '33333333-3333-4333-8333-333333333333', businessDate: '2026-09-26', checkedInAt: '2026-09-26T02:00:00Z', employeeName: '值班员工', status: 'checked_in' as const }
function setup(mode: 'allowed' | 'anonymous' | 'read-only' = 'allowed') {
  const app = Fastify(); apps.push(app)
  const transaction = { scope, query: vi.fn() }
  const run = vi.fn(async (_scope, operation)=>operation(transaction))
  const execute = vi.fn(async (_input, operation) => ({ value: (await operation(transaction)).result, replayed: false }))
  const permission = vi.spyOn(StaffAccessRepository.prototype,'assertPermission').mockImplementation(async (_employee,code) => {
    if (mode === 'read-only' && code !== 'loyalty.account.view') throw new StaffAccessDeniedError('denied')
    return { permissions: mode === 'allowed' ? ['loyalty.account.view','customer.relationship.manage'] : ['loyalty.account.view'] } as never
  })
  vi.spyOn(MemberVisitRewardRepository.prototype,'progressForMember').mockResolvedValue([])
  const current = vi.spyOn(MemberVisitRepository.prototype,'current').mockResolvedValue(null)
  const checkIn = vi.spyOn(MemberVisitRepository.prototype,'checkIn').mockResolvedValue({ visit, changed: true })
  const cancel = vi.spyOn(MemberVisitRepository.prototype,'cancel').mockResolvedValue({ visit: { ...visit, status: 'cancelled' }, changed: true })
  app.register(memberVisitApiPlugin, { transactions: {run} as CustomerBenefitApiOptions['transactions'], commands: {execute} as unknown as Pick<NormalizedCommandExecutor,'execute'>,
    resolveStaffContext: async () => { if(mode==='anonymous')throw new NormalizedAuthenticationRequiredError();return {scope,employeeId:'employee-current',businessDate:'2026-09-26'} } })
  return { app, run, execute, permission, current, checkIn, cancel }
}
describe('member attendance choices are independent of activity admission', () => {
  it('authenticates before reading and never exposes member attendance to guests', async () => {
    const value = setup('anonymous')
    const response = await value.app.inject({method:'POST',url:'/staff/member-visits/lookup',payload:{code:payload.code}})
    expect(response.statusCode).toBe(401);expect(value.run).not.toHaveBeenCalled()
    expect(response.headers['cache-control']).toContain('no-store')
  })
  it('reports current server business date and read-only access without granting write permission', async () => {
    const value=setup('read-only')
    const response=await value.app.inject({method:'POST',url:'/staff/member-visits/lookup',payload:{code:payload.code}})
    expect(response.json().data).toEqual({memberNo:'MBX-100000',businessDate:'2026-09-26',canCheckIn:false,visit:null,rewards:[]})
    expect(value.run).toHaveBeenCalledWith(scope,expect.any(Function),{readOnly:true})
    expect(value.checkIn).not.toHaveBeenCalled()
  })
  it.each(['check-in','cancel'])('denies %s to staff with only query permission', async action => {
    const value=setup('read-only')
    const response=await value.app.inject({method:'POST',url:`/staff/member-visits/${action}`,headers,payload:{...payload,...(action==='cancel'?{visitId:visit.id,reason:'误签到撤回'}:{})}})
    expect(response.statusCode).toBe(403);expect(value.execute).not.toHaveBeenCalled()
  })
  it.each([{employeeId:'other'},{customerId:'other'},{activityId:'event'},{businessDate:'not-a-date'}])('rejects injected identity or activity fields %j', async extra => {
    const value=setup()
    const response=await value.app.inject({method:'POST',url:'/staff/member-visits/check-in',headers,payload:{...payload,...extra}})
    expect(response.statusCode).toBe(400);expect(value.execute).not.toHaveBeenCalled()
  })
  it('requires a command key, binds the authenticated employee, and rechecks write permission inside the transaction', async () => {
    const value=setup()
    expect((await value.app.inject({method:'POST',url:'/staff/member-visits/check-in',payload})).statusCode).toBe(400)
    const response=await value.app.inject({method:'POST',url:'/staff/member-visits/check-in',headers,payload})
    expect(response.statusCode).toBe(200)
    expect(value.checkIn).toHaveBeenCalledWith('MBX-100000','2026-09-26','employee-current')
    expect(value.permission.mock.calls.filter(call=>call[1]==='customer.relationship.manage')).toHaveLength(2)
    expect(value.execute.mock.calls[0]?.[0].requestFingerprint).toContain('employee-current')
  })
  it('rejects a stale business day before creating any attendance', async () => {
    const value=setup()
    const response=await value.app.inject({method:'POST',url:'/staff/member-visits/check-in',headers,payload:{...payload,businessDate:'2026-09-25'}})
    expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('MEMBER_VISIT_DAY_CHANGED')
    expect(value.checkIn).not.toHaveBeenCalled()
  })
  it('requires the original visit ID when cancelling and never cancels by member alone', async () => {
    const value=setup()
    expect((await value.app.inject({method:'POST',url:'/staff/member-visits/cancel',headers,payload})).statusCode).toBe(400)
    const response=await value.app.inject({method:'POST',url:'/staff/member-visits/cancel',headers,payload:{...payload,visitId:visit.id,reason:'误签到撤回'}})
    expect(response.statusCode).toBe(200)
    expect(value.cancel).toHaveBeenCalledWith('MBX-100000','2026-09-26',visit.id,'employee-current','误签到撤回')
  })
})
