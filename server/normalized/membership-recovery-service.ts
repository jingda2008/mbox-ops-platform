import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { CustomerRepository } from './customer-repository.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import type { ActivityContactProtectionKeyring } from './personal-contact-protection.js'
import type {
  PublicCustomerExperienceContext,
  StaffCustomerExperienceContext,
} from './customer-experience-service.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
} from './transaction-runner.js'

export interface VerifiedRecoveryPhoneAuthorization {
  e164Phone: string
  providerReference: string
  verifiedAt: string
}

export interface MembershipRecoveryPhoneAuthorizationPort {
  verify(input: Readonly<{
    authorizationCode: string
    customerId: string
  }>): Promise<VerifiedRecoveryPhoneAuthorization>
}

export interface ProtectedRecoveryPhone {
  contactHash: string
  encryptedValue: Buffer
  encryptionKeyVersion: number
  encryptionKeyId: string
  matchHashes: readonly string[]
  maskedValue: string
}

export interface MembershipRecoveryPhoneProtector {
  protect(e164Phone: string): ProtectedRecoveryPhone
}

export interface PublicMembershipRecoveryState {
  challengePublicId: string
  status: 'awaiting_verification' | 'no_match' | 'pending_review' | 'manual_review' | 'completed' | 'rejected' | 'expired'
  message: string
  expiresAt: string
}

export interface PublicVerifiedPhone {
  publicId: string
  maskedPhone: string
  status: 'active'
  verifiedAt: string
  verificationSource: 'wechat_phone_authorization' | 'staff_controlled'
}

interface ChallengeRow extends Record<string, unknown> {
  id: string
  public_id: string
  requester_customer_id: string
  status: PublicMembershipRecoveryState['status'] | 'cancelled'
  verified_contact_id: string | null
  candidate_count: number
  verify_idempotency_key: string | null
  expires_at: string
}

interface CandidateRow extends Record<string, unknown> {
  id: string
  public_id: string
  customer_id: string
  membership_id: string
  matched_contact_id: string
  member_no: string
  joined_at: string
  verified_by_employee_id: string | null
}

interface MergeCaseRow extends Record<string, unknown> {
  id: string
  public_id: string
  challenge_id: string
  target_customer_id: string
  selected_candidate_id: string | null
  source_customer_id: string | null
  source_membership_id: string | null
  status: 'manual_review' | 'pending_review' | 'approved' | 'rejected' | 'executed'
  requested_by_customer_id: string
  selected_by_employee_id: string | null
}

type TransactionRunner = Pick<ScopedPostgresTransactionRunner, 'run'>

const RECOVERY_TTL_MS = 10 * 60_000

