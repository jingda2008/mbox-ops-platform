import type { RuntimeState } from '../src/shared/contracts.js'
import type { RuntimeRepository } from './repository.js'

export interface StaffPresenceDirectory {
  storeId: string
  businessDate: string
  revision: number
  employees: Map<string, string>
}

export function buildStaffPresenceDirectory(state: RuntimeState): StaffPresenceDirectory {
  return {
    storeId: state.store.id,
    businessDate: state.store.businessDate,
    revision: state.revision,
    employees: new Map(state.employees
      .filter((employee) => employee.status === 'active')
      .map((employee) => [employee.id, employee.roleId])),
  }
}

export function createStaffPresenceDirectoryResolver(repository: RuntimeRepository, initialState: RuntimeState) {
  let current = buildStaffPresenceDirectory(initialState)
  let refresh: Promise<StaffPresenceDirectory> | null = null

  return async () => {
    const revision = repository.readRevision
      ? await repository.readRevision()
      : (await repository.healthCheck()).revision
    if (revision === null) throw new Error('无法确认员工权限版本')
    if (current.revision === revision) return current
    if (!refresh) {
      // readRevision already proved that the cached directory is stale. A
      // cache-eligible aggregate read can still return the previous business
      // day for a short window on another API instance.
      refresh = (repository.readFresh?.() ?? repository.read())
        .then(buildStaffPresenceDirectory)
        .then((directory) => {
          current = directory
          return directory
        })
        .finally(() => { refresh = null })
    }
    return refresh
  }
}
