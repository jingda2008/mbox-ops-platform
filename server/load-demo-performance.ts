import { Pool } from 'pg'
import { asPostgresPool, PostgresRepository } from './postgres-repository.js'
import { loadDemoPerformance } from './demo-performance.js'

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少${name}`)
  return value
}

if (process.env.MBOX_CONFIRM_DEMO_PERFORMANCE !== 'LOAD_DEMO') {
  throw new Error('加载演示排班必须设置MBOX_CONFIRM_DEMO_PERFORMANCE=LOAD_DEMO')
}

const pool = new Pool({ connectionString: required('DATABASE_URL'), application_name: 'mbox-demo-performance-loader' })
const repository = new PostgresRepository({
  pool: asPostgresPool(pool),
  tenantId: required('MBOX_TENANT_ID'),
  storeId: required('MBOX_STORE_UUID'),
})

try {
  await repository.init()
  const session = await repository.mutate((state) => loadDemoPerformance(state))
  process.stdout.write(JSON.stringify({
    performanceSessionId: session.id,
    currentSingerId: session.appearances[0]?.singerId,
    currentEndsAt: session.appearances[0]?.endsAt,
    nextSingerId: session.appearances[1]?.singerId,
    nextStartsAt: session.appearances[1]?.startsAt,
  }))
} finally {
  await repository.close()
}
