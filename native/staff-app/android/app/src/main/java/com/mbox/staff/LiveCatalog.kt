package com.mbox.staff

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

data class LiveProduct(val source: String) {
    private val json = JSONObject(source)
    val id = json.getString("id")
    val code = json.getString("code")
    val name = json.getString("name")
    val imageURL = menuImageURL(json.optJSONObject("productSnapshot")?.opt("imageUrl") as? String)
    val description =
        (json.optJSONObject("productSnapshot")?.opt("description") as? String).orEmpty()
    val specification =
        (json.optJSONObject("productSnapshot")?.opt("specification") as? String).orEmpty()
    val categoryCode = json.getString("categoryCode")
    val categoryName =
        json.optString("categoryName").takeUnless { it.isBlank() || it == "null" } ?: categoryCode
    val maxOrderQuantity = json.getInt("maxOrderQuantity")
    val menuSortOrder = json.getInt("menuSortOrder")

    data class Component(val name: String, val quantity: Int, val note: String?)

    data class Option(
        val id: String,
        val name: String,
        val quantity: Int,
        val available: Boolean,
        val reason: String?,
    )

    data class Group(val id: String, val name: String, val count: Int, val options: List<Option>)

    val components =
        json.getJSONArray("bundleComponents").objects().map {
            Component(
                it.getString("name"),
                it.getInt("quantity"),
                it.optString("note").takeUnless { v -> v.isBlank() || v == "null" },
            )
        }
    val groups =
        (json.optJSONArray("bundleChoiceGroups") ?: JSONArray()).objects().map { g ->
            Group(
                g.getString("id"),
                g.getString("name"),
                g.getInt("selectionCount"),
                g.getJSONArray("options").objects().map {
                    Option(
                        it.getString("productId"),
                        it.getString("name"),
                        it.getInt("quantity"),
                        it.getBoolean("available"),
                        it.optString("unavailableReason").takeUnless { v ->
                            v.isBlank() || v == "null"
                        },
                    )
                },
            )
        }
    val price: Int? =
        json.optJSONObject("standardPrice")?.let { p ->
            p.optString("amountMinor").toIntOrNull()?.takeIf {
                p.optString("currency") == "CNY" && it in 0..1_000_000_000
            }
        }
    val unavailable: String?
        get() =
            when {
                !(json.getJSONArray("allowedChannels").strings().contains("staff_assisted")) ->
                    "未开放员工点单渠道"
                json.getString("status") == "sold_out" -> "已售罄"
                json.getString("status") != "active" -> "已下架"
                price == null -> "缺少有效人民币售价"
                !json.getBoolean("inventoryConfigurationComplete") -> "库存配方未配置完整"
                !json.getBoolean("inventoryAvailable") -> "库存不足"
                !json.getBoolean("isAvailable") ->
                    json.optJSONArray("availabilityReasons")?.strings()?.firstOrNull() ?: "当前不可售"
                maxOrderQuantity < 1 -> "未开放可购数量"
                groups.any {
                    it.count < 1 || it.options.count { option -> option.available } < it.count
                } -> "套餐可选商品不足"
                else -> null
            }

    fun matches(query: String): Boolean =
        ("$name $code $categoryName").contains(query.trim(), ignoreCase = true)
}

fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

