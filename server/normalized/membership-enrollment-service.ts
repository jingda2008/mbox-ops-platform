import { createHash } from 'node:crypto'
import type { JsonCodec, JsonObject, NormalizedCommandExecutor } from './command-executor.js'
import { CustomerRepository } from './customer-repository.js'
import {
  CustomerExperienceRepository,
  CustomerExperienceRequestError,
  type PublicPortalSnapshot,
} from './customer-experience-repository.js'
import type { PublicCustomerExperienceContext } from './customer-experience-service.js'
import {
  MembershipTermsRepository,
  type MembershipTermsAcknowledgementSource,
} from './membership-terms-service.js'
import {
  MembershipPhoneOwnedElsewhereError,
  customerFamilyHasMembership,
  lockMembershipPhone,
  membershipPhoneReviewRequired,
  resolveMembershipPhoneOwner,
  replaceVerifiedPhoneInTransaction,
  type MembershipRecoveryPhoneAuthorizationPort,
  type MembershipRecoveryPhoneProtector,
  type MiniProgramPhoneAuthorizationProvider,
  type PublicVerifiedPhone,
} from './membership-recovery-service.js'
import type { ScopedTransaction } from './transaction-runner.js'

export interface MembershipEnrollmentResult {
  membership: PublicPortalSnapshot['membership']
  created: boolean
  verifiedPhone: PublicVerifiedPhone
}

export class MembershipEnrollmentService {
  constructor(
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    private readonly phoneAuthorization: MembershipRecoveryPhoneAuthorizationPort,
    private readonly phones: MembershipRecoveryPhoneProtector,
  ) {}

