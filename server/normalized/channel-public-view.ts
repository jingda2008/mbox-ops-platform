import { z } from 'zod'
import { channelRuleSchema } from '../../src/shared/channel-distribution.js'

// Public read models enumerate fields; internal cost/contract additions never flow through.
const products = z.array(z.object({ id: z.string().uuid(), name: z.string() }))
const offer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gift'), productId: z.string().uuid(), productName: z.string().optional(), quantity: z.number().int().positive() }),
  z.object({ kind: z.literal('credit'), amountMinor: z.number().int().positive() }),
  z.object({ kind: z.literal('discount'), discountBps: z.number().int().positive(), maximumMinor: z.number().int().positive() }),
])
export const channelCouponViewSchema = z.object({
  id: z.string().uuid(), batchId: z.string().uuid(), offerCode: z.string(), title: z.string(),
  status: z.enum(['available','active','fulfilled','expired','revoked']), offer,
  useFrom: z.string(), useUntil: z.string(), sourceLabel: z.string(), minimumMinor: z.number(),
  allowStacking:z.boolean().default(false),visitDiscountCapMinor:z.number().nullable().default(null),
  perCustomerClaims: z.number(), perVisitUses: z.number(), eligibleProducts: products.nullable().transform(v=>v??[]),
})
export const publicChannelOffer = (value: unknown) => offer.parse(value)
export function publicChannelRule(value: unknown) {
  const rule=channelRuleSchema.parse(value)
  return { title:rule.title, totalClaims:rule.totalClaims, perCustomerClaims:rule.perCustomerClaims, perVisitUses:rule.perVisitUses,allowStacking:rule.allowStacking,visitDiscountCapMinor:rule.visitDiscountCapMinor,
    claimFrom:rule.claimFrom, claimUntil:rule.claimUntil, useFrom:rule.useFrom, useUntil:rule.useUntil,
    minimumMinor:rule.minimumMinor, eligibleProducts:products.parse(rule.eligibleProductNames??[]), offer:publicChannelOffer(rule.offer),
    commissionBps:rule.commissionBps, observationDays:rule.observationDays }
}
export interface ChannelWalletQuery { limit?: number; cursor?: string; status?: 'all'|'available'|'active'|'fulfilled'|'expired'|'revoked'; code?: string; claimId?: string }

// External reconciliation needs sale/refund totals, not internal evidence blobs or payment identifiers.
export const channelPartnerStatementSchema=z.object({
  statement:z.object({id:z.string(),promoterId:z.string(),sourceStatementId:z.string().nullable(),amountMinor:z.string(),status:z.string(),accountSubject:z.string(),accountReference:z.string()}),
  lines:z.array(z.object({visitId:z.string(),deltaMinor:z.string(),basisMinor:z.string(),createdAt:z.string(),
    evidence:z.object({evidence:z.array(z.object({orderId:z.string(),paid:z.number().optional(),refunded:z.number().optional(),basis:z.number().optional(),excluded:z.string().optional(),pending:z.string().optional()})).default([])})})),
})
