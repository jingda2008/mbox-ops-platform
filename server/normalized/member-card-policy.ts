/** Membership grade, card enrollment, contact consent and message delivery are
 * intentionally separate domains. This policy never upgrades a grade, creates
 * a marketing consent, or treats external verification failure as refusal. */
export type CardApplicationState = 'pending' | 'approved' | 'rejected' | 'withdrawn'
export type MemberCardState = 'active' | 'suspended' | 'withdrawn' | 'revoked'
export type CardProjectState = 'draft' | 'open' | 'paused' | 'closed'
export class MemberCardPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'MemberCardPolicyError' }
}
export interface CardProjectEligibility {
  state: CardProjectState
  availableFrom: string
  availableUntil: string
  kind: 'interest' | 'cobrand'
  cooperationConfirmed: boolean
  cooperationValidUntil: string | null
}
function instant(value: string): number {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new MemberCardPolicyError('卡项目时间须包含明确时区')
  }
  return Date.parse(value)
}
export function assertCardProjectOpen(project: CardProjectEligibility, now: Date): void {
  const current=now.getTime(),from=instant(project.availableFrom),until=instant(project.availableUntil)
  if (!Number.isFinite(current) || until<=from) throw new MemberCardPolicyError('卡项目有效期不正确')
  if (project.state!=='open' || current<from || current>=until) throw new MemberCardPolicyError('卡项目当前不接受申请或发卡')
  if (project.kind==='cobrand' && (!project.cooperationConfirmed || project.cooperationValidUntil===null || instant(project.cooperationValidUntil)<=current)) {
    throw new MemberCardPolicyError('联名合作尚未确认或已到期')
  }
}
export function decideCardApplication(input: {
  state: CardApplicationState
  decision: 'approve' | 'reject'
  reviewerAuthorized: boolean
  project: CardProjectEligibility
  now: Date
  activeMember: boolean
  alreadyHoldsCard: boolean
}) {
  if (!input.reviewerAuthorized) throw new MemberCardPolicyError('没有卡申请审核权限')
  if (!['approve','reject'].includes(input.decision)) throw new MemberCardPolicyError('审核结果不正确')
  if (input.state!=='pending') throw new MemberCardPolicyError('申请已处理，请刷新后查看真实结果')
  if (input.decision==='reject') return { applicationState:'rejected' as const, createCard:false }
  assertCardProjectOpen(input.project,input.now)
  if (!input.activeMember) throw new MemberCardPolicyError('请先完成正常会员入会；无需同意额外营销')
  return { applicationState:'approved' as const, createCard:!input.alreadyHoldsCard }
}
export function transitionMemberCard(state: MemberCardState, action:'suspend'|'resume'|'withdraw'|'revoke'):MemberCardState {
  if (action==='withdraw' && (state==='active'||state==='suspended')) return 'withdrawn'
  if (action==='revoke' && (state==='active'||state==='suspended')) return 'revoked'
  if (action==='suspend' && state==='active') return 'suspended'
  if (action==='resume' && state==='suspended') return 'active'
  throw new MemberCardPolicyError('当前持卡状态不能执行此操作')
}

export interface CardAudienceRule {
  minimumTier:'member'|'silver'|'gold'|'black'|null
  cardCodes:string[]
  cardMatch:'any'|'all'
  tierAndCards:'and'|'or'
}
/** Callers must supply live authoritative grade/cards at grant time, not a
 * previously displayed preview. A completely empty audience is rejected. */
export function matchesCardAudience(rule:CardAudienceRule, subject:{tier:string;activeCardCodes:readonly string[]}):boolean {
  const tiers=['member','silver','gold','black']
  if (!Array.isArray(rule.cardCodes)||rule.cardCodes.length>100||rule.cardCodes.some(code=>typeof code!=='string'||!/^[A-Z][A-Z0-9_]{1,39}$/.test(code))
    ||new Set(rule.cardCodes).size!==rule.cardCodes.length||!['any','all'].includes(rule.cardMatch)||!['and','or'].includes(rule.tierAndCards)
    ||(rule.minimumTier!==null&&!tiers.includes(rule.minimumTier))) throw new MemberCardPolicyError('发卡或发券人群规则不正确')
  if (rule.minimumTier===null&&!rule.cardCodes.length) throw new MemberCardPolicyError('须明确选择目标人群，不能以空条件自动全量发放')
  if (!tiers.includes(subject.tier)) return false
  const tier=rule.minimumTier===null?null:tiers.indexOf(subject.tier)>=tiers.indexOf(rule.minimumTier)
  const cards=rule.cardCodes.length===0?null:rule.cardMatch==='all'
    ?rule.cardCodes.every(code=>subject.activeCardCodes.includes(code)):rule.cardCodes.some(code=>subject.activeCardCodes.includes(code))
  if(tier===null)return cards!
  if(cards===null)return tier
  return rule.tierAndCards==='and'?tier&&cards:tier||cards
}
