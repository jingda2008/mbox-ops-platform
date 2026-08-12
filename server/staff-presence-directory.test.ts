import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { RuntimeRepository, RuntimeRepositoryHealth } from './repository.js'
import { createSeedState } from './seed.js'
import { createStaffPresenceDirectoryResolver } from './staff-presence-directory.js'

class RevisionRepository implements RuntimeRepository {
  state = createSeedState()
  reads = 0
  directoryReads = 0
  async init() {}
  async read() { this.reads += 1; return structuredClone(this.state) }
  async readFresh() { this.reads += 1; return structuredClone(this.state) }
  async readRevision() { return this.state.revision }
  async readStaffDirectory() {
    this.directoryReads += 1
    return {
      storeId: this.state.store.id,
      businessDate: this.state.store.businessDate,
      revision: this.state.revision,
      employees: this.state.employees.map(({ id, roleId, status }) => ({ id, roleId, status })),
    }
  }
  async mutate<T>(mutation: (state: RuntimeState) => T | Promise<T>) {
    const working = structuredClone(this.state)
    const result = await mutation(working)
    this.state = working
    return result
  }
  async reset() { return structuredClone(this.state) }
  async healthCheck(): Promise<RuntimeRepositoryHealth> { return { ready: true, repository: 'test', revision: this.state.revision } }
  async close() {}
}

describe('staff presence directory', () => {
  it('reuses the directory at the same revision and invalidates immediately after an employee is disabled', async () => {
    const repository = new RevisionRepository()
    const resolve = createStaffPresenceDirectoryResolver(repository, repository.state)

    expect((await resolve()).employees.has('emp-chen')).toBe(true)
    expect(repository.reads).toBe(0)
    repository.state.employees.find((employee) => employee.id === 'emp-chen')!.status = 'inactive'
    repository.state.revision += 1

    expect((await resolve()).employees.has('emp-chen')).toBe(false)
    expect(repository.reads).toBe(0)
    expect(repository.directoryReads).toBe(1)
    await resolve()
    expect(repository.reads).toBe(0)
    expect(repository.directoryReads).toBe(1)
  })

  it('uses a fresh aggregate after another instance rolls the business day', async () => {
    const repository = new RevisionRepository()
    const initial = structuredClone(repository.state)
    const resolve = createStaffPresenceDirectoryResolver(repository, initial)
    repository.state.store.businessDate = '2030-08-10'
    repository.state.revision += 1

    const directory = await resolve()

    expect(directory.businessDate).toBe('2030-08-10')
    expect(directory.revision).toBe(repository.state.revision)
    expect(repository.reads).toBe(0)
    expect(repository.directoryReads).toBe(1)
  })
})
