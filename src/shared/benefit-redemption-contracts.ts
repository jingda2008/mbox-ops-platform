import { z } from 'zod'
import type { BenefitKind } from './benefit-contracts.js'

export type BenefitRedemptionStatus = 'locked' | 'confirmed' | 'cancelled'

export interface BenefitRedemption {
  id: string
  memberBenefitId: string
  memberId: string
  templateId: string
  kind: BenefitKind
  tableId: string
  tableSessionId: string
  tableOpenedAt: string
  quantity: number
  status: BenefitRedemptionStatus
  lockedBy: string
  lockedAt: string
  confirmedBy: string | null
  authorizedBy: string | null
  confirmedAt: string | null
  cancelledBy: string | null
  cancelledAt: string | null
  cancelReason: string | null
  orderId: string | null
  orderItemId: string | null
  authorizationId: string | null
  lockIdempotencyKey: string
  lockFingerprint: string
  confirmIdempotencyKey: string | null
  confirmFingerprint: string | null
  cancelIdempotencyKey: string | null
  cancelFingerprint: string | null
}

const idempotencyKeySchema = z.string().trim().min(8).max(128)

export const benefitRedemptionLockSchema = z.object({
  actorId: z.string().trim().min(1),
  benefitId: z.string().trim().min(1),
  tableId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(100),
  idempotencyKey: idempotencyKeySchema,
})

export const benefitRedemptionConfirmSchema = z.object({
  actorId: z.string().trim().min(1),
  authorizedBy: z.string().trim().min(1),
  idempotencyKey: idempotencyKeySchema,
})

export const benefitRedemptionCancelSchema = z.object({
  actorId: z.string().trim().min(1),
  reason: z.string().trim().min(2).max(200),
  idempotencyKey: idempotencyKeySchema,
})

export type BenefitRedemptionLockInput = z.infer<typeof benefitRedemptionLockSchema>
export type BenefitRedemptionConfirmInput = z.infer<typeof benefitRedemptionConfirmSchema>
export type BenefitRedemptionCancelInput = z.infer<typeof benefitRedemptionCancelSchema>

export interface BenefitRedemptionLockCommand extends BenefitRedemptionLockInput {
  occurredAt: string
}

export interface BenefitRedemptionConfirmCommand extends BenefitRedemptionConfirmInput {
  occurredAt: string
}

export interface BenefitRedemptionCancelCommand extends BenefitRedemptionCancelInput {
  occurredAt: string
}