  enroll(
    context: PublicCustomerExperienceContext,
    input: Readonly<{
      termsVersion: number
      acknowledgementSource: MembershipTermsAcknowledgementSource
      phoneAuthorizationCode: string
      phoneAuthorizationProvider?: MiniProgramPhoneAuthorizationProvider
      idempotencyKey: string
      /** 服务端已校验的微信身份 principal hash（来自 wechat session），绝不信任客户端自报。 */
      wechatPrincipalHash?: string | null
    }>,
  ) {
    const memberNo = memberNumber(context.customerId)
    const phoneAuthorizationCodeSha256 = sha256(input.phoneAuthorizationCode)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.membership.enroll',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: JSON.stringify({
        customerId: context.customerId,
        memberNo,
        termsVersion: input.termsVersion,
        acknowledgementSource: input.acknowledgementSource,
        phoneAuthorizationCodeSha256,
      }),
      resultCodec: objectCodec<MembershipEnrollmentResult>(),
    }, async (transaction) => {
      const verifiedAuthorization = await this.phoneAuthorization.verify({
        authorizationCode: input.phoneAuthorizationCode,
        customerId: context.customerId,
        ...(input.phoneAuthorizationProvider
          ? { provider: input.phoneAuthorizationProvider }
          : {}),
      })
      const protectedPhone = this.phones.protect(verifiedAuthorization.e164Phone)
      const experience = new CustomerExperienceRepository(transaction)
      const customers = new CustomerRepository(transaction)

      await lockMembershipPhone(transaction, protectedPhone)
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${context.scope.tenantId}:${context.scope.storeId}:verified-phone:${context.customerId}`,
      ])
      const requester = await customers.resolveCanonical(context.customerId)
      if (requester.status !== 'active') throw membershipPhoneReviewRequired()
      let enrollCustomerId = requester.id
      const ownerCustomerId = await resolveMembershipPhoneOwner(transaction, protectedPhone, enrollCustomerId)
      const claim = async (owner: string) => {
        if (owner === enrollCustomerId) return
        const target = await customers.resolveCanonical(owner)
        if (target.status !== 'active' || target.id !== owner || await customerFamilyHasMembership(transaction, enrollCustomerId, false)) {
          throw membershipPhoneReviewRequired()
        }
        await releaseSourcePhonesForMerge(transaction, enrollCustomerId)
        await customers.merge(enrollCustomerId, owner)
        enrollCustomerId = owner
      }
      if (ownerCustomerId) await claim(ownerCustomerId)

      const bindVerifiedPhone = () => replaceVerifiedPhoneInTransaction(transaction, {
        customerId: enrollCustomerId,
        protectedPhone,
        providerReferenceHash: sha256(verifiedAuthorization.providerReference),
        repeatableProofSha256: verifiedAuthorization.repeatableProofReference
          ? sha256(verifiedAuthorization.repeatableProofReference)
          : null,
        verifiedAt: verifiedAuthorization.verifiedAt,
        idempotencyKey: input.idempotencyKey,
      })
      let verifiedPhone: PublicVerifiedPhone
      try {
        verifiedPhone = await bindVerifiedPhone()
      } catch (error) {
        if (!(error instanceof MembershipPhoneOwnedElsewhereError)) throw error
        if (ownerCustomerId || error.ownerCustomerId === enrollCustomerId) throw membershipPhoneReviewRequired()
        await claim((await customers.resolveCanonical(error.ownerCustomerId)).id)
        verifiedPhone = await bindVerifiedPhone()
      }
      const enrolled = await experience.enrollMembership(enrollCustomerId)
      const assignedMemberNo = enrolled.membership!.memberNo
      const wechatBinding: WechatIdentityBindingResult = input.wechatPrincipalHash
        ? await bindVerifiedWechatIdentityToMember(transaction, enrollCustomerId, input.wechatPrincipalHash)
        : { outcome: 'not_provided' }
      if (wechatBinding.outcome === 'conflict_other_member') throw membershipPhoneReviewRequired()
      if (enrolled.created) {
        await new MembershipTermsRepository(transaction).acceptCurrentEnrollment({
          customerId: enrollCustomerId,
          memberNo: assignedMemberNo,
          termsVersion: input.termsVersion,
          acknowledgementSource: input.acknowledgementSource,
        })
      }
      const result: MembershipEnrollmentResult = {
        membership: enrolled.membership,
        created: enrolled.created,
        verifiedPhone,
      }
      const afterData: JsonObject = {
        memberNo: assignedMemberNo,
        created: enrolled.created,
        verifiedPhoneRecorded: true,
        wechatIdentityBinding: wechatBinding.outcome,
        ...(wechatBinding.previousCustomerId
          ? { wechatIdentityPreviousCustomerId: wechatBinding.previousCustomerId }
          : {}),
        ...(enrolled.created ? {
          termsVersion: input.termsVersion,
          acknowledgementSource: input.acknowledgementSource,
        } : {}),
      }
      const outboxMessages = enrolled.created
        ? [{
            businessEventKey: `membership.enrolled:${enrollCustomerId}`,
            aggregateType: 'customer_membership',
            aggregateId: enrollCustomerId,
            aggregateVersion: 1,
            eventType: 'membership.enrolled.v1',
            payload: afterData,
          }]
        : [{
            businessEventKey: `membership.reclaimed:${enrollCustomerId}:${input.idempotencyKey}`,
            aggregateType: 'customer_membership',
            aggregateId: enrollCustomerId,
            aggregateVersion: 1,
            eventType: 'membership.reclaimed.v1',
            payload: afterData,
          }]
      return {
        result,
        auditEvents: [{
          actor: { type: 'guest', ref: context.actorRef },
          action: enrolled.created ? 'membership.enrolled' : 'membership.reclaimed',
          objectType: 'customer_membership',
          objectId: enrollCustomerId,
          businessDate: context.businessDate,
          afterData,
        }],
        outboxMessages,
      }
    })
  }
}

export type WechatIdentityBindingOutcome =
  | 'not_provided'
  | 'linked'
  | 'already_linked'
  | 'moved_from_guest'
  | 'conflict_other_member'

export interface WechatIdentityBindingResult {
  outcome: WechatIdentityBindingOutcome
  previousCustomerId?: string
}

/**
 * 认领/开通会员时，把本次会话里服务端已校验的微信身份绑定到会员顾客。
 * - 未绑定：直接 link。
 * - 已绑在该会员（含合并族）：幂等，不动。
 * - 绑在没有任何会员的访客顾客上：把这条身份移到会员顾客（访客无会员资产可丢）。
 * - 已绑定其他会员的微信身份必须由门店核对。
 */
export async function bindVerifiedWechatIdentityToMember(
  transaction: ScopedTransaction,
  memberCustomerId: string,
  wechatPrincipalHash: string,
): Promise<WechatIdentityBindingResult> {
  if (!/^[0-9a-f]{64}$/.test(wechatPrincipalHash)) throw new Error('invalid wechat principal hash')
  const customers = new CustomerRepository(transaction)
  const member = await customers.resolveCanonical(memberCustomerId)
  const owner = await customers.findByIdentity('wechat', wechatPrincipalHash)
  if (owner === null) {
    await customers.linkIdentity(member.id, 'wechat', wechatPrincipalHash)
    return { outcome: 'linked' }
  }
  if (owner.id === member.id) return { outcome: 'already_linked' }
  if (await customerFamilyHasMembership(transaction, owner.id, false)) {
    return { outcome: 'conflict_other_member', previousCustomerId: owner.id }
  }
  await transaction.query(`
    UPDATE mbox.customer_identities
    SET customer_id = $4::uuid
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND identity_kind = 'wechat' AND identity_hash = $3
  `, [transaction.scope.tenantId, transaction.scope.storeId, wechatPrincipalHash, member.id])
  return {
    outcome: 'moved_from_guest',
    previousCustomerId: owner.id,
  }
}

function memberNumber(customerId: string): string {
  return `MBX-${sha256(customerId).slice(0, 12).toUpperCase()}`
}

async function releaseSourcePhonesForMerge(
  transaction: ScopedTransaction,
  customerId: string,
): Promise<void> {
  await transaction.query(`
    WITH RECURSIVE ancestry AS (
      SELECT id, merged_into_customer_id FROM mbox.customers
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      UNION ALL
      SELECT parent.id, parent.merged_into_customer_id
      FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
      WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
    ), canonical AS (
      SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
    ), family AS (
      SELECT id FROM canonical
      UNION ALL
      SELECT child.id FROM mbox.customers child JOIN family parent
        ON child.merged_into_customer_id=parent.id
      WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
    )
    UPDATE mbox.customer_verified_contacts contact
    SET processing_status='revoked',
        revoked_at=clock_timestamp(),
        revocation_reason_code='membership_enroll_phone_merge'
    WHERE contact.tenant_id=$1::uuid AND contact.store_id=$2::uuid
      AND contact.customer_id IN (SELECT id FROM family)
      AND contact.contact_type='phone'
      AND contact.processing_status='active'
  `, [transaction.scope.tenantId, transaction.scope.storeId, customerId])
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function objectCodec<Value>(): JsonCodec<Value> {
  return {
    encode: (value) => value as unknown as JsonObject,
    decode: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CustomerExperienceRequestError(
          '会员加入重放结果无效', 'MEMBERSHIP_ENROLLMENT_REPLAY_INVALID', 409,
        )
      }
      return value as Value
    },
  }
}
