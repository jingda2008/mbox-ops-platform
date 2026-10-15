import type {ScopedTransaction} from '../../server/normalized/transaction-runner.js'
import {StaffAccessRepository} from '../../server/normalized/staff-access-repository.js'
// Only called inside the disposable browser database; never a production seed.
export async function seedManualPointsBrowserFixture(tx:ScopedTransaction,requester:string,reviewer:string,publisher:string){
 const scope=[tx.scope.tenantId,tx.scope.storeId],access=new StaffAccessRepository(tx)
 for(const employeeId of [requester,reviewer])for(const permissionCode of ['loyalty.adjust.manual','loyalty.accrual.approve','loyalty.accrual.exception.view'])await access.setEmployeePermissionOverride({employeeId,permissionCode,effect:'grant',reason:'隔离人工积分浏览器验收',configuredByEmployeeId:publisher,startsAt:new Date(Date.now()-60000).toISOString()})
 await tx.query(`INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency)
  SELECT tenant_id,store_id,role_id,'loyalty.adjust.manual',10000,'CNY' FROM mbox.employee_roles WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 AND ends_at IS NULL ON CONFLICT DO NOTHING`,[...scope,reviewer])
 await tx.query(`INSERT INTO mbox.loyalty_policy_versions(tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason)
  SELECT $1,$2,'BASE',COALESCE(MAX(version),0)+1,'published',1,1000,1,100,'floor',18,clock_timestamp()-interval '1 day',$3,$4,clock_timestamp()-interval '1 day',$5,clock_timestamp()-interval '1 day','separated','隔离人工积分审核规则'
  FROM mbox.loyalty_policy_versions WHERE tenant_id=$1 AND store_id=$2 AND policy_code='BASE'`,[...scope,requester,reviewer,publisher])
 for(const width of [320,360]){
  const customer=(await tx.query<{id:string}>("INSERT INTO mbox.customers(tenant_id,store_id,public_id) VALUES($1,$2,$3) RETURNING id",[...scope,`manual-browser-${width}`])).rows[0]!.id
  const member=(await tx.query<{id:string}>("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no,level) VALUES($1,$2,$3,$4,'member') RETURNING id",[...scope,customer,`MBX-MANUAL${width}`])).rows[0]!.id
  await tx.query('INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4)',[...scope,member,customer])
 }
}
