import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  hardwareCommandRequestSchema,
  hardwareConfigUpdateSchema,
  hardwareHeartbeatSchema,
  hardwareSimulationSchema,
} from '../src/shared/hardware-contracts.js'
import type { RuntimeState, StaffPermissionId } from '../src/shared/contracts.js'
import { effectivePermissionIdsForEmployee } from '../src/shared/staff-access.js'
import { requireRequestActor } from './auth-context.js'
import { AuthorizationError, requireConfiguredOperation, requireTableDataScope } from './authorization.js'
import {
  buildHardwareWorkspace,
  recordHardwareHeartbeat,
  requestHardwareCommand,
  simulateHardwareStatus,
  updateHardwareConfig,
} from './hardware-domain.js'
import type { RuntimeRepository } from './repository.js'

function requireHardwareView(request: FastifyRequest, state: RuntimeState) {
  const actor = requireRequestActor(request)
  const permissions = effectivePermissionIdsForEmployee(state, actor.actorId)
  if (!permissions.includes('hardware.view')) {
    throw new AuthorizationError('当前岗位无权查看设备中心', 'hardware.view')
  }
  return { actor, permissions: new Set<StaffPermissionId>(permissions) }
}

export function registerHardwareRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.get('/api/hardware', async (request) => {
    const state = await repository.read()
    const { permissions } = requireHardwareView(request, state)
    return buildHardwareWorkspace(state, permissions.has('hardware.manage'), permissions.has('hardware.operate'))
  })

  app.put('/api/hardware/config', async (request) => {
    const input = hardwareConfigUpdateSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'hardware.config.write')
      return updateHardwareConfig(state, actor.actorId, input)
    })
  })

  app.post<{ Params: { deviceId: string } }>('/api/hardware/devices/:deviceId/heartbeat', async (request) => {
    const input = hardwareHeartbeatSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'hardware.device.heartbeat')
      return recordHardwareHeartbeat(state, request.params.deviceId, actor.actorId, input)
    })
  })

  app.post<{ Params: { deviceId: string } }>('/api/hardware/devices/:deviceId/simulate', async (request) => {
    const input = hardwareSimulationSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'hardware.config.write')
      return simulateHardwareStatus(state, request.params.deviceId, actor.actorId, input)
    })
  })

  app.post('/api/hardware/commands', async (request, reply) => {
    const input = hardwareCommandRequestSchema.parse(request.body)
    const command = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'hardware.command.execute')
      if (input.tableId) requireTableDataScope(request, state, input.tableId, 'hardware.command.execute')
      return requestHardwareCommand(state, actor.actorId, input)
    })
    return reply.status(201).send(command)
  })
}
