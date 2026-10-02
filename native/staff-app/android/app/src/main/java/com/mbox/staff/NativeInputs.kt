package com.mbox.staff

import java.net.URI
import java.net.URLDecoder
import java.util.Locale

/** A table QR is a navigation hint only. Never exchanges guest credentials or changes a table. */
fun scannedTableCode(value: String): String {
    val text = value.trim()
    require(text.length in 1..4096) { "扫码内容无效，请手动搜索桌号" }
    val code = if (text.startsWith("https://", ignoreCase = true)) {
        val uri = try { URI(text) } catch (_: Exception) { error("无法识别桌码，请手动搜索桌号") }
        require(uri.scheme.equals("https", true) && uri.host.equals("mbox.shmbox.com", true) && uri.userInfo == null && uri.port in listOf(-1, 443)) { "这不是本门店桌码" }
        val pairs = (uri.rawQuery ?: "").split('&').map { it.split('=', limit = 2) }
        val values = pairs.filter { URLDecoder.decode(it[0], "UTF-8") == "table" }
        require(values.size == 1 && values[0].size == 2) { "桌码缺少唯一桌号，请手动搜索" }
        URLDecoder.decode(values[0][1], "UTF-8").trim()
    } else text
    require(Regex("[A-Za-z0-9\\p{IsHan}_-]{1,32}").matches(code)) { "未识别到桌号，请手动搜索" }
    return code.uppercase(Locale.ROOT)
}

fun resolveScannedTable(value: String, tables: List<StaffTable>): StaffTable {
    val code = scannedTableCode(value)
    val matches = tables.filter { it.code.uppercase(Locale.ROOT) == code }
    require(matches.size == 1) { "当前岗位可见桌台中没有唯一匹配的桌号，请刷新后手动搜索" }
    return matches.single()
}

fun speechCandidate(candidates: List<String>): String? = candidates.asSequence()
    .map { it.trim() }.firstOrNull { it.isNotEmpty() && it.length <= 2000 }
