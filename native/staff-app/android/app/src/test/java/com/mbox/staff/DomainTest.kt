package com.mbox.staff

import java.io.*
import org.junit.Assert.*
import org.junit.Test

class DomainTest {
    @Test
    fun exactCents() {
        assertEquals(1, parseMoney("0.01"))
        assertEquals(1230, parseMoney("12.3"))
        listOf("0", "-1", "1.001", "1e3", "NaN", "1.１２").forEach { assertNull(parseMoney(it)) }
    }

    @Test
    fun orderingAndSearch() {
        val w = World.training()
        assertTrue(w.ordered().take(4).all { it.session != null })
        assertEquals(listOf("A5"), w.ordered("A5").map { it.code })
        assertEquals("已结清 · 在座", w.tables[1].status)
    }

    @Test
    fun fuzzyTableSearch() {
        val w = World.training()
        assertEquals(listOf("A5", "A6", "A8", "A9"), w.ordered(" a ").map { it.code })
        assertEquals(listOf("A5"), w.ordered("5").map { it.code })
        assertEquals(listOf("A8", "A9"), w.ordered("a", "空闲").map { it.code })
        assertEquals(listOf("A5", "A6"), w.ordered("a", "营业中").map { it.code })
        assertEquals(w.ordered(), w.ordered("  "))
        assertTrue(w.ordered("368").isEmpty())
        val search =
            w.copy(
                tables =
                    w.tables +
                        listOf(
                            StaffTable("a50", "A50", 4),
                            StaffTable("ba5", "BA5", 4, session = "search-ba5"),
                        )
            )
        assertEquals(listOf("A5", "BA5", "A50"), search.ordered("a5").map { it.code })
        val emptyExact =
            search.copy(
                tables = search.tables.map { if (it.id == "a5") it.copy(session = null) else it }
            )
        assertEquals(listOf("A5", "BA5", "A50"), emptyExact.ordered("a5").map { it.code })
        assertTrue(search.ordered("ZZ").isEmpty())
    }

    @Test
    fun unknownPaymentBlocked() {
        assertThrows(IllegalArgumentException::class.java) {
            World.training().apply(Command("cash", "b2", "training-b2", given = 15600))
        }
    }

    @Test
    fun fullCycleAndReplay() {
        var w = World.training()
        val open = Command("open", "a8", null, people = 2)
        w = w.apply(open).first
        val s = w.tables[4].session!!
        val lines = listOf(Line("water", "鲜柠气泡水", 2800, 2, "少冰"))
        w = w.copy(drafts = mapOf(s to lines))
        val order = Command("order", "a8", s, lines = lines)
        w = w.apply(order).first
        assertEquals(5600, w.tables[4].due)
        assertNull(w.drafts[s])
        val before = w
        w = w.apply(order).first
        assertEquals(before, w)
        assertThrows(IllegalArgumentException::class.java) {
            w.apply(order.copy(lines = lines.map { it.copy(quantity = 3) }))
        }
        w = w.apply(Command("cash", "a8", s, given = 1000)).first
        assertEquals(4600, w.tables[4].due)
        val cash = Command("cash", "a8", s, given = 5000)
        val (next, r) = w.apply(cash)
        w = next
        assertEquals(4600, r.applied)
        assertEquals(400, r.change)
        w = w.apply(cash).first
        assertEquals(5600, w.tables[4].paid)
        assertThrows(IllegalArgumentException::class.java) { w.apply(Command("close", "a8", s)) }
        w = w.apply(Command("deliver", "a8", s, orderID = order.id)).first
        w = w.copy(drafts = mapOf(s to lines))
        w = w.apply(Command("transfer", "a8", s, targetID = "a9")).first
        assertNull(w.tables[4].session)
        assertEquals(s, w.tables[5].session)
        assertEquals("A9", w.orders[0].tableCode)
        assertNotNull(w.drafts[s])
        w = w.apply(Command("close", "a9", s)).first
        assertNull(w.tables[5].session)
        assertNull(w.drafts[s])
        assertThrows(IllegalArgumentException::class.java) {
            w.apply(Command("cash", "a9", s, given = 1))
        }
        val bytes =
            ByteArrayOutputStream()
                .also { ObjectOutputStream(it).use { out -> out.writeObject(w) } }
                .toByteArray()
        val restored =
            ObjectInputStream(ByteArrayInputStream(bytes)).use { it.readObject() as World }
        assertEquals(w, restored)
        assertEquals(restored, restored.apply(cash).first)
        assertEquals(r, restored.apply(cash).second)
    }

    @Test
    fun soldOutAndDuplicateLinesRejected() {
        val w = World.training()
        assertThrows(IllegalArgumentException::class.java) {
            w.apply(
                Command(
                    "order",
                    "a5",
                    "training-a5",
                    lines = listOf(Line("sold", "当日甜品", 3200, 1, "标准")),
                )
            )
        }
        val line = Line("water", "鲜柠气泡水", 2800, 1, "少冰")
        assertThrows(IllegalArgumentException::class.java) {
            w.apply(Command("order", "a5", "training-a5", lines = listOf(line, line)))
        }
    }
}
