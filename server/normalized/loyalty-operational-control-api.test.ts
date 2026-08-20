import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loyaltyOperationalControlApiPlugin } from './loyalty-operational-control-api.js'
import { LoyaltyOperationalControlError, type LoyaltyOperationalControlService } from './loyalty-operational-control-service.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'

const apps:ReturnType<typeof Fastify>[]=[]
const scope={ tenantId:'87000000-0000-4000-8000-000000000001',storeId:'87000000-0000-4000-8000-000000000002' }
afterEach(async()=>{ await Promise.all(apps.splice(0).map((app)=>app.close()));vi.restoreAllMocks() })

describe('loyalty operational control API',()=>{
  it('requires separate view/control permissions and passes only typed pause facts',async()=>{
    const checked:string[]=[]
    const service={
      list:vi.fn(async()=>[]),
      set:vi.fn(async()=>({ value:{ capability:'points_accrual',state:'paused',version:1 },replayed:false })),
    }
    const app=fixture(service,async(_employee,permission)=>{checked.push(permission);return {}})
    const view=await app.inject({ method:'GET',url:'/staff/loyalty/operational-controls' })
    const pause=await app.inject({
      method:'PUT',url:'/staff/loyalty/operational-controls/points_accrual',
      headers:{ 'idempotency-key':'loyalty-emergency-pause-api-001' },
      payload:{ operation:'pause',reason:'发现积分规则异常，暂停等待复核',reviewAt:'2099-08-17T10:00:00Z',expectedVersion:0 },
    })
    expect([view.statusCode,pause.statusCode]).toEqual([200,200])
    expect(checked).toEqual(['loyalty.operations.view','loyalty.operations.control'])
    expect(service.set).toHaveBeenCalledWith(expect.objectContaining({ employeeId:expect.any(String) }),{
      capability:'points_accrual',operation:'pause',reason:'发现积分规则异常，暂停等待复核',
      reviewAt:'2099-08-17T10:00:00Z',expectedVersion:0,idempotencyKey:'loyalty-emergency-pause-api-001',
    })
  })

  it('rejects unsupported capability, stale version and staff permission bypass',async()=>{
    const service={
      set:vi.fn(async()=>{ throw new LoyaltyOperationalControlError('LOYALTY_OPERATION_CONTROL_VERSION_CONFLICT','已被修改') }),
      list:vi.fn(),
    }
    const app=fixture(service,async()=>({}))
    const unsupported=await app.inject({ method:'PUT',url:'/staff/loyalty/operational-controls/payment',
      headers:{'idempotency-key':'loyalty-emergency-invalid-001'},
      payload:{operation:'pause',reason:'错误能力',expectedVersion:0} })
    const stale=await app.inject({ method:'PUT',url:'/staff/loyalty/operational-controls/points_redemption',
      headers:{'idempotency-key':'loyalty-emergency-stale-001'},
      payload:{operation:'pause',reason:'暂停兑换检查',expectedVersion:0} })
    expect(unsupported.statusCode).toBe(400)
    expect(stale.statusCode).toBe(409)

    const deniedService={ list:vi.fn() }
    const denied=fixture(deniedService,async()=>{throw new StaffAccessDeniedError('denied')})
    const deniedResponse=await denied.inject({method:'GET',url:'/staff/loyalty/operational-controls'})
    expect(deniedResponse.statusCode).toBe(403)
    expect(deniedService.list).not.toHaveBeenCalled()
  })

  it('rejects blank reasons, past review times and review scheduling on resume',async()=>{
    const service={set:vi.fn()}
    const app=fixture(service,async()=>({}))
    const payloads=[
      {operation:'pause',reason:' ',expectedVersion:0},
      {operation:'pause',reason:'暂停检查',reviewAt:'2020-01-01T00:00:00Z',expectedVersion:0},
      {operation:'resume',reason:'复核后恢复',reviewAt:'2099-01-01T00:00:00Z',expectedVersion:1},
    ]
    for (const [index,payload] of payloads.entries()) {
      const response=await app.inject({method:'PUT',url:'/staff/loyalty/operational-controls/wechat_notification',
        headers:{'idempotency-key':`loyalty-emergency-invalid-${index+10}`},payload})
      expect(response.statusCode).toBe(400)
    }
    expect(service.set).not.toHaveBeenCalled()
  })
})

function fixture(
  service:Record<string,ReturnType<typeof vi.fn>>,
  assertPermission:(employeeId:string,permission:string)=>Promise<unknown>,
) {
  const app=Fastify();apps.push(app)
  void app.register(loyaltyOperationalControlApiPlugin,{
    transactions:{run:async(_scope,operation)=>operation({scope} as never)},
    service:service as unknown as LoyaltyOperationalControlService,
    resolveStaffContext:()=>({scope,employeeId:'87000000-0000-4000-8000-000000000003',businessDate:'2026-08-16'}),
    createStaffAccessRepository:()=>({assertPermission}),
  })
  return app
}
