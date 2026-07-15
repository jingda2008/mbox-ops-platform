import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { JsonRepository } from './repository.js'
import { registerTableSessionRoutes } from './table-session-api.js'

async function fixture(actorId: string, roleId: string) {
  const repository = new JsonRepository(`/tmp/mbox-table-transfer-api-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.mboxActor = {
      actorId, roleId, storeId: 'mbox-lujiazui', runtimeMode: 'test', authenticatedBy: 'local_header',
    }
  })
  registerTableSessionRoutes(app, repository)
  return { app, repository }
}

const payload = {
  targetTableId: 'table-l04',
  kind: 'relocate',
  reason: '顾客现场申请更换位置',
  idempotencyKey: 'table-transfer-api-001',
}

describe('table transfer API authorization', () => {
  it('allows a manager and keeps an idempotent transfer record', async () => {
    const { app, repository } = await fixture('emp-chen', 'manager')
    const first = await app.inject({ method: 'POST', url: '/api/tables/table-l01/transfer', payload })
    const replay = await app.inject({ method: 'POST', url: '/api/tables/table-l01/transfer', payload })
    expect(first.statusCode).toBe(200)
    expect(replay.json()).toEqual(first.json())
    expect((await repository.read()).tableTransfers).toHaveLength(1)
    await app.close()
    await repository.close()
  })

  it('denies a server even for an assigned table', async () => {
    const { app, repository } = await fixture('emp-lin', 'server')
    const response = await app.inject({ method: 'POST', url: '/api/tables/table-l01/transfer', payload })
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('AUTHORIZATION_DENIED')
    expect((await repository.read()).tableTransfers).toHaveLength(0)
    await app.close()
    await repository.close()
  })
})
