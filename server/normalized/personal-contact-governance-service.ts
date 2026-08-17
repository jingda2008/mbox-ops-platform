import { createHash, randomUUID } from 'node:crypto'
import type { ProtectedActivityRegistrationContact } from './customer-experience-repository.js'
import type {
  PublicCustomerExperienceContext,
  StaffCustomerExperienceContext,
} from './customer-experience-service.js'
import {
  PersonalContactDecryptionError,
  type ActivityContactProtectionKeyring,
} from './personal-contact-protection.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

type ResourceKind = 'activity_registration_contact' | 'verified_membership_phone'
type ContactAccessPurpose =
  | 'attendance_coordination' | 'waitlist_coordination' | 'payment_followup'
  | 'activity_change' | 'safety_coordination'

export class PersonalContactGovernanceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(message)
    this.name = 'PersonalContactGovernanceError'
  }
}

export class PersonalContactGovernanceService {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly activityContacts: ActivityContactProtectionKeyring,
  ) {}

  updateMyActivityContact(
    context: PublicCustomerExperienceContext,
    input: Readonly<{
      registrationPublicId: string
      contact: ProtectedActivityRegistrationContact
      idempotencyKey: string
    }>,
  ): Promise<{ contactVersionPublicId: string; maskedContact: string; status: 'active' }> {
    const requestSha256 = stableContactFingerprint(input.contact)
    return this.transactions.run(context.scope, async (transaction) => {
      const registration = await transaction.query<{
        id: string; registration_cycle: number; customer_id: string
      }>(`
        WITH RECURSIVE ancestry AS (
          SELECT id,merged_into_customer_id FROM mbox.customers
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$4::uuid
          UNION ALL
          SELECT parent.id,parent.merged_into_customer_id
          FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
          WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
        ), canonical AS (
          SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
        ), family AS (
          SELECT id FROM canonical UNION ALL
          SELECT child.id FROM mbox.customers child JOIN family parent
            ON child.merged_into_customer_id=parent.id
          WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
        )
        SELECT registration.id,registration.registration_cycle,registration.customer_id
        FROM mbox.community_activity_registrations registration
        WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
          AND registration.public_id=$3 AND registration.customer_id IN (SELECT id FROM family)
          AND registration.status IN ('reserved','payment_pending','confirmed','waitlisted','checked_in')
        FOR UPDATE
      `, [
        transaction.scope.tenantId, transaction.scope.storeId,
        input.registrationPublicId, context.customerId,
      ])
      const row = registration.rows[0]
      if (!row) throw error('ACTIVITY_CONTACT_NOT_FOUND', '没有找到可更正联系方式的活动报名', 404)
      const replay = await transaction.query<{
        public_id: string; masked_contact: string | null; request_sha256: string
        status: 'active' | 'inactive' | 'disposed'; is_current: boolean
      }>(`
        SELECT contact.public_id,contact.masked_contact,contact.request_sha256,contact.status,
          (contact.status='active' AND NOT EXISTS (
            SELECT 1 FROM mbox.community_activity_registration_contact_versions current_contact
            WHERE current_contact.tenant_id=contact.tenant_id
              AND current_contact.store_id=contact.store_id
              AND current_contact.registration_id=contact.registration_id
              AND current_contact.registration_cycle=contact.registration_cycle
              AND current_contact.status='active' AND current_contact.id<>contact.id
          )) AS is_current
        FROM mbox.community_activity_registration_contact_versions contact
        WHERE contact.tenant_id=$1::uuid AND contact.store_id=$2::uuid
          AND contact.registration_id=$3::uuid
          AND contact.registration_cycle=$4 AND contact.idempotency_key=$5
        FOR UPDATE
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, row.id,
        row.registration_cycle, input.idempotencyKey,
      ])
      if (replay.rows[0]) {
        if (replay.rows[0].request_sha256 !== requestSha256) {
          throw error('ACTIVITY_CONTACT_IDEMPOTENCY_CONFLICT', '重复编号对应的联系方式不一致')
        }
        if (replay.rows[0].status !== 'active' || !replay.rows[0].is_current
          || replay.rows[0].masked_contact === null) {
          throw error('ACTIVITY_CONTACT_REPLAY_EXPIRED', '该联系方式更正请求已过期，请使用新的重试编号')
        }
        return {
          contactVersionPublicId: replay.rows[0].public_id,
          maskedContact: replay.rows[0].masked_contact,
          status: 'active' as const,
        }
      }
      const current = await transaction.query<{ id: string; version: number }>(`
        SELECT id,version FROM mbox.community_activity_registration_contact_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND registration_id=$3::uuid
          AND registration_cycle=$4 AND status='active'
        FOR UPDATE
      `, [
        transaction.scope.tenantId, transaction.scope.storeId,
        row.id, row.registration_cycle,
      ])
      const previous = current.rows[0]
      if (!previous) throw error('ACTIVITY_CONTACT_STATE_CONFLICT', '当前报名联系方式状态不完整', 503)
      await transaction.query(`
        UPDATE mbox.community_activity_registration_contact_versions
        SET status='inactive',inactivated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active'
      `, [transaction.scope.tenantId, transaction.scope.storeId, previous.id])
      const publicId = contactPublicId('ACV')
      await transaction.query(`
        INSERT INTO mbox.community_activity_registration_contact_versions(
          tenant_id,store_id,public_id,registration_id,registration_cycle,version,status,
          supersedes_contact_version_id,contact_type,contact_hash,encrypted_contact,
          encryption_key_id,masked_contact,contact_source,created_by_customer_id,
          idempotency_key,request_sha256
        ) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,'active',$7::uuid,$8,$9,$10::bytea,
          $11,$12,$13,$14::uuid,$15,$16)
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, publicId,
        row.id, row.registration_cycle, previous.version + 1, previous.id,
        input.contact.contactType, input.contact.contactHash,
        Buffer.from(input.contact.encryptedContact, 'base64'), input.contact.encryptionKeyId,
        input.contact.maskedContact, input.contact.source, context.customerId,
        input.idempotencyKey, requestSha256,
      ])
      return { contactVersionPublicId: publicId, maskedContact: input.contact.maskedContact, status: 'active' as const }
    })
  }

  async revealActivityContact(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      contactVersionPublicId: string
      purpose: ContactAccessPurpose
      idempotencyKey: string
    }>,
  ): Promise<{ contactType: string; contactValue: string; maskedContact: string; expiresAt: string }> {
    const claimToken = randomUUID()
    const claimed = await this.transactions.run(context.scope, async (transaction) => {
      const selected = await transaction.query<{
        id: string; contact_type: string; contact_hash: string; encrypted_contact: Buffer
        encryption_key_id: string; masked_contact: string; employee_allowed: boolean
        registration_id: string; payment_id: string | null; purpose_allowed: boolean
      }>(`
        SELECT contact.id,contact.contact_type,contact.contact_hash,contact.encrypted_contact,
          contact.encryption_key_id,contact.masked_contact,
          mbox.employee_has_effective_permission(
            contact.tenant_id,contact.store_id,$4::uuid,'community.activity.contact.reveal'
          ) AS employee_allowed,registration.id AS registration_id,
          registration.payment_id,
          CASE
            WHEN $5='waitlist_coordination' THEN registration.status='waitlisted'
            WHEN $5='attendance_coordination' THEN registration.status IN ('confirmed','checked_in')
              AND clock_timestamp()>=activity.starts_at-interval '24 hours'
            WHEN $5='payment_followup' THEN registration.status='payment_pending'
              AND registration.payment_status='pending' AND payment.status IN ('created','pending')
            ELSE false
          END AS purpose_allowed
        FROM mbox.community_activity_registration_contact_versions contact
        JOIN mbox.community_activity_registrations registration
          ON registration.tenant_id=contact.tenant_id AND registration.store_id=contact.store_id
         AND registration.id=contact.registration_id
        JOIN mbox.community_activities activity
          ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
         AND activity.id=registration.activity_id
        LEFT JOIN mbox.payments payment
          ON payment.tenant_id=registration.tenant_id AND payment.store_id=registration.store_id
         AND payment.id=registration.payment_id
        WHERE contact.tenant_id=$1::uuid AND contact.store_id=$2::uuid
          AND contact.public_id=$3 AND contact.status='active'
          AND contact.registration_cycle=registration.registration_cycle
          AND registration.status IN ('reserved','payment_pending','confirmed','waitlisted','checked_in')
          AND activity.status IN ('published','full') AND activity.ends_at>clock_timestamp()
        FOR UPDATE OF contact
      `, [
        transaction.scope.tenantId,transaction.scope.storeId,input.contactVersionPublicId,
        context.employeeId,input.purpose,
      ])
      const row = selected.rows[0]
      if (!row) throw error('ACTIVITY_CONTACT_REVEAL_DENIED', '联系方式已更新、已清除或不属于当前报名', 404)
      if (!row.employee_allowed) throw error('ACTIVITY_CONTACT_REVEAL_FORBIDDEN', '当前岗位无权查看活动联系方式', 403)
      if (!row.purpose_allowed || (input.purpose==='payment_followup' && row.payment_id===null)) {
        throw error('ACTIVITY_CONTACT_PURPOSE_UNAVAILABLE', '当前报名没有可验证的联系用途', 409)
      }
      const contextKind=input.purpose==='payment_followup'?'payment' as const:'activity_registration' as const
      const contextId=input.purpose==='payment_followup'?row.payment_id!:row.registration_id
      const requestSha256 = sha256(JSON.stringify({
        contactVersionId: row.id,employeeId:context.employeeId,purpose:input.purpose,
        contextKind,contextId,
      }))
      const inserted = await transaction.query<{
        outcome: 'claimed'; display_expires_at: string
      }>(`
        INSERT INTO mbox.activity_contact_access_events(
          tenant_id,store_id,contact_version_id,employee_id,access_purpose,outcome,
          denial_code,claim_token,context_kind,context_id,idempotency_key,request_sha256,
          display_expires_at
        ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'claimed',NULL,$6::uuid,$7,$8::uuid,$9,$10,
          clock_timestamp()+interval '60 seconds')
        ON CONFLICT (tenant_id,store_id,employee_id,idempotency_key) DO NOTHING
        RETURNING outcome,display_expires_at::text
      `, [
        transaction.scope.tenantId,transaction.scope.storeId,row.id,context.employeeId,
        input.purpose,claimToken,contextKind,contextId,input.idempotencyKey,requestSha256,
      ])
      const existing = await transaction.query<{
        request_sha256: string; outcome: 'claimed' | 'revealed' | 'denied' | 'decrypt_failed'
        denial_code: string | null; display_expires_at: string | null; access_unexpired: boolean
      }>(`
        SELECT request_sha256,outcome,denial_code,display_expires_at::text,
          COALESCE(display_expires_at>clock_timestamp(),false) AS access_unexpired
        FROM mbox.activity_contact_access_events
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND employee_id=$3::uuid
          AND idempotency_key=$4 FOR UPDATE
      `, [
        transaction.scope.tenantId, transaction.scope.storeId,
        context.employeeId, input.idempotencyKey,
      ])
      if (existing.rows[0] && existing.rows[0].request_sha256 !== requestSha256) {
        throw error('ACTIVITY_CONTACT_ACCESS_IDEMPOTENCY_CONFLICT', '重复查看编号对应的用途不一致')
      }
      const access = existing.rows[0]
      if (!inserted.rows[0]) {
        if (!access) throw error('ACTIVITY_CONTACT_ACCESS_STATE_CONFLICT', '查看请求状态不完整', 503)
        if (access.outcome === 'claimed') {
          if (!access.access_unexpired) {
            await transaction.query(`
              UPDATE mbox.activity_contact_access_events
              SET outcome='denied',denial_code='CLAIM_EXPIRED',display_expires_at=NULL
              WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND employee_id=$3::uuid
                AND idempotency_key=$4 AND outcome='claimed'
            `, [
              transaction.scope.tenantId,transaction.scope.storeId,
              context.employeeId,input.idempotencyKey,
            ])
            throw error('ACTIVITY_CONTACT_ACCESS_EXPIRED', '查看请求已过期，请使用新的查看编号', 409)
          }
          throw error('ACTIVITY_CONTACT_ACCESS_IN_PROGRESS', '联系方式查看请求正在处理，请稍后重试', 425)
        }
        if (access.outcome !== 'revealed') {
          throw error('ACTIVITY_CONTACT_REVEAL_DENIED', '该次查看未成功，请使用新的查看编号', 409)
        }
        if (!access.access_unexpired) {
          throw error('ACTIVITY_CONTACT_ACCESS_EXPIRED', '联系方式显示时限已过，请使用新的查看编号', 409)
        }
      }
      return {
        row,
        requestSha256,
        initialClaim: inserted.rows[0] !== undefined,
        contextKind,contextId,
        expiresAt: inserted.rows[0]?.display_expires_at ?? access!.display_expires_at!,
      }
    })
    let contactValue: string
    try {
      contactValue = this.activityContacts.reveal({
        encryptedContact: claimed.row.encrypted_contact,
        contactHash: claimed.row.contact_hash,
        encryptionKeyId: claimed.row.encryption_key_id,
      })
    } catch (decryptionError) {
      if (claimed.initialClaim) {
        const denialCode = decryptionError instanceof PersonalContactDecryptionError
          ? decryptionError.code : 'CIPHERTEXT_INVALID'
        await this.finalizeActivityContactAccess(context, input, claimToken, claimed.row.id, {
          outcome: 'decrypt_failed', denialCode,
        },claimed.contextKind,claimed.contextId)
      }
      throw error('ACTIVITY_CONTACT_DECRYPT_FAILED', '联系方式无法安全读取，请由负责人核查密钥配置', 503)
    }
    if (claimed.initialClaim) {
      const finalOutcome = await this.finalizeActivityContactAccess(context, input, claimToken, claimed.row.id, {
        outcome: 'revealed', denialCode: null,
      },claimed.contextKind,claimed.contextId)
      if (finalOutcome !== 'revealed') {
        throw error('ACTIVITY_CONTACT_REVEAL_DENIED', '联系用途已结束，请勿继续联系', 409)
      }
    } else {
      const stillAllowed=await this.transactions.run(context.scope,async (transaction) => {
        const checked=await transaction.query<{ allowed:boolean }>(`
          SELECT mbox.activity_contact_access_context_is_valid(
            $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid
          ) AS allowed
        `,[
          transaction.scope.tenantId,transaction.scope.storeId,claimed.row.id,
          context.employeeId,input.purpose,claimed.contextKind,claimed.contextId,
        ])
        return checked.rows[0]?.allowed===true
      },{ readOnly:true })
      if (!stillAllowed) throw error(
        'ACTIVITY_CONTACT_REVEAL_DENIED','联系用途已结束，请勿继续联系',409,
      )
    }
    return {
      contactType: claimed.row.contact_type,
      contactValue,
      maskedContact: claimed.row.masked_contact,
      expiresAt: claimed.expiresAt,
    }
  }

  private finalizeActivityContactAccess(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ purpose: ContactAccessPurpose; idempotencyKey: string }>,
    claimToken: string,
    contactVersionId: string,
    result: Readonly<{ outcome: 'revealed' | 'denied' | 'decrypt_failed'; denialCode: string | null }>,
    contextKind:'activity_registration'|'payment',
    contextId:string,
  ) {
    return this.transactions.run(context.scope, async (transaction) => {
      if (result.outcome === 'revealed') {
        const stillAllowed = await transaction.query<{ allowed: boolean }>(`
          SELECT mbox.activity_contact_access_context_is_valid(
            $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid
          ) AS allowed
        `, [
          transaction.scope.tenantId,transaction.scope.storeId,contactVersionId,
          context.employeeId,input.purpose,contextKind,contextId,
        ])
        if (!stillAllowed.rows[0]?.allowed) {
          result = { outcome: 'denied', denialCode: 'PURPOSE_ENDED' }
        }
      }
      const updated = await transaction.query<{ outcome: 'revealed' | 'denied' | 'decrypt_failed' }>(`
        UPDATE mbox.activity_contact_access_events
        SET outcome=CASE
            WHEN $6='revealed' AND display_expires_at>clock_timestamp() THEN 'revealed'
            WHEN $6='revealed' THEN 'denied'
            ELSE $6
          END,
          denial_code=CASE
            WHEN $6='revealed' AND display_expires_at<=clock_timestamp() THEN 'CLAIM_EXPIRED'
            ELSE $7
          END,
          display_expires_at=CASE
            WHEN $6='revealed' AND display_expires_at>clock_timestamp() THEN display_expires_at
            ELSE NULL
          END
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND contact_version_id=$3::uuid
          AND employee_id=$4::uuid AND idempotency_key=$5 AND claim_token=$8::uuid
          AND outcome='claimed'
        RETURNING outcome
      `, [
        transaction.scope.tenantId,transaction.scope.storeId,contactVersionId,
        context.employeeId,input.idempotencyKey,result.outcome,result.denialCode,claimToken,
      ])
      if (!updated.rows[0]) throw error('ACTIVITY_CONTACT_ACCESS_STATE_CONFLICT', '查看请求未能安全确认', 503)
      return updated.rows[0].outcome
    })
  }

  listPolicies(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<Record<string, unknown>>(`
        SELECT policy.public_id AS "publicId",policy.resource_kind AS "resourceKind",
          policy.version,policy.status,
          policy.retention_days_after_purpose_end AS "retentionDaysAfterPurposeEnd",
          policy.legal_basis_reference AS "legalBasisReference",
          drafter.display_name AS "draftedBy",policy.draft_reason AS "draftReason",
          approver.display_name AS "approvedBy",policy.approval_reason AS "approvalReason",
          policy.approved_at::text AS "approvedAt",publisher.display_name AS "publishedBy",
          policy.publication_reason AS "publicationReason",policy.published_at::text AS "publishedAt",
          policy.effective_from::text AS "effectiveFrom",policy.effective_until::text AS "effectiveUntil",
          policy.created_at::text AS "createdAt"
        FROM mbox.personal_contact_retention_policy_versions policy
        LEFT JOIN mbox.employees drafter ON drafter.tenant_id=policy.tenant_id
          AND drafter.store_id=policy.store_id AND drafter.id=policy.drafted_by_employee_id
        LEFT JOIN mbox.employees approver ON approver.tenant_id=policy.tenant_id
          AND approver.store_id=policy.store_id AND approver.id=policy.approved_by_employee_id
        LEFT JOIN mbox.employees publisher ON publisher.tenant_id=policy.tenant_id
          AND publisher.store_id=policy.store_id AND publisher.id=policy.published_by_employee_id
        WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
        ORDER BY policy.resource_kind,policy.version DESC
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      return result.rows
    }, { readOnly: true })
  }

  listEvidence(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, async (transaction) => {
      const eligibleResources=await transaction.query<Record<string,unknown>>(`
        SELECT eligible."publicId",eligible."resourceKind",eligible."maskedContact",
          eligible."businessLabel",eligible.status
        FROM (
          SELECT contact.public_id AS "publicId",
            'activity_registration_contact'::text AS "resourceKind",
            COALESCE(contact.masked_contact,'已清除') AS "maskedContact",
            activity.title AS "businessLabel",registration.status,
            contact.captured_at AS created_at
          FROM mbox.community_activity_registration_contact_versions contact
          JOIN mbox.community_activity_registrations registration
            ON registration.tenant_id=contact.tenant_id AND registration.store_id=contact.store_id
           AND registration.id=contact.registration_id
          JOIN mbox.community_activities activity
            ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
           AND activity.id=registration.activity_id
          WHERE contact.tenant_id=$1::uuid AND contact.store_id=$2::uuid
            AND contact.status<>'disposed'
          UNION ALL
          SELECT contact.public_id,'verified_membership_phone'::text,
            COALESCE(contact.masked_value,'已清除'),'已验证会员手机号'::text,
            contact.processing_status,contact.created_at
          FROM mbox.customer_verified_contacts contact
          WHERE contact.tenant_id=$1::uuid AND contact.store_id=$2::uuid
            AND contact.processing_status<>'disposed'
        ) eligible
        ORDER BY eligible.created_at DESC,eligible."publicId" DESC LIMIT 200
      `,[transaction.scope.tenantId,transaction.scope.storeId])
      const holds=await transaction.query<Record<string,unknown>>(`
        SELECT hold.public_id AS "publicId",hold.resource_kind AS "resourceKind",
          CASE WHEN hold.resource_kind='activity_registration_contact'
            THEN activity_contact.public_id ELSE verified_contact.public_id END AS "resourcePublicId",
          CASE WHEN hold.resource_kind='activity_registration_contact'
            THEN COALESCE(activity_contact.masked_contact,'已清除')
            ELSE COALESCE(verified_contact.masked_value,'已清除') END AS "maskedContact",
          hold.status,hold.legal_basis_reference AS "legalBasisReference",hold.reason,
          creator.display_name AS "createdBy",hold.created_at::text AS "createdAt",
          hold.hold_until::text AS "holdUntil",releaser.display_name AS "releasedBy",
          hold.release_reason AS "releaseReason",hold.released_at::text AS "releasedAt"
        FROM mbox.personal_contact_legal_holds hold
        LEFT JOIN mbox.community_activity_registration_contact_versions activity_contact
          ON activity_contact.tenant_id=hold.tenant_id AND activity_contact.store_id=hold.store_id
         AND activity_contact.id=hold.activity_contact_version_id
        LEFT JOIN mbox.customer_verified_contacts verified_contact
          ON verified_contact.tenant_id=hold.tenant_id AND verified_contact.store_id=hold.store_id
         AND verified_contact.id=hold.verified_contact_id
        JOIN mbox.employees creator ON creator.tenant_id=hold.tenant_id
          AND creator.store_id=hold.store_id AND creator.id=hold.created_by_employee_id
        LEFT JOIN mbox.employees releaser ON releaser.tenant_id=hold.tenant_id
          AND releaser.store_id=hold.store_id AND releaser.id=hold.released_by_employee_id
        WHERE hold.tenant_id=$1::uuid AND hold.store_id=$2::uuid
        ORDER BY (hold.status='active') DESC,hold.created_at DESC LIMIT 200
      `,[transaction.scope.tenantId,transaction.scope.storeId])
      const dispositions=await transaction.query<Record<string,unknown>>(`
        SELECT CASE WHEN event.resource_kind='activity_registration_contact'
            THEN activity_contact.public_id ELSE verified_contact.public_id END AS "resourcePublicId",
          event.resource_kind AS "resourceKind",'已清除'::text AS "maskedContact",
          policy.public_id AS "policyPublicId",policy.version AS "policyVersion",
          event.disposition_method AS "dispositionMethod",
          event.purpose_ended_at::text AS "purposeEndedAt",event.disposed_at::text AS "disposedAt"
        FROM mbox.personal_contact_disposition_events event
        JOIN mbox.personal_contact_retention_policy_versions policy
          ON policy.tenant_id=event.tenant_id AND policy.store_id=event.store_id
         AND policy.id=event.policy_version_id
        LEFT JOIN mbox.community_activity_registration_contact_versions activity_contact
          ON activity_contact.tenant_id=event.tenant_id AND activity_contact.store_id=event.store_id
         AND activity_contact.id=event.activity_contact_version_id
        LEFT JOIN mbox.customer_verified_contacts verified_contact
          ON verified_contact.tenant_id=event.tenant_id AND verified_contact.store_id=event.store_id
         AND verified_contact.id=event.verified_contact_id
        WHERE event.tenant_id=$1::uuid AND event.store_id=$2::uuid
        ORDER BY event.disposed_at DESC LIMIT 200
      `,[transaction.scope.tenantId,transaction.scope.storeId])
      return {eligibleResources:eligibleResources.rows,holds:holds.rows,dispositions:dispositions.rows}
    },{readOnly:true})
  }

  draftPolicy(context: StaffCustomerExperienceContext, input: Readonly<{
    resourceKind: ResourceKind; retentionDaysAfterPurposeEnd: number
    legalBasisReference: string; reason: string
  }>) {
    return this.transactions.run(context.scope, async (transaction) => {
      const publicId = contactPublicId('PCR')
      await transaction.query(`
        SELECT mbox.draft_personal_contact_retention_policy(
          $1,$2,$3,$4,$5::uuid,$6
        )
      `, [
        publicId,input.resourceKind,input.retentionDaysAfterPurposeEnd,
        input.legalBasisReference,context.employeeId,input.reason,
      ])
      const result = await transaction.query<Record<string, unknown>>(`
        SELECT public_id AS "publicId",resource_kind AS "resourceKind",version,status
        FROM mbox.personal_contact_retention_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
      `,[transaction.scope.tenantId,transaction.scope.storeId,publicId])
      return required(result.rows[0], 'contact retention draft')
    }, { isolation: 'serializable', retryOnConflict: 2 })
  }

  approvePolicy(context: StaffCustomerExperienceContext, input: Readonly<{
    publicId: string; reason: string
  }>) {
    return this.policyTransition(context, input.publicId, async (transaction, policy) => {
      const result = await transaction.query<Record<string, unknown>>(`
        SELECT mbox.approve_personal_contact_retention_policy(
          $1::uuid,$2::uuid,$3
        ) AS "publicId"
      `, [
        policy.id, context.employeeId, input.reason,
      ])
      if (!result.rows[0]) throw error('CONTACT_RETENTION_MAKER_CHECKER_REQUIRED', '审批人必须与起草人不同')
      return result.rows[0]
    })
  }

  publishPolicy(context: StaffCustomerExperienceContext, input: Readonly<{
    publicId: string; effectiveFrom: string; reason: string
  }>) {
    return this.policyTransition(context, input.publicId, async (transaction, policy) => {
      const effectiveFrom = new Date(input.effectiveFrom)
      if (!Number.isFinite(effectiveFrom.getTime()) || effectiveFrom.getTime() < Date.now() - 60_000) {
        throw error('CONTACT_RETENTION_EFFECTIVE_TIME_INVALID', '生效时间无效或已明显早于当前时间')
      }
      const result = await transaction.query<Record<string, unknown>>(`
        SELECT mbox.publish_personal_contact_retention_policy(
          $1::uuid,$2::uuid,$3,$4::timestamptz
        ) AS "publicId"
      `, [
        policy.id, context.employeeId, input.reason, effectiveFrom.toISOString(),
      ])
      return required(result.rows[0], 'contact retention publication')
    })
  }

  createLegalHold(context: StaffCustomerExperienceContext, input: Readonly<{
    resourceKind: ResourceKind; resourcePublicId: string
    legalBasisReference: string; reason: string; holdUntil: string | null
  }>) {
    return this.transactions.run(context.scope, async (transaction) => {
      const publicId = contactPublicId('PCH')
      const created=await transaction.query<{ public_id:string }>(`
        SELECT mbox.create_personal_contact_legal_hold(
          $1,$2,$3,$4,$5,$6::uuid,$7::timestamptz
        ) AS public_id
      `, [
        publicId,input.resourceKind,input.resourcePublicId,input.legalBasisReference,
        input.reason,context.employeeId,input.holdUntil,
      ])
      return { publicId:required(created.rows[0],'personal contact legal hold').public_id, status: 'active' as const }
    })
  }

  releaseLegalHold(context: StaffCustomerExperienceContext, input: Readonly<{
    publicId: string; reason: string
  }>) {
    return this.transactions.run(context.scope, async (transaction) => {
      const updated = await transaction.query<{ public_id: string }>(`
        SELECT mbox.release_personal_contact_legal_hold($1,$2::uuid,$3) AS public_id
      `, [
        input.publicId, context.employeeId, input.reason,
      ])
      if (!updated.rows[0]) throw error('CONTACT_LEGAL_HOLD_NOT_FOUND', '法定保留不存在或已释放', 404)
      return { publicId: updated.rows[0].public_id, status: 'released' as const }
    })
  }

  private policyTransition<Result>(
    context: StaffCustomerExperienceContext,
    publicId: string,
    execute: (transaction: ScopedTransaction, policy: { id: string; resource_kind: ResourceKind }) => Promise<Result>,
  ): Promise<Result> {
    return this.transactions.run(context.scope, async (transaction) => {
      const selected = await transaction.query<{ id: string; resource_kind: ResourceKind }>(`
        SELECT id,resource_kind FROM mbox.personal_contact_retention_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3 FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, publicId])
      if (!selected.rows[0]) throw error('CONTACT_RETENTION_POLICY_NOT_FOUND', '保留策略不存在', 404)
      return execute(transaction, selected.rows[0])
    }, { isolation: 'serializable', retryOnConflict: 2 })
  }
}

function stableContactFingerprint(contact: ProtectedActivityRegistrationContact) {
  return sha256(JSON.stringify({
    contactType: contact.contactType,
    contactHash: contact.contactHash,
    contactSource: contact.source,
  }))
}

function contactPublicId(prefix: 'ACV' | 'PCR' | 'PCH') {
  return `${prefix}${randomUUID().replaceAll('-', '').toUpperCase()}`
}

function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
function required<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) throw error('CONTACT_GOVERNANCE_STATE_CONFLICT', `${label}未能建立`, 503)
  return value
}
function error(code: string, message: string, statusCode = 409) {
  return new PersonalContactGovernanceError(message, code, statusCode)
}
