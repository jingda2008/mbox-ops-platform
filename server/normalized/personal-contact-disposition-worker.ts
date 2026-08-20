import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export interface PersonalContactDispositionBatch {
  workerId: string
  examined: number
  disposed: number
  skipped: number
  failed: number
}

type Candidate = { resource_kind:'activity_registration_contact'|'verified_membership_phone'; resource_id:string; policy_id:string }

export class PersonalContactDispositionWorker {
  constructor(
    private readonly transactions:Pick<ScopedPostgresTransactionRunner,'run'>,
    private readonly batchSize=50,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize<1 || batchSize>200) {
      throw new TypeError('personal contact disposition batch size must be between 1 and 200')
    }
  }

  runBatch(scope:Readonly<StoreScope>,workerId:string):Promise<PersonalContactDispositionBatch> {
    // The coordinator supplies the final evidence id.  Do not add the worker
    // name a second time: a valid 96-character coordinator id plus one suffix
    // must still fit the database's 128-character evidence boundary.
    const evidenceWorkerId=workerId
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,96}:personal-contact-disposition$/.test(evidenceWorkerId)
      || evidenceWorkerId.length>128) {
      throw new TypeError('personal contact disposition worker id is invalid')
    }
    return this.transactions.run(scope,async (transaction) => {
      const candidates=await transaction.query<Candidate>(`
        WITH current_policy AS (
          SELECT DISTINCT ON (policy.resource_kind) policy.resource_kind,policy.id,
            policy.retention_days_after_purpose_end
          FROM mbox.personal_contact_retention_policy_versions policy
          WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
            AND policy.status='published' AND policy.effective_from<=clock_timestamp()
            AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
          ORDER BY policy.resource_kind,policy.effective_from DESC,policy.version DESC
        ), eligible AS (
          SELECT 'activity_registration_contact'::text AS resource_kind,
            contact.id AS resource_id,policy.id AS policy_id,
            COALESCE(contact.inactivated_at,
              CASE WHEN registration.status IN ('cancelled','no_show','refunded')
                  OR registration.payment_status='expired'
                THEN GREATEST(contact.captured_at,COALESCE(registration.cancelled_at,activity.ends_at))
                ELSE GREATEST(contact.captured_at,activity.ends_at) END
            ) AS ordered_at
          FROM mbox.community_activity_registration_contact_versions contact
          JOIN mbox.community_activity_registrations registration
            ON registration.tenant_id=contact.tenant_id AND registration.store_id=contact.store_id
           AND registration.id=contact.registration_id
          JOIN mbox.community_activities activity
            ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
           AND activity.id=registration.activity_id
          JOIN current_policy policy ON policy.resource_kind='activity_registration_contact'
          WHERE contact.tenant_id=$1::uuid AND contact.store_id=$2::uuid
            AND contact.status IN ('active','inactive') AND (
              contact.status='inactive' OR registration.status IN ('cancelled','no_show','refunded')
              OR registration.payment_status='expired'
              OR activity.status IN ('cancelled','completed') OR activity.ends_at<=clock_timestamp()
            )
            AND COALESCE(contact.inactivated_at,
              CASE WHEN registration.status IN ('cancelled','no_show','refunded')
                  OR registration.payment_status='expired'
                THEN GREATEST(contact.captured_at,COALESCE(registration.cancelled_at,activity.ends_at))
                ELSE GREATEST(contact.captured_at,activity.ends_at) END
            )+make_interval(days=>policy.retention_days_after_purpose_end)<=clock_timestamp()
            AND NOT EXISTS (
              SELECT 1 FROM mbox.personal_contact_legal_holds hold
              WHERE hold.tenant_id=contact.tenant_id AND hold.store_id=contact.store_id
                AND hold.activity_contact_version_id=contact.id AND hold.status='active'
                AND (hold.hold_until IS NULL OR hold.hold_until>clock_timestamp())
            )
            AND NOT EXISTS (
              SELECT 1 FROM mbox.payments payment
              LEFT JOIN mbox.payment_provider_actions provider_action
                ON provider_action.tenant_id=payment.tenant_id AND provider_action.store_id=payment.store_id
               AND provider_action.payment_id=payment.id
              LEFT JOIN mbox.refunds refund
                ON refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id
               AND refund.payment_id=payment.id
              WHERE payment.tenant_id=registration.tenant_id AND payment.store_id=registration.store_id
                AND payment.id=registration.payment_id AND (
                  payment.status IN ('created','pending') OR provider_action.state IN ('creating','unknown')
                  OR refund.status IN ('requested','approved','processing')
                  OR refund.provider_submission_state IN ('submitting','manual_review')
                )
            )
          UNION ALL
          SELECT 'verified_membership_phone',contact.id,policy.id,contact.revoked_at
          FROM mbox.customer_verified_contacts contact
          JOIN current_policy policy ON policy.resource_kind='verified_membership_phone'
          WHERE contact.tenant_id=$1::uuid AND contact.store_id=$2::uuid
            AND contact.contact_type='phone' AND contact.processing_status='revoked'
            AND contact.revoked_at+make_interval(days=>policy.retention_days_after_purpose_end)<=clock_timestamp()
            AND NOT EXISTS (
              SELECT 1 FROM mbox.personal_contact_legal_holds hold
              WHERE hold.tenant_id=contact.tenant_id AND hold.store_id=contact.store_id
                AND hold.verified_contact_id=contact.id AND hold.status='active'
                AND (hold.hold_until IS NULL OR hold.hold_until>clock_timestamp())
            )
            AND NOT EXISTS (
              SELECT 1 FROM mbox.membership_recovery_challenges challenge
              WHERE challenge.tenant_id=contact.tenant_id AND challenge.store_id=contact.store_id
                AND challenge.verified_contact_id=contact.id
                AND challenge.status IN ('awaiting_verification','manual_review','pending_review')
            )
        )
        SELECT resource_kind,resource_id,policy_id FROM eligible
        ORDER BY ordered_at,resource_id LIMIT $3
      `,[transaction.scope.tenantId,transaction.scope.storeId,this.batchSize])
      return candidates.rows
    },{ readOnly:true }).then(async (candidates) => {
      let disposed=0
      let failed=0
      for (const candidate of candidates) {
        try {
          const result=await this.transactions.run(scope,transaction => transaction.query<{ disposed:boolean }>(`
          SELECT mbox.dispose_personal_contact($1,$2::uuid,$3::uuid,$4) AS disposed
          `,[candidate.resource_kind,candidate.resource_id,candidate.policy_id,evidenceWorkerId]))
          if (result.rows[0]?.disposed) disposed+=1
        } catch { failed+=1 }
      }
      return {
        workerId:evidenceWorkerId,examined:candidates.length,disposed,
        skipped:candidates.length-disposed-failed,failed,
      }
    })
  }
}
