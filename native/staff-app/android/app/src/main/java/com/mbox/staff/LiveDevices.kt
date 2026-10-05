package com.mbox.staff

import org.json.JSONObject
import java.util.UUID

class DeviceBoard(val source: JSONObject) {
    val enabled = source.getBoolean("nativeCommands")
    val employee = source.getString("employeeId")
    val devices = source.getJSONArray("devices").objects()
    val routes = source.getJSONArray("routes").objects()
    val policies = source.getJSONArray("policies").objects()
    val commands = source.getJSONArray("commands").objects()
}
fun devicePolicyDraft(row: JSONObject): JSONObject = JSONObject()
    .put("kind", "policy-save").put("expected", row.getString("configurationFingerprint")).put("reason", "")
    .put("policy", JSONObject().put("ticketKind", row.getString("ticketKind"))
        .put("enabled", row.getBoolean("enabled")).put("copies", row.get("copies")))

fun devicePolicyCopiesLabel(policy: JSONObject): String =
    if (policy.isNull("copies")) "份数跟随打印路由" else "固定 ${policy.getInt("copies")} 份"

object DeviceCommands {
    val stations = linkedMapOf("bar" to "吧台", "kitchen" to "后厨", "cashier" to "收银", "service" to "服务")
    val statuses = linkedMapOf("active" to "启用", "paused" to "暂停", "retired" to "退役")
    val profiles = linkedMapOf("escpos_58" to "58毫米热敏", "escpos_80" to "80毫米热敏", "windows_text" to "Windows文本")
    val tickets = linkedMapOf("bar_production" to "吧台制作单", "kitchen_production" to "后厨制作单", "order_summary" to "整单汇总", "delivery" to "配送单", "cashier_settlement" to "预结算单", "cashier_payment" to "支付凭证", "cashier_refund" to "退款凭证", "table_settlement" to "整桌归档", "daily_settlement" to "营业日结单")
    fun make(body: JSONObject, actor: StaffIdentity, confirmation: String): LiveCommand {
        val permission = if(actor.allows("printer.manage")) "printer.manage" else "hardware.manage"
        require(actor.allows(permission)) { "没有打印设备管理权限" }
        val kind = body.getString("kind")
        val reason = body.getString("reason").trim()
        require(reason.length in 3..500) { "请填写3至500字处理说明" }; body.put("reason", reason)
        val id = UUID.randomUUID().toString(); val key = "native-business-$id"
        val row = when(kind) {
            "device-create", "device-update" -> JSONObject(body.getJSONObject("device").toString()).apply {
                require(Regex("^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$").matches(getString("code"))) { "设备编码须为2至64位字母、数字、点、下划线或短横线" }
                require(getString("name").length in 1..120)
                require(getString("stationCode") in stations && getString("status") in statuses)
                if(kind == "device-update") put("id", UUID.fromString(body.getString("id")).toString())
                else require(getString("status") == "active")
                if(!isNull("printBridgeId")) UUID.fromString(getString("printBridgeId"))
                if(!isNull("printProfile")) require(getString("printProfile") in profiles)
                if(!isNull("windowsQueueName")) require(getString("windowsQueueName").length in 1..180)
                put("deviceType", "printer")
            }
            "route-save" -> JSONObject(body.getJSONObject("route").toString()).apply {
                require(Regex("^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$").matches(getString("code"))) { "请核对路由编码" }
                require(getString("name").length in 1..120 && getString("stationCode") in stations.keys - "service")
                UUID.fromString(getString("printerDeviceId"))
                require(getInt("copies") in 1..5 && getInt("priority") in 0..1000 && getString("status") in statuses)
            }
            "policy-save" -> JSONObject(body.getJSONObject("policy").toString()).apply {
                require(getString("ticketKind") in tickets && has("copies"))
                require(isNull("copies") || (get("copies") is Number && getDouble("copies") == getInt("copies").toDouble() && getInt("copies") in 1..5)) { "票据份数须跟随路由或固定为1至5份" }
                require(get("enabled") is Boolean)
            }
            "bridge-revoke" -> JSONObject().put("id",UUID.fromString(body.getString("id")).toString()).put("status","revoked")
            "device-test" -> JSONObject().put("deviceId", UUID.fromString(body.getString("id")).toString())
                .put("commandType", body.getString("command")).put("publicId", key).put("status", "requested").apply {
                    require(getString("commandType") in listOf("test_print", "reconnect", "ping"))
                }
            else -> error("设备操作无效")
        }
        if(kind !in listOf("device-create","bridge-revoke")) require((kind == "route-save" && body.isNull("expected")) || Regex("^[a-f0-9]{64}$").matches(body.getString("expected"))) { "缺少原配置，请刷新" }
        val proof = JSONObject().put("kind",kind).put("employeeId",actor.employeeId).put("reason",reason).put("row",row)
            .put("confirmation",confirmation+"\n说明：$reason\n"+if(kind == "device-test") "只创建设备任务，是否执行成功须刷新查看结果并核对现场出纸。" else "配置保存后影响后续打印，请核对设备和出纸位置。")
        return LiveCommand(id,actor.employeeId,if(kind == "device-test") "打印设备测试" else "保存打印配置",permission,
            listOf(LiveStep(if(kind=="bridge-revoke") "/api/hardware/native-print-bridges/${LiveCommand.part(body.getString("id"))}/revoke" else "/api/hardware/native-management/commands",body.toString(),"idempotency-key",key,recoveryBody=JSONObject().put("device",proof).toString())))
    }
}
val LiveStep.deviceProof: JSONObject? get() = recoveryBody?.let { runCatching { JSONObject(it).optJSONObject("device") }.getOrNull() }
fun validateDeviceReply(text: String, step: LiveStep) {
    val root = JSONObject(text); require(root.getJSONObject("meta").get("replayed") is Boolean)
    val data = root.getJSONObject("data"); val proof=step.deviceProof!!
    for(key in listOf("kind","employeeId","reason")) require(data.getString(key)==proof.getString(key)) { "设备原回执不匹配" }
    val row=data.getJSONObject("row"); val expected=proof.getJSONObject("row")
    if(proof.getString("kind")!="policy-save") require(row.getString("id").isNotBlank())
    for (key in expected.keys()) {
        require(row.has(key)) { "设备配置回执缺少字段，请保留原请求核对" }
        val submitted = expected.get(key)
        val actual = row.get(key)
        val matches = when (submitted) {
            JSONObject.NULL -> actual === JSONObject.NULL
            is Number -> actual is Number && submitted.toString().toBigDecimal().compareTo(actual.toString().toBigDecimal()) == 0
            is Boolean -> actual is Boolean && actual == submitted
            is String -> actual is String && actual == submitted
            else -> false
        }
        require(matches) { "设备配置回执不匹配，请保留原请求核对" }
    }
}
