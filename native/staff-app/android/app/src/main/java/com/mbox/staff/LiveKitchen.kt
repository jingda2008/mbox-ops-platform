package com.mbox.staff

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

data class KitchenPending(val source: JSONObject) {
    val id = source.getString("taskId")
    val name = source.getString("productName")
    val tableCode = source.getString("tableCode")
    val unmade = source.getInt("unmade")
    val canPrepare = source.getBoolean("canPrepare")
    val specification = source.getString("specification")
    val itemNote = source.getString("itemNote")
    val orderNote = source.getString("orderNote")
    val compatibility
        get() =
            JSONArray(listOf(source.getString("productId"), specification, itemNote, orderNote))
                .toString()
                .replace("\\/", "/")
}

data class KitchenUnit(val source: JSONObject) {
    val id = source.getString("unitId")
    val taskId = source.getString("taskId")
    val tableCode = source.getString("tableCode")
    val state = source.getString("state")
    val held = source.getBoolean("held")
    val stopped = source.getBoolean("stopped")
    val canReady
        get() = state == "started" && !held && !stopped
}

data class KitchenBatch(val source: JSONObject) {
    val id = source.getString("id")
    val name = source.getString("productName")
    val employeeID = source.getString("employeeId")
    val employeeName = source.getString("employeeName")
    val version = source.getInt("ownershipVersion")
    val released = !source.isNull("releasedAt")
    val equipment = if (source.isNull("equipment")) null else source.getString("equipment")
    val units = source.getJSONArray("units").objects().map(::KitchenUnit)
}

data class LiveKitchen(val source: JSONObject) {
    val employeeID = source.getString("employeeId")
    val station = source.getString("stationCode")
    val canHandoff = source.getBoolean("canHandoff")
    val canStart = source.getBoolean("canStart")
    val canPrepare = source.getBoolean("canPrepare")
    val sessionValid = source.getBoolean("actionSessionValid")
    val pending = source.getJSONArray("pending").objects().map(::KitchenPending)
    val batches = source.getJSONArray("batches").objects().map(::KitchenBatch)
    val equipment = source.getJSONArray("equipmentLabels").strings()
    val legacy = source.getJSONArray("legacyTaskIds").strings()

    fun command(
        actor: StaffIdentity,
        action: String,
        sourceID: String,
        quantity: Int = 1,
        equipment: String = "",
        seconds: Int? = null,
        unitIDs: Set<String> = emptySet(),
        selections: Map<String, Int> = emptyMap(),
    ): LiveCommand {
        require(
            actor.employeeId == employeeID &&
                actor.allows("kds.prepare") &&
                canPrepare &&
                sessionValid &&
                station in listOf("bar", "kitchen")
        ) {
            "出品岗位或会话已变化，请刷新"
        }
        val command = JSONObject().put("action", action)
        val title: String
        if (action in listOf("start", "quick-ready")) {
            val row = pending.find { it.id == sourceID }
            require(
                canStart &&
                    row != null &&
                    row.canPrepare &&
                    quantity in 1..minOf(999, row.unmade) &&
                    (seconds == null || seconds in 1..36000) &&
                    equipment.length <= 40
            ) {
                "待制作数量或准入状态已变化，请重新核对"
            }
            val quantities = if (selections.isEmpty()) mapOf(sourceID to quantity) else selections
            val chosen = pending.filter { it.id in quantities }.sortedBy { it.id }
            require(
                chosen.isNotEmpty() &&
                    chosen.size <= 50 &&
                    chosen.size == quantities.size &&
                    chosen.all {
                        it.canPrepare &&
                            it.compatibility == row.compatibility &&
                            quantities.getValue(it.id) in 1..minOf(999, it.unmade)
                    } &&
                    quantities.values.sum() <= 999
            ) {
                "合批仅支持商品、规格及两种备注完全相同的品项；请重新核对各桌份数"
            }
            val items =
                chosen.map { selected ->
                    JSONObject()
                        .put("taskId", selected.id)
                        .put("quantity", quantities.getValue(selected.id))
                        .put("expectedUnmade", selected.unmade)
                        .also { item ->
                            listOf("tableId", "tableSessionId", "locationVersion").forEach {
                                item.put(it, selected.source.get(it))
                            }
                        }
                }
            command
                .put("compatibilityKey", row.compatibility)
                .put("items", JSONArray(items))
                .put(
                    "equipment",
                    if (action == "quick-ready" || equipment.isEmpty()) JSONObject.NULL
                    else equipment,
                )
                .put(
                    "expectedSeconds",
                    if (action == "quick-ready") JSONObject.NULL else seconds ?: JSONObject.NULL,
                )
            title =
                chosen.joinToString("、") { "${it.tableCode} ×${quantities.getValue(it.id)}" } +
                    " · ${row.name} · " +
                    if (action == "start") "开始制作" else "确认实际备齐"
        } else {
            val batch = batches.find { it.id == sourceID }
            require(
                batch != null &&
                    batch.employeeID == employeeID &&
                    action in listOf("ready", "release")
            ) {
                "批次负责人已改变，请重新核对"
            }
            command.put("batchId", batch.id).put("expectedOwnershipVersion", batch.version)
            if (action == "ready") {
                val chosen = batch.units.filter { it.id in unitIDs }
                require(
                    chosen.isNotEmpty() &&
                        chosen.size == unitIDs.size &&
                        chosen.size <= 999 &&
                        chosen.all { it.canReady }
                ) {
                    "部分份数已暂停、停止或完成，请刷新后选择实际备齐的份数"
                }
                val items =
                    chosen
                        .groupBy { it.taskId }
                        .toSortedMap()
                        .map { (task, units) ->
                            JSONObject()
                                .put("taskId", task)
                                .put("unitIds", JSONArray(units.map { it.id }.sorted()))
                                .also { item ->
                                    listOf("tableId", "tableSessionId", "locationVersion").forEach {
                                        item.put(it, units[0].source.get(it))
                                    }
                                }
                        }
                command.put("items", JSONArray(items))
                title = "${batch.name} · 确认实际备齐 ${chosen.size}份"
            } else {
                require(!batch.released) { "此设备已释放" }
                title = "${batch.name} · 确认实物已移出设备"
            }
        }
        val id = UUID.randomUUID().toString()
        val body =
            JSONObject()
                .put("employeeId", employeeID)
                .put("stationCode", station)
                .put("command", command)
        return LiveCommand(
            id,
            employeeID,
            title,
            "kds.prepare",
            listOf(
                LiveStep(
                    "/api/commerce/kitchen-board/commands",
                    body.toString(),
                    "idempotency-key",
                    "native-kitchen-$id",
                )
            ),
        )
    }
}

