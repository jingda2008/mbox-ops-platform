import pg from 'pg'
import { asPostgresPool } from '../dist-server/server/postgres-repository.js'
import { PostgresPresenceLeaseStore } from '../dist-server/server/presence-store.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('员工在线租约验证必须配置DATABASE_URL')

const tenantId = '33333333-3333-4333-8333-333333333333'
const storeId = '44444444-4444-4444-8444-444444444444'
const otherStoreId = '55555555-5555-4555-8555-555555555555'
const businessDate = '2026-08-09'
const admin = new pg.Client({ connectionString: databaseUrl, application_name: 'mbox-presence-verifier-admin' })
await admin.connect()
await admin.query(
  `INSERT INTO mbox.tenants(id, code, name) VALUES ($1::uuid, 'presence-ci', 'Presence CI')
   ON CONFLICT (id) DO NOTHING`,
  [tenantId],
)
for (const [id, code] of [[storeId, 'presence-a'], [otherStoreId, 'presence-b']]) {
  await admin.query(
    `INSERT INTO mbox.stores(id, tenant_id, code, name, timezone)
     VALUES ($1::uuid, $2::uuid, $3, $3, 'Asia/Shanghai') ON CONFLICT (id) DO NOTHING`,
    [id, tenantId, code],
  )
}

const rawPool = new pg.Pool({ connectionString: databaseUrl, max: 4, application_name: 'mbox-presence-verifier' })
const measuredPool = asPostgresPool(rawPool)
const rolePool = {
  ...measuredPool,
  connect: async () => {
    const client = await measuredPool.connect()
    await client.query('SET ROLE mbox_app')
    return client
  },
}
const firstInstance = new PostgresPresenceLeaseStore({ pool: rolePool, tenantId, storeId })
const secondInstance = new PostgresPresenceLeaseStore({ pool: rolePool, tenantId, storeId })
const now = Date.parse('2026-08-09T12:00:00.000Z')
const lease = {
  sessionId: 'presence-ci-session', actorId: 'employee-liyan', storeId: 'mbox-lujiazui', businessDate,
  establishedAt: now, lastSeenAt: now, expiresAt: now + 60_000, sessionExpiresAt: now + 6 * 60 * 60_000,
}

try {
  await firstInstance.upsert(lease)
  const active = await secondInstance.findActive({ ...lease, now: now + 1_000 })
  if (!active) throw new Error('第二实例看不到第一实例创建的租约')
  if (active.businessDate !== businessDate) {
    throw new Error(`营业日跨时区读取错误：${active.businessDate} != ${businessDate}`)
  }

  await firstInstance.heartbeat({ ...lease, now: now + 20_000, leaseTtlMs: 60_000 })
  const stale = await secondInstance.heartbeat({ ...lease, now: now + 10_000, leaseTtlMs: 60_000 })
  if (!stale || stale.lastSeenAt !== now + 20_000 || stale.expiresAt !== now + 80_000) {
    throw new Error('乱序心跳回退了租约时间')
  }

  await secondInstance.revoke({ sessionId: lease.sessionId, actorId: lease.actorId, now: now + 30_000 })
  if (!await firstInstance.isRevoked(lease)) throw new Error('跨实例未立即看到撤销状态')
  if (await firstInstance.findActive({ ...lease, now: now + 31_000 })) throw new Error('撤销后租约仍可用于鉴权')
  await firstInstance.upsertMany([lease])
  if (await secondInstance.findActive({ ...lease, now: now + 31_000 })) throw new Error('启动回填复活了已撤销租约')

  const removedEarly = await firstInstance.removeExpired(businessDate, now + 60_000)
  if (removedEarly.includes(lease.sessionId) || !await secondInstance.isRevoked(lease)) {
    throw new Error('签名会话到期前删除了撤销墓碑')
  }
  const removedAfterExpiry = await firstInstance.removeExpired(businessDate, lease.sessionExpiresAt + 1)
  if (!removedAfterExpiry.includes(lease.sessionId) || await secondInstance.isRevoked(lease)) {
    throw new Error('签名会话到期后未清理撤销墓碑')
  }

  console.log(JSON.stringify({ verified: true, crossInstance: true, rlsRole: 'mbox_app', businessDateRoundTrip: true, monotonicHeartbeat: true, durableRevocation: true }))
} finally {
  await rawPool.end()
  await admin.query('DELETE FROM mbox.stores WHERE tenant_id = $1::uuid', [tenantId]).catch(() => undefined)
  await admin.query('DELETE FROM mbox.tenants WHERE id = $1::uuid', [tenantId]).catch(() => undefined)
  await admin.end()
}
