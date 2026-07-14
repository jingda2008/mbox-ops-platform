import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { storeImportPackageSchema } from '../src/shared/store-import-contracts.js'
import { requireRequestActor } from './auth-context.js'
import type { RuntimeRepository } from './repository.js'
import { applyStoreImportPackage, preflightStoreImportPackage } from './store-import.js'

const applyRequestSchema = z.object({
  package: storeImportPackageSchema,
  reason: z.string().trim().min(2).max(500),
  approvalActorId: z.string().trim().min(1).max(128),
}).strict()

export function registerStoreImportRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post('/api/store-import/preflight', async (request) => {
    const actor = requireRequestActor(request)
    if (!['supervisor', 'manager'].includes(actor.roleId)) throw new Error('只有领班或经理可以预检整店导入包')
    return preflightStoreImportPackage(await repository.read(), request.body)
  })

  app.post('/api/store-import/apply', async (request) => {
    const actor = requireRequestActor(request)
    const input = applyRequestSchema.parse(request.body)
    if (actor.roleId !== 'manager') throw new Error('只有经理可以应用整店导入包')
    if (input.approvalActorId === actor.actorId) throw new Error('整店导入必须由另一名管理人员复核')
    return repository.mutate((state) => {
      const approver = state.employees.find((employee) =>
        employee.id === input.approvalActorId && employee.status === 'active' &&
        ['supervisor', 'manager'].includes(employee.roleId),
      )
      if (!approver) throw new Error('复核人必须是在职领班或经理')
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
