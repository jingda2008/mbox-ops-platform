package com.mbox.staff

import java.time.LocalDate
import org.json.JSONObject

fun overviewPath(period: String, anchor: String): String {
    require(period in listOf("day", "week", "month", "quarter", "year")) { "统计周期无效" }
    if (anchor.isNotEmpty()) require(LocalDate.parse(anchor).toString() == anchor) { "营业日格式无效" }
    return "/api/commercial-ops/profit?period=$period" +
        (if (anchor.isEmpty()) "" else "&anchor=" + LiveCommand.part(anchor))
}

fun validateOverview(d: JSONObject, period: String) {
    require(
        d.getString("period") == period &&
            d.getString("currency") == "CNY" &&
            d.getString("status") in listOf("complete", "provisional") &&
            !d.getJSONObject("gaps").getBoolean("unknownUnrecordedCostsMeasurable")
    ) {
        "经营报表口径不匹配"
    }
    listOf("paymentReceiptsMinor", "refundsMinor", "netReceiptsMinor").forEach {
        require(d.getJSONObject("revenue").getJSONObject("cash").get(it) is Number)
    }
    listOf("goodsCostMinor", "inventoryLossMinor", "operatingExpenseMinor").forEach {
        require(d.getJSONObject("costs").get(it) is Number)
    }
    require(d.getJSONObject("profit").get("operatingProfitMinor") is Number)
}
