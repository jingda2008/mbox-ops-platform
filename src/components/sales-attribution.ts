import type { Employee } from '../shared/contracts'

export function salesAttributionEmployees(employees: Employee[]) {
  return employees
    .filter((employee) => employee.status === 'active')
    .toSorted((left, right) => Number(right.online) - Number(left.online) || left.displayName.localeCompare(right.displayName, 'zh-CN'))
}