data class LiveKitchenHandoff(val source: JSONObject) {
    val station = source.getString("stationCode")
    val id = source.getString("anchorBatchId")
    val batches = source.getJSONArray("batches").objects()
    val tasks = source.getJSONArray("tasks").objects()
    val lines = source.getJSONArray("displayLines").objects()

    fun command(
        actor: StaffIdentity,
        board: LiveKitchen,
        reason: String,
        physicalChecked: Boolean,
    ): LiveCommand {
        require(
            physicalChecked &&
                actor.employeeId == board.employeeID &&
                actor.allows("kds.prepare") &&
                actor.allows("kds.exception.manage") &&
                board.canHandoff &&
                board.sessionValid &&
                station == board.station &&
                board.batches.any { it.id == id } &&
                batches.size in 1..500 &&
                tasks.size in 1..500 &&
                batches.map { it.getString("batchId") }.distinct().size == batches.size &&
                tasks.map { it.getString("taskId") }.distinct().size == tasks.size &&
                batches.any { it.getString("batchId") == id } &&
                batches.all {
                    it.getString("expectedCurrentOwnerId") ==
                        batches[0].getString("expectedCurrentOwnerId") &&
                        it.getString("expectedCurrentOwnerId") != actor.employeeId
                } &&
                tasks.all {
                    it.isNull("expectedEmployeeId") ||
                        it.getString("expectedEmployeeId") ==
                            batches[0].getString("expectedCurrentOwnerId")
                } &&
                reason.trim().length in 2..1000
        ) {
            "请核对完整交接范围、实物和接班权限，填写接班原因"
        }
        val operation =
            JSONObject()
                .put("action", "handoff")
                .put("batchId", id)
                .put("expectedBatches", JSONArray(batches))
                .put("expectedTasks", JSONArray(tasks))
                .put("physicalChecked", true)
                .put("reason", reason.trim())
        val key = UUID.randomUUID().toString()
        val body =
            JSONObject()
                .put("employeeId", actor.employeeId)
                .put("stationCode", station)
                .put("command", operation)
        return LiveCommand(
            key,
            actor.employeeId,
            "确认接班 ${batches.size}批制作 · ${tasks.size}项任务",
            "kds.prepare",
            listOf(
                LiveStep(
                    "/api/commerce/kitchen-board/commands",
                    body.toString(),
                    "idempotency-key",
                    "native-handoff-$key",
                )
            ),
        )
    }
}

