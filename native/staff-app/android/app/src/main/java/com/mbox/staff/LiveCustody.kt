package com.mbox.staff

import java.math.BigDecimal
import java.util.UUID
import org.json.JSONObject

const val custodyRoot = "/api/native/staff/bottle-custody"
val custodyStatuses = linkedMapOf("" to "全部", "stored" to "寄存中", "collected" to "已取待处理", "archived" to "已归档", "voided" to "已作废")
val custodyFractions = linkedMapOf("" to "自定义数量", "1" to "1", "1/2" to "0.5", "1/4" to "0.25", "3/4" to "0.75", "1/5" to "0.2", "2/5" to "0.4", "3/5" to "0.6", "4/5" to "0.8", "1/10" to "0.1")
fun custodyQuantity(text: String): BigDecimal {
    require(Regex("^(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,6})?$").matches(text) && BigDecimal(text) > BigDecimal.ZERO) { "数量须大于零，最多6位小数" }
    return BigDecimal(text)
}
class CustodyBoard(val config: JSONObject, val list: JSONObject, val capability: JSONObject, val detail: JSONObject?) {
    val enabled = capability.getBoolean("durableCommands")
    val employee = capability.getString("employeeId")
    val policy = config.getJSONObject("policy")
    val categories = config.getJSONArray("categories").objects()
    val items = list.getJSONArray("items").objects()
    val next = list.textOrNull("nextCursor")
}
fun custodyCommand(actor: StaffIdentity, operation: String, body: JSONObject, confirmation: String, order: JSONObject? = null, category: JSONObject? = null): LiveCommand {
    val permission = when(operation) { "policy", "category" -> "member.card.manage"; "export", "report_export" -> "bottle.custody.export"; else -> "bottle.manage.all" }
    require(actor.allows(permission) && actor.allows("bottle.manage.all")) { "当前岗位没有此存酒操作权限" }
    val id = UUID.randomUUID().toString()
    val suffix = when(operation) {
        "create" -> ""
        "category" -> "/categories"
        "policy" -> "/policy"
        "export" -> "/export"
        "report_export" -> "/report-export"
        "request_code", "verify", "collect", "resolve_collection", "archive", "expiry", "print_prepared" -> {
            require(order != null); UUID.fromString(order.getString("id"))
            "/${order.getString("id")}/" + when(operation) { "request_code" -> "request-code"; "resolve_collection" -> "resolve-collection"; "print_prepared" -> "print"; else -> operation }
        }
        else -> error("不支持的存酒操作")
    }
    if(operation in listOf("create","request_code")) custodyQuantity(body.getString("quantity"))
    if(operation == "request_code") require(custodyQuantity(body.getString("quantity")) <= custodyQuantity(order!!.getString("remaining_quantity"))) { "取酒数量超过当前剩余" }
    if(operation == "verify") require(Regex("^[0-9]{4,8}$").matches(body.getString("code"))) { "请填写4至8位验证码" }
    if(operation in listOf("verify","collect")) UUID.fromString(body.getString("challengeId"))
    if(operation in listOf("resolve_collection","archive","expiry","policy")) require(body.getString("reason").trim().length in 2..300) { "请填写2至300字原因" }
    if(operation == "resolve_collection") {
        UUID.fromString(body.getString("collectionId")); if(!body.isNull("quantity")) custodyQuantity(body.getString("quantity"))
    }
    if(operation == "create" || operation == "resolve_collection" && !body.isNull("quantity")) {
        val evidence = body.getJSONObject("evidence"); require(evidence.getString("photoBase64").length in 100..1400000) { "请拍摄实物照片" }
        evidence.textOrNull("fraction")?.let { require(custodyFractions[it] != null && BigDecimal(custodyFractions[it]) == custodyQuantity(body.getString("quantity"))) { "比例与数量不符" } }
    }
    val proof = JSONObject().put("operation",operation).put("employeeId",actor.employeeId).put("confirmation",confirmation)
    if(order != null) proof.put("target",order.getString("id")).put("version",order.getInt("version")).put("publicId",order.getString("public_id"))
    if(category != null) proof.put("categoryExpected",category.getString("configurationFingerprint"))
    return LiveCommand(id,actor.employeeId,confirmation.lineSequence().first(),permission,listOf(LiveStep(custodyRoot+suffix,body.toString(),"idempotency-key","native-business-$id",JSONObject().put("custody",proof).toString())))
}
val LiveStep.custodyProof: JSONObject? get() = recoveryBody?.let { JSONObject(it).optJSONObject("custody") }
fun secureCustodyCommand(command: LiveCommand, store: (String,String)->Unit): LiveCommand {
    if(command.steps.firstOrNull()?.custodyProof == null) return command
    require(command.steps.size == 1)
    val step = command.steps[0]; val proof = JSONObject(step.custodyProof!!.toString())
    if(proof.has("payloadKey")) return command
    store(command.id,step.body); proof.put("payloadKey",command.id)
    return command.copy(steps=listOf(step.copy(body="{}",recoveryBody=JSONObject().put("custody",proof).toString())))
}
fun custodyHeaders(step: LiveStep): Map<String,String> {
    val proof = step.custodyProof!!; val headers = mutableMapOf(step.keyHeader to step.key)
    if(proof.has("version")) headers["x-custody-version"] = proof.getInt("version").toString()
    proof.textOrNull("categoryExpected")?.let { headers["x-custody-category"] = it }
    return headers
}
fun validateCustodyReply(text: String, step: LiveStep, body: JSONObject): JSONObject {
    val root = JSONObject(text); val meta = root.getJSONObject("meta"); require(meta.getInt("protocol") == 1 && meta.get("replayed") is Boolean)
    val data = root.getJSONObject("data"); val proof = step.custodyProof!!
    require(data.getString("operation") == proof.getString("operation") && data.getString("employeeId") == proof.getString("employeeId") && data.getString("requestKey") == step.key)
    val result = data.getJSONObject("result")
    when(proof.getString("operation")) {
        "create" -> { val row = result.getJSONObject("order"); require(row.getString("id").isNotBlank()); require(row.getString("member_no") == body.getString("memberNo") && row.getString("item_name") == body.getString("itemName") && custodyQuantity(row.getString("original_quantity")) == custodyQuantity(body.getString("quantity"))) }
        "request_code" -> { UUID.fromString(result.getString("challengeId")); require(result.getString("deliveryStatus") == "pending") }
        "verify" -> { require(result.get("verified") is Boolean); require(result.getString("message").isNotBlank()) }
        "collect", "resolve_collection", "archive", "expiry" -> { val row = result.getJSONObject("order"); require(row.getString("id") == proof.getString("target")); if(proof.getString("operation") == "archive") require(row.getString("status") == "archived"); if(proof.getString("operation") == "expiry") require(serverInstant(row.getString("expires_at")) == serverInstant(body.getString("expiresAt"))) }
        "category" -> { UUID.fromString(result.getString("id")); if(body.has("id")) require(result.getString("id") == body.getString("id")) }
        "policy" -> require(result.getInt("version") > body.getInt("version"))
        "export", "report_export" -> require(result.getString("filename").endsWith(".xlsx") && result.getString("base64").length > 100)
        "print_prepared" -> require(result.getString("publicId") == proof.getString("publicId") && result.getJSONObject("document").getJSONObject("order").getString("public_id") == result.getString("publicId"))
        else -> error("回执类型无效")
    }
    return result
}
