import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  benefitCampaignSchema,
  benefitDecisionSchema,
  benefitGrantSchema,
  benefitPolicyWriteSchema,
  benefitTemplateWriteSchema,
} from '../src/shared/benefit-contracts.js'
import type {
  BenefitCampaign,
  BenefitCampaignInput,
  BenefitChannel,
  BenefitDecisionInput,
  BenefitGrantInput,
  BenefitGrantRequest,
  BenefitPolicyWriteInput,
  BenefitTemplateWriteInput,
  MemberBenefit,
  MemberProfile,
} from '../src/shared/benefit-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { RuntimeRepository } from './repository.js'

function audit(
  state: RuntimeState,
  actorId: string,
  action: string,
  objectType: string,
  objectId: string,
  details: Record<string, unknown>,
  now: Date,
) {
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action,
    objectType,
    objectId,
    occurredAt: now.toISOString(),
    details,
  })
}

function actorContext(state: RuntimeState, actorId: string) {
  const employee = state.employees.find((item) => item.id === actorId && item.status === 'active')
  if (!employee) throw new Error('发放人员不存在或已停用')
  const policy = state.benefitGrantPolicies.find((item) => item.roleId === employee.roleId)
  return { employee, policy }
}

function availableQuantity(state: RuntimeState, memberId: string, templateId: string) {
  return state.memberBenefits
    .filter((item) => item.memberId === memberId && item.templateId === templateId && ['available', 'locked'].includes(item.status))
    .reduce((total, item) => total + item.remainingQuantity, 0)
}

function ensureMemberCapacity(state: RuntimeState, memberId: string, templateId: string, quantity: number) {
  const template = state.benefitTemplates.find((item) => item.id === templateId && item.enabled)
  if (!template) throw new Error('权益不存在或已停用')
  if (availableQuantity(state, memberId, templateId) + quantity > template.maxPerMember) {
    throw new Error(`该会员持有的“${template.name}”已达到上限`)
  }
  return template
}

function actorDailyCost(state: RuntimeState, actorId: string, now: Date) {
  const day = now.toISOString().slice(0, 10)
  return state.memberBenefits
    .filter((item) => item.issuedBy === actorId && item.issuedAt.slice(0, 10) === day && item.status !== 'revoked')
    .reduce((total, item) => {
      const template = state.benefitTemplates.find((candidate) => candidate.id === item.templateId)
      return total + (template?.costAmount ?? 0) * item.quantity
    }, 0)
}

function createNotification(
  state: RuntimeState,
  member: MemberProfile,
  benefit: MemberBenefit,
  channel: BenefitChannel,
  now: Date,
) {
  if (channel === 'none') return null
  const template = state.benefitTemplates.find((item) => item.id === benefit.templateId)!
  const channelBound = channel === 'service_account' ? member.serviceAccountBound : member.wecomBound
  const sendable = member.notificationConsent && channelBound
  const failureReason = !member.notificationConsent
    ? '会员未授权该消息触达'
    : !channelBound ? `${channel === 'service_account' ? '服务号' : '企业微信'}未绑定` : null
  const notification = {
    id: `notification_${randomUUID()}`,
    memberId: member.id,
    benefitId: benefit.id,
    campaignId: benefit.campaignId,
    channel,
    status: sendable ? 'queued' as const : 'skipped' as const,
    templateCode: benefit.campaignId ? 'BENEFIT_CAMPAIGN_GRANTED' : 'BENEFIT_GRANTED',
    content: `${member.displayName}，您已获得${template.name}，有效期至${benefit.validUntil.slice(0, 10)}。请在M-Box会员中心查看使用规则。`,
    queuedAt: now.toISOString(),
    sentAt: null,
    failureReason,
    adapter: 'unconfigured' as const,
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: sendable ? now.toISOString() : null,
    providerMessageId: null,
    lastErrorCode: null,
  }
  state.customerNotifications.unshift(notification)
  audit(
    state,
    'system',
    sendable ? 'customer.notification_queued.v1' : 'customer.notification_result.v1',
    'customerNotification',
    notification.id,
    { memberId: member.id, benefitId: benefit.id, channel, status: notification.status, failureReason },
    now,
  )
  return notification
}

