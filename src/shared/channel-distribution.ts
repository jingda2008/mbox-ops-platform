import { z } from 'zod'

const money = z.number().int().min(0).max(1_000_000_000)
const positive = z.number().int().min(1).max(1_000_000)
const timestamp = z.iso.datetime({ offset: true })
export const channelOfferSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gift'), productId: z.string().uuid(), productName: z.string().min(1).max(200).optional(), quantity: positive.max(100), costMinor: money }).strict(),
  z.object({ kind: z.literal('credit'), amountMinor: money.refine(n => n > 0) }).strict(),
  // discountBps is the reduction, e.g. 1000 = 10% off, not the payable rate.
  z.object({ kind: z.literal('discount'), discountBps: z.number().int().min(1).max(10_000), maximumMinor: money.refine(n => n > 0) }).strict(),
])
export const channelRuleSchema = z.object({
  title: z.string().trim().min(2).max(100),
  totalClaims: positive,
  perCustomerClaims: positive,
  perVisitUses: positive.max(100),
  allowStacking: z.boolean().default(false),
  visitDiscountCapMinor: money.refine(n => n > 0).nullable().default(null),
  claimFrom: timestamp, claimUntil: timestamp, useFrom: timestamp, useUntil: timestamp,
  minimumMinor: money,
  eligibleProductIds: z.array(z.string().uuid()).min(1).max(500),
  commissionProductIds:z.array(z.string().uuid()).min(1).max(500).optional(),
  // Server replaces this display snapshot from the actual same-store catalog.
  eligibleProductNames: z.array(z.object({ id: z.string().uuid(), name: z.string().min(1).max(200) }).strict()).max(500).optional(),
  offer: channelOfferSchema,
  commissionBps: z.number().int().min(0).max(10_000).default(1000),
  observationDays: z.number().int().min(0).max(90).default(7),
}).strict().superRefine((v, ctx) => {
  if (!v.allowStacking && v.visitDiscountCapMinor !== null) ctx.addIssue({ code: 'custom', path: ['visitDiscountCapMinor'], message: '请先开启叠加再设置客组总优惠上限' })
  if (Date.parse(v.claimUntil) <= Date.parse(v.claimFrom)) ctx.addIssue({ code: 'custom', path: ['claimUntil'], message: '领取结束须晚于开始' })
  if (Date.parse(v.useUntil) <= Date.parse(v.useFrom) || Date.parse(v.claimUntil) > Date.parse(v.useUntil)) ctx.addIssue({ code: 'custom', path: ['useUntil'], message: '使用窗口须有效且覆盖领取截止' })
  if (v.perCustomerClaims > v.totalClaims) ctx.addIssue({ code: 'custom', path: ['perCustomerClaims'], message: '个人上限不能超过总发行数' })
  if (new Set(v.eligibleProductIds).size !== v.eligibleProductIds.length) ctx.addIssue({ code: 'custom', path: ['eligibleProductIds'], message: '适用商品不得重复' })
})
// One contract for staff forms and their HTTP endpoints; all money is integer cents.
const configReason = z.string().trim().min(2).max(500)
const configUuid = z.string().uuid()
export const channelStoreLimitsSchema = z.object({
  action:z.literal('limits'),claimLimit:z.number().int().min(0).max(1_000_000),
  capacityLimit:z.number().int().min(0).max(1_000_000),costLimitMinor:z.number().int().min(0).max(1e12),reason:configReason,
}).strict()
export const channelManagementSchemas = {
  partner:z.object({name:z.string().trim().min(2).max(100),settlementSubject:z.string().trim().min(2).max(200),promoterName:z.string().trim().min(1).max(100),reason:configReason}).strict(),
  campaign:z.object({title:z.string().trim().min(2).max(100),claimLimit:positive,capacityLimit:positive,costLimitMinor:z.number().int().min(0).max(1e12),reason:configReason}).strict(),
  batch:z.object({campaignId:configUuid,promoterId:configUuid,rule:channelRuleSchema,contract:z.object({version:z.string().min(1).max(100),settlementSubject:z.string().min(2).max(200),terms:z.string().min(2).max(3000)}).strict(),reason:configReason}).strict(),
  invite:z.object({promoterId:configUuid}).strict(),
  followup:z.object({promoterId:configUuid,batchId:configUuid.nullable(),kind:z.enum(['sent','received','feedback','contact']),note:z.string().trim().min(2).max(2000),nextContactAt:timestamp.nullable()}).strict(),
}
export type ChannelRule = z.infer<typeof channelRuleSchema>
export type ChannelOffer = ChannelRule['offer']
export type ChannelEntry = 'staff' | 'self'
export type ChannelCouponState = 'available' | 'active' | 'fulfilled' | 'expired' | 'revoked'
export const CHANNEL_ERROR_MESSAGES = {
  STACKING_DISABLED:'本次客组或所选券不允许叠加，请先核对已绑定优惠',
  DISCOUNT_CAP:'本次客组总优惠额度不足，不能放宽原上限',
  CONTINUITY_REVIEW:'顾客近期已有结束的客组，请主管确认是续台还是新一轮到店',
  RATE_LIMIT:'操作较频繁，请一分钟后重试原操作',
  AUTH_REQUIRED: '请先确认顾客身份', NOT_AUTHORIZED: '没有执行此操作的权限',
  NOT_FOUND: '未找到此渠道优惠', NOT_STARTED: '还未到可用时间', EXPIRED: '已超过有效时间',
  PAUSED: '已暂停新的领取，原有效券仍可使用', CLAIM_LIMIT: '本批次已领完',
  CUSTOMER_LIMIT: '您已达到本批次领取上限', VISIT_LIMIT: '本次客组已达到限用次数',
  SOURCE_CONFLICT: '本次消费已有其他推荐来源', CAPACITY: '本批次可承诺份数不足',
  OWNERSHIP: '请使用本人优惠券并确认当前桌次', VERSION_CONFLICT: '记录已变化，请刷新核对',
  NOT_REVERSIBLE: '权益已兑现，不能直接撤销使用', INVALID_AMOUNT: '金额或分摊依据无效',
} as const
export type ChannelErrorCode = keyof typeof CHANNEL_ERROR_MESSAGES

export interface ChannelCouponView {
  id: string; batchId: string; title: string; customerId: string
  state: ChannelCouponState; useFrom: string; useUntil: string
  perVisitUses: number; allowStacking:boolean;visitDiscountCapMinor:number|null; sourceLabel: string; offer: ChannelOffer
}
