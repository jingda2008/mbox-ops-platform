package com.mbox.staff

import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

private val serverTimestamp = Regex(
    """(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?)"""
)

/** Accept API ISO timestamps and PostgreSQL timestamptz text without assuming a device timezone. */
fun serverInstant(value: String?): Instant {
    val match = value?.let { serverTimestamp.matchEntire(it) }
        ?: throw DateTimeParseException("服务器返回的时间格式不兼容，请联系管理员", value ?: "", 0)
    val (date, time, zone) = match.destructured
    val digits = zone.replace(":", "")
    val offset = when (digits.length) {
        3 -> "$digits:00"
        5 -> digits.substring(0, 3) + ":" + digits.substring(3)
        7 -> digits.substring(0, 3) + ":" + digits.substring(3, 5) + ":" + digits.substring(5)
        else -> zone
    }
    try {
        return OffsetDateTime.parse("${date}T$time$offset", DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()
    } catch (error: DateTimeParseException) {
        throw DateTimeParseException("服务器返回的时间格式不兼容，请联系管理员", value, 0, error)
    }
}
