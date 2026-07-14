import { afterEach, describe, expect, it } from 'vitest'
import { PostgresRepository } from './postgres-repository.js'
import { JsonRepository, type RuntimeRepository } from './repository.js'
import { createRuntimeRepository } from './repository-factory.js'
import { loadRuntimeConfig } from './runtime-config.js'

const repositories: RuntimeRepository[] = []

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()))
})

describe('repository factory', () => {
  it('uses JSON only when explicitly configured or in local defaults', () => {
    const repository = createRuntimeRepository(loadRuntimeConfig({ MBOX_RUNTIME_MODE: 'test' }))
    repositories.push(repository)
    expect(repository).toBeInstanceOf(JsonRepository)
  })

  it('constructs a production PostgreSQL repository without opening a connection eagerly', () => {
    const repository = createRuntimeRepository(loadRuntimeConfig({
      MBOX_RUNTIME_MODE: 'production',
      MBOX_REPOSITORY: 'postgres',
      DATABASE_URL: 'postgresql://mbox:secret@db.invalid/mbox?sslmode=verify-full',
      MBOX_TENANT_ID: '11111111-1111-4111-8111-111111111111',
      MBOX_STORE_UUID: '22222222-2222-4222-8222-222222222222',
      MBOX_SESSION_SECRET: 's'.repeat(32),
      MBOX_METRICS_TOKEN: 'm'.repeat(32),
      MBOX_CORS_ORIGINS: 'https://ops.example.com',
      MBOX_PUBLIC_BASE_URL: 'https://api.example.com',
    }))
    repositories.push(repository)
    expect(repository).toBeInstanceOf(PostgresRepository)
  })
})
