import { z } from 'zod'

export type BenefitKind = 'product_gift' | 'amount_coupon' | 'service' | 'song'
export type BenefitChannel = 'none' | 'service_account' | 'wecom'

export interface MemberProfile {
  id: string
  displayName: string
  phoneMasked: string
  level: 'standard' | 'silver' | 'gold' | 'platinum'
  tags: string[]
  lastVisitAt: string
  visitCount: number
  totalSpendAmount: number
  salesOwnerId: string | null
  serviceAccountBound: boolean
  wecomBound: boolean
  notificationConsent: boolean
}

export interface BenefitTemplate {
  id: string
  code: string
  name: string
  kind: BenefitKind
  description: string
  valueAmount: number
  costAmount: number
  productId: string | null
  validityDays: number
  maxPerMember: number
  enabled: boolean
}

export interface BenefitGrantPolicy {
  id: string
  roleId: string
  templateIds: string[]
  maxCostPerGrantAmount: number
  maxDailyCostAmount: number
  canApprove: boolean
  canLaunchCampaign: boolean
}

export interface BenefitGrantRequest {
  id: string
  memberId: string
  templateId: string
  quantity: number
  reason: string
  source: 'staff' | 'campaign' | 'service_recovery'
  requestedBy: string
  requestedAt: string
  status: 'pending' | 'granted' | 'rejected'
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  channel: BenefitChannel
  campaignId: string | null
  benefitId: string | null
  idempotencyKey: string
}

export interface MemberBenefit {
  id: string
  memberId: string
  templateId: string
  quantity: number
  remainingQuantity: number
  status: 'available' | 'locked' | 'redeemed' | 'expired' | 'revoked'
  validFrom: string
  validUntil: string
  source: BenefitGrantRequest['source']
  reason: string
  issuedBy: string
  approvedBy: string | null
  issuedAt: string
  grantRequestId: string
  campaignId: string | null
}

export interface BenefitCampaign {
  id: string
  name: string
  segment: 'dormant_30' | 'dormant_60' | 'vip' | 'all_opted_in'
  templateId: string
  channel: Exclude<BenefitChannel, 'none'>
  reason: string
  status: 'completed' | 'cancelled'
  launchedBy: string
  launchedAt: string
  eligibleCount: number
  issuedCount: number
  skippedCount: number
  idempotencyKey: string
}

export interface CustomerNotification {
  id: string
  memberId: string
  benefitId: string
  campaignId: string | null
  channel: Exclude<BenefitChannel, 'none'>
  status: 'queued' | 'sent' | 'failed' | 'skipped'
  templateCode: string
  content: string
  queuedAt: string
  sentAt: string | null
  failureReason: string | null
  adapter: 'unconfigured' | 'service_account' | 'wecom'
  attemptCount?: number
  lastAttemptAt?: string | null
  nextAttemptAt?: string | null
  providerMessageId?: string | null
  lastErrorCode?: string | null
}

export const benefitGrantSchema = z.object({
  actorId: z.string().trim().min(1),
  memberId: z.string().trim().min(1),
  templateId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(10),
  reason: z.string().trim().min(2).max(200),
  channel: z.enum(['none', 'service_account', 'wecom']),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const benefitDecisionSchema = z.object({
  actorId: z.string().trim().min(1),
  decision: z.enum(['granted', 'rejected']),
  note: z.string().trim().min(2).max(200),
})

export const benefitCampaignSchema = z.object({
  actorId: z.string().trim().min(1),
  name: z.string().trim().min(2).max(80),
  segment: z.enum(['dormant_30', 'dormant_60', 'vip', 'all_opted_in']),
  templateId: z.string().trim().min(1),
  channel: z.enum(['service_account', 'wecom']),
  reason: z.string().trim().min(2).max(200),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const benefitTemplateWriteSchema = z.object({
  name: z.string().trim().min(2).max(60),
  kind: z.enum(['product_gift', 'amount_coupon', 'service', 'song']),
  description: z.string().trim().min(2).max(200),
  valueAmount: z.number().int().min(0).max(10_000_000),
  costAmount: z.number().int().min(0).max(10_000_000),
  productId: z.string().trim().min(1).nullable(),
  validityDays: z.number().int().min(1).max(730),
  maxPerMember: z.number().int().min(1).max(100),
  enabled: z.boolean(),
}).superRefine((value, context) => {
  if (value.kind === 'product_gift' && !value.productId) {
    context.addIssue({ code: 'custom', path: ['productId'], message: '商品赠品权益必须关联商品' })
  }
})

export const benefitPolicyWriteSchema = z.object({
  templateIds: z.array(z.string().trim().min(1)).max(100),
  maxCostPerGrantAmount: z.number().int().min(0).max(100_000_000),
  maxDailyCostAmount: z.number().int().min(0).max(1_000_000_000),
  canApprove: z.boolean(),
  canLaunchCampaign: z.boolean(),
}).refine((value) => value.maxCostPerGrantAmount <= value.maxDailyCostAmount, {
  message: '单次成本上限不能高于每日成本上限',
  path: ['maxCostPerGrantAmount'],
})

export type BenefitGrantInput = z.infer<typeof benefitGrantSchema>
export type BenefitDecisionInput = z.infer<typeof benefitDecisionSchema>
export type BenefitCampaignInput = z.infer<typeof benefitCampaignSchema>
export type BenefitTemplateWriteInput = z.infer<typeof benefitTemplateWriteSchema>
export type BenefitPolicyWriteInput = z.infer<typeof benefitPolicyWriteSchema>
