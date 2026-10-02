package com.mbox.staff

import java.net.URLEncoder
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

data class LiveStep(
    val path: String,
    val body: String,
    val keyHeader: String,
    val key: String,
    val recoveryBody: String? = null,
)

data class LiveCommand(
    val id: String,
    val employeeID: String,
    val title: String,
    val permission: String,
    val steps: List<LiveStep>,
    val completedSteps: Int = 0,
    val rejected: Boolean = false,
) {
    fun json(): JSONObject =
        JSONObject()
            .put("id", id)
            .put("employeeID", employeeID)
            .put("title", title)
            .put("permission", permission)
            .put("completedSteps", completedSteps)
            .put("rejected", rejected)
            .put(
                "steps",
                JSONArray(
                    steps.map {
                        JSONObject()
                            .put("path", it.path)
                            .put("body", it.body)
                            .put("keyHeader", it.keyHeader)
                            .put("key", it.key)
                            .put("recoveryBody", it.recoveryBody ?: JSONObject.NULL)
                    }
                ),
            )

    companion object {
        fun part(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

        fun parse(value: JSONObject): LiveCommand {
            val rows = value.getJSONArray("steps")
            val steps =
                (0 until rows.length()).map {
                    val s = rows.getJSONObject(it)
                    LiveStep(
                        s.getString("path"),
                        s.getString("body"),
                        s.getString("keyHeader"),
                        s.getString("key"),
                        if (s.isNull("recoveryBody")) null
                        else s.optString("recoveryBody").takeIf { it.isNotBlank() },
                    )
                }
            val completed = value.getInt("completedSteps")
            require(steps.isNotEmpty() && completed in 0..steps.size)
            return LiveCommand(
                value.getString("id"),
                value.getString("employeeID"),
                value.getString("title"),
                value.getString("permission"),
                steps,
                completed,
                value.getBoolean("rejected"),
            )
        }

        fun make(
            kind: String,
            table: LiveTable,
            actor: StaffIdentity,
            people: Int = 0,
            target: LiveTable? = null,
            task: LiveTask? = null,
            frozen: Boolean = false,
            reason: String = "",
        ): LiveCommand {
            val id = UUID.randomUUID().toString()
            fun step(
                path: String,
                body: JSONObject = JSONObject(),
                header: String = "idempotency-key",
                key: String = "native-$id",
            ) = LiveStep(path, body.toString(), header, key)
            val t = table.display
            val permission: String
            val title: String
            val steps: List<LiveStep>
            when (kind) {
                "open" -> {
                    require(table.status == "available" && t.session == null && people in 1..200) {
                        "桌台或人数已变化，请刷新"
                    }
                    permission = "table.open"
                    val over = people > t.capacity
                    require(!over || reason.trim().length in 2..1000) { "人数超过容量，请填写2—1000字现场加座说明" }
                    val body = JSONObject().put("tableId", t.id).put("guestCount", people)
                    if (over) body.put("capacityOverrideReason", reason.trim())
                    title = "${t.code} 开台 · ${people}人 / 容量${t.capacity}人"
                    steps =
                        listOf(
                            step("/api/table-management/sessions/open", body, "x-idempotency-key")
                        )
                }
                "transfer" -> {
                    require(
                        t.session != null &&
                            table.locationVersion != null &&
                            target != null &&
                            target.status == "available" &&
                            target.display.session == null &&
                            target.display.id != t.id
                    ) {
                        "目标桌不可用或桌次版本缺失，请刷新"
                    }
                    permission = "table.transfer"
                    val over = t.people > target.display.capacity
                    require(!over || reason.trim().length in 2..1000) {
                        "人数超过目标桌容量，请填写2—1000字现场加座说明"
                    }
                    val body =
                        JSONObject()
                            .put("targetTableId", target.display.id)
                            .put("expectedSourceTableId", t.id)
                            .put("expectedLocationVersion", table.locationVersion)
                    if (over) body.put("capacityOverrideReason", reason.trim())
                    title =
                        "${t.code} 转至 ${target.display.code} · ${t.people}人 / 容量${target.display.capacity}人"
                    steps =
                        listOf(
                            step(
                                "/api/table-management/sessions/${part(t.session)}/transfer",
                                body,
                                "x-idempotency-key",
                            )
                        )
                }
                "close" -> {
                    require(t.session != null && table.sessionStatus in listOf("open", "closing")) {
                        "桌次状态不支持结束用餐"
                    }
                    permission = "table.close"
                    title = "结束 ${t.code} 用餐"
                    val prefix = "/api/table-sessions/${part(t.session)}"
                    steps =
                        (if (table.sessionStatus == "open")
                            listOf(
                                step(
                                    "$prefix/begin-closing",
                                    key = "staff-close-${t.session}-begin",
                                )
                            )
                        else emptyList()) +
                            step("$prefix/close", key = "staff-close-${t.session}-complete")
                }
                "turnover" -> {
                    require(
                        t.session != null &&
                            table.sessionStatus in listOf("open", "closing") &&
                            actor.allows("table.close") &&
                            reason.trim().length in 2..500
                    ) {
                        "请确认顾客已离店并填写翻台原因，需同时具有关台和未结清翻台权限"
                    }
                    permission = "table.turnover_unsettled"
                    title = "确认 ${t.code} 顾客已离店 · 保留原账释放桌台"
                    steps =
                        listOf(
                            step(
                                "/api/table-sessions/${part(t.session)}/close-after-customer-left",
                                JSONObject().put("reasonNote", reason.trim()),
                            )
                        )
                }
                "freeze" -> {
                    require(
                        t.session != null &&
                            table.sessionStatus == "open" &&
                            (!frozen || reason.trim().length in 2..500)
                    ) {
                        "请填写暂停原因并确认桌次仍在营业"
                    }
                    permission = "guest.cart.freeze"
                    title = if (frozen) "暂停 ${t.code} 客人加购" else "恢复 ${t.code} 客人加购"
                    val body = JSONObject().put("frozen", frozen)
                    if (frozen) body.put("reason", reason.trim())
                    steps =
                        listOf(
                            step("/api/table-sessions/${part(t.session)}/guest-cart-freeze", body)
                        )
                }
                "service" -> {
                    require(
                        task != null &&
                            t.session != null &&
                            task.session == t.session &&
                            task.tableId == t.id &&
                            task.mode == "quick_complete"
                    ) {
                        "该任务需主管处理或桌次已变化"
                    }
                    permission = "service.execute"
                    title = "完成：${task.title}"
                    steps = listOf(step("/api/service-tasks/${part(task.id)}/complete"))
                }
                else -> throw IllegalArgumentException("操作尚未接入")
            }
            require(actor.allows(permission)) { "当前员工没有此操作权限" }
            return LiveCommand(id, actor.employeeId, title, permission, steps)
        }
    }
}

data class LiveOrderItem(
    val id: String,
    val name: String,
    val quantity: Int,
    val amount: Int?,
    val state: String,
) {
    val stateLabel
        get() =
            mapOf(
                "delivered" to "已送达",
                "ready_for_delivery" to "待送达",
                "preparing" to "制作中",
                "pending" to "待制作",
                "awaiting_payment" to "待支付",
                "not_required" to "无需出品",
                "cancelled" to "已取消",
                "attention" to "待处理",
            )[state] ?: "状态待核对"
}

data class LiveOrderDetail(val id: String, val amount: Int?, val items: List<LiveOrderItem>) {
    companion object {
        fun parse(value: JSONObject): LiveOrderDetail {
            val rows = value.getJSONArray("items")
            fun minor(v: JSONObject, key: String): Int? =
                if (v.isNull(key)) null else v.get(key).toString().toIntOrNull()
            return LiveOrderDetail(
                value.getString("publicId"),
                minor(value, "totalAmountMinor"),
                (0 until rows.length()).map {
                    val item = rows.getJSONObject(it)
                    LiveOrderItem(
                        item.getString("id"),
                        item.getString("productName"),
                        item.getInt("quantity"),
                        minor(item, "totalAmountMinor"),
                        item.getString("fulfillmentStatus"),
                    )
                },
            )
        }
    }
}

object LiveCommandRunner {
    suspend fun advance(
        command: LiveCommand,
        send: suspend (LiveStep) -> Unit,
        checkpoint: (LiveCommand) -> Unit,
    ): LiveCommand {
        require(
            !command.rejected &&
                command.steps.isNotEmpty() &&
                command.completedSteps in 0..command.steps.size
        ) {
            "原请求记录无效，操作已锁定"
        }
        var current = command
        while (current.completedSteps < current.steps.size) {
            send(current.steps[current.completedSteps])
            current = current.copy(completedSteps = current.completedSteps + 1)
            checkpoint(current)
        }
        return current
    }
}