export class MembershipRecoveryService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly phones: MembershipRecoveryPhoneProtector,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(
    context: PublicCustomerExperienceContext,
    input: Readonly<{ idempotencyKey: string }>,
  ): Promise<PublicMembershipRecoveryState> {
    const publicId = recoveryPublicId('MRC')
    const expiresAt = new Date(this.now().getTime() + RECOVERY_TTL_MS).toISOString()
    return this.transactions.run(context.scope, async (transaction) => {
      await assertCustomerCanRecover(transaction, context.customerId)
      const inserted = await transaction.query<ChallengeRow>(`
        INSERT INTO mbox.membership_recovery_challenges (
          tenant_id,store_id,public_id,requester_customer_id,
          verification_method,start_idempotency_key,expires_at
        ) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,'wechat_phone',$5,$6::timestamptz)
        ON CONFLICT (tenant_id,store_id,requester_customer_id,start_idempotency_key)
        DO UPDATE SET updated_at=mbox.membership_recovery_challenges.updated_at
        RETURNING id,public_id,requester_customer_id,status,verified_contact_id,
          candidate_count,verify_idempotency_key,expires_at::text
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, publicId,
        context.customerId, input.idempotencyKey, expiresAt,
      ])
      return publicState(required(inserted.rows[0], 'recovery challenge'))
    })
  }

  async verify(
    context: PublicCustomerExperienceContext,
    input: Readonly<{
      challengePublicId: string
      verifiedPhone: VerifiedRecoveryPhoneAuthorization
      idempotencyKey: string
    }>,
  ): Promise<PublicMembershipRecoveryState> {
    const protectedPhone = this.phones.protect(input.verifiedPhone.e164Phone)
    const providerReferenceHash = sha256(input.verifiedPhone.providerReference)
    const verifiedAt = timestamp(input.verifiedPhone.verifiedAt, 'verifiedAt')
    return this.transactions.run(context.scope, async (transaction) => {
      const challenge = await lockChallenge(
        transaction, input.challengePublicId, context.customerId,
      )
      if (challenge.verify_idempotency_key === input.idempotencyKey) return publicState(challenge)
      if (challenge.status !== 'awaiting_verification') {
        throw recoveryError('RECOVERY_CHALLENGE_ALREADY_USED', '这次找回申请已经处理，请刷新后查看')
      }
      if (new Date(challenge.expires_at).getTime() <= this.now().getTime()) {
        await expireChallenge(transaction, challenge.id)
        return { ...publicState({ ...challenge, status: 'expired' }), status: 'expired' }
      }
      await assertCustomerCanRecover(transaction, context.customerId)

      const contact = await upsertVerifiedContact(transaction, {
        customerId: context.customerId,
        protectedPhone,
        verificationSource: 'wechat_phone_authorization',
        providerReferenceHash,
        verifiedByCustomerId: context.customerId,
        verifiedByEmployeeId: null,
        verifiedAt,
        idempotencyKey: input.idempotencyKey,
        reasonDetail: null,
      })
      await transaction.query(`
        INSERT INTO mbox.membership_recovery_verifications (
          tenant_id,store_id,challenge_id,contact_id,verification_method,
          provider_reference_sha256,verified_at
        ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'wechat_phone',$5,$6::timestamptz)
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, challenge.id,
        contact.id, providerReferenceHash, verifiedAt,
      ])
      const candidates = await matchingCandidates(
        transaction, protectedPhone.matchHashes, context.customerId,
      )
      for (const candidate of candidates) {
        await transaction.query(`
          INSERT INTO mbox.membership_recovery_candidates (
            id,tenant_id,store_id,public_id,challenge_id,candidate_customer_id,
            candidate_membership_id,matched_contact_id,match_kind
          ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::uuid,$8::uuid,'verified_phone')
        `, [
          candidate.id, transaction.scope.tenantId, transaction.scope.storeId, recoveryPublicId('MRD'),
          challenge.id, candidate.customer_id, candidate.membership_id, candidate.matched_contact_id,
        ])
      }

      const status = candidates.length === 0
        ? 'no_match'
        : candidates.length === 1 ? 'pending_review' : 'manual_review'
      const updated = await transaction.query<ChallengeRow>(`
        UPDATE mbox.membership_recovery_challenges
        SET status=$4,verified_contact_id=$5::uuid,candidate_count=$6,
          verify_idempotency_key=$7,verified_at=$8::timestamptz,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='awaiting_verification'
        RETURNING id,public_id,requester_customer_id,status,verified_contact_id,
          candidate_count,verify_idempotency_key,expires_at::text
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, challenge.id,
        status, contact.id, candidates.length, input.idempotencyKey, verifiedAt,
      ])
      const next = required(updated.rows[0], 'verified recovery challenge')
      if (candidates.length > 0) {
        const selected = candidates.length === 1 ? candidates[0] : null
        const mergeCase = await transaction.query<{ id: string }>(`
          INSERT INTO mbox.membership_merge_cases (
            tenant_id,store_id,public_id,challenge_id,target_customer_id,
            selected_candidate_id,source_customer_id,source_membership_id,status,
            requested_by_customer_id
          ) VALUES (
            $1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,
            $6::uuid,$7::uuid,$8::uuid,$9,$5::uuid
          ) RETURNING id
        `, [
          transaction.scope.tenantId, transaction.scope.storeId, recoveryPublicId('MMC'),
          challenge.id, context.customerId, selected?.id ?? null,
          selected?.customer_id ?? null, selected?.membership_id ?? null, status,
        ])
        await appendAction(transaction, required(mergeCase.rows[0], 'merge case').id, {
          action: 'requested', actorType: 'customer', actorCustomerId: context.customerId,
          actorEmployeeId: null, reason: '顾客通过微信专用手机号授权申请找回历史会员',
          idempotencyKey: input.idempotencyKey,
        })
      }
      return publicState(next)
    })
  }

  async verifiedReplay(
    context: PublicCustomerExperienceContext,
    input: Readonly<{ challengePublicId: string; idempotencyKey: string }>,
  ): Promise<PublicMembershipRecoveryState | null> {
    return this.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<ChallengeRow>(`
        SELECT id,public_id,requester_customer_id,status,verified_contact_id,
          candidate_count,verify_idempotency_key,expires_at::text
        FROM mbox.membership_recovery_challenges
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
          AND requester_customer_id=$4::uuid AND verify_idempotency_key=$5
          AND status<>'awaiting_verification'
      `, [
        transaction.scope.tenantId, transaction.scope.storeId,
        input.challengePublicId, context.customerId, input.idempotencyKey,
      ])
      return result.rows[0] === undefined ? null : publicState(result.rows[0])
    }, { readOnly: true })
  }

  async listMyVerifiedPhones(
    context: PublicCustomerExperienceContext,
  ): Promise<readonly PublicVerifiedPhone[]> {
    return this.transactions.run(context.scope, async (transaction) => {
      const family = await canonicalCustomerFamily(transaction, context.customerId)
      const result = await transaction.query<{
        public_id: string
        masked_value: string
        verified_at: string
        verification_source: PublicVerifiedPhone['verificationSource']
      }>(`
        SELECT public_id,masked_value,verified_at::text,verification_source
        FROM mbox.customer_verified_contacts
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND customer_id=ANY($3::uuid[]) AND contact_type='phone'
          AND processing_status='active'
        ORDER BY verified_at DESC,id DESC
      `, [transaction.scope.tenantId, transaction.scope.storeId, family.customerIds])
      return result.rows.map((row) => ({
        publicId: row.public_id,
        maskedPhone: row.masked_value,
        status: 'active' as const,
        verifiedAt: row.verified_at,
        verificationSource: row.verification_source,
      }))
    }, { readOnly: true })
  }

  async replaceMyVerifiedPhone(
    context: PublicCustomerExperienceContext,
    input: Readonly<{
      verifiedPhone: VerifiedRecoveryPhoneAuthorization
      idempotencyKey: string
    }>,
  ): Promise<PublicVerifiedPhone> {
    const protectedPhone = this.phones.protect(input.verifiedPhone.e164Phone)
    const providerReferenceHash = sha256(input.verifiedPhone.providerReference)
    const verifiedAt = timestamp(input.verifiedPhone.verifiedAt, 'verifiedAt')
    return this.transactions.run(context.scope, async (transaction) => {
      await transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `${transaction.scope.tenantId}:${transaction.scope.storeId}:verified-phone:${context.customerId}`,
      ])
      const family = await canonicalCustomerFamily(transaction, context.customerId)
      const replay = await transaction.query<{
        public_id: string; masked_value: string; verified_at: string
        verification_source: PublicVerifiedPhone['verificationSource']
      }>(`
        SELECT contact.public_id,contact.masked_value,action.authorized_at::text AS verified_at,
          action.authorization_source AS verification_source
        FROM mbox.customer_verified_contact_actions action
        JOIN mbox.customer_verified_contacts contact
          ON contact.tenant_id=action.tenant_id AND contact.store_id=action.store_id
         AND contact.id=action.contact_id
        WHERE action.tenant_id=$1::uuid AND action.store_id=$2::uuid
          AND contact.customer_id=ANY($3::uuid[])
          AND action.authorization_reference_sha256=$4 AND action.action='verified'
          AND contact.processing_status<>'disposed'
        ORDER BY action.authorized_at DESC,action.id DESC LIMIT 1
      `, [
        transaction.scope.tenantId, transaction.scope.storeId,
        family.customerIds, providerReferenceHash,
      ])
      if (replay.rows[0]) return verifiedPhoneView(replay.rows[0])
      const exact = await transaction.query<{
        id: string; public_id: string; masked_value: string
        verification_source: PublicVerifiedPhone['verificationSource']
      }>(`
        SELECT id,public_id,masked_value,verification_source
        FROM mbox.customer_verified_contacts
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND customer_id=ANY($3::uuid[]) AND contact_type='phone'
          AND contact_hash=ANY($4::char(64)[]) AND processing_status<>'disposed'
        ORDER BY verified_at DESC,id DESC LIMIT 1 FOR UPDATE
      `, [
        transaction.scope.tenantId, transaction.scope.storeId,
        family.customerIds, protectedPhone.matchHashes,
      ])
      const exactContact = exact.rows[0]
      const active = await transaction.query<{ id: string }>(`
        SELECT id FROM mbox.customer_verified_contacts
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND customer_id=ANY($3::uuid[]) AND contact_type='phone'
          AND processing_status='active'
          AND ($4::uuid IS NULL OR id<>$4::uuid)
        ORDER BY verified_at,id FOR UPDATE
      `, [
        transaction.scope.tenantId, transaction.scope.storeId,
        family.customerIds, exactContact?.id ?? null,
      ])
      for (const contact of active.rows) {
        await revokeVerifiedContact(transaction, contact.id, {
          customerId: context.customerId,
          employeeId: null,
          reasonCode: 'customer_replaced_phone',
          reasonDetail: null,
          idempotencyKey: input.idempotencyKey,
          action: 'superseded',
        })
      }
      if (exactContact) {
        const requestSha256 = sha256(JSON.stringify({
          contactId: exactContact.id,
          customerId: context.customerId,
          providerReferenceHash,
          authorizedAt: verifiedAt,
        }))
        await transaction.query(`
          SELECT mbox.reauthorize_verified_membership_phone(
            $1::uuid,$2::uuid,NULL::uuid,'wechat_phone_authorization',
            $3::char(64),$4::timestamptz,$5,$6::char(64)
          )
        `, [
          exactContact.id, context.customerId, providerReferenceHash,
          verifiedAt, input.idempotencyKey, requestSha256,
        ])
        return {
          publicId: exactContact.public_id,
          maskedPhone: exactContact.masked_value,
          status: 'active',
          verifiedAt,
          verificationSource: 'wechat_phone_authorization',
        }
      }
      const supersedesContactId = active.rows.at(-1)?.id ?? null
      const inserted = await transaction.query<{
        id: string; public_id: string; masked_value: string; verified_at: string
        verification_source: PublicVerifiedPhone['verificationSource']
      }>(`
        INSERT INTO mbox.customer_verified_contacts(
          tenant_id,store_id,public_id,customer_id,contact_type,contact_hash,
          encrypted_value,encryption_key_version,masked_value,verification_source,
          contact_encryption_key_id,provider_reference_sha256,verified_by_customer_id,verified_at,
          processing_status,supersedes_contact_id
        ) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,'phone',$5,$6::bytea,$7,$8,
          'wechat_phone_authorization',$9,$10,$4::uuid,$11::timestamptz,'active',$12::uuid)
        RETURNING id,public_id,masked_value,verified_at::text,verification_source
      `, [
        transaction.scope.tenantId, transaction.scope.storeId,
        `CVC${randomUUID().replaceAll('-', '').toUpperCase()}`, family.canonicalCustomerId,
        protectedPhone.contactHash, protectedPhone.encryptedValue,
        protectedPhone.encryptionKeyVersion, protectedPhone.maskedValue,
        protectedPhone.encryptionKeyId,providerReferenceHash, verifiedAt, supersedesContactId,
      ])
      const row = required(inserted.rows[0], 'replaced verified phone')
      return verifiedPhoneView(row)
    })
  }

  async revokeMyVerifiedPhone(
    context: PublicCustomerExperienceContext,
    input: Readonly<{ contactPublicId: string; idempotencyKey: string }>,
  ): Promise<{ publicId: string; status: 'revoked' }> {
    return this.transactions.run(context.scope, async (transaction) => {
      const family = await canonicalCustomerFamily(transaction, context.customerId)
      const contact = await transaction.query<{ id: string; public_id: string; processing_status: string }>(`
        SELECT id,public_id,processing_status FROM mbox.customer_verified_contacts
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
          AND customer_id=ANY($4::uuid[]) AND contact_type='phone'
        FOR UPDATE
      `, [
        transaction.scope.tenantId, transaction.scope.storeId,
        input.contactPublicId, family.customerIds,
      ])
      const row = contact.rows[0]
      if (!row) throw recoveryError('VERIFIED_PHONE_NOT_FOUND', '没有找到可撤回的手机号')
      if (row.processing_status === 'disposed') {
        throw recoveryError('VERIFIED_PHONE_NOT_FOUND', '这个手机号已停止处理')
      }
      if (row.processing_status === 'active') {
        await revokeVerifiedContact(transaction, row.id, {
          customerId: context.customerId, employeeId: null,
          reasonCode: 'customer_withdrew_optional_phone', reasonDetail: null,
          idempotencyKey: input.idempotencyKey, action: 'revoked',
        })
      }
      return { publicId: row.public_id, status: 'revoked' }
    })
  }

  async recordStaffVerifiedContact(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      memberNo: string
      e164Phone: string
      reason: string
      idempotencyKey: string
    }>,
  ): Promise<{ memberNo: string; maskedPhone: string; verifiedAt: string }> {
    const protectedPhone = this.phones.protect(input.e164Phone)
    const verifiedAt = this.now().toISOString()
    return this.transactions.run(context.scope, async (transaction) => {
      const member = await transaction.query<{ customer_id: string; member_no: string }>(`
        SELECT customer_id,member_no FROM mbox.customer_memberships
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND member_no=$3 AND status='active'
        FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.memberNo])
      const row = required(member.rows[0], 'active membership')
      const providerReferenceHash = sha256(`staff:${context.employeeId}:${input.idempotencyKey}`)
      const replay = await transaction.query<{
        masked_value: string; verified_at: string
      }>(`
        SELECT masked_value,verified_at::text FROM mbox.customer_verified_contacts
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND customer_id=$3::uuid
          AND provider_reference_sha256=$4 AND verification_source='staff_controlled'
          AND processing_status<>'disposed'
      `, [
        transaction.scope.tenantId, transaction.scope.storeId,
        row.customer_id, providerReferenceHash,
      ])
      if (replay.rows[0] !== undefined) return {
        memberNo: row.member_no,
        maskedPhone: replay.rows[0].masked_value,
        verifiedAt: replay.rows[0].verified_at,
      }
      await upsertVerifiedContact(transaction, {
        customerId: row.customer_id,
        protectedPhone,
        verificationSource: 'staff_controlled',
        providerReferenceHash,
        verifiedByCustomerId: null,
        verifiedByEmployeeId: context.employeeId,
        verifiedAt,
        idempotencyKey: input.idempotencyKey,
        reasonDetail: input.reason,
      })
      return { memberNo: row.member_no, maskedPhone: protectedPhone.maskedValue, verifiedAt }
    })
  }

  async reviewQueue(context: StaffCustomerExperienceContext): Promise<readonly Record<string, unknown>[]> {
    return this.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<Record<string, unknown>>(`
        SELECT merge_case.public_id AS "casePublicId",merge_case.status,
          challenge.candidate_count AS "candidateCount",contact.masked_value AS "maskedPhone",
          selected_candidate.public_id AS "selectedCandidatePublicId",
          CASE WHEN membership.member_no IS NULL THEN NULL
            ELSE left(membership.member_no,4)||repeat('*',GREATEST(length(membership.member_no)-6,2))||right(membership.member_no,2)
          END AS "maskedMemberNo",
          merge_case.created_at::text AS "createdAt"
        FROM mbox.membership_merge_cases merge_case
        JOIN mbox.membership_recovery_challenges challenge
          ON challenge.tenant_id=merge_case.tenant_id AND challenge.store_id=merge_case.store_id
         AND challenge.id=merge_case.challenge_id
        JOIN mbox.customer_verified_contacts contact
          ON contact.tenant_id=challenge.tenant_id AND contact.store_id=challenge.store_id
         AND contact.id=challenge.verified_contact_id
        LEFT JOIN mbox.membership_recovery_candidates selected_candidate
          ON selected_candidate.tenant_id=merge_case.tenant_id AND selected_candidate.store_id=merge_case.store_id
         AND selected_candidate.id=merge_case.selected_candidate_id
        LEFT JOIN mbox.customer_memberships membership
          ON membership.tenant_id=merge_case.tenant_id AND membership.store_id=merge_case.store_id
         AND membership.id=merge_case.source_membership_id
        WHERE merge_case.tenant_id=$1::uuid AND merge_case.store_id=$2::uuid
          AND merge_case.status IN ('manual_review','pending_review')
        ORDER BY merge_case.created_at,merge_case.id LIMIT 100
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      return result.rows
    }, { readOnly: true })
  }

  async candidates(
    context: StaffCustomerExperienceContext,
    casePublicId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    return this.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<Record<string, unknown>>(`
        SELECT candidate.public_id AS "candidatePublicId",
          left(membership.member_no,4)||repeat('*',GREATEST(length(membership.member_no)-6,2))||right(membership.member_no,2) AS "maskedMemberNo",
          membership.joined_at::date::text AS "joinedDate",
          contact.masked_value AS "maskedPhone"
        FROM mbox.membership_merge_cases merge_case
        JOIN mbox.membership_recovery_candidates candidate
          ON candidate.tenant_id=merge_case.tenant_id AND candidate.store_id=merge_case.store_id
         AND candidate.challenge_id=merge_case.challenge_id
        JOIN mbox.customer_memberships membership
          ON membership.tenant_id=candidate.tenant_id AND membership.store_id=candidate.store_id
         AND membership.id=candidate.candidate_membership_id
        JOIN mbox.customer_verified_contacts contact
          ON contact.tenant_id=candidate.tenant_id AND contact.store_id=candidate.store_id
         AND contact.id=candidate.matched_contact_id
        WHERE merge_case.tenant_id=$1::uuid AND merge_case.store_id=$2::uuid
          AND merge_case.public_id=$3 AND merge_case.status='manual_review'
        ORDER BY membership.joined_at,candidate.id
      `, [transaction.scope.tenantId, transaction.scope.storeId, casePublicId])
      return result.rows
    }, { readOnly: true })
  }

  async selectCandidate(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      casePublicId: string
      candidatePublicId: string
      reason: string
      idempotencyKey: string
    }>,
  ): Promise<{ casePublicId: string; status: 'pending_review' }> {
    return this.transactions.run(context.scope, async (transaction) => {
      const mergeCase = await lockMergeCase(transaction, input.casePublicId)
      if (await hasAction(transaction, mergeCase.id, 'candidate_selected', input.idempotencyKey)) {
        return { casePublicId: mergeCase.public_id, status: 'pending_review' }
      }
      if (mergeCase.status !== 'manual_review') {
        throw recoveryError('RECOVERY_CASE_NOT_SELECTABLE', '该找回申请已不在候选核验阶段')
      }
      const selected = await transaction.query<CandidateRow>(`
        SELECT candidate.id,candidate.public_id,
          candidate.candidate_customer_id AS customer_id,
          candidate.candidate_membership_id AS membership_id,
          candidate.matched_contact_id, membership.member_no,membership.joined_at::text,
          contact.verified_by_employee_id
        FROM mbox.membership_recovery_candidates candidate
        JOIN mbox.customer_memberships membership
          ON membership.tenant_id=candidate.tenant_id AND membership.store_id=candidate.store_id
         AND membership.id=candidate.candidate_membership_id AND membership.status='active'
        JOIN mbox.customer_verified_contacts contact
          ON contact.tenant_id=candidate.tenant_id AND contact.store_id=candidate.store_id
         AND contact.id=candidate.matched_contact_id AND contact.processing_status='active'
        WHERE candidate.tenant_id=$1::uuid AND candidate.store_id=$2::uuid
          AND candidate.challenge_id=$3::uuid AND candidate.public_id=$4
      `, [transaction.scope.tenantId, transaction.scope.storeId, mergeCase.challenge_id, input.candidatePublicId])
      const candidate = required(selected.rows[0], 'recovery candidate')
      await transaction.query(`
        UPDATE mbox.membership_merge_cases
        SET selected_candidate_id=$4::uuid,source_customer_id=$5::uuid,
          source_membership_id=$6::uuid,status='pending_review',
          selected_by_employee_id=$7::uuid,selected_reason=$8,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='manual_review'
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, mergeCase.id,
        candidate.id, candidate.customer_id, candidate.membership_id,
        context.employeeId, input.reason,
      ])
      await appendAction(transaction, mergeCase.id, {
        action: 'candidate_selected', actorType: 'employee', actorCustomerId: null,
        actorEmployeeId: context.employeeId, reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      })
      return { casePublicId: mergeCase.public_id, status: 'pending_review' }
    })
  }

  async approve(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ casePublicId: string; reason: string; idempotencyKey: string }>,
  ): Promise<{ casePublicId: string; status: 'executed' }> {
    return this.transactions.run(context.scope, async (transaction) => {
      const mergeCase = await lockMergeCase(transaction, input.casePublicId)
      if (mergeCase.status === 'executed') {
        if (await hasAction(transaction, mergeCase.id, 'approved', input.idempotencyKey)) {
          return { casePublicId: mergeCase.public_id, status: 'executed' }
        }
        throw recoveryError('RECOVERY_CASE_NOT_APPROVABLE', '该找回申请已经完成')
      }
      if (mergeCase.status !== 'pending_review' || mergeCase.source_customer_id === null
        || mergeCase.source_membership_id === null || mergeCase.selected_candidate_id === null) {
        throw recoveryError('RECOVERY_CASE_NOT_APPROVABLE', '该找回申请尚未完成候选核验')
      }
      if (mergeCase.selected_by_employee_id === context.employeeId) {
        throw recoveryError('RECOVERY_MAKER_CHECKER_REQUIRED', '候选核验人与合并复核人必须是不同员工')
      }
      const evidence = await transaction.query<{ verified_by_employee_id: string | null }>(`
        SELECT contact.verified_by_employee_id
        FROM mbox.membership_recovery_candidates candidate
        JOIN mbox.customer_verified_contacts contact
          ON contact.tenant_id=candidate.tenant_id AND contact.store_id=candidate.store_id
         AND contact.id=candidate.matched_contact_id
        WHERE candidate.tenant_id=$1::uuid AND candidate.store_id=$2::uuid
          AND candidate.id=$3::uuid AND contact.processing_status='active'
      `, [transaction.scope.tenantId, transaction.scope.storeId, mergeCase.selected_candidate_id])
      const verifier = required(evidence.rows[0], 'candidate verification evidence').verified_by_employee_id
      if (verifier === context.employeeId) {
        throw recoveryError('RECOVERY_MAKER_CHECKER_REQUIRED', '历史联系方式核验人与合并复核人必须是不同员工')
      }
      const targetMembership = await transaction.query<{ id: string }>(`
        WITH RECURSIVE family(id) AS (
          SELECT $3::uuid
          UNION ALL
          SELECT child.id FROM mbox.customers child JOIN family parent
            ON child.merged_into_customer_id=parent.id
          WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
        )
        SELECT membership.id FROM mbox.customer_memberships membership
        WHERE membership.tenant_id=$1::uuid AND membership.store_id=$2::uuid
          AND membership.customer_id IN (SELECT id FROM family) AND membership.status='active'
        ORDER BY membership.joined_at,membership.id FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, mergeCase.target_customer_id])
      if ((targetMembership.rowCount ?? 0) > 0) {
        throw recoveryError('RECOVERY_TARGET_ALREADY_MEMBER', '当前账户已经成为会员，必须重新人工核对')
      }
      await transaction.query(`
        UPDATE mbox.membership_merge_cases
        SET status='approved',approved_by_employee_id=$4::uuid,approval_reason=$5,
          approved_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='pending_review'
      `, [transaction.scope.tenantId, transaction.scope.storeId, mergeCase.id, context.employeeId, input.reason])
      await appendAction(transaction, mergeCase.id, {
        action: 'approved', actorType: 'employee', actorCustomerId: null,
        actorEmployeeId: context.employeeId, reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      })
      await transaction.query(`
        SELECT mbox.reconcile_verified_contacts_for_membership_merge(
          $1::uuid,$2::uuid,$3
        )
      `, [mergeCase.id,context.employeeId,input.idempotencyKey])
      await new CustomerRepository(transaction).merge(
        mergeCase.source_customer_id, mergeCase.target_customer_id,
      )
      await transaction.query(`
        UPDATE mbox.membership_merge_cases
        SET status='executed',executed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='approved'
      `, [transaction.scope.tenantId, transaction.scope.storeId, mergeCase.id])
      await transaction.query(`
        UPDATE mbox.membership_recovery_challenges
        SET status='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      `, [transaction.scope.tenantId, transaction.scope.storeId, mergeCase.challenge_id])
      await appendAction(transaction, mergeCase.id, {
        action: 'executed', actorType: 'system', actorCustomerId: null,
        actorEmployeeId: null, reason: '独立复核通过后在同一事务中保留来源账户并建立规范化合并链',
        idempotencyKey: input.idempotencyKey,
      })
      return { casePublicId: mergeCase.public_id, status: 'executed' }
    })
  }

  async reject(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ casePublicId: string; reason: string; idempotencyKey: string }>,
  ): Promise<{ casePublicId: string; status: 'rejected' }> {
    return this.transactions.run(context.scope, async (transaction) => {
      const mergeCase = await lockMergeCase(transaction, input.casePublicId)
      if (mergeCase.status === 'rejected') {
        const replay = await hasAction(transaction, mergeCase.id, 'rejected', input.idempotencyKey)
        if (replay) return { casePublicId: mergeCase.public_id, status: 'rejected' }
      }
      if (!['manual_review', 'pending_review'].includes(mergeCase.status)) {
        throw recoveryError('RECOVERY_CASE_NOT_REJECTABLE', '该找回申请已不能驳回')
      }
      await transaction.query(`
        UPDATE mbox.membership_merge_cases
        SET status='rejected',rejected_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status IN ('manual_review','pending_review')
      `, [transaction.scope.tenantId, transaction.scope.storeId, mergeCase.id])
      await transaction.query(`
        UPDATE mbox.membership_recovery_challenges
        SET status='rejected',completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      `, [transaction.scope.tenantId, transaction.scope.storeId, mergeCase.challenge_id])
      await appendAction(transaction, mergeCase.id, {
        action: 'rejected', actorType: 'employee', actorCustomerId: null,
        actorEmployeeId: context.employeeId, reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      })
      return { casePublicId: mergeCase.public_id, status: 'rejected' }
    })
  }
}

