import { describe, expect, it } from 'vitest'
import { createSeedState } from '../../server/seed.js'
import { configDraftSchema, employeeWriteSchema } from './contracts.js'

describe('staff navigation configuration contracts', () => {
  it('accepts one to four role high-frequency entries that belong to role permissions', () => {
    const state = createSeedState()
    const input = {
      ...state.config,
      roles: state.config.roles.map((role) => role.id === 'manager'
        ? { ...role, primaryNavigationIds: ['live', 'tasks', 'reservations', 'payments'] }
        : role),
    }

    expect(configDraftSchema.safeParse(input).success).toBe(true)
  })

  it('rejects a role high-frequency entry outside role permissions', () => {
    const state = createSeedState()
    const input = {
      ...state.config,
      roles: state.config.roles.map((role) => role.id === 'server'
        ? { ...role, primaryNavigationIds: ['config'] }
        : role),
    }

    const result = configDraftSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toBe('高频入口必须属于该岗位已有权限')
  })

  it('allows an employee override to be omitted or reset by omission', () => {
    const state = createSeedState()
    const employee = state.employees[0]!
    expect(employeeWriteSchema.safeParse(employee).success).toBe(true)
    expect(employeeWriteSchema.safeParse({ ...employee, primaryNavigationIds: ['live', 'tasks'] }).success).toBe(true)
    expect(employeeWriteSchema.safeParse({ ...employee, primaryNavigationIds: [] }).success).toBe(false)
  })
})
