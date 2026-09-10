import {describe,it,expect,vi} from 'vitest'
import {ActivityOperationsService} from './activity-operations-service.js'
import type {NormalizedCommandExecutor} from './command-executor.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {StaffAccessDeniedError} from './staff-access-repository.js'

describe('activity closure live permission',()=>{
  it('refuses revoked permission before locking or changing the activity',async()=>{
    const query=vi.fn(async()=>({rows:[{allowed:false}],rowCount:1}))
    const scope={tenantId:'tenant',storeId:'store'}
    const tx={scope,query} as unknown as ScopedTransaction
    const commands={execute:async(_command:unknown,handler:(value:ScopedTransaction)=>Promise<unknown>)=>handler(tx)} as unknown as NormalizedCommandExecutor
    const service=new ActivityOperationsService({run:vi.fn()},commands)
    await expect(service.closeActivity({scope,employeeId:'employee',businessDate:'2026-09-10'},
      {publicId:'activity',status:'cancelled',reason:'取消测试',idempotencyKey:'close-attempt-1'})).rejects.toBeInstanceOf(StaffAccessDeniedError)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('employee_has_effective_permission'),['tenant','store','employee','community.activity.manage']])
    query.mockClear()
    await expect(service.stopRegistration({scope,employeeId:'employee',businessDate:'2026-09-10'},
      {publicId:'activity',reason:'停止报名测试',idempotencyKey:'stop-attempt-1'})).rejects.toBeInstanceOf(StaffAccessDeniedError)
    expect(query).toHaveBeenCalledTimes(1)
  })
})
