package com.mbox.staff

import java.io.Serializable
import java.util.UUID

data class StaffTable(
    val id: String,
    val code: String,
    val capacity: Int,
    val people: Int = 0,
    val session: String? = null,
    val total: Int? = 0,
    val paid: Int? = 0,
    val unknown: Boolean = false,
    val service: Boolean = false,
) : Serializable {
    val due: Int?
        get() = if (total != null && paid != null) maxOf(0, total - paid) else null

    val status: String
        get() =
            when {
                session == null -> "空闲"
                unknown -> "款项确认中"
                due == null -> "账单待核对"
                total == 0 -> "已开台 · 未点单"
                due == 0 -> "已结清 · 在座"
                else -> "待收款"
            }
}

data class Product(
    val id: String,
    val name: String,
    val category: String,
    val price: Int,
    val available: Boolean = true,
    val choices: List<String> = listOf("标准"),
) : Serializable

data class Line(
    val productID: String,
    val name: String,
    val price: Int,
    val quantity: Int,
    val variant: String,
) : Serializable {
    val key
        get() = "$productID:$variant"

    val amount
        get() = price * quantity
}

data class StaffOrder(
    val id: String,
    val session: String,
    val tableCode: String,
    val lines: List<Line>,
    val delivered: Boolean = false,
) : Serializable {
    val amount
        get() = lines.sumOf { it.amount }
}

data class Receipt(
    val requestID: String,
    val session: String,
    val kind: String,
    val applied: Int = 0,
    val given: Int = 0,
) : Serializable {
    val change
        get() = maxOf(0, given - applied)
}

data class Command(
    val kind: String,
    val tableID: String,
    val expectedSession: String?,
    val id: String = UUID.randomUUID().toString(),
    val people: Int = 0,
    val targetID: String? = null,
    val lines: List<Line> = emptyList(),
    val given: Int = 0,
    val orderID: String? = null,
) : Serializable

data class Entry(val command: Command, val receipt: Receipt) : Serializable

