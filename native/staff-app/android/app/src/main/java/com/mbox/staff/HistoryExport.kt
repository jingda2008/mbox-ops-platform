package com.mbox.staff

fun historyExportTime(value: String?): String {
    if (value.isNullOrEmpty()) return ""
    return try {
        java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss", java.util.Locale.ROOT)
            .withZone(java.time.ZoneId.of("Asia/Shanghai"))
            .format(serverInstant(value))
    } catch (_: java.time.DateTimeException) {
        value
    }
}

fun historyExportAmount(minor: Long): String =
    (if (minor < 0) "-" else "") +
        kotlin.math.abs(minor / 100).toString() +
        "." +
        kotlin.math.abs(minor % 100).toString().padStart(2, '0')

fun HistoryQuery.exportPath(page: Int, all: Boolean) =
    path(if (all) 0 else page) + (if (all) "&exportAll=true" else "")

fun csvCell(value: String): String {
    val escaped =
        if (value.firstOrNull() in listOf('=', '+', '-', '@', '\t', '\r', '\n')) "'$value"
        else value
    return "\"" + escaped.replace("\"", "\"\"") + "\""
}

fun LiveHistory.exportCSV(): ByteArray {
    require(orders.size <= 5000) { "导出超过5000单，请缩小日期或筛选范围；不会只导出部分记录" }
    val rows =
        mutableListOf(
            listOf(
                "营业日",
                "订单",
                "桌台",
                "桌次",
                "下单员工",
                "下单时间",
                "菜品",
                "数量",
                "计价说明",
                "单价",
                "优惠后小计",
                "履约状态",
                "商品备注",
                "制作员工",
                "制作完成时间",
                "送达员工",
                "送达时间",
            )
        )
    orders.forEach { order ->
        order.getJSONArray("items").objects().forEach { item ->
            val bundle = item.optBoolean("includedInBundle", false)
            rows +=
                listOf(
                    order.textOrNull("businessDate") ?: date,
                    order.getString("publicId"),
                    order.getString("tableCode"),
                    order.textOrNull("sessionPublicId")
                        ?: order.textOrNull("tableSessionId")
                        ?: "未留存",
                    order.textOrNull("employeeName") ?: "顾客自助",
                    historyExportTime(order.getString("submittedAt")),
                    item.getString("name"),
                    item.getInt("quantity").toString(),
                    if (bundle) "套餐内商品，不另收费" else "订单成交价",
                    if (bundle) "" else historyExportAmount(item.getLong("unitPriceMinor")),
                    if (bundle) "" else historyExportAmount(item.getLong("totalMinor")),
                    item.textOrNull("fulfillmentClosureNote")
                        ?: historyStatus(item.getString("status")),
                    item.textOrNull("note") ?: "",
                    item.textOrNull("preparedBy") ?: "",
                    historyExportTime(item.textOrNull("preparedAt")),
                    item.textOrNull("deliveredBy") ?: "",
                    historyExportTime(item.textOrNull("deliveredAt")),
                )
        }
    }
    return ("\uFEFF" +
            rows.joinToString("\r\n") { row -> row.joinToString(",", transform = ::csvCell) })
        .toByteArray(Charsets.UTF_8)
}