function createMemberBenefit(
  state: RuntimeState,
  request: BenefitGrantRequest,
  approvedBy: string | null,
  now: Date,
) {
  const member = state.members.find((item) => item.id === request.memberId)
  if (!member) throw new Error('会员不存在')
  const template = ensureMemberCapacity(state, request.memberId, request.templateId, request.quantity)
  const validUntil = new Date(now)
  validUntil.setUTCDate(validUntil.getUTCDate() + template.validityDays)
  const benefit: MemberBenefit = {
    id: `member_benefit_${randomUUID()}`,
    memberId: request.memberId,
    templateId: request.templateId,
    quantity: request.quantity,
    remainingQuantity: request.quantity,
    status: 'available',
    validFrom: now.toISOString(),
    validUntil: validUntil.toISOString(),
    source: request.source,
    reason: request.reason,
    issuedBy: request.requestedBy,
    approvedBy,
    issuedAt: now.toISOString(),
    grantRequestId: request.id,
    campaignId: request.campaignId,
  }
  state.memberBenefits.unshift(benefit)
  request.status = 'granted'
  request.decidedBy = approvedBy ?? request.requestedBy
  request.decidedAt = now.toISOString()
  request.decisionNote = approvedBy ? '授权人批准发放' : '发放人权限内自动通过'
  request.benefitId = benefit.id
  createNotification(state, member, benefit, request.channel, now)
  audit(state, request.requestedBy, 'benefit.granted.v1', 'memberBenefit', benefit.id, {
    memberId: member.id,
    templateId: template.id,
    quantity: request.quantity,
    approvedBy,
    campaignId: request.campaignId,
  }, now)
  return benefit
}

export function requestBenefitGrant(state: RuntimeState, input: BenefitGrantInput, now = new Date()) {
  const previous = state.benefitGrantRequests.find((item) => item.idempotencyKey === input.idempotencyKey)
  if (previous) return previous
  const member = state.members.find((item) => item.id === input.memberId)
  if (!member) throw new Error('会员不存在')
  const template = ensureMemberCapacity(state, input.memberId, input.templateId, input.quantity)
  const { policy } = actorContext(state, input.actorId)
  const cost = template.costAmount * input.quantity
  const directAllowed = Boolean(
    policy &&
    policy.templateIds.includes(template.id) &&
    cost <= policy.maxCostPerGrantAmount &&
    actorDailyCost(state, input.actorId, now) + cost <= policy.maxDailyCostAmount,
  )
  const request: BenefitGrantRequest = {
    id: `benefit_request_${randomUUID()}`,
    memberId: member.id,
    templateId: template.id,
    quantity: input.quantity,
    reason: input.reason,
    source: 'staff',
    requestedBy: input.actorId,
    requestedAt: now.toISOString(),
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    channel: input.channel,
    campaignId: null,
    benefitId: null,
    idempotencyKey: input.idempotencyKey,
  }
  state.benefitGrantRequests.unshift(request)
  audit(state, input.actorId, 'benefit.requested.v1', 'benefitGrantRequest', request.id, {
    memberId: member.id,
    templateId: template.id,
    quantity: input.quantity,
    directAllowed,
  }, now)
  if (directAllowed) createMemberBenefit(state, request, null, now)
  state.revision += 1
  return request
}

