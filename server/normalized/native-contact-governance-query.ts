import {createHash} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'
const sql={
policies:`
        SELECT policy.public_id AS "publicId",policy.resource_kind AS "resourceKind",
          policy.version,policy.status,policy.drafted_by_employee_id AS "draftedByEmployeeId",policy.approved_by_employee_id AS "approvedByEmployeeId",policy.published_by_employee_id AS "publishedByEmployeeId",
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
        AND ($3::text IS NULL OR policy.public_id>$3) AND ($4::text IS NULL OR policy.public_id=$4) ORDER BY policy.public_id LIMIT 51
      `
,resources:`
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
        WHERE ($3::text IS NULL OR eligible."publicId">$3) AND ($4::text IS NULL OR eligible."publicId"=$4) AND ($5::text IS NULL OR eligible."businessLabel" ILIKE $5 OR eligible."publicId" ILIKE $5 OR eligible."maskedContact" ILIKE $5) ORDER BY eligible."publicId" LIMIT 51
      `
,holds:`
        SELECT hold.public_id AS "publicId",hold.resource_kind AS "resourceKind",
          CASE WHEN hold.resource_kind='activity_registration_contact'
            THEN activity_contact.public_id ELSE verified_contact.public_id END AS "resourcePublicId",
          CASE WHEN hold.resource_kind='activity_registration_contact'
            THEN COALESCE(activity_contact.masked_contact,'已清除')
            ELSE COALESCE(verified_contact.masked_value,'已清除') END AS "maskedContact",
          hold.created_by_employee_id AS "createdByEmployeeId",hold.released_by_employee_id AS "releasedByEmployeeId",hold.status,hold.legal_basis_reference AS "legalBasisReference",hold.reason,
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
        AND ($3::text IS NULL OR hold.public_id>$3) AND ($4::text IS NULL OR hold.public_id=$4) ORDER BY hold.public_id LIMIT 51
      `
,dispositions:`SELECT * FROM (
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
        
      ) d WHERE ($3::text IS NULL OR d."resourcePublicId">$3) ORDER BY d."resourcePublicId" LIMIT 51`
}
export async function nativeContactRows(tx:ScopedTransaction,area:keyof typeof sql,cursor:string|null=null,only:string|null=null,search:string=''){
 const args:unknown[]=[tx.scope.tenantId,tx.scope.storeId,cursor];if(area!=='dispositions')args.push(only);if(area==='resources')args.push(search?'%'+search.replace(/[\\%_]/g,'\\$&')+'%':null)
 const result=await tx.query<Record<string,unknown>>(sql[area],args),rows:Array<Record<string,unknown>&{nativeVersion:string}>=result.rows.slice(0,50).map(row=>({...row,nativeVersion:createHash('sha256').update(JSON.stringify(row)).digest('hex')}))
 return{rows,next:result.rows.length>50?String(rows[49]![area==='dispositions'?'resourcePublicId':'publicId']):null}
}
