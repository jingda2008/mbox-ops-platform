import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { PublicCustomerExperienceContext } from './customer-experience-service.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { WechatLoyaltyNotificationRepository } from './wechat-loyalty-notification-repository.js'
import { WechatMemberServiceNotificationRepository } from './wechat-member-service-notification-repository.js'
import { ReservationPerformanceNotificationRepository } from './reservation-performance-notification-repository.js'
import {
  decideWechatNotificationPresentation,
  decideWechatNotificationPrompt,
  WECHAT_NOTIFICATION_PROMPT_CONTEXTS,
  type WechatNotificationPromptContext,
  type WechatNotificationPromptOption,
} from './wechat-notification-prompt-decision-engine.js'

interface Options {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  channelConfigured: boolean
  resolvePublicContext(request: FastifyRequest): Promise<PublicCustomerExperienceContext> | PublicCustomerExperienceContext
}

export const wechatNotificationPromptApiPlugin: FastifyPluginAsync<Options> = async (app, options) => {
  app.get('/public/mini/wechat-notification-prompt', async (request, reply) => {
    let context: WechatNotificationPromptContext
    try { context = promptContext(request.query) } catch {
      return reply.status(400).send({
        code: 'WECHAT_NOTIFICATION_PROMPT_CONTEXT_INVALID', message: '提醒触发场景格式不正确',
      })
    }
    if (!options.channelConfigured) return reply.send({
      data: { available: false, context, authorizations: [], presentation: [] },
    })
    const customer = await options.resolvePublicContext(request)
    const payload = await options.transactions.run(customer.scope, async (transaction) => {
      const [loyaltyAuthorizations, memberServiceAuthorizations, performancePolicy] = await Promise.all([
        new WechatLoyaltyNotificationRepository(transaction).authorizationOptions(customer.customerId, true),
        new WechatMemberServiceNotificationRepository(transaction).authorizationOptions(customer.customerId, true),
        reservationPerformancePresentation(context, transaction, options.channelConfigured),
      ])
      const input = {
        context,
        loyaltyAuthorizations,
        memberServiceAuthorizations,
        reservationPerformanceAuthorizations: performancePolicy ? [performancePolicy] : [],
      }
      return {
        authorizations: decideWechatNotificationPrompt(input),
        presentation: decideWechatNotificationPresentation(input),
      }
    }, { readOnly: true })
    return reply.send({
      data: {
        available: payload.authorizations.length > 0,
        context,
        authorizations: payload.authorizations,
        presentation: payload.presentation,
      },
    })
  })
}

async function reservationPerformancePresentation(
  context: WechatNotificationPromptContext,
  transaction: Parameters<Parameters<Options['transactions']['run']>[1]>[0],
  channelConfigured: boolean,
): Promise<WechatNotificationPromptOption | null> {
  if (context !== 'reservation_submit' && context !== 'reservation_performance') return null
  const policy = await new ReservationPerformanceNotificationRepository(transaction)
    .presentationPolicy(channelConfigured)
  if (!policy || !policy.templateId.trim()) return null
  return {
    apiKind: 'reservation_performance',
    policyId: policy.policyId,
    notificationType: 'reservation_performance_revised',
    policyVersion: policy.policyVersion,
    templateId: policy.templateId,
    decision: policy.decision,
    platformResult: policy.platformResult,
    authorizationVersion: policy.authorizationVersion,
    usesRemaining: policy.usesRemaining,
    changedAt: policy.changedAt,
    reservationPublicId: policy.reservationPublicId || undefined,
  }
}

function promptContext(value: unknown): WechatNotificationPromptContext {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).context : null
  if (typeof candidate !== 'string' || !WECHAT_NOTIFICATION_PROMPT_CONTEXTS.includes(candidate as WechatNotificationPromptContext)) {
    throw new TypeError('提醒触发场景格式不正确')
  }
  return candidate as WechatNotificationPromptContext
}
