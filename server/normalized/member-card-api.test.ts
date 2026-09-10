import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memberCardApiPlugin } from './member-card-api.js'
import { MemberCardRepository } from './member-card-repository.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import type { CustomerBenefitApiOptions } from './customer-benefit-api.js'
import type { NormalizedCommandExecutor } from './command-executor.js'

const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks() })
function setup(mode: 'allowed' | 'anonymous' | 'denied' = 'allowed') {
  const app = Fastify(); apps.push(app)
  const scope = { tenantId: '11111111-1111-4111-8111-111111111111', storeId: '22222222-2222-4222-8222-222222222222' }
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  const run = vi.fn(async (scope, action) => action({ scope, query }))
  const permission = vi.spyOn(StaffAccessRepository.prototype, 'assertPermission').mockImplementation(async () => { if (mode === 'denied') throw new StaffAccessDeniedError('denied') })
  const execute = vi.fn(async (input, action) => {
    const result = await action({ scope: input.scope, query })
    return { value: result.result, replayed: false }
  })
  app.register(memberCardApiPlugin, {
    transactions: { run } as CustomerBenefitApiOptions['transactions'],
    commands: { execute } as unknown as Pick<NormalizedCommandExecutor, 'execute'>,
    resolveStaffContext: async () => { if (mode === 'anonymous') throw new NormalizedAuthenticationRequiredError(); return { scope, employeeId: 'employee-current', businessDate: '2026-09-09' } },
    resolveSelfContext: async () => { if (mode === 'anonymous') throw new NormalizedAuthenticationRequiredError(); return { scope, customerId: 'customer-current', businessDate: '2026-09-09', tableSessionId: null, actorRef: 'test-customer' } },
  })
  return { app, execute, run, query, permission }
}
const headers = { 'idempotency-key': 'card-command-1234' }
describe('member card HTTP security and command contracts', () => {
  it.each(['/public/mini/member-cards', '/staff/member-cards/projects', '/staff/member-cards/applications'])('authenticates %s before reading data', async url => {
    const { app, run } = setup('anonymous')
    const response = await app.inject({ method: 'GET', url })
    expect(response.statusCode).toBe(401); expect(run).not.toHaveBeenCalled()
    expect(response.headers['cache-control']).toContain('no-store')
  })
  it('reads only the authenticated customer using a readonly transaction', async () => {
    const self = vi.spyOn(MemberCardRepository.prototype, 'selfView').mockResolvedValue({ projects: [], cards: [], applications: [], activeMember: true, nextCursors: {projects:null,cards:null,applications:null} })
    const { app, run } = setup()
    const response = await app.inject({ method: 'GET', url: '/public/mini/member-cards?customerId=somebody-else' })
    expect(response.statusCode).toBe(200); expect(self).toHaveBeenCalledWith('customer-current',{})
    expect(run.mock.calls[0]?.[2]).toEqual({ readOnly: true })
  })
  it.each([{ customerId: 'victim' }, { marketingConsent: true }, { memberLevel: 'black' }, { acceptedProjectVersion: '1' }])('rejects overposting or invalid acceptance %j', async extra => {
    const { app, execute } = setup()
    const response = await app.inject({ method: 'POST', url: '/public/mini/member-cards/applications', headers, payload: { projectId: 'project-id', acceptedProjectVersion: 1, ...extra } })
    expect(response.statusCode).toBe(400); expect(execute).not.toHaveBeenCalled()
  })
  it('binds application and idempotency fingerprint to the authenticated identity', async () => {
    const apply = vi.spyOn(MemberCardRepository.prototype, 'apply').mockResolvedValue({ applicationId: 'application-id', status: 'pending', replayed: false })
    const { app, execute } = setup()
    const response = await app.inject({ method: 'POST', url: '/public/mini/member-cards/applications', headers, payload: { projectId: 'project-id', acceptedProjectVersion: 1 } })
    expect(response.statusCode).toBe(200)
    expect(apply).toHaveBeenCalledWith({ projectId: 'project-id', acceptedProjectVersion: 1, customerId: 'customer-current', businessDate: '2026-09-09' })
    expect(JSON.parse(execute.mock.calls[0]![0].requestFingerprint).customerId).toBe('customer-current')
  })
  it('rejects missing idempotency key without changing an application', async () => {
    const { app, execute } = setup()
    const response = await app.inject({ method: 'POST', url: '/public/mini/member-cards/applications', payload: { projectId: 'project-id', acceptedProjectVersion: 1 } })
    expect(response.statusCode).toBe(400); expect(execute).not.toHaveBeenCalled()
  })
  it('checks current review permission even before an old command could replay', async () => {
    const { app, execute, permission } = setup('denied')
    const response = await app.inject({ method: 'POST', url: '/staff/member-cards/applications/application-id/review', headers, payload: { decision: 'approve', reason: '符合申请条件' } })
    expect(response.statusCode).toBe(403); expect(execute).not.toHaveBeenCalled()
    expect(permission).toHaveBeenCalledWith('employee-current', 'member.card.review')
  })
  it('does not accept a client-supplied reviewer or a multi-person approval override', async () => {
    const { app, execute } = setup()
    const response = await app.inject({ method: 'POST', url: '/staff/member-cards/applications/application-id/review', headers, payload: { decision: 'approve', reason: '符合申请条件', employeeId: 'admin' } })
    expect(response.statusCode).toBe(400); expect(execute).not.toHaveBeenCalled()
  })
  it('requires current management permission before changing a card', async () => {
    const { app, execute, permission } = setup('denied')
    const response = await app.inject({ method: 'POST', url: '/staff/member-cards/holdings/card-id/state', headers, payload: { action: 'revoke', reason: '撤销测试卡' } })
    expect(response.statusCode).toBe(403); expect(execute).not.toHaveBeenCalled()
    expect(permission).toHaveBeenCalledWith('employee-current', 'member.card.manage')
  })
  it('does not expose arbitrary card state writes or staff impersonated customer withdrawal', async () => {
    const { app, execute } = setup()
    const response = await app.inject({ method: 'POST', url: '/staff/member-cards/holdings/card-id/state', headers, payload: { action: 'withdraw', reason: '伪造客户退出' } })
    expect(response.statusCode).toBe(400); expect(execute).not.toHaveBeenCalled()
  })
})