export function createMembershipRecoveryPhoneProtector(
  secret: string | ActivityContactProtectionKeyring,
  encryptionKeyVersion = 1,
): MembershipRecoveryPhoneProtector {
  if (typeof secret !== 'string') {
    return {
      protect(value) {
        const protectedPhone=secret.protectPhone(normalizePhone(value))
        return { ...protectedPhone,encryptionKeyVersion:2 }
      },
    }
  }
  if (secret.length < 16) throw new TypeError('Membership recovery protection secret is too short')
  const encryptionKey = createHash('sha256').update(`mbox:membership-recovery:encryption:${secret}`).digest()
  const hashKey = createHmac('sha256', secret).update('mbox:membership-recovery:lookup:v1').digest()
  return {
    protect(value) {
      const phone = normalizePhone(value)
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce)
      const ciphertext = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()])
      return {
        contactHash: createHmac('sha256', hashKey).update(phone).digest('hex'),
        encryptedValue: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
        encryptionKeyVersion,
        encryptionKeyId:'normalized-phone-v1',
        matchHashes:[createHmac('sha256', hashKey).update(phone).digest('hex')],
        maskedValue: `${phone.slice(0, Math.min(3, phone.length - 4))}${'*'.repeat(Math.max(3, phone.length - 7))}${phone.slice(-4)}`,
      }
    },
  }
}

