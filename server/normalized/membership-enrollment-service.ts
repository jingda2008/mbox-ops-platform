import { createHash } from 'node:crypto'
import type { JsonCodec, JsonObject, NormalizedCommandExecutor } from './command-executor.js'
import { CustomerMergeConflictError, CustomerRepository } from './customer-repository.js'
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

      let enrollCustomerId = (await customers.resolveCanonical(context.customerId)).id
      // 只合并回 6 位新会员号；MBX- 历史脏号不再作为“原会员”拉回。
      const ownerCustomerId = await findExistingModernMembershipCustomerByPhone(
        transaction, protectedPhone.matchHashes, context.customerId,
      )
      if (ownerCustomerId !== null) {
        const ownerCanonicalId = (await customers.resolveCanonical(ownerCustomerId)).id
        if (ownerCanonicalId !== enrollCustomerId) {
          await releaseSourcePhonesForMerge(transaction, enrollCustomerId)
          try {
            await customers.merge(enrollCustomerId, ownerCanonicalId)
          } catch (error) {
            if (!isPhoneFamilyMergeGuard(error) && !(error instanceof CustomerMergeConflictError)) {
              throw error
            }
            enrollCustomerId = (await customers.resolveCanonical(context.customerId)).id
            if (enrollCustomerId !== ownerCanonicalId) {
              await releaseSourcePhonesForMerge(transaction, enrollCustomerId)
              await customers.merge(enrollCustomerId, ownerCanonicalId)
            }
          }
        }
        enrollCustomerId = ownerCanonicalId
      } else {
        // 同手机号若只挂在 MBX- 脏号上，释放后给当前顾客发新 6 位号。
        await releaseLegacyMbxPhonesForHash(
          transaction, protectedPhone.matchHashes, enrollCustomerId,
        )
      }

      const verifiedPhone = await replaceVerifiedPhoneInTransaction(transaction, {
        customerId: enrollCustomerId,
        protectedPhone,
        providerReferenceHash: sha256(verifiedAuthorization.providerReference),
        verifiedAt: verifiedAuthorization.verifiedAt,
        idempotencyKey: input.idempotencyKey,
      })
      const enrolled = await experience.enrollMembership(enrollCustomerId)
      const assignedMemberNo = enrolled.membership!.memberNo
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

function memberNumber(customerId: string): string {
  return `MBX-${sha256(customerId).slice(0, 12).toUpperCase()}`
}

function isPhoneFamilyMergeGuard(error: unknown): boolean {
  return error instanceof Error
    && /multiple active verified phones in one family/i.test(error.message)
}

function isModernMemberNo(memberNo: string): boolean {
  return /^[0-9]{6}$/.test(memberNo)
}

async function findExistingModernMembershipCustomerByPhone(
  transaction: ScopedTransaction,
  contactHashes: readonly string[],
  requesterCustomerId: string,
): Promise<string | null> {
  if (contactHashes.length === 0) return null
  const result = await transaction.query<{ customer_id: string; member_no: string }>(`
    SELECT membership.customer_id, membership.member_no
    FROM mbox.customer_verified_contacts contact
    JOIN mbox.customers customer
      ON customer.tenant_id=contact.tenant_id AND customer.store_id=contact.store_id
     AND customer.id=contact.customer_id AND customer.status='active'
    JOIN mbox.customer_memberships membership
      ON membership.tenant_id=contact.tenant_id AND membership.store_id=contact.store_id
     AND membership.customer_id=contact.customer_id AND membership.status='active'
    WHERE contact.tenant_id=$1::uuid AND contact.store_id=$2::uuid
      AND contact.contact_type='phone' AND contact.contact_hash=ANY($3::char(64)[])
      AND contact.processing_status='active' AND contact.customer_id<>$4::uuid
      AND membership.member_no ~ '^[0-9]{6}$'
      AND membership.member_no !~* '^MBX-'
    ORDER BY membership.joined_at, membership.id
    LIMIT 1
    FOR UPDATE OF contact, customer, membership
  `, [
    transaction.scope.tenantId, transaction.scope.storeId,
    contactHashes, requesterCustomerId,
  ])
  const row = result.rows[0]
  if (!row || !isModernMemberNo(row.member_no)) return null
  return row.customer_id
}

async function releaseLegacyMbxPhonesForHash(
  transaction: ScopedTransaction,
  contactHashes: readonly string[],
  requesterCustomerId: string,
): Promise<void> {
  if (contactHashes.length === 0) return
  await transaction.query(`
    UPDATE mbox.customer_verified_contacts contact
    SET processing_status='revoked',
        revoked_at=clock_timestamp(),
        revocation_reason_code='membership_enroll_ignore_legacy_mbx'
    FROM mbox.customer_memberships membership
    JOIN mbox.customers customer
      ON customer.tenant_id=membership.tenant_id AND customer.store_id=membership.store_id
     AND customer.id=membership.customer_id AND customer.status='active'
    WHERE contact.tenant_id=$1::uuid AND contact.store_id=$2::uuid
      AND membership.tenant_id=contact.tenant_id AND membership.store_id=contact.store_id
      AND membership.customer_id=contact.customer_id AND membership.status='active'
      AND contact.contact_type='phone' AND contact.contact_hash=ANY($3::char(64)[])
      AND contact.processing_status='active'
      AND contact.customer_id<>$4::uuid
      AND (
        membership.member_no ~* '^MBX-'
        OR membership.member_no !~ '^[0-9]{6}$'
      )
  `, [
    transaction.scope.tenantId, transaction.scope.storeId,
    contactHashes, requesterCustomerId,
  ])
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
