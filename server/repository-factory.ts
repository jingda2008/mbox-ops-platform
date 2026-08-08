import { Pool } from 'pg'
import { asPostgresPool, PostgresRepository, type PostgresPool } from './postgres-repository.js'
import { JsonRepository, type RuntimeRepository } from './repository.js'
import type { RuntimeConfig } from './runtime-config.js'
import { PostgresOperationalProjector } from './operational-projection.js'
import { PostgresOperationalReadStore } from './operational-read-store.js'

export interface RuntimeDependencies {
  repository: RuntimeRepository
  postgresPool?: PostgresPool
  operationalReadStore?: PostgresOperationalReadStore
}

export function createRuntimeDependencies(config: RuntimeConfig): RuntimeDependencies {
  if ((config.runtimeMode === 'staging' || config.runtimeMode === 'production') && config.repositoryMode !== 'postgres') {
    throw new Error('预发布和生产环境必须使用PostgreSQL仓储')
  }
  if (config.repositoryMode === 'json') return { repository: new JsonRepository(config.jsonStatePath) }
  const nativePool = new Pool({
    connectionString: config.databaseUrl,
    application_name: `mbox-ops-${config.runtimeMode}`,
    max: config.databasePoolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
  })
  const postgresPool = asPostgresPool(nativePool)
  return { repository: new PostgresRepository({
    pool: postgresPool,
    tenantId: config.tenantId!,
    storeId: config.storeUuid!,
    seedState: null,
    readCacheValidationTtlMs: config.stateReadCacheMs,
    maxPendingMutations: config.databaseMutationQueueMax,
    mutationQueueTimeoutMs: config.databaseMutationQueueWaitMs,
    projector: new PostgresOperationalProjector(),
  }), postgresPool, operationalReadStore: new PostgresOperationalReadStore(postgresPool, {
    tenantId: config.tenantId!,
    storeId: config.storeUuid!,
  }) }
}

export function createRuntimeRepository(config: RuntimeConfig): RuntimeRepository {
  return createRuntimeDependencies(config).repository
}
