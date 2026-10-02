package com.mbox.staff

import java.util.UUID
import org.json.JSONObject

data class ProductManagementBoard(val data: JSONObject) {
    val employee = data.getString("currentEmployeeId")
    val durable = data.getBoolean("durableProducts")
    val canPrice = data.getBoolean("canPrice")
    val products = data.getJSONArray("products").objects()
    val offset = data.getInt("offset")
    val limit = data.getInt("limit")
}

fun productPriceText(p: JSONObject): String =
    p.optJSONObject("standardPrice")?.textOrNull("amountMinor")?.toLongOrNull()?.let {
        java.math.BigDecimal(it).movePointLeft(2).setScale(2).toPlainString()
    } ?: ""

fun productManagementCommand(
    actor: StaffIdentity,
    board: ProductManagementBoard,
    p: JSONObject,
    status: String,
    visible: Boolean,
    sort: String,
    price: String,
    reason: String,
): LiveCommand {
    val order = sort.toIntOrNull()
    require(
        board.durable &&
            board.employee == actor.employeeId &&
            actor.allows("catalog.product.manage") &&
            board.products.any {
                it.getString("id") == p.getString("id") &&
                    it.getString("nativeVersion") == p.getString("nativeVersion")
            } &&
            status in listOf("active", "sold_out", "inactive") &&
            order != null &&
            order in 0..10000
    ) {
        "请刷新原商品并核对权限和排序（0—10000）"
    }
    val patch = JSONObject()
    val changes = mutableListOf<String>()
    if (status != p.getString("status")) {
        patch.put("status", status)
        val labels=mapOf("active" to "在售","sold_out" to "售罄","inactive" to "下架")
        changes.add("状态：${labels[p.getString("status")]} → ${labels[status]}")
    }
    if (visible != p.getBoolean("guestVisible")) {
        patch.put("guestVisible", visible)
        changes.add(if (visible) "客人菜单显示" else "客人菜单隐藏")
    }
    if (order != p.getInt("menuSortOrder")) {
        patch.put("menuSortOrder", order)
        changes.add("排序：${p.getInt("menuSortOrder")} → $order")
    }
    if (price != productPriceText(p)) {
        val amount = nativeNonnegativeMoney(price)
        require(
            board.canPrice &&
                actor.allows("catalog.price.manage") &&
                p.optJSONObject("standardPrice")?.textOrNull("currency").let {
                    it == null || it == "CNY"
                } &&
                amount != null &&
                amount in 0..100000000 &&
                reason.isNotBlank() &&
                reason.length <= 500
        ) {
            "修改价格需价格权限、人民币有效金额及变更原因"
        }
        patch.put(
            "standardPrice",
            JSONObject().put("amountMinor", amount).put("currency", "CNY").put("reason", reason),
        )
        changes.add("新售价：${money(amount)}；仅影响后续报价，已有账单不改价。")
    }
    require(patch.length() > 0) { "没有需要提交的变更" }
    val id = UUID.randomUUID().toString()
    val proof =
        JSONObject()
            .put("id", p.getString("id"))
            .put("expected", patch)
            .put(
                "confirmation",
                p.getString("name") +
                    "\n" +
                    changes.joinToString("\n") +
                    "\n恢复在售仍须通过服务器的配方、库存和套餐校验。",
            )
    return LiveCommand(
        id,
        actor.employeeId,
        "确认商品变更",
        "catalog.product.manage",
        listOf(
            LiveStep(
                "/api/native/catalog/products/" + LiveCommand.part(p.getString("id")),
                JSONObject()
                    .put("expectedVersion", p.getString("nativeVersion"))
                    .put("patch", patch)
                    .toString(),
                "idempotency-key",
                "native-product-$id",
                recoveryBody = JSONObject().put("productManagement", proof).toString(),
            )
        ),
    )
}

val LiveStep.productManagementProof: JSONObject?
    get() = recoveryBody?.let { JSONObject(it).optJSONObject("productManagement") }

fun validateProductManagementReply(text: String, step: LiveStep) {
    val p = step.productManagementProof ?: error("缺少原商品凭证")
    val patch = p.getJSONObject("expected")
    val root = JSONObject(text)
    val d = root.getJSONObject("data")
    require(
        (if(p.optBoolean("creating")){UUID.fromString(d.getString("id"));d.getString("code")==patch.getString("code")}else d.getString("id") == p.getString("id")) &&
            root.getJSONObject("meta").get("replayed") is Boolean
    ) {
        "商品回执不匹配"
    }
    for (key in listOf("status", "guestVisible", "menuSortOrder","name","categoryCode","fulfillmentStation","productKind","inventoryControlMode","maxOrderQuantity","kdsPriority","fulfillmentSlaSeconds","searchText","recommendationEnabled","recommendationMinGuests","recommendationMaxGuests","recommendationPriority","recommendationSingleWaveEligible","recommendationExpectedPrepMinutes","recommendationHoldMinutes","recommendationUpgradeProductId")) if (patch.has(key))
        require(patch.get(key) == d.get(key)) { "商品变更回执不匹配" }
    patch.optJSONObject("productSnapshot")?.let{expected->for(k in listOf("imageUrl","description","salesSpecificationType"))if(expected.has(k))require(expected.get(k)==d.getJSONObject("productSnapshot").get(k)){"商品展示内容回执不匹配"}}
    patch.optJSONObject("productSnapshot")?.optJSONObject("tasteProfile")?.let{taste->for(k in listOf("acidity","sweetness"))require(taste.opt(k)==d.getJSONObject("productSnapshot").getJSONObject("tasteProfile").opt(k)){"口味评价回执不匹配"}}
    for(k in productTagOptions.keys)patch.optJSONArray(k)?.let{require(it.strings().toSet()==d.getJSONArray(k).strings().toSet()){"推荐标签回执不匹配"}}
    if(patch.has("costAmountMinor"))require(patch.textOrNull("costAmountMinor")?.toLongOrNull()==d.textOrNull("costAmountMinor")?.toLongOrNull()){"原成本回执未确认"}
    for(k in listOf("availableFrom","availableUntil")) if(patch.has(k))require(patch.textOrNull(k)?.take(5)==d.textOrNull(k)?.take(5))
    patch.optJSONArray("allowedChannels")?.let{require(it.strings().toSet()==d.getJSONArray("allowedChannels").strings().toSet())}
    patch.optJSONArray("bundleComponents")?.let{require(comparableBundleComponents(it)==comparableBundleComponents(d.getJSONArray("bundleComponents")))}
    patch.optJSONArray("bundleChoiceGroups")?.let{require(comparableBundleChoices(it)==comparableBundleChoices(d.getJSONArray("bundleChoiceGroups")))}
    patch.optJSONObject("standardPrice")?.let {
        val got = d.getJSONObject("standardPrice")
        require(
            got.getString("currency") == "CNY" &&
                got.getString("amountMinor").toLong() == it.getLong("amountMinor")
        ) {
            "商品价格回执不匹配"
        }
    }
}