data class World(
    val tables: List<StaffTable>,
    val products: List<Product>,
    val orders: List<StaffOrder> = emptyList(),
    val journal: Map<String, Entry> = emptyMap(),
    val drafts: Map<String, List<Line>> = emptyMap(),
) : Serializable {
    fun ordered(query: String = "", filter: String = "全部"): List<StaffTable> {
        val key = query.trim()
        return tables
            .filter {
                (key.isEmpty() || it.code.contains(key, ignoreCase = true)) &&
                    (filter == "全部" ||
                        if (filter == "营业中") it.session != null else it.session == null)
            }
            .sortedWith(
                compareBy<StaffTable> {
                        !(key.isNotEmpty() && it.code.equals(key, ignoreCase = true))
                    }
                    .thenBy { it.session == null }
                    .thenBy { it.code }
            )
    }

    fun apply(c: Command): Pair<World, Receipt> {
        journal[c.id]?.let {
            require(it.command == c) { "同一请求不能更换内容" }
            return this to it.receipt
        }
        val index = tables.indexOfFirst { it.id == c.tableID }
        require(index >= 0) { "桌台不存在" }
        var t = tables[index]
        require(t.session == c.expectedSession) { "桌次已变化，请刷新；原草稿已保留" }
        val updated = tables.toMutableList()
        var newOrders = orders
        var newDrafts = drafts
        var receipt = Receipt(c.id, t.session ?: "", c.kind)
        when (c.kind) {
            "open" -> {
                require(t.session == null && c.people in 1..t.capacity) { "请核对桌台状态与人数" }
                t =
                    t.copy(
                        session = "training-${c.id}",
                        people = c.people,
                        total = 0,
                        paid = 0,
                        unknown = false,
                        service = false,
                    )
                receipt = receipt.copy(session = t.session!!)
            }
            "order" -> {
                require(t.session != null && c.lines.isNotEmpty()) { "请先开台并选择商品" }
                require(c.lines.distinctBy { it.key }.size == c.lines.size) { "商品行重复" }
                c.lines.forEach { l ->
                    val p = products.find { it.id == l.productID }
                    require(
                        p != null &&
                            p.available &&
                            p.price == l.price &&
                            p.name == l.name &&
                            l.variant in p.choices &&
                            l.quantity in 1..99
                    ) {
                        "商品或规格已变化"
                    }
                }
                val amount = c.lines.sumOf { it.amount.toLong() }
                require(amount in 1..100_000_000 && t.total != null) { "金额无法确认" }
                t = t.copy(total = t.total!! + amount.toInt())
                newOrders = orders + StaffOrder(c.id, t.session!!, t.code, c.lines)
                newDrafts = drafts - t.session!!
            }
            "cash" -> {
                val due = t.due
                require(
                    t.session != null &&
                        !t.unknown &&
                        due != null &&
                        due > 0 &&
                        t.paid != null &&
                        c.given in 1..100_000_000
                ) {
                    "金额或原款状态不允许收款，请先核对"
                }
                val applied = minOf(c.given, due!!)
                t = t.copy(paid = t.paid!! + applied)
                receipt = receipt.copy(applied = applied, given = c.given)
            }
            "service" -> {
                require(t.session != null && t.service) { "服务任务已变化" }
                t = t.copy(service = false)
            }
            "deliver" -> {
                require(orders.any { it.id == c.orderID && it.session == t.session }) {
                    "订单不属于当前桌次"
                }
                newOrders = orders.map { if (it.id == c.orderID) it.copy(delivered = true) else it }
            }
            "close" -> {
                require(
                    t.session != null &&
                        t.due == 0 &&
                        !t.unknown &&
                        !t.service &&
                        orders.none { it.session == t.session && !it.delivered }
                ) {
                    "请先处理未结款项、待送商品和服务任务"
                }
                newDrafts = drafts - t.session!!
                t = StaffTable(t.id, t.code, t.capacity)
            }
            "transfer" -> {
                val target = tables.indexOfFirst { it.id == c.targetID }
                require(
                    t.session != null &&
                        target >= 0 &&
                        target != index &&
                        tables[target].session == null &&
                        tables[target].capacity >= t.people
                ) {
                    "目标桌不可用或容量不足"
                }
                val dest = tables[target]
                updated[target] = t.copy(id = dest.id, code = dest.code, capacity = dest.capacity)
                newOrders =
                    orders.map {
                        if (it.session == t.session) it.copy(tableCode = dest.code) else it
                    }
                t = StaffTable(t.id, t.code, t.capacity)
            }
            else -> error("不支持的操作")
        }
        updated[index] = t
        return copy(
            tables = updated,
            orders = newOrders,
            drafts = newDrafts,
            journal = journal + (c.id to Entry(c, receipt)),
        ) to receipt
    }

    companion object {
        fun training() =
            World(
                listOf(
                    StaffTable("a5", "A5", 4, 4, "training-a5", 36800, 10000, service = true),
                    StaffTable("a6", "A6", 4, 3, "training-a6", 22800, 22800),
                    StaffTable("b2", "B2", 4, 2, "training-b2", 15600, 0, unknown = true),
                    StaffTable("b3", "B3", 4, 2, "training-b3", 12800, 0),
                    StaffTable("a8", "A8", 4),
                    StaffTable("a9", "A9", 6),
                ),
                listOf(
                    Product("set", "经典双人套餐", "套餐", 8800, choices = listOf("标准搭配", "无酒精搭配")),
                    Product("water", "鲜柠气泡水", "饮品", 2800, choices = listOf("正常冰", "少冰", "去冰")),
                    Product("fries", "薯条拼盘", "小食", 3800),
                    Product("beer", "单杯精酿", "酒水", 3800),
                    Product("sold", "当日甜品", "小食", 3200, false),
                ),
            )
    }
}

fun parseMoney(text: String): Int? {
    if (!Regex("[0-9]{1,6}(\\.[0-9]{1,2})?").matches(text)) return null
    val parts = text.split('.')
    return (parts[0].toInt() * 100 + (parts.getOrNull(1)?.padEnd(2, '0')?.toInt() ?: 0)).takeIf {
        it > 0
    }
}

fun money(value: Int?): String =
    if (value == null) "待核对"
    else if (value % 100 == 0) "¥${value/100}"
    else "¥${value/100}.${(value%100).toString().padStart(2,'0')}"
