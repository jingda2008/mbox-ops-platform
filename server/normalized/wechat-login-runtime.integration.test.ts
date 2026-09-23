import { createHash, randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { wechatApiPlugin } from '../wechat-api.js'
import { PostgresWechatChallengeRepository, PostgresWechatIdentityRepository } from '../wechat-production-adapters.js'
import { assertRuntimeDatabasePool } from './runtime-database-identity.js'
import { CustomerRepository } from './customer-repository.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

const adminUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = adminUrl && runtimeUrl ? describe : describe.skip

integration('WeChat login with the production runtime column permissions', () => {
  const scope = { tenantId: randomUUID(), storeId: randomUUID(), appId: 'wx-runtime-login-fixture' }
  let admin: Pool, runtime: Pool, repository: PostgresWechatIdentityRepository
  const app = Fastify()
  beforeAll(async () => {
    await runNormalizedMigrations(adminUrl!)
    admin = new Pool({ connectionString: adminUrl })
    runtime = new Pool({ connectionString: runtimeUrl })
    await assertRuntimeDatabasePool(runtime, runtimeUrl!)
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Login fixture')", [scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2::uuid,$1::text,'Login fixture')", [scope.storeId, scope.tenantId])
    const options = { ...scope, pool: runtime, activeKeyVersion: 1, encryptionKeys: new Map([[1, Buffer.alloc(32, 9)]]) }
    repository = new PostgresWechatIdentityRepository(options)
    await app.register(wechatApiPlugin, {
      runtimeMode: 'test', stateSecret: 'runtime-login-fixture-secret-at-least-32-characters',
      applications: [scope], identityRepository: repository,
      challengeRepository: new PostgresWechatChallengeRepository(options),
      provider: { exchangeCode: async ({ code }) => ({ ok: true, value: {
        openId: code, unionId: null, sessionKey: 'isolated-provider-fixture-session-key',
      } }) },
    })
    await app.ready()
  })
  afterAll(async () => { await app.close(); await runtime?.end(); await admin?.end() })

  async function login(openId: string) {
    const challenge = await app.inject({ method: 'POST', url: '/api/wechat/challenges', payload: { ...scope, idempotencyKey: randomUUID() } })
    expect(challenge.statusCode).toBe(201)
    const { state, nonce } = challenge.json()
    return app.inject({ method: 'POST', url: '/api/wechat/code-authentication', payload: {
      ...scope, state, nonce, code: openId, idempotencyKey: randomUUID(),
    } })
  }

  it('authenticates new and returning guests and persists readable bearer sessions', async () => {
    const openId = `new-guest-${randomUUID()}`
    const first = await login(openId)
    expect(first.statusCode, first.body).toBe(200)
    const second = await login(openId)
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json().principal).toEqual(first.json().principal)
    const session = await repository.findSession(createHash('sha256').update(second.json().accessToken).digest('base64url'))
    expect(session?.principal).toEqual(first.json().principal)
    const customerId = await new ScopedPostgresTransactionRunner(runtime).run(scope, async transaction => {
      const customers = new CustomerRepository(transaction)
      const customer = await customers.createAnonymous({ publicId: randomUUID() })
      const hash = createHash('sha256').update(`wechat:${session!.principal.principalId}`).digest('hex')
      return (await customers.linkIdentity(customer.customer.id, 'wechat', hash)).id
    })
    expect(await repository.resolveMiniProgramPaymentPayer(customerId, scope.appId)).toBe(openId)
    expect(await repository.resolveMiniProgramPaymentPayer(customerId, 'wrong-app')).toBeNull()
  })

  it('does not grant runtime permission to reassign or delete an identity', async () => {
    const result = await runtime.query("SELECT has_column_privilege(current_user,'mbox.wechat_identities','principal_id','UPDATE') AS reassign, has_table_privilege(current_user,'mbox.wechat_identities','DELETE') AS remove")
    expect(result.rows[0]).toEqual({ reassign: false, remove: false })
  })

  it('rejects a conflicting principal or external identity without changing the stored binding', async () => {
    const openId = `conflict-guest-${randomUUID()}`
    const response = await login(openId)
    expect(response.statusCode, response.body).toBe(200)
    const original = (await repository.findByAppOpenId(scope.tenantId, scope.appId, openId))!
    for (const replacement of [{ ...original, principalId: `other-${randomUUID()}` }, { ...original, id: `other-${randomUUID()}` }]) {
      await expect(repository.save(replacement)).rejects.toThrow(/identity binding conflict/i)
      expect(await repository.findByAppOpenId(scope.tenantId, scope.appId, openId)).toEqual(original)
    }
  })

  it('rejects saves outside the repository store before writing', async () => {
    const openId = `scoped-guest-${randomUUID()}`
    expect((await login(openId)).statusCode).toBe(200)
    const original = (await repository.findByAppOpenId(scope.tenantId, scope.appId, openId))!
    await expect(repository.save({ ...original, storeId: randomUUID() })).rejects.toThrow()
    expect(await repository.findByAppOpenId(scope.tenantId, scope.appId, openId)).toEqual(original)
  })
})