class LiveFulfillment(val source: JSONObject) {
    val actor = source.getJSONObject("actor")
    val rows = financeRows(source, "workItems")
    val employeeID = actor.getString("employeeId")
    val usesPickup =
        listOf("sharedPickupActive", "threeScreenWorkflowEnabled", "pickupDeviceConfigured").any {
            actor.optBoolean(it)
        }

    fun validate(employee: String) {
        require(
            employeeID == employee &&
                rows.map { it.getString("taskId") }.distinct().size == rows.size &&
                rows.all { row ->
                    val q = row.optJSONObject("quantities")
                    row.getString("taskId").isNotBlank() &&
                        row.getJSONObject("item").getInt("quantity") > 0 &&
                        (q == null ||
                            q.getInt("total") > 0 &&
                                listOf("unmade", "started", "ready", "delivered", "held", "stopped")
                                    .all { q.getInt(it) in 0..q.getInt("total") })
                }
        ) {
            "出品队列身份或份数不匹配"
        }
    }

    fun command(
        identity: StaffIdentity,
        taskID: String,
        action: String,
        quantity: Int,
        reason: String,
        confirmed: Boolean,
    ): LiveCommand {
        val row = rows.find { it.getString("taskId") == taskID }
        require(
            actor.optBoolean("supportsNativePhysicalRecovery") &&
                employeeID == identity.employeeId &&
                actor.optBoolean("actionSessionValid") &&
                confirmed &&
                row != null
        ) {
            "请刷新出品队列并核对实物"
        }
        val q = row.optJSONObject("quantities")
        val note = reason.trim()
        val body = JSONObject().put("actorId", identity.employeeId)
        val permission: String
        val title: String
        val suffix: String
        when (action) {
            "start",
            "complete" -> {
                require(
                    row.getBoolean("canPrepare") &&
                        row.textOrNull("productionScreen") == null &&
                        fulfillmentMaximum(row, action) > 0 &&
                        (q != null ||
                            action != "start" ||
                            row.getString("kdsStatus") in listOf("pending", "accepted"))
                ) {
                    "请从对应制作批次处理，或刷新原任务状态"
                }
                permission = "kds.prepare"
                suffix = "actions"
                body.put("action", action)
                title = if (action == "start") "开始实际制作" else "确认实际备齐"
            }
            "deliver" -> {
                require(
                    row.getBoolean("canDeliver") &&
                        !usesPickup &&
                        fulfillmentMaximum(row, action) > 0
                ) {
                    "请到取餐工作台按实际份数取走，勿重复登记送达"
                }
                permission = "kds.deliver"
                suffix = "actions"
                body.put("action", "deliver")
                title = "确认实际送达"
            }
            "fail" -> {
                require(
                    row.getBoolean("canPrepare") &&
                        q == null &&
                        row.textOrNull("productionScreen") == null
                ) {
                    "按份商品请从售后处理，不能整行作废"
                }
                permission = "kds.prepare"
                suffix = "actions"
                body.put("action", "fail")
                title = "登记制作异常"
            }
            "remake", "manager-cancel" -> {
                require(
                    q == null && if(action=="remake") row.getBoolean("canRemake")&&row.getString("kdsStatus")=="failed"
                    else row.optBoolean("canManagerCancel")&&row.getString("kdsStatus") in setOf("pending","accepted","preparing","failed")
                ) {
                    "原异常或管理权限已变化"
                }
                permission = "kds.exception.manage"
                suffix = action
                title = if (action == "remake") "按原异常重新制作" else "主管结束原制作任务"
            }
            else -> error("不支持的出品操作")
        }
        require(identity.allows(permission)) { "当前岗位权限已变化" }
        if (action in listOf("fail", "remake", "manager-cancel")) {
            require(note.length in 2..500) { "请填写2—500字实际处理原因" }
            body
                .put(
                    "reasonCode",
                    if (action == "remake") "production_remake" else "production_exception",
                )
                .put("reason", note)
        } else if (q != null) {
            require(quantity in 1..minOf(999, fulfillmentMaximum(row, action))) {
                "所选份数超过当前可操作数量；暂停份数不得处理"
            }
            body.put("quantity", quantity)
        }
        val item = row.getJSONObject("item")
        val order = row.getJSONObject("order")
        val count = if (q == null) item.getInt("quantity") else quantity
        val key = java.util.UUID.randomUUID().toString()
        val proof =
            JSONObject()
                .put("fulfillment", action)
                .put("taskId", taskID)
                .put("itemId", item.getString("id"))
                .put("orderId", order.getString("id"))
                .put("station", row.getString("stationCode"))
                .put("quantity", count)
                .put("byQuantity", q != null)
                .put(
                    "confirmation",
                    "${row.getJSONObject("table").getString("code")} · ${order.getString("publicId")}\n${item.getString("productName")} · ${count}份\n$title\n$note\n制作异常和主管结束任务不会自动退款、免收或回库，须分别核对资金与实物。",
                )
        return LiveCommand(
            key,
            identity.employeeId,
            title,
            permission,
            listOf(
                LiveStep(
                    "/api/commerce/native-kds/${LiveCommand.part(taskID)}/$suffix",
                    body.toString(),
                    "idempotency-key",
                    "native-fulfillment-$key",
                    proof.toString(),
                )
            ),
        )
    }
}

