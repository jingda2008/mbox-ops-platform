import { z } from 'zod'
import type { ScopedTransaction } from './transaction-runner.js'

export const memberNumberPolicySchema = z.object({
  width: z.number().int().min(4).max(12),
  startNumber: z.number().int().min(1).max(999999999999),
  padZero: z.boolean(),
  alphabet: z.string().regex(/^[A-Z]{1,26}$/).refine(value => new Set(value).size === value.length, '字母不能重复'),
  maximumPrefixLength: z.number().int().min(0).max(4),
}).strict().refine(value => value.startNumber < 10 ** value.width && value.width - value.maximumPrefixLength >= 2, '号段宽度或起始值不正确')
export type MemberNumberPolicy = z.infer<typeof memberNumberPolicySchema>
export const defaultMemberNumberPolicy: MemberNumberPolicy = { width: 6, startNumber: 100001, padZero: true, alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', maximumPrefixLength: 2 }

/** Ordinals are monotone. Each prefix consumes its entire numeric suffix range;
 * changing policy never changes previously issued member numbers. */
export function memberNumberAt(policy: MemberNumberPolicy, ordinal: bigint): string {
  memberNumberPolicySchema.parse(policy)
  if (ordinal < 0n) throw new Error('会员号序号不能为负数')
  for (let length = 0; length <= policy.maximumPrefixLength; length++) {
    const digits = policy.width - length
    const start = BigInt(Math.max(1, Math.ceil(policy.startNumber / 10 ** length)))
    const span = 10n ** BigInt(digits) - start
    const prefixes = BigInt(policy.alphabet.length) ** BigInt(length)
    if (ordinal >= span * prefixes) { ordinal -= span * prefixes; continue }
    let prefixIndex = ordinal / span
    let prefix = ''
    for (let i = 0; i < length; i++) {
      prefix = policy.alphabet[Number(prefixIndex % BigInt(policy.alphabet.length))]! + prefix
      prefixIndex /= BigInt(policy.alphabet.length)
    }
    const suffix = (start + ordinal % span).toString()
    return prefix + (policy.padZero ? suffix.padStart(digits, '0') : suffix)
  }
  throw new Error('会员号号段已用尽，请扩展后台号段配置')
}

export async function allocateMemberNumber(tx: ScopedTransaction): Promise<string> {
  const scope = [tx.scope.tenantId, tx.scope.storeId]
  await tx.query('INSERT INTO mbox.member_number_policies(tenant_id,store_id) VALUES($1,$2) ON CONFLICT DO NOTHING', scope)
  const row = (await tx.query<{width:number;start_number:string;pad_zero:boolean;alphabet:string;maximum_prefix_length:number;next_ordinal:string}>(
    'SELECT width,start_number::text,pad_zero,alphabet,maximum_prefix_length,next_ordinal::text FROM mbox.member_number_policies WHERE tenant_id=$1 AND store_id=$2 FOR UPDATE', scope)).rows[0]!
  const policy = memberNumberPolicySchema.parse({width:row.width,startNumber:Number(row.start_number),padZero:row.pad_zero,alphabet:row.alphabet,maximumPrefixLength:row.maximum_prefix_length})
  let ordinal = BigInt(row.next_ordinal)
  // A changed policy can overlap historical identifiers. Never overwrite them.
  for (let attempts = 0; attempts < 10000; attempts++, ordinal++) {
    const candidate = memberNumberAt(policy, ordinal)
    const used = await tx.query('SELECT id FROM mbox.customer_memberships WHERE tenant_id=$1 AND store_id=$2 AND member_no=$3', [...scope,candidate])
    if (used.rows.length) continue
    await tx.query('UPDATE mbox.member_number_policies SET next_ordinal=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2', [...scope,(ordinal+1n).toString()])
    return candidate
  }
  throw new Error('新号段与历史号码重叠过多，请调整后台号段起始值')
}
