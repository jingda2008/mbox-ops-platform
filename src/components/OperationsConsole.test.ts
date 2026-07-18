import { describe, expect, it } from 'vitest'
import type { Employee } from '../shared/contracts'
import { salesAttributionEmployees } from './sales-attribution'

function employee(id: string, displayName: string, status: Employee['status'], online: boolean): Employee {
  return {
    id,
    displayName,
    initials: displayName.slice(0, 1),
    status,
    roleId: 'server',
    online,
    paused: false,
    areaIds: [],
    skillIds: [],
  }
}

describe('salesAttributionEmployees', () => {
  it('keeps active staff selectable when their device presence is offline', () => {
    const options = salesAttributionEmployees([
      employee('tom', 'Tom', 'active', false),
      employee('jerry', 'Jerry', 'active', true),
      employee('former', '离职员工', 'inactive', true),
    ])

    expect(options.map((item) => item.id)).toEqual(['jerry', 'tom'])
  })
})