async function assertCustomerCanRecover(transaction: ScopedTransaction, customerId: string): Promise<void> {
  const customer = await transaction.query<{ status: string }>(`
    SELECT status FROM mbox.customers
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    FOR UPDATE
  `, [transaction.scope.tenantId, transaction.scope.storeId, customerId])
  if (customer.rows[0]?.status !== 'active') {
    throw recoveryError('RECOVERY_CUSTOMER_UNAVAILABLE', '当前顾客身份不能发起会员找回')
  }
  const membership = await transaction.query(`
    WITH RECURSIVE family(id) AS (
      SELECT $3::uuid
      UNION ALL
      SELECT child.id FROM mbox.customers child JOIN family parent
        ON child.merged_into_customer_id=parent.id
      WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
    )
    SELECT 1 FROM mbox.customer_memberships
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      AND customer_id IN (SELECT id FROM family) AND status='active'
  `, [transaction.scope.tenantId, transaction.scope.storeId, customerId])
  if ((membership.rowCount ?? 0) > 0) {
    throw recoveryError('MEMBERSHIP_ALREADY_BOUND', '当前微信已经绑定会员，无需再次找回')
  }
}

async function lockChallenge(
  transaction: ScopedTransaction,
  publicId: string,
  customerId: string,
): Promise<ChallengeRow> {
  const result = await transaction.query<ChallengeRow>(`
    SELECT id,public_id,requester_customer_id,status,verified_contact_id,
      candidate_count,verify_idempotency_key,expires_at::text
    FROM mbox.membership_recovery_challenges
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
      AND requester_customer_id=$4::uuid
    FOR UPDATE
  `, [transaction.scope.tenantId, transaction.scope.storeId, publicId, customerId])
  if (result.rows[0] === undefined) {
    throw recoveryError('RECOVERY_CHALLENGE_NOT_FOUND', '找回申请不存在或不属于当前账户')
  }
  return result.rows[0]
}