data class LiveDraftLine(
    val id: String,
    val product: LiveProduct,
    val choices: Map<String, List<String>>,
    val note: String,
) {
    companion object {
        fun make(
            product: LiveProduct,
            choices: Map<String, List<String>>,
            note: String,
        ): LiveDraftLine {
            product.unavailable?.let { error(it) }
            require(note.length <= 300) { "商品备注最多300字" }
            require(choices.keys.all { id -> product.groups.any { it.id == id } }) {
                "套餐分组已变化，请重新选择"
            }
            product.groups.forEach { g ->
                val picked = choices[g.id].orEmpty()
                require(
                    picked.size == g.count &&
                        picked.distinct().size == picked.size &&
                        picked.all { id -> g.options.any { it.id == id && it.available } }
                ) {
                    "请为“${g.name}”选择${g.count}款可售商品"
                }
            }
            return LiveDraftLine(UUID.randomUUID().toString(), product, choices, note.trim())
        }

        fun parse(j: JSONObject) =
            LiveDraftLine(
                j.getString("id"),
                LiveProduct(j.getJSONObject("product").toString()),
                j.getJSONObject("choices").let { obj ->
                    obj.keys().asSequence().associateWith { obj.getJSONArray(it).strings() }
                },
                j.getString("note"),
            )
    }

    val selectionLabel
        get() =
            product.groups
                .flatMap { g ->
                    g.options
                        .filter { choices[g.id]?.contains(it.id) == true }
                        .map { "${it.name} ×${it.quantity}" }
                }
                .joinToString("、")

    fun json(): JSONObject =
        JSONObject()
            .put("id", id)
            .put("product", JSONObject(product.source))
            .put("choices", JSONObject(choices))
            .put("note", note)

    fun payload(): JSONObject =
        JSONObject().put("productId", product.id).put("quantity", 1).also { obj ->
            if (note.isNotBlank()) obj.put("note", note)
            if (product.groups.isNotEmpty())
                obj.put(
                    "bundleSelections",
                    JSONArray()
                        .put(
                            JSONObject()
                                .put(
                                    "groups",
                                    JSONArray(
                                        product.groups.map {
                                            JSONObject()
                                                .put("groupId", it.id)
                                                .put(
                                                    "productIds",
                                                    JSONArray(choices[it.id].orEmpty()),
                                                )
                                        }
                                    ),
                                )
                        ),
                )
        }
}

data class LiveDraftBook(val entries: Map<String, List<LiveDraftLine>> = emptyMap()) {
    companion object {
        fun key(employee: String, session: String) = "$employee:$session"

        fun parse(j: JSONObject) =
            LiveDraftBook(
                j.keys().asSequence().associateWith {
                    j.getJSONArray(it).objects().map(LiveDraftLine::parse)
                }
            )
    }

    fun add(line: LiveDraftLine, employee: String, session: String): LiveDraftBook {
        val key = key(employee, session)
        val lines = entries[key].orEmpty()
        require(lines.size < 100) { "每次草稿最多100份，请分次处理" }
        require(lines.count { it.product.id == line.product.id } < line.product.maxOrderQuantity) {
            "已达到该商品每单限量"
        }
        require(lines.filter { it.product.id == line.product.id }.all { it.note == line.note }) {
            "同一商品共用备注，请使用相同备注，或先移除旧份数"
        }
        require((lines.map { it.product.id } + line.product.id).distinct().size <= 50) {
            "每次订单最多50种商品"
        }
        return copy(entries = entries + (key to lines + line))
    }

    fun json() =
        JSONObject().also { obj ->
            entries.forEach { (key, lines) -> obj.put(key, JSONArray(lines.map { it.json() })) }
        }
}

fun liveOrderItems(lines: List<LiveDraftLine>): JSONArray {
    require(lines.isNotEmpty()) { "请先选择商品" }
    val groups = lines.groupBy { it.product.id }
    require(groups.size <= 50) { "每次订单最多50种商品" }
    return JSONArray(
        groups.values.map { units ->
            val first = units.first()
            require(
                units.size <= minOf(999, first.product.maxOrderQuantity) &&
                    units.all { it.note == first.note }
            ) {
                "商品数量或共用备注不一致，请重新核对"
            }
            first.payload().put("quantity", units.size).also { item ->
                if (first.product.groups.isNotEmpty())
                    item.put(
                        "bundleSelections",
                        JSONArray(
                            units.map {
                                it.payload().getJSONArray("bundleSelections").getJSONObject(0)
                            }
                        ),
                    )
            }
        }
    )
}

fun menuImageURL(value: String?): String? {
    val path = value?.trim() ?: return null
    return if (
        Regex(
                "^(/api/public/media-assets/MA[0-9A-F]{32}|/menu/([A-Za-z0-9][A-Za-z0-9_.-]*/)*[A-Za-z0-9][A-Za-z0-9_.-]*\\.(jpg|jpeg|png|webp))$",
                RegexOption.IGNORE_CASE,
            )
            .matches(path)
    )
        "https://mbox.shmbox.com$path"
    else null
}
