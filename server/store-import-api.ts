import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { InventoryApprovalActorSnapshot } from '../src/shared/inventory-contracts.js'
import { storeImportPackageSchema } from '../src/shared/store-import-contracts.js'
import { requireConfiguredOperation } from './authorization.js'
import { requireRequestActor } from './auth-context.js'
import {
  beginDualApprovalDecision,
  completeDualApprovalDecision,
  requestDualApproval,
} from './dual-approval.js'
import { ensureInventoryDomainState } from './inventory-api.js'
import type { RuntimeRepository } from './repository.js'
import {
  applyStoreImportPackage,
  preflightStoreImportPackage,
  StoreImportValidationError,
} from './store-import.js'

const reason = z.string().trim().min(2).max(500)
const idempotencyKey = z.string().trim().min(8).max(128)
const occurredAt = z.string().datetime({ offset: true })

const applyRequestSchema = z.object({
  package: storeImportPackageSchema,
  reason,
  occurredAt: occurredAt.optional(),
  idempotencyKey: idempotencyKey.optional(),
}).strict()

const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason,
  occurredAt,
  idempotencyKey,
}).strict()

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

function actorSnapshot(request: FastifyRequest, state: Awaited<ReturnType<RuntimeRepository['read']>>) {
  const actor = requireRequestActor(request)
  const employee = state.employees.find((item) => item.id === actor.actorId && item.status === 'active')
  if (!employee) throw new Error('整店导入操作人不存在或已停用')
  return {
    employeeId: employee.id,
    displayName: employee.displayName,
    roleId: actor.roleId,
    authenticatedBy: actor.authenticatedBy,
  } satisfies InventoryApprovalActorSnapshot
}

function storeSnapshot(state: Awaited<ReturnType<RuntimeRepository['read']>>) {
  return structuredClone({
    revision: state.revision,
    store: state.store,
    config: state.config,
    areas: state.areas,
    tables: state.tables,
    employees: state.employees,
    shiftAssignments: state.shiftAssignments,
    products: state.products,
    authorizationAuthorities: state.orderDomain.authorizationAuthorities,
  })
}

function appendApprovalAudit(
  state: Awaited<ReturnType<RuntimeRepository['read']>>,
  input: { approvalId: string; actorId: string; action: string; occurredAt: string; details: Record<string, unknown> },
) {
  state.auditEntries.push({
    id: deterministicId('audit_store_import_approval', `${input.approvalId}:${input.action}:${input.occurredAt}`),
    actorId: input.actorId,
    action: input.action,
    objectType: 'storeImportApproval',
    objectId: input.approvalId,
    occurredAt: input.occurredAt,
    details: structuredClone(input.details),
  })
}

export function registerStoreImportRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post('/api/store-import/preflight', async (request) => {
    const state = await repository.read()
    requireConfiguredOperation(request, state, 'master-data.write')
    return preflightStoreImportPackage(state, request.body)
  })

  app.post('/api/store-import/apply', async (request, reply) => {
    const input = applyRequestSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'store-import.apply')
      const preview = preflightStoreImportPackage(state, input.package)
      if (!preview.valid) throw new StoreImportValidationError(preview.issues)
      const domain = ensureInventoryDomainState(state)
      const requestedAt = input.occurredAt ?? new Date().toISOString()
      const requestKey = input.idempotencyKey ??
        `store-import-request:${input.package.packageId}:${input.package.packageVersion}:${actor.actorId}`
      const beforeCount = domain.approvalRequests.length
      const approval = requestDualApproval(domain, {
        approvalId: deterministicId('store_import_approval', requestKey),
        action: 'store_import',
        targetId: `${input.package.packageId}:v${input.package.packageVersion}`,
        requestPayload: { package: structuredClone(input.package) },
        beforeSnapshot: storeSnapshot(state),
        requestedBy: actorSnapshot(request, state),
        reason: input.reason,
        occurredAt: requestedAt,
        idempotencyKey: requestKey,
      })
      if (domain.approvalRequests.length !== beforeCount) {
        state.revision += 1
        appendApprovalAudit(state, {
          approvalId: approval.id,
          actorId: actor.actorId,
          action: 'store_import.approval.requested.v1',
          occurredAt: requestedAt,
          details: {
            targetId: approval.targetId,
            packageId: input.package.packageId,
            packageVersion: input.package.packageVersion,
            beforeSnapshot: approval.beforeSnapshot,
          },
        })
      }
      return { approval, preview: preview.preview }
    })
    return reply.status(202).send(result)
  })

  app.post<{ Params: { approvalId: string } }>('/api/store-import/approvals/:approvalId/decision', async (request) => {
    const input = decisionSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'store-import.apply')
      const domain = ensureInventoryDomainState(state)
      const command = { ...input, decidedBy: actorSnapshot(request, state) }
      const pending = beginDualApprovalDecision(domain, request.params.approvalId, command)
      if (pending.approval.action !== 'store_import') throw new Error('该审批单不属于整店导入')
      if (pending.replay) return { approval: pending.approval, revision: state.revision }

      if (input.decision === 'reject') {
        const approval = completeDualApprovalDecision(domain, pending.approval.id, command, pending.approval.beforeSnapshot)
        state.revision += 1
        appendApprovalAudit(state, {
          approvalId: approval.id,
          actorId: actor.actorId,
          action: 'store_import.approval.rejected.v1',
          occurredAt: input.occurredAt,
          details: { requestedBy: approval.requestedBy.employeeId, reason: input.reason },
        })
        return { approval, revision: state.revision }
      }

      const payload = z.object({ package: storeImportPackageSchema }).strict().parse(pending.approval.requestPayload)
      const applied = applyStoreImportPackage(state, payload.package, {
        actorId: actor.actorId,
        occurredAt: input.occurredAt,
        reason: `${pending.approval.requestReason}；审批意见：${input.reason}`,
      })
      Object.assign(state, applied.state)
      const importedAudit = state.auditEntries.find((entry) => entry.id === applied.auditEntry.id)
      if (importedAudit) {
        importedAudit.details.approvalId = pending.approval.id
        importedAudit.details.requestedBy = pending.approval.requestedBy.employeeId
        importedAudit.details.approvedBy = actor.actorId
      }
      const currentDomain = ensureInventoryDomainState(state)
      const approval = completeDualApprovalDecision(
        currentDomain,
        pending.approval.id,
        command,
        storeSnapshot(state),
      )
      state.revision += 1
      appendApprovalAudit(state, {
        approvalId: approval.id,
        actorId: actor.actorId,
        action: 'store_import.approval.approved_and_applied.v1',
        occurredAt: input.occurredAt,
        details: {
          requestedBy: approval.requestedBy.employeeId,
          beforeSnapshot: approval.beforeSnapshot,
          afterSnapshot: approval.afterSnapshot,
        },
      })
      return { approval, preview: applied.preview, auditEntry: importedAudit, revision: state.revision }
    })
  })
}
