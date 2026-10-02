package com.mbox.staff
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import java.time.Instant
class StaffToolsTest{
 private fun actor(vararg permissions:String)=StaffIdentity("s","e","worker","员工","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),permissions.toSet(),emptySet())
 @Test fun readOnlyEmployeesCanFindTheirViewsWithoutGainingWrites(){
  val a=actor("service.view","loyalty.policy.view").copy(navigationRoutes=listOf("/staff/tasks","/staff/member-overview"))
  assertTrue(staffTools(a).any{it.id=="service"});assertTrue(staffTools(a).any{it.id=="membershipOverview"});assertFalse(staffTools(a).any{it.id=="membershipConfig"});assertFalse(a.allows("service.execute"));assertEquals(listOf(6,3),staffTabs(a))
  assertTrue(staffTools(a.copy(navigationRoutes=emptyList())).isEmpty());assertFalse(staffTools(a.copy(denied=setOf("loyalty.policy.view"))).any{it.id=="membershipOverview"})
 }
 @Test fun searchFindsOperationsInDescriptionsAndRespectsAvailablePermissions(){
  val a=actor("inventory.receive","catalog.product.manage").copy(navigationRoutes=listOf("/staff/inventory"));val tools=staffTools(a)
  assertEquals(listOf("stock"),filterStaffTools(tools," 扫码 入库 ","").map{it.id});assertEquals(listOf("products"),filterStaffTools(tools,"套餐","").map{it.id});assertTrue(filterStaffTools(tools,"退款","").isEmpty());assertTrue(filterStaffTools(tools,"","会员服务").isEmpty());assertEquals(tools.size,tools.map{it.id}.distinct().size)
 }
 @Test fun publishedOverviewDoesNotTreatScheduledOrExpiredRulesAsEffective(){
  val r=JSONObject().put("id","a").put("version",1).put("status","published").put("effectiveFrom","2037-01-01 10:00:00+08").put("effectiveUntil","2037-01-02T10:00:00+08:00")
  assertEquals("已发布 · 待生效",membershipEffective(r,Instant.parse("2037-01-01T01:59:59Z")));assertEquals("生效时段内",membershipEffective(r,Instant.parse("2037-01-01T02:00:00Z")));assertEquals("历史已结束",membershipEffective(r,Instant.parse("2037-01-02T02:00:00Z")))
  assertEquals(1,publishedMembershipRows(listOf(r,JSONObject(r.toString()).put("status","draft").put("version",2))).size)
 }
}
