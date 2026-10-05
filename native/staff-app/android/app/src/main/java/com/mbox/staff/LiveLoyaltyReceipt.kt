package com.mbox.staff

import java.math.BigDecimal
import org.json.JSONObject

/** Reward receipts use exact JSON integers; getInt/getLong would coerce strings or truncate. */
internal fun loyaltyReceiptInteger(row: JSONObject, key: String): Long {
    val value = row.get(key)
    require(value is Number && value.toDouble().isFinite()) { "积分回执数值无效，请核对原记录" }
    val integer = try { BigDecimal(value.toString()).longValueExact() }
        catch (_: ArithmeticException) { null }
    require(integer != null && integer in -9007199254740991L..9007199254740991L) {
        "积分回执须为有效整数，请核对原记录"
    }
    return integer
}
