package com.mbox.staff

/** Server navigation narrows entry points; permissions always remain mandatory. */
fun StaffIdentity.hasRoute(route: String): Boolean = navigationRoutes?.contains(route) ?: true

fun StaffIdentity.canReadService()=listOf("service.view","service.execute","service.manage","complaint.handle").any(::allows)

fun staffTabs(actor: StaffIdentity?): List<Int> {
    if (actor == null) return listOf(3)
    val choices = buildList {
        if (actor.canReadTables && actor.hasRoute("/staff/live")) add(0)
        if (listOf("order.history.view", "order.history.all", "reconciliation.view").any(actor::allows) && actor.hasRoute("/staff/orders")) add(1)
        if (LiveCashier.permissions.any(actor::allows) && actor.hasRoute("/staff/payments")) add(2)
        if (actor.allows("kds.prepare") && actor.hasRoute("/staff/fulfillment")) add(4)
        if (actor.allows("kds.deliver") && actor.hasRoute("/staff/fulfillment")) add(5)
        if (actor.canReadService() && actor.hasRoute("/staff/tasks")) add(6)
    }
    return choices.take(3) + 3
}