export function decideBenefitGrant(
  state: RuntimeState,
  requestId: string,
  input: BenefitDecisionInput,
  now = new Date(),
) {
  const request = state.benefitGrantRequests.find((item) => item.id === requestId)
  if (!request) throw new Error('权益申请不存在')
  if (request.status !== 'pending') return request
  const { policy } = actorContext(state, input.actorId)
  if (!policy?.canApprove) throw new Error('当前人员没有权益审批权限')
  if (input.decision === 'granted') {
    createMemberBenefit(state, request, input.actorId, now)
  } else {
    request.status = 'rejected'
    request.decidedBy = input.actorId
    request.decidedAt = now.toISOString()
    request.decisionNote = input.note
    audit(state, input.actorId, 'benefit.rejected.v1', 'benefitGrantRequest', request.id, { note: input.note }, now)
  }
  state.revision += 1
  return request
}

function memberMatchesSegment(member: MemberProfile, segment: BenefitCampaignInput['segment'], now: Date) {
  const dormantDays = Math.floor((now.getTime() - new Date(member.lastVisitAt).getTime()) / 86_400_000)
  if (segment === 'dormant_30') return dormantDays >= 30
  if (segment === 'dormant_60') return dormantDays >= 60
  if (segment === 'vip') return ['gold', 'platinum'].includes(member.level)
  return member.notificationConsent
}

export function previewBenefitCampaign(state: RuntimeState, input: BenefitCampaignInput, now = new Date()) {
  const { policy } = actorContext(state, input.actorId)
  if (!policy?.canLaunchCampaign) throw new Error('当前人员没有活动批量发放权限')
  const template = state.benefitTemplates.find((item) => item.id === input.templateId && item.enabled)
  if (!template || !policy.templateIds.includes(template.id)) throw new Error('该权益不在活动发放权限范围内')
  const eligibleMembers = state.members.filter((member) => memberMatchesSegment(member, input.segment, now))
  const issuableMembers = eligibleMembers.filter(
    (member) => availableQuantity(state, member.id, template.id) < template.maxPerMember,
  )
  const reachableCount = issuableMembers.filter((member) => (
    member.notificationConsent && (input.channel === 'service_account' ? member.serviceAccountBound : member.wecomBound)
  )).length
  const estimatedCostAmount = issuableMembers.length * template.costAmount
  return {
    eligibleCount: eligibleMembers.length,
    issuableCount: issuableMembers.length,
    skippedCount: eligibleMembers.length - issuableMembers.length,
    reachableCount,
    estimatedCostAmount,
    withinDailyBudget: actorDailyCost(state, input.actorId, now) + estimatedCostAmount <= policy.maxDailyCostAmount,
  }
}

export function launchBenefitCampaign(state: RuntimeState, input: BenefitCampaignInput, now = new Date()) {
  const previous = state.benefitCampaigns.find((item) => item.idempotencyKey === input.idempotencyKey)
  if (previous) return previous
  const { policy } = actorContext(state, input.actorId)
  if (!policy?.canLaunchCampaign) throw new Error('当前人员没有活动批量发放权限')
  const template = state.benefitTemplates.find((item) => item.id === input.templateId && item.enabled)
  if (!template || !policy.templateIds.includes(template.id)) throw new Error('该权益不在活动发放权限范围内')
  const eligibleMembers = state.members.filter((member) => memberMatchesSegment(member, input.segment, now))
  const projectedCost = eligibleMembers.length * template.costAmount
  if (actorDailyCost(state, input.actorId, now) + projectedCost > policy.maxDailyCostAmount) {
    throw new Error('本次活动预计成本超过发起人的每日权益额度')
  }
  const campaign: BenefitCampaign = {
    id: `benefit_campaign_${randomUUID()}`,
    name: input.name,
    segment: input.segment,
    templateId: template.id,
    channel: input.channel,
    reason: input.reason,
    status: 'completed',
    launchedBy: input.actorId,
    launchedAt: now.toISOString(),
    eligibleCount: eligibleMembers.length,
    issuedCount: 0,
    skippedCount: 0,
    idempotencyKey: input.idempotencyKey,
  }
  state.benefitCampaigns.unshift(campaign)
  for (const member of eligibleMembers) {
    try {
      ensureMemberCapacity(state, member.id, template.id, 1)
      const request: BenefitGrantRequest = {
        id: `benefit_request_${randomUUID()}`,
        memberId: member.id,
        templateId: template.id,
        quantity: 1,
        reason: input.reason,
        source: 'campaign',
        requestedBy: input.actorId,
        requestedAt: now.toISOString(),
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        channel: input.channel,
        campaignId: campaign.id,
        benefitId: null,
        idempotencyKey: `${input.idempotencyKey}:${member.id}`,
      }
      state.benefitGrantRequests.unshift(request)
      createMemberBenefit(state, request, input.actorId, now)
      campaign.issuedCount += 1
    } catch {
      campaign.skippedCount += 1
    }
  }
  audit(state, input.actorId, 'benefit.campaign_completed.v1', 'benefitCampaign', campaign.id, {
    segment: campaign.segment,
    eligibleCount: campaign.eligibleCount,
    issuedCount: campaign.issuedCount,
    skippedCount: campaign.skippedCount,
  }, now)
  state.revision += 1
  return campaign
}

