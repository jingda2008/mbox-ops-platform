import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerAuthContext } from './auth-context.js'
import { AuthorizationError } from './authorization.js'
import { registerHardwareRoutes } from './hardware-api.js'
import { HardwareBusinessError } from './hardware-domain.js'
import { JsonRepository } from './repository.js'

function headers(actorId: string) {
  return { 'x-mbox-actor-id': actorId, 'x-mbox-store-id': 'mbox-lujiazui' }
}

async function fixture() {
  const repository = new JsonRepository(`/tmp/mbox-hardware-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  await registerAuthContext(app, { runtimeMode: 'test', readState: () => repository.read() })
  registerHardwareRoutes(app, repository)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthorizationError || error instanceof HardwareBusinessError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message })
    }
    return reply.status(400).send({ message: error.message })
  })
  return { app, repository }
}

describe('hardware API', () => {
  it('lets a manager view and operate devices but not change configuration', async () => {
    const { app, repository } = await fixture()
    const workspace = await app.inject({ method: 'GET', url: '/api/hardware', headers: headers('emp-chen') })
    expect(workspace.statusCode, workspace.body).toBe(200)
    expect(workspace.json()).toMatchObject({ canManage: false, canOperate: true, summary: { simulated: 5 } })

    const command = await app.inject({
      method: 'POST', url: '/api/hardware/commands', headers: headers('emp-chen'),
      payload: {
        kind: 'camera_capture', deviceId: 'sim-camera-lounge', source: 'manual', tableId: 'table-l01',
        content: '经理检查L01关键事件画面链路', requestedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(),
      },
    })
    expect(command.statusCode, command.body).toBe(201)
    expect(command.json()).toMatchObject({ status: 'completed', simulation: true, verified: false })

    const config = (workspace.json() as { state: { config: Record<string, unknown>; devices: Array<Record<string, unknown>> } }).state
    const {
      version: _version,
      updatedAt: _configUpdatedAt,
      updatedBy: _configUpdatedBy,
      ...editableConfig
    } = config.config
    const forbidden = await app.inject({
      method: 'PUT', url: '/api/hardware/config', headers: headers('emp-chen'),
      payload: {
        ...editableConfig,
        devices: config.devices.map(({ status: _status, lastHeartbeatAt: _heartbeat, lastStatusChangeAt: _change, diagnostics: _diagnostics, updatedAt: _updatedAt, updatedBy: _updatedBy, ...device }) => device),
        reason: '经理不应有配置权限', idempotencyKey: crypto.randomUUID(),
      },
    })
    expect(forbidden.statusCode).toBe(403)
    await app.close()
    await repository.close()
  })

  it('keeps frontline service staff outside the device center and lets admins run failure simulation', async () => {
    const { app, repository } = await fixture()
    const denied = await app.inject({ method: 'GET', url: '/api/hardware', headers: headers('emp-lin') })
    expect(denied.statusCode).toBe(403)

    const simulated = await app.inject({
      method: 'POST', url: '/api/hardware/devices/sim-camera-lounge/simulate', headers: headers('emp-admin'),
      payload: { status: 'offline', message: '验证离线降级', occurredAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID() },
    })
    expect(simulated.statusCode, simulated.body).toBe(200)
    expect(simulated.json()).toMatchObject({ id: 'sim-camera-lounge', status: 'offline' })
    await app.close()
    await repository.close()
  })
})
