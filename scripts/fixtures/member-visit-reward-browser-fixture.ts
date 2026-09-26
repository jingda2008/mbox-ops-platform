import type { ScopedTransaction } from '../../server/normalized/transaction-runner.js'
import { MemberGiftCampaignRepository } from '../../server/normalized/member-gift-campaign-repository.js'
import { StaffAccessRepository } from '../../server/normalized/staff-access-repository.js'
// Only called in the opt-in throwaway browser database, never production.
export async function seedMemberVisitRewardBrowserFixture(tx:ScopedTransaction,input:{employeeId:string;approver:string;publisher:string;businessDate:string;calendarId:string;productId:string}){
  const {employeeId,approver,publisher,businessDate,calendarId,productId}=input
  await new StaffAccessRepository(tx).setEmployeePermissionOverride({employeeId,permissionCode:'loyalty.configuration.approve',effect:'grant',reason:'隔离签到审批浏览器测试',configuredByEmployeeId:employeeId,startsAt:new Date(Date.now()-60000).toISOString()})
  const gifts=new MemberGiftCampaignRepository(tx)
  const saved=await gifts.create({code:'BROWSER_VISIT_REWARD',name:'测试累计签到赠品',employeeId,businessDate,reason:'隔离签到赠品规则',requestKey:'browser-visit-reward-rule',rule:{
    trigger:'targeted',cardProjectId:null,audience:{minimumTier:'member',cardCodes:[],cardMatch:'any',tierAndCards:'and'},quantityPerCustomer:1,maximumQuantity:20,maximumDailyQuantity:20,maximumCostMinor:2000,maximumDailyCostMinor:2000,maximumUnitCostMinor:100,budgetDateBasis:'business',budgetDayStartMinute:360,currency:'CNY',availableFrom:new Date(Date.now()-3600000).toISOString(),availableUntil:new Date(Date.now()+86400000).toISOString(),couponCalendarVersionId:calendarId,productIds:[productId],
  }})
  await gifts.decide({versionId:saved.versionId,action:'approve',employeeId:approver,businessDate,reason:'隔离规则审批'})
  await gifts.decide({versionId:saved.versionId,action:'publish',employeeId:publisher,businessDate,reason:'隔离规则发布'})
  for(const suffix of ['A','B','C']){
    const customer=(await tx.query<{id:string}>('INSERT INTO mbox.customers(tenant_id,store_id,public_id) VALUES($1,$2,$3) RETURNING id',[tx.scope.tenantId,tx.scope.storeId,`browser-visit-${suffix}`])).rows[0]!.id
    await tx.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no,level) VALUES($1,$2,$3,$4,'gold')",[tx.scope.tenantId,tx.scope.storeId,customer,`MBX-REWARD-${suffix}`])
  }
}