async function lockMergeCase(transaction: ScopedTransaction, publicId: string): Promise<MergeCaseRow> {
  const result = await transaction.query<MergeCaseRow>(`
    SELECT id,public_id,challenge_id,target_customer_id,selected_candidate_id,
      source_customer_id,source_membership_id,status,requested_by_customer_id,
      selected_by_employee_id
    FROM mbox.membership_merge_cases
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
    FOR UPDATE
  `, [transaction.scope.tenantId, transaction.scope.storeId, publicId])
  if (result.rows[0] === undefined) throw recoveryError('RECOVERY_CASE_NOT_FOUND', '会员找回申请不存在')
  return result.rows[0]
}

async function matchingCandidates(
  transaction: ScopedTransaction,
  contactHashes: readonly string[],
  requesterCustomerId: string,
): Promise<CandidateRow[]> {
  const result = await transaction.query<CandidateRow>(`
    SELECT contact.customer_id,membership.id AS membership_id,contact.id AS matched_contact_id,
      membership.member_no,membership.joined_at::text,contact.verified_by_employee_id,
      gen_random_uuid()::text AS id,''::text AS public_id
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
    ORDER BY membership.joined_at,membership.id
    FOR UPDATE OF contact,customer,membership
  `, [transaction.scope.tenantId, transaction.scope.storeId, contactHashes, requesterCustomerId])
  return result.rows
}

