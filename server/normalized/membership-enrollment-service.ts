import { createHash } from 'node:crypto'
import type { JsonCodec, JsonObject, NormalizedCommandExecutor } from './command-executor.js'
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
      // The provider exchange intentionally happens after the idempotency claim. If the
      // first response is lost, a retry replays the committed result without consuming
      // the one-time WeChat code again. All database facts below still commit atomically.
      const verifiedAuthorization = await this.phoneAuthorization.verify({
        authorizationCode: input.phoneAuthorizationCode,
        customerId: context.customerId,
        ...(input.phoneAuthorizationProvider
          ? { provider: input.phoneAuthorizationProvider }
          : {}),
      })
      const verifiedPhone = await replaceVerifiedPhoneInTransaction(transaction, {
        customerId: context.customerId,
        protectedPhone: this.phones.protect(verifiedAuthorization.e164Phone),
        providerReferenceHash: sha256(verifiedAuthorization.providerReference),
        verifiedAt: verifiedAuthorization.verifiedAt,
        idempotencyKey: input.idempotencyKey,
      })
      const enrolled = await new CustomerExperienceRepository(transaction)
        .enrollMembership(context.customerId, memberNo)
      if (enrolled.created) {
        await new MembershipTermsRepository(transaction).acceptCurrentEnrollment({
          customerId: context.customerId,
          memberNo,
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
        memberNo,
        created: enrolled.created,
        verifiedPhoneRecorded: true,
        ...(enrolled.created ? {
          termsVersion: input.termsVersion,
          acknowledgementSource: input.acknowledgementSource,
        } : {}),
      }
      return {
        result,
        auditEvents: [{
          actor: { type: 'guest', ref: context.actorRef },
          action: 'membership.enrolled',
          objectType: 'customer_membership',
          objectId: context.customerId,
          businessDate: context.businessDate,
          afterData,
        }],
        outboxMessages: [{
          businessEventKey: `membership.enrolled:${context.customerId}`,
          aggregateType: 'customer_membership',
          aggregateId: context.customerId,
          aggregateVersion: 1,
          eventType: 'membership.enrolled.v1',
          payload: afterData,
        }],
      }
    })
  }
}

function memberNumber(customerId: string): string {
  return `MBX-${sha256(customerId).slice(0, 12).toUpperCase()}`
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
