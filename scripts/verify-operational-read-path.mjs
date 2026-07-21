import pg from 'pg'
import { asPostgresPool, PostgresRepository } from '../dist-server/server/postgres-repository.js'
import { PostgresOperationalProjector } from '../dist-server/server/operational-projection.js'
import {
  hydrateRuntimeStateFromOperationalTables,
  PostgresOperationalReadStore,
} from '../dist-server/server/operational-read-store.js'
import { createSeedState } from '../dist-server/server/seed.js'
import { provisionRuntime } from '../dist-server/server/provision-runtime.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('规范化读取集成验证必须配置DATABASE_URL')

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const state = createSeedState(new Date('2026-07-21T12:00:00.000Z'))

await provisionRuntime({
  databaseUrl,
  tenantId,
  tenantCode: 'ci-tenant',
  tenantName: 'CI Tenant',
  storeUuid: storeId,
  storeCode: state.store.id,
  state,
})

const pool = asPostgresPool(new pg.Pool({ connectionString: databaseUrl, max: 4 }))
const repository = new PostgresRepository({
  pool,
  tenantId,
  storeId,
  seedState: null,
  projector: new PostgresOperationalProjector(),
})

try {
  await repository.init()
  const before = await repository.readFresh()
  const operationalStore = new PostgresOperationalReadStore(pool, { tenantId, storeId })
  const firstSnapshot = await operationalStore.read(before.revision, before.store.businessDate)
  if (firstSnapshot.tables.length !== before.tables.length) {
    throw new Error(`首次回填桌台数量不一致：${firstSnapshot.tables.length}/${before.tables.length}`)
  }

  const target = before.tables[0]
  await repository.mutate((working) => {
    working.tables[0] = { ...working.tables[0], guestCount: working.tables[0].guestCount + 1 }
    working.revision += 1
  })

  const after = await repository.readFresh()
  const secondSnapshot = await operationalStore.read(after.revision, after.store.businessDate)
  const hydrated = hydrateRuntimeStateFromOperationalTables(after, secondSnapshot)
  if (secondSnapshot.tables.length !== after.tables.length) {
    throw new Error(`单行变更后未变化桌台丢失：${secondSnapshot.tables.length}/${after.tables.length}`)
  }
  if (hydrated.tables.find((table) => table.id === target.id)?.guestCount !== target.guestCount + 1) {
    throw new Error('单行变更未同步到规范化读取结果')
  }

  const health = await repository.healthCheck()
  if (!health.ready || !health.projectionReady || !health.projectionCountsMatch || health.projectionRevision !== after.revision) {
    throw new Error(`规范化投影健康检查失败：${JSON.stringify(health)}`)
  }
  console.log(JSON.stringify({
    verified: true,
    revision: after.revision,
    tables: secondSnapshot.tables.length,
    projectionRevision: health.projectionRevision,
    countsMatch: health.projectionCountsMatch,
  }))
} finally {
  await repository.close()
}