async function upsertVerifiedContact(
  transaction: ScopedTransaction,
  input: Readonly<{
    customerId: string
    protectedPhone: ProtectedRecoveryPhone
    verificationSource: 'wechat_phone_authorization' | 'staff_controlled'
    providerReferenceHash: string
    verifiedByCustomerId: string | null
    verifiedByEmployeeId: string | null
    verifiedAt: string
    idempotencyKey: string
    reasonDetail: string | null
  }>,
): Promise<{ id: string }> {
  const family = await canonicalCustomerFamily(transaction,input.customerId)
  await transaction.query(`
    SELECT id FROM mbox.customers
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    FOR UPDATE
  `,[transaction.scope.tenantId,transaction.scope.storeId,family.canonicalCustomerId])
  const verificationCustomerId = input.verifiedByCustomerId === null
    ? null
    : family.canonicalCustomerId
  const replay = await transaction.query<{ id: string }>(`
    SELECT id FROM mbox.customer_verified_contacts
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND customer_id=ANY($3::uuid[])
      AND contact_type='phone' AND provider_reference_sha256=$4
    FOR UPDATE
  `, [
    transaction.scope.tenantId, transaction.scope.storeId,
    family.customerIds, input.providerReferenceHash,
  ])
  if (replay.rows[0]) return replay.rows[0]
  const current = await transaction.query<{ id: string }>(`
    SELECT id FROM mbox.customer_verified_contacts
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND customer_id=ANY($3::uuid[])
      AND contact_type='phone' AND processing_status='active'
    ORDER BY verified_at,id FOR UPDATE
  `, [transaction.scope.tenantId, transaction.scope.storeId, family.customerIds])
  const superseded = current.rows[0]
  const sameValue = await transaction.query<{ id: string }>(`
    SELECT id FROM mbox.customer_verified_contacts
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND customer_id=ANY($3::uuid[])
      AND contact_type='phone' AND contact_hash=ANY($4::char(64)[]) AND processing_status<>'disposed'
    ORDER BY verified_at DESC,id DESC LIMIT 1 FOR UPDATE
  `, [
    transaction.scope.tenantId, transaction.scope.storeId,
    family.customerIds, input.protectedPhone.matchHashes,
  ])
  const sameContact = sameValue.rows[0]
  if (superseded && superseded.id !== sameContact?.id) {
    await transaction.query(`
      SELECT mbox.revoke_verified_membership_phone(
        $1::uuid,$2::uuid,$3::uuid,'replaced_by_verified_contact'
      )
    `, [
      superseded.id,input.verifiedByCustomerId,input.verifiedByEmployeeId,
    ])
    await appendVerifiedContactAction(transaction, superseded.id, {
      action: 'superseded',
      actorCustomerId: input.verifiedByCustomerId,
      actorEmployeeId: input.verifiedByEmployeeId,
      reasonCode: 'replaced_by_verified_contact',
      reasonDetail: input.reasonDetail,
      idempotencyKey: input.idempotencyKey,
      authorizationSource: null,
      authorizationReferenceSha256: null,
      authorizedAt: null,
    })
  }
  if (sameContact) {
    const requestSha256 = sha256(JSON.stringify({
      contactId: sameContact.id,
      actorCustomerId: input.verifiedByCustomerId,
      actorEmployeeId: input.verifiedByEmployeeId,
      authorizationSource: input.verificationSource,
      authorizationReferenceSha256: input.providerReferenceHash,
      authorizedAt: input.verifiedAt,
    }))
    await transaction.query(`
      SELECT mbox.reauthorize_verified_membership_phone(
        $1::uuid,$2::uuid,$3::uuid,$4,$5::char(64),$6::timestamptz,$7,$8::char(64)
      )
    `, [
      sameContact.id, input.verifiedByCustomerId, input.verifiedByEmployeeId,
      input.verificationSource, input.providerReferenceHash, input.verifiedAt,
      input.idempotencyKey, requestSha256,
    ])
    return sameContact
  }
  const result = await transaction.query<{ id: string }>(`
    INSERT INTO mbox.customer_verified_contacts (
      tenant_id,store_id,public_id,customer_id,contact_type,contact_hash,encrypted_value,
      encryption_key_version,masked_value,verification_source,provider_reference_sha256,
      contact_encryption_key_id,
      verified_by_customer_id,verified_by_employee_id,verified_at,
      processing_status,supersedes_contact_id
    ) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,'phone',$5,$6::bytea,$7,$8,$9,$10,$11,
      $12::uuid,$13::uuid,$14::timestamptz,'active',$15::uuid)
    RETURNING id
  `, [
    transaction.scope.tenantId, transaction.scope.storeId,
    `CVC${randomUUID().replaceAll('-', '').toUpperCase()}`, family.canonicalCustomerId,
    input.protectedPhone.contactHash, input.protectedPhone.encryptedValue,
    input.protectedPhone.encryptionKeyVersion, input.protectedPhone.maskedValue,
    input.verificationSource, input.providerReferenceHash,input.protectedPhone.encryptionKeyId,
    verificationCustomerId, input.verifiedByEmployeeId, input.verifiedAt,
    superseded?.id ?? null,
  ])
  return required(result.rows[0], 'verified contact')
}

