package com.mbox.staff

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class StockTest {
    private fun fixture() =
        JSONObject(
            javaClass.classLoader!!.getResourceAsStream("live-stock.json")!!.bufferedReader().use {
                it.readText()
            }
        )

    @Test
    fun supplierAndBatchTraceabilitySurviveEmployeeDraftAndOriginalRequestRecovery() {
        val f = fixture()
        val board = StockBoard(f.getJSONObject("board"))
        val actor = StaffIdentity.parse(f.getJSONObject("auth"))
        val line = StockLine.make(board.items[0], "2", "10.01", f.getJSONObject("scan"), "  LOT-20261005-A  ")
        val secondBatch = line.copy(batchCode = "LOT-20261005-B")
        val lines = listOf(line, secondBatch)
        val book = stockDraftBookEntry(JSONObject(), actor.employeeId, lines, "  上海供货商  ")
        stockDraftBookEntry(book, "other-employee", emptyList(), "其他供应商")
        val reopened = JSONObject(book.toString())
        val restored = reopened.getJSONArray(actor.employeeId).objects().map(StockLine::parse)
        assertEquals(lines, restored)
        assertEquals("上海供货商", stockDraftSupplier(reopened, actor.employeeId))
        assertEquals("其他供应商", stockDraftSupplier(reopened, "other-employee"))

        val command = stockCommand(actor, board, restored, supplierName = stockDraftSupplier(reopened, actor.employeeId))
        val recovered = LiveCommand.parse(command.json())
        assertEquals(command, recovered)
        val body = JSONObject(recovered.steps.single().body)
        assertEquals("上海供货商", body.getJSONObject("supplierSnapshot").getString("name"))
        assertEquals(listOf("LOT-20261005-A", "LOT-20261005-B"), body.getJSONArray("lines").objects().map { it.getString("batchCode") })
        assertTrue(body.getJSONArray("lines").objects().all { it.getString("expectedPackageQuantity") == "12" })
        assertEquals("draft", recovered.steps.single().stockProof!!.getString("status"))
        assertTrue(stockDraftMatchesReceipt(reopened, actor.employeeId, recovered.steps.single().stockProof!!))

        stockDraftBookEntry(reopened, actor.employeeId, restored, "后来修改的供应商")
        assertFalse(stockDraftMatchesReceipt(reopened, actor.employeeId, recovered.steps.single().stockProof!!))
        stockDraftBookEntry(reopened, actor.employeeId, listOf(line.copy(batchCode = "新批次")), "上海供货商")
        assertFalse(stockDraftMatchesReceipt(reopened, actor.employeeId, recovered.steps.single().stockProof!!))

        val receipt = board.receipts.single()
        receipt.put("supplier", JSONObject().put("name", "上海供货商"))
        receipt.getJSONArray("lines").getJSONObject(0).put("batchCode", "LOT-20261005-A")
        val receive = stockCommand(actor, board, receiptID = receipt.getString("id"))
        val confirmation = receive.steps.single().stockProof!!.getString("confirmation")
        assertTrue(confirmation.contains("上海供货商"))
        assertTrue(confirmation.contains("LOT-20261005-A"))
        assertEquals("received", receive.steps.single().stockProof!!.getString("status"))
        assertTrue(receive.steps.single().path.endsWith("/receive"))
    }

    @Test
    fun optionalTraceabilityKeepsLegacyDraftsReadableAndRejectsBadInputsBeforeSubmission() {
        val f = fixture()
        val board = StockBoard(f.getJSONObject("board"))
        val actor = StaffIdentity.parse(f.getJSONObject("auth"))
        val old = StockLine.make(board.items[0], "2", "10", null)
        val legacyJson = old.json()
        assertFalse(legacyJson.has("batchCode"))
        assertNull(StockLine.parse(legacyJson).batchCode)
        val book = JSONObject().put(actor.employeeId, JSONArray().put(legacyJson))
        assertEquals("", stockDraftSupplier(book, actor.employeeId))
        val command = stockCommand(actor, board, listOf(old))
        assertEquals(0, JSONObject(command.steps.single().body).getJSONObject("supplierSnapshot").length())
        assertFalse(JSONObject(command.steps.single().body).getJSONArray("lines").getJSONObject(0).has("batchCode"))
        val oldProof = JSONObject(command.steps.single().stockProof!!.toString()).apply { remove("supplierName") }
        assertTrue(stockDraftMatchesReceipt(book, actor.employeeId, oldProof))

        assertThrows(IllegalArgumentException::class.java) { stockCommand(actor, board, listOf(old), supplierName = "供".repeat(201)) }
        assertThrows(IllegalArgumentException::class.java) { normalizedStockSupplierName("供应商\n另一行") }
        assertThrows(IllegalArgumentException::class.java) { StockLine.make(board.items[0], "1", "10", null, "B".repeat(129)) }
        assertThrows(IllegalArgumentException::class.java) { stockCommand(actor, board, listOf(old.copy(batchCode = " invalid "))) }
        assertThrows(IllegalArgumentException::class.java) { stockCommand(actor, board, listOf(old, old.copy())) }
    }

    @Test
    fun quantitiesAndDurableReceiptGuards() {
        val f = fixture()
        val b = StockBoard(f.getJSONObject("board"))
        val a = StaffIdentity.parse(f.getJSONObject("auth"))
        val scan = f.getJSONObject("scan")
        val l = StockLine.make(b.items[0], "2", "10.01", scan)
        assertEquals("2", l.payload().getString("packages"))
        assertFalse(l.payload().has("quantity"))
        assertEquals("1001", l.payload().getString("totalCostMinor"))
        for (q in listOf("-1", "0", "1e3", "0.1", "1.1234567", "NaN")) assertThrows(
            IllegalArgumentException::class.java
        ) {
            StockLine.make(b.items[0], q, "10", null)
        }
        assertThrows(IllegalArgumentException::class.java) {
            StockLine.make(b.items[0], "1", "1.001", null)
        }
        val create = stockCommand(a, b, listOf(l))
        assertEquals("draft", create.steps[0].stockProof!!.getString("status"))
        assertEquals(create, LiveCommand.parse(create.json()))
        assertThrows(IllegalArgumentException::class.java) { stockCommand(a, b, listOf(l, l)) }
        val id = b.receipts[0].getString("id")
        val receive = stockCommand(a, b, receiptID = id)
        val data =
            JSONObject()
                .put("id", id)
                .put("publicId", "r1")
                .put("currency", "CNY")
                .put("status", "received")
                .put("lineCount", 1)
        fun reply(d: JSONObject) =
            JSONObject().put("data", d).put("meta", JSONObject().put("replayed", true)).toString()
        validateStockReply(reply(data), receive.steps[0])
        for ((key, value) in
            listOf(
                "id" to "33333333-3333-4333-8333-333333333333",
                "currency" to "USD",
                "status" to "draft",
            )) assertThrows(IllegalArgumentException::class.java) {
            validateStockReply(reply(JSONObject(data.toString()).put(key, value)), receive.steps[0])
        }
        val denied =
            StaffIdentity.parse(
                f.getJSONObject("auth")
                    .put("deniedPermissions", JSONArray(listOf("inventory.receive")))
            )
        assertThrows(IllegalArgumentException::class.java) { stockCommand(denied, b, listOf(l)) }
    }

    @Test
    fun productVersionAndStockApprovalGuards() {
        assertEquals(0, nativeNonnegativeMoney("0.00"))
        assertNull(nativeNonnegativeMoney("-1"))
        assertNull(parseMoney("0.00"))
        val f = fixture()
        val actor = StaffIdentity.parse(f.getJSONObject("auth"))
        val b = StockBoard(f.getJSONObject("board"))
        val board = ProductManagementBoard(f.getJSONObject("products"))
        val p = board.products[0]
        val update =
            productManagementCommand(actor, board, p, "sold_out", false, "20", "15.01", "菜单改价")
        assertEquals(
            p.getString("nativeVersion"),
            JSONObject(update.steps[0].body).getString("expectedVersion"),
        )
        assertEquals(update, LiveCommand.parse(update.json()))
        assertThrows(IllegalArgumentException::class.java) {
            productManagementCommand(actor, board, p, "active", true, "10", "12.34", "")
        }
        assertThrows(IllegalArgumentException::class.java) {
            productManagementCommand(actor, board, p, "active", true, "10", "12.001", "改价")
        }
        val pd =
            JSONObject()
                .put("id", p.getString("id"))
                .put("status", "sold_out")
                .put("guestVisible", false)
                .put("menuSortOrder", 20)
                .put(
                    "standardPrice",
                    JSONObject().put("amountMinor", "1501").put("currency", "CNY"),
                )
        fun response(data: JSONObject) =
            JSONObject()
                .put("data", data)
                .put("meta", JSONObject().put("replayed", true))
                .toString()
        validateProductManagementReply(response(pd), update.steps[0])
        pd.getJSONObject("standardPrice").put("amountMinor", "1502")
        assertThrows(IllegalArgumentException::class.java) {
            validateProductManagementReply(response(pd), update.steps[0])
        }
        val item = b.items[0]
        val line =
            JSONObject()
                .put("inventoryItemId", item.getString("id"))
                .put("name", item.getString("name"))
                .put("baseUnit", item.getString("baseUnit"))
                .put("countedQuantity", "0")
                .put("reason", "现场清点")
                .put("expectedOnHandQuantity", item.getString("onHandQuantity"))
                .put("observedAt", b.source.getString("inventoryObservedAt"))
        val count = stockAuditCommand(actor, b, "count", lines = listOf(line))
        assertTrue(count.steps[0].path.endsWith("stock-count-submissions"))
        assertEquals("submitted", count.steps[0].stockAuditProof!!.getString("status"))
        assertEquals(count, LiveCommand.parse(count.json()))
        assertThrows(IllegalArgumentException::class.java) {
            stockAuditCommand(actor, b, "count", lines = listOf(line, line))
        }
        assertThrows(IllegalArgumentException::class.java) { stockQuantity("0.5", item, true) }
        val waste =
            stockAuditCommand(
                actor,
                b,
                "waste",
                itemID = item.getString("id"),
                quantity = "1",
                reason = "现场损耗",
            )
        assertTrue(JSONObject(waste.steps[0].body).getBoolean("requestApproval"))
        val pending =
            JSONObject().put("status", "pending").put("id", "44444444-4444-4444-8444-444444444444")
        validateStockAuditReply(response(pending), waste.steps[0])
        assertThrows(IllegalArgumentException::class.java) {
            validateStockAuditReply(response(pending), count.steps[0])
        }
        assertThrows(IllegalArgumentException::class.java) {
            stockAuditCommand(actor, b, "wasteApprove", reason = "确认")
        }
    }
}
