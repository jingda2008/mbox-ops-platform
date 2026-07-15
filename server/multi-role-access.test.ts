import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RequestActorContext } from '../src/shared/auth-contracts.js'
import { requireAnyRole, requireConfiguredOperation } from './authorization.js'
import { createSeedState } from './seed.js'

function request(actor: RequestActorContext) {
  return { mboxActor: actor } as FastifyRequest
}

describe('configurable multi-role account access', () => {
  it('unions the active shift duties and direct permissions without changing the default home role', () => {
    const state = createSeedState()
    const employee = state.employees.find((item) => item.id === 'emp-host')!
    const shift = state.shiftAssignments.find((item) => item.employeeId === employee.id)!
    employee.roleIds = ['server']
    employee.permissionIds = ['kds.deliver']
    shift.roleIds = ['server', 'runner']
    const actor = request({
      actorId: employee.id,
      roleId: 'host',
      storeId: state.store.id,
      runtimeMode: 'test',
      authenticatedBy: 'local_header',
    })

    expect(requireConfiguredOperation(actor, state, 'commerce.order.create')).toMatchObject({ actorId: employee.id, roleId: 'server' })
    expect(requireConfiguredOperation(actor, state, 'commerce.kds.deliver')).toMatchObject({ actorId: employee.id })
    expect(requireAnyRole(actor, state, ['runner'], 'delivery')).toMatchObject({ actorId: employee.id, roleId: 'runner' })
    expect(employee.roleId).toBe('host')
  })
})