async function appendVerifiedContactAction(
  transaction: ScopedTransaction,
  contactId: string,
  input: Readonly<{
    action: 'verified' | 'superseded' | 'revoked' | 'disposed'
    actorCustomerId: string | null
    actorEmployeeId: string | null
    reasonCode: string
    reasonDetail: string | null
    idempotencyKey: string
    authorizationSource: 'wechat_phone_authorization' | 'staff_controlled' | null
    authorizationReferenceSha256: string | null
    authorizedAt: string | null
  }>,
): Promise<void> {
  const actorType = input.actorCustomerId ? 'customer' : input.actorEmployeeId ? 'employee' : 'system'
  const requestSha256 = sha256(JSON.stringify({
    contactId, action: input.action, actorType,
    actorCustomerId: input.actorCustomerId, actorEmployeeId: input.actorEmployeeId,
    reasonCode: input.reasonCode, reasonDetail: input.reasonDetail,
    authorizationSource: input.authorizationSource,
    authorizationReferenceSha256: input.authorizationReferenceSha256,
    authorizedAt: input.authorizedAt,
  }))
  if (actorType === 'system') {
    throw recoveryError('VERIFIED_CONTACT_ACTION_ACTOR_REQUIRED','手机号操作必须绑定顾客或授权员工')
  }
  await transaction.query(`
    SELECT mbox.append_customer_verified_contact_action(
      $1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7,$8::char(64),
      $9::timestamptz,$10,$11::char(64)
    )
  `, [
    contactId,input.action,input.actorCustomerId,input.actorEmployeeId,
    input.reasonCode,input.reasonDetail,input.authorizationSource,
    input.authorizationReferenceSha256,input.authorizedAt,input.idempotencyKey,requestSha256,
  ])
}

