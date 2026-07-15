import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { storeImportPackageSchema } from '../src/shared/store-import-contracts.js'
import { AuthorizationError, requireConfiguredOperation } from './authorization.js'
import type { RuntimeRepository } from './repository.js'
import { applyStoreImportPackage, preflightStoreImportPackage } from './store-import.js'

const applyRequestSchema = z.object({
  package: storeImportPackageSchema,
  reason: z.string().trim().min(2).max(500),
  approvalActorId: z.string().trim().min(1).max(128),
}).strict()

export function registerStoreImportRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post('/api/store-import/preflight', async (request) => {
    const state = await repository.read()
    requireConfiguredOperation(request, state, 'master-data.write')
    return preflightStoreImportPackage(state, request.body)
  })

  app.post('/api/store-import/apply', async (request) => {
    const input = applyRequestSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'store-import.apply')
      if (input.approvalActorId === actor.actorId) throw new AuthorizationError('整店导入必须由另一名管理人员复核', 'store-import.apply')
      const approver = state.employees.find((employee) =>
        employee.id === input.approvalActorId && employee.status === 'active',
      )
      const approverRole = approver && state.config.roles.find((role) => role.id === approver.roleId)
      if (!approver || !approverRole?.permissionIds?.includes('store_import.apply')) {
        throw new AuthorizationError('复核人岗位无权批准整店导入', 'store-import.apply')
      }
      const result = applyStoreImportPackage(state, input.package, {
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
        reason: `${input.reason}；复核人：${approver.displayName}`,
      })
      Object.assign(state, result.state)
      return { preview: result.preview, auditEntry: result.auditEntry, revision: state.revision }
    })
  })
}
