package com.mbox.staff

import org.junit.Assert.*
import org.junit.Test

class StaffNavigationTest {
    private fun actor(vararg permissions: String) = StaffIdentity("s","e","staff","员工","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),permissions.toSet(),emptySet())
    @Test fun leastPrivilegeKitchenAndPickupDoNotLandOnTables() {
        assertEquals(listOf(4,3), staffTabs(actor("kds.prepare")))
        assertEquals(listOf(5,3), staffTabs(actor("kds.deliver")))
        assertEquals(listOf(6,3), staffTabs(actor("service.execute")))
        assertEquals(listOf(3), staffTabs(null))
    }
    @Test fun explicitNavigationAndPermissionDenialsNarrowRoutes() {
        val user=actor("dashboard.view","kds.prepare","reconciliation.view")
        assertEquals(listOf(0,1,2,3),staffTabs(user))
        assertEquals(listOf(4,3),staffTabs(user.copy(navigationRoutes=listOf("/staff/fulfillment"))))
        assertEquals(listOf(3),staffTabs(user.copy(navigationRoutes=emptyList())))
        assertEquals(listOf(3),staffTabs(actor("dashboard.view").copy(denied=setOf("dashboard.view"))))
    }
}