fun fulfillmentMaximum(row: JSONObject, action: String): Int {
    val q = row.optJSONObject("quantities") ?: return row.getJSONObject("item").getInt("quantity")
    return when (action) {
        "start" -> q.getInt("unmade")
        "complete" -> q.getInt("unmade") + q.getInt("started")
        else -> q.getInt("ready")
    }
}

val LiveStep.fulfillmentProof: JSONObject?
    get() = recoveryBody?.let { JSONObject(it) }?.takeIf { it.opt("fulfillment") is String }

fun validateFulfillmentReply(text: String, step: LiveStep) {
    val p = step.fulfillmentProof ?: invalidResponse()
    val d = JSONObject(text)
    val action = p.getString("fulfillment")
    require(
        d.getJSONObject("meta").get("replayed") is Boolean &&
            d.getString("orderId") == p.getString("orderId") &&
            d.getString("orderItemId") == p.getString("itemId") &&
            d.getString("stationCode") == p.getString("station") &&
            d.getString("id").isNotBlank()
    ) {
        "原制作回执不匹配"
    }
    if (action == "remake") {
        require(
            d.getString("id") != p.getString("taskId") &&
                d.getString("remakeOf") == p.getString("taskId") &&
                d.getString("normalizedStatus") == "pending"
        ) {
            "原异常重做回执不匹配"
        }
    } else {
        require(d.getString("id") == p.getString("taskId")) { "任务回执不匹配" }
        if (p.getBoolean("byQuantity")) {
            val array = d.getJSONArray("affectedUnitIds")
            val units = (0 until array.length()).map { array.getString(it) }
            require(
                units.distinct().size == units.size &&
                    units.size == p.getInt("quantity") &&
                    d.getInt("affectedQuantity") == p.getInt("quantity")
            ) {
                "实际处理份数回执不匹配"
            }
        } else {
            val expected =
                mapOf(
                    "start" to "preparing",
                    "complete" to "ready",
                    "deliver" to "ready",
                    "fail" to "failed",
                    "manager-cancel" to "cancelled",
                )[action]
            require(
                expected != null &&
                    d.getString("normalizedStatus") == expected &&
                    (action != "deliver" || d.getString("fulfillmentStatus") == "delivered")
            ) {
                "出品回执状态不匹配"
            }
        }
    }
}

fun batchFulfillmentCancellation(board:LiveFulfillment,actor:StaffIdentity,taskIds:List<String>,reason:String,confirmed:Boolean):LiveCommand{
 require(taskIds.size in 1..50&&taskIds.distinct().size==taskIds.size){"一次须选择1至50项不同的跨日旧任务"}
 val commands=taskIds.map{id->val row=board.rows.find{it.getString("taskId")==id}?:error("原任务已不在当前队列");require(row.optBoolean("carryover")&&row.optJSONObject("quantities")==null){"批量结案只适用于跨日旧任务，按份商品须逐项处理"};board.command(actor,id,"manager-cancel",1,reason,confirmed)}
 return LiveCommand(java.util.UUID.randomUUID().toString(),actor.employeeId,"逐项结束 ${commands.size} 个跨日旧任务","kds.exception.manage",commands.flatMap{it.steps})
}
fun validFulfillmentCommandSelection(command:LiveCommand,board:LiveFulfillment):Boolean=runCatching{
 require(command.steps.size in 1..50);val ids=command.steps.map{it.fulfillmentProof!!.getString("taskId")};require(ids.distinct().size==ids.size)
 for(step in command.steps){val p=step.fulfillmentProof!!;val row=board.rows.find{it.getString("taskId")==p.getString("taskId")}?:error("原任务已变化");if(command.steps.size>1){require(command.permission=="kds.exception.manage"&&p.getString("fulfillment")=="manager-cancel"&&row.optBoolean("carryover")&&row.optJSONObject("quantities")==null&&row.optBoolean("canManagerCancel")&&row.getString("kdsStatus") in listOf("pending","accepted","preparing","failed"))}}
 true
}.getOrDefault(false)