async function appendAction(
  transaction: ScopedTransaction,
  mergeCaseId: string,
  input: Readonly<{
    action: 'requested' | 'candidate_selected' | 'approved' | 'rejected' | 'executed'
    actorType: 'customer' | 'employee' | 'system'
    actorCustomerId: string | null
    actorEmployeeId: string | null
    reason: string
    idempotencyKey: string
  }>,
): Promise<void> {
  await transaction.query(`
    INSERT INTO mbox.membership_merge_actions (
      tenant_id,store_id,merge_case_id,action,actor_type,
      actor_customer_id,actor_employee_id,reason,idempotency_key
    ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::uuid,$8,$9)
    ON CONFLICT (tenant_id,store_id,merge_case_id,action,idempotency_key) DO NOTHING
  `, [
    transaction.scope.tenantId, transaction.scope.storeId, mergeCaseId,
    input.action, input.actorType, input.actorCustomerId, input.actorEmployeeId,
    input.reason, input.idempotencyKey,
  ])
}

async function hasAction(
  transaction: ScopedTransaction,
  mergeCaseId: string,
  action: 'candidate_selected' | 'approved' | 'rejected' | 'executed',
  idempotencyKey: string,
): Promise<boolean> {
  const result = await transaction.query(`
    SELECT 1 FROM mbox.membership_merge_actions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND merge_case_id=$3::uuid
      AND action=$4 AND idempotency_key=$5
  `, [transaction.scope.tenantId, transaction.scope.storeId, mergeCaseId, action, idempotencyKey])
  return (result.rowCount ?? 0) > 0
}

async function expireChallenge(transaction: ScopedTransaction, id: string): Promise<void> {
  await transaction.query(`
    UPDATE mbox.membership_recovery_challenges
    SET status='expired',completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status='awaiting_verification'
  `, [transaction.scope.tenantId, transaction.scope.storeId, id])
}

function publicState(challenge: ChallengeRow): PublicMembershipRecoveryState {
  const status = challenge.status === 'cancelled' ? 'rejected' : challenge.status
  const message = status === 'awaiting_verification'
    ? '请使用微信专用手机号授权继续；这不会开启短信或营销。'
    : status === 'no_match'
      ? '未找到可安全确认的历史会员，请联系现场人员人工核验。'
      : status === 'pending_review'
        ? '验证已完成，门店将复核后恢复历史会员。'
        : status === 'manual_review'
          ? '发现多个可能账户，已转人工核验；系统不会自动合并或展示账户信息。'
          : status === 'completed'
            ? '历史会员已安全恢复。'
            : status === 'expired'
              ? '本次找回申请已过期，请重新发起。'
              : '本次找回未通过，请联系现场人员。'
  return {
    challengePublicId: challenge.public_id,
    status,
    message,
    expiresAt: challenge.expires_at,
  }
}

async function canonicalCustomerFamily(
  transaction: ScopedTransaction,
  customerId: string,
): Promise<{ canonicalCustomerId: string; customerIds: string[] }> {
  const result = await transaction.query<{ id: string; canonical_id: string }>(`
    WITH RECURSIVE ancestry AS (
      SELECT id,merged_into_customer_id FROM mbox.customers
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      UNION ALL
      SELECT parent.id,parent.merged_into_customer_id
      FROM mbox.customers parent JOIN ancestry child
        ON child.merged_into_customer_id=parent.id
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
    SELECT family.id,canonical.id AS canonical_id FROM family CROSS JOIN canonical
    ORDER BY family.id
  `, [transaction.scope.tenantId, transaction.scope.storeId, customerId])
  const canonicalCustomerId = result.rows[0]?.canonical_id
  if (!canonicalCustomerId) throw recoveryError('RECOVERY_CUSTOMER_UNAVAILABLE', '当前顾客身份不存在')
  return { canonicalCustomerId, customerIds: result.rows.map((row) => row.id) }
}

async function revokeVerifiedContact(
  transaction: ScopedTransaction,
  contactId: string,
  input: Readonly<{
    customerId: string | null
    employeeId: string | null
    reasonCode: string
    reasonDetail: string | null
    idempotencyKey: string
    action: 'superseded' | 'revoked'
  }>,
): Promise<void> {
  const updated = await transaction.query<{ revoked: boolean }>(`
    SELECT mbox.revoke_verified_membership_phone(
      $1::uuid,$2::uuid,$3::uuid,$4
    ) AS revoked
  `, [
    contactId,input.customerId,input.employeeId,input.reasonCode,
  ])
  if (!updated.rows[0]?.revoked) return
  await appendVerifiedContactAction(transaction, contactId, {
    action: input.action,
    actorCustomerId: input.customerId,
    actorEmployeeId: input.employeeId,
    reasonCode: input.reasonCode,
    reasonDetail: input.reasonDetail,
    idempotencyKey: input.idempotencyKey,
    authorizationSource: null,
    authorizationReferenceSha256: null,
    authorizedAt: null,
  })
}

function verifiedPhoneView(row: Readonly<{
  public_id: string
  masked_value: string
  verified_at: string
  verification_source: PublicVerifiedPhone['verificationSource']
}>): PublicVerifiedPhone {
  return {
    publicId: row.public_id,
    maskedPhone: row.masked_value,
    status: 'active',
    verifiedAt: row.verified_at,
    verificationSource: row.verification_source,
  }
}

function normalizePhone(value: string): string {
  const phone = value.replace(/[\s()-]/g, '')
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) {
    throw recoveryError('RECOVERY_PHONE_INVALID', '微信返回的手机号格式无效')
  }
  return phone
}

function recoveryPublicId(prefix: 'MRC' | 'MRD' | 'MMC'): string {
  return `${prefix}${randomUUID().replaceAll('-', '').toUpperCase()}`
}

function sha256(value: string): string {
  if (!value.trim()) throw recoveryError('RECOVERY_VERIFICATION_INVALID', '手机号授权凭证无效')
  return createHash('sha256').update(value).digest('hex')
}

function timestamp(value: string, label: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw recoveryError('RECOVERY_VERIFICATION_INVALID', `${label}无效`)
  return parsed.toISOString()
}

function required<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) throw recoveryError('RECOVERY_STATE_CONFLICT', `${label}不存在或状态已变化`)
  return value
}

function recoveryError(code: string, message: string): CustomerExperienceRequestError {
  return new CustomerExperienceRequestError(message, code, 409)
}
