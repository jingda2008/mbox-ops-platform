import { z } from 'zod'
import type { AuditEntry, RuntimeState, StoreConfig } from './contracts.js'

export type ConfigVersionOperation = 'baseline' | 'publish' | 'rollback'

export interface ConfigVersionRecord {
  id: string
  storeId: string
  version: number
  operation: ConfigVersionOperation
  sourceVersion: number | null
  rollbackTargetVersion: number | null
  snapshot: StoreConfig
  actorId: string
  reason: string
  idempotencyKey: string
  createdAt: string
}

export interface ConfigVersioningResult {
  state: RuntimeState
  versions: ConfigVersionRecord[]
  record: ConfigVersionRecord
  auditEntry: AuditEntry
  idempotent: boolean
}

const actorIdSchema = z.string().trim().min(1).max(128)
const reasonSchema = z.string().trim().min(2).max(500)
const idempotencyKeySchema = z.string().trim().min(8).max(128)
const occurredAtSchema = z.string().datetime({ offset: true })

export const publishConfigVersionSchema = z.object({
  actorId: actorIdSchema,
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
  occurredAt: occurredAtSchema,
})

export const rollbackConfigVersionSchema = publishConfigVersionSchema.extend({
  targetVersion: z.number().int().positive(),
})

export type PublishConfigVersionCommand = z.infer<typeof publishConfigVersionSchema>
export type RollbackConfigVersionCommand = z.infer<typeof rollbackConfigVersionSchema>