export function updateBenefitTemplate(
  state: RuntimeState,
  templateId: string,
  input: BenefitTemplateWriteInput,
  actorId: string,
  now = new Date(),
) {
  const template = state.benefitTemplates.find((item) => item.id === templateId)
  if (!template) throw new Error('权益模板不存在')
  if (input.productId && !state.products.some((item) => item.id === input.productId && item.enabled)) {
    throw new Error('关联商品不存在或已停用')
  }
  Object.assign(template, input)
  audit(state, actorId, 'benefit.template_updated.v1', 'benefitTemplate', template.id, { code: template.code }, now)
  state.revision += 1
  return template
}

export function updateBenefitPolicy(
  state: RuntimeState,
  policyId: string,
  input: BenefitPolicyWriteInput,
  actorId: string,
  now = new Date(),
) {
  const policy = state.benefitGrantPolicies.find((item) => item.id === policyId)
  if (!policy) throw new Error('权益授权策略不存在')
  if (input.templateIds.some((id) => !state.benefitTemplates.some((template) => template.id === id))) {
    throw new Error('授权策略包含不存在的权益模板')
  }
  Object.assign(policy, input)
  audit(state, actorId, 'benefit.policy_updated.v1', 'benefitGrantPolicy', policy.id, { roleId: policy.roleId }, now)
  state.revision += 1
  return policy
}

export function registerBenefitRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post('/api/benefits/grants', async (request, reply) => {
    const input = benefitGrantSchema.parse(request.body)
    const result = await repository.mutate((state) => requestBenefitGrant(state, input))
    return reply.status(201).send(result)
  })

  app.post<{ Params: { requestId: string } }>('/api/benefits/grants/:requestId/decision', async (request) => {
    const input = benefitDecisionSchema.parse(request.body)
    return repository.mutate((state) => decideBenefitGrant(state, request.params.requestId, input))
  })

  app.post('/api/benefits/campaigns', async (request, reply) => {
    const input = benefitCampaignSchema.parse(request.body)
    const result = await repository.mutate((state) => launchBenefitCampaign(state, input))
    return reply.status(201).send(result)
  })

  app.post('/api/benefits/campaigns/preview', async (request) => {
    const input = benefitCampaignSchema.parse(request.body)
    const state = await repository.read()
    return previewBenefitCampaign(state, input)
  })

  app.put<{ Params: { templateId: string } }>('/api/benefits/templates/:templateId', async (request) => {
    const input = benefitTemplateWriteSchema.parse(request.body)
    return repository.mutate((state) => updateBenefitTemplate(state, request.params.templateId, input, 'emp-chen'))
  })

  app.put<{ Params: { policyId: string } }>('/api/benefits/policies/:policyId', async (request) => {
    const input = benefitPolicyWriteSchema.parse(request.body)
    return repository.mutate((state) => updateBenefitPolicy(state, request.params.policyId, input, 'emp-chen'))
  })
}
