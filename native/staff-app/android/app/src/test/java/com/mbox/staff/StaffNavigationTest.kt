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

    @Test fun serviceTaskEntryRespectsExplicitNavigationWithoutChangingServicePermission() {
        val cases = listOf(
            null to true,
            emptyList<String>() to false,
            listOf("/staff/orders") to false,
            listOf("/staff/orders", "/staff/tasks") to true,
        )
        for ((routes, expected) in cases) {
            val user = actor("service.view").copy(navigationRoutes = routes)
            assertTrue(user.canReadService())
            assertEquals(expected, user.canOpenServiceTasks())
            assertEquals(if (expected) listOf(6, 3) else listOf(3), staffTabs(user))
        }
    }

    @Test fun serviceTaskRouteNeverGrantsMissingOrDeniedPermissions() {
        val cases = listOf(
            actor() to false,
            actor("dashboard.view") to false,
            actor("service.view").copy(denied = setOf("service.view")) to false,
            actor("service.view", "service.execute").copy(denied = setOf("service.view")) to true,
            actor("service.view", "service.execute", "service.manage", "complaint.handle")
                .copy(denied = setOf("service.view", "service.execute", "service.manage", "complaint.handle")) to false,
        )
        for ((base, expected) in cases) {
            val user = base.copy(navigationRoutes = listOf("/staff/tasks"))
            assertEquals(expected, user.canReadService())
            assertEquals(expected, user.canOpenServiceTasks())
            assertEquals(if (expected) listOf(6, 3) else listOf(3), staffTabs(user))
        }
    }
}
