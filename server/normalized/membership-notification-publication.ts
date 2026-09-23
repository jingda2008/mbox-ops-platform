import type {ScopedTransaction} from './transaction-runner.js'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {assertMembershipConfigurationPublisherSeparation} from './membership-configuration-draft-service.js'

export async function publishMembershipNotification(tx:ScopedTransaction,id:string,employeeId:string,input:{expectedRevision:number;effectiveFrom:string;effectiveUntil:string|null;reason:string}){
  await new StaffAccessRepository(tx).assertPermission(employeeId,'loyalty.policy.publish')
  const s=[tx.scope.tenantId,tx.scope.storeId]
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`notification-publication:${s.join(':')}`])
  const row=(await tx.query<{status:string;notification_type:string;draft_revision:number;approved_by_employee_id:string;drafted_by_employee_id:string}>(`SELECT status,notification_type,draft_revision,approved_by_employee_id,drafted_by_employee_id
    FROM mbox.lock_managed_notification_policy($3::uuid) WHERE tenant_id=$1::uuid AND store_id=$2::uuid`,[...s,id])).rows[0]
  if(!row||row.status!=='approved'||row.draft_revision!==input.expectedRevision)throw conflict('通知规则已变化，请重新读取已审批版本')
  const makers=await tx.query<{employee_id:string}>(`SELECT employee_id FROM mbox.membership_configuration_draft_contributors
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND configuration_domain='wechat_notifications' AND configuration_id=$3::uuid`,[...s,id])
  assertMembershipConfigurationPublisherSeparation({makerEmployeeIds:[row.drafted_by_employee_id,...makers.rows.map(r=>r.employee_id)],approverEmployeeId:row.approved_by_employee_id,publisherEmployeeId:employeeId})
  if(!Number.isFinite(Date.parse(input.effectiveFrom))||Date.parse(input.effectiveFrom)<=Date.now()||input.effectiveUntil!==null&&(!Number.isFinite(Date.parse(input.effectiveUntil))||Date.parse(input.effectiveUntil)<=Date.parse(input.effectiveFrom)))throw conflict('请选择未来的生效时间；结束时间须晚于生效时间')
  const future=await tx.query(`SELECT id FROM mbox.wechat_notification_policies WHERE tenant_id=$1::uuid AND store_id=$2::uuid
    AND notification_type=$3 AND status='published' AND effective_from>=$4::timestamptz`,[...s,row.notification_type,input.effectiveFrom])
  if(future.rows.length)throw conflict('已有更晚的通知规则排期，请核对现有生效时间后再发布')
  await tx.query('SELECT mbox.publish_managed_notification_policy($1::uuid,$2::integer,$3::uuid,$4::timestamptz,$5::timestamptz,$6)',
    [id,input.expectedRevision,employeeId,input.effectiveFrom,input.effectiveUntil,input.reason])
  return {id,status:'published',effectiveFrom:input.effectiveFrom,effectiveUntil:input.effectiveUntil}
}
function conflict(message:string){return new CustomerExperienceRequestError(message,'MEMBERSHIP_NOTIFICATION_CONFLICT',409)}
