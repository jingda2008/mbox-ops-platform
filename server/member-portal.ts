import type { FastifyInstance } from 'fastify'
import type { MemberPortalResponse } from '../src/shared/member-portal-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { RuntimeRepository } from './repository.js'

export function buildMemberPortal(state: RuntimeState, memberId: string): MemberPortalResponse {
  const member = state.members.find((item) => item.id === memberId)
  if (!member) throw new Error('会员不存在')
  return {
    communityBrand: state.config.communityBrand.enabled && state.config.communityBrand.memberPortalVisible
      ? {
          name: state.config.communityBrand.name,
          eyebrow: state.config.communityBrand.eyebrow,
          tagline: state.config.communityBrand.tagline,
          markUrl: state.config.communityBrand.markUrl,
          highlights: [...state.config.communityBrand.highlights],
        }
      : null,
    member: {
      id: member.id,
      displayName: member.displayName,
      phoneMasked: member.phoneMasked,
      level: member.level,
      serviceAccountBound: member.serviceAccountBound,
      wecomBound: member.wecomBound,
    },
    benefits: state.memberBenefits
      .filter((benefit) => benefit.memberId === member.id && ['available', 'locked'].includes(benefit.status))
      .map((benefit) => {
        const template = state.benefitTemplates.find((item) => item.id === benefit.templateId)
        if (!template) throw new Error('会员权益模板缺失')
        return {
          id: benefit.id,
          name: template.name,
          description: template.description,
          kind: template.kind,
          remainingQuantity: benefit.remainingQuantity,
          validUntil: benefit.validUntil,
          status: benefit.status as 'available' | 'locked',
        }
      }),
  }
}

export function registerMemberPortalRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.get<{ Params: { memberId: string } }>('/api/dev/member-portal/:memberId', async (request) => {
    const state = await repository.read()
    return buildMemberPortal(state, request.params.memberId)
  })
}
