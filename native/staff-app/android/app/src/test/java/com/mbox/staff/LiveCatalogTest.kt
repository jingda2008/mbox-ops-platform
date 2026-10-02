package com.mbox.staff

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LiveCatalogTest {
    private fun fixture() =
        JSONObject(
                javaClass.classLoader!!
                    .getResourceAsStream("live-catalog.json")!!
                    .bufferedReader()
                    .use { it.readText() }
            )
            .getJSONObject("product")

    @Test
    fun menuPresentationIsOptionalAndRejectsMalformedMetadata() {
        val snapshot =
            JSONObject()
                .put("imageUrl", "/menu/food/fries.jpg")
                .put("description", "现炸小食")
                .put("specification", "一份")
        val product = LiveProduct(fixture().put("productSnapshot", snapshot).toString())
        assertEquals("https://mbox.shmbox.com/menu/food/fries.jpg", product.imageURL)
        assertEquals("现炸小食", product.description)
        assertEquals("一份", product.specification)
        val malformed =
            LiveProduct(
                fixture()
                    .put(
                        "productSnapshot",
                        JSONObject()
                            .put("imageUrl", 1)
                            .put("description", JSONObject())
                            .put("specification", false),
                    )
                    .toString()
            )
        assertNull(malformed.imageURL)
        assertEquals("", malformed.description)
        assertEquals("", malformed.specification)
        assertNull(malformed.unavailable)
    }

    @Test
    fun menuImagesUseOnlyApprovedPublicAssetPaths() {
        for (path in
            listOf(
                "/menu/food/fries.jpg",
                "/menu/DRINK.PNG",
                "/api/public/media-assets/MA" + "A".repeat(32),
            )) {
            assertEquals("https://mbox.shmbox.com$path", menuImageURL(path))
        }
        for (path in
            listOf(
                "https://example.com/x.jpg",
                "//example.com/x.jpg",
                "/menu/../private.jpg",
                "/menu/%2e%2e/x.jpg",
                "/menu/a.jpg?token=secret",
                "/api/staff/photo",
                "/menu/a.svg",
            )) {
            assertNull(path, menuImageURL(path))
        }
    }

    @Test
    fun actualCatalogRestrictionsAndBundleRules() {
        val p = LiveProduct(fixture().toString())
        assertEquals(19800, p.price)
        assertNull(p.unavailable)
        assertTrue(p.matches("pk0"))
        assertThrows(IllegalArgumentException::class.java) { LiveDraftLine.make(p, emptyMap(), "") }
        assertThrows(IllegalArgumentException::class.java) {
            LiveDraftLine.make(p, mapOf("g1" to listOf("p3")), "")
        }
        assertThrows(IllegalArgumentException::class.java) {
            LiveDraftLine.make(p, mapOf("g1" to listOf("p1", "p1")), "")
        }
        val cases =
            listOf(
                fixture().put("allowedChannels", org.json.JSONArray().put("guest_qr")),
                fixture().put("inventoryAvailable", false),
                fixture()
                    .put(
                        "standardPrice",
                        JSONObject().put("amountMinor", "-1").put("currency", "CNY"),
                    ),
            )
        cases.forEach {
            assertThrows(IllegalStateException::class.java) {
                LiveDraftLine.make(LiveProduct(it.toString()), mapOf("g1" to listOf("p1")), "")
            }
        }
    }

    @Test
    fun durableDraftScopesAndPerUnitSelections() {
        val p = LiveProduct(fixture().toString())
        val first = LiveDraftLine.make(p, mapOf("g1" to listOf("p1")), "少冰")
        val second = LiveDraftLine.make(p, mapOf("g1" to listOf("p2")), "少冰")
        val book = LiveDraftBook().add(first, "e1", "s1").add(second, "e1", "s1")
        assertThrows(IllegalArgumentException::class.java) { book.add(first, "e1", "s1") }
        val restored = LiveDraftBook.parse(JSONObject(book.json().toString()))
        assertEquals(
            listOf("饮品甲 ×2", "饮品乙 ×2"),
            restored.entries["e1:s1"]!!.map { it.selectionLabel },
        )
        assertNull(restored.entries["e2:s1"])
        assertNull(restored.entries["e1:s2"])
        assertEquals(
            "p1",
            first
                .payload()
                .getJSONArray("bundleSelections")
                .getJSONObject(0)
                .getJSONArray("groups")
                .getJSONObject(0)
                .getJSONArray("productIds")
                .getString(0),
        )
        assertEquals(1, first.payload().getInt("quantity"))
        assertEquals("少冰", first.payload().getString("note"))
        val items = liveOrderItems(listOf(first, second))
        assertEquals(1, items.length())
        assertEquals(2, items.getJSONObject(0).getInt("quantity"))
        assertEquals(2, items.getJSONObject(0).getJSONArray("bundleSelections").length())
        assertThrows(IllegalArgumentException::class.java) {
            liveOrderItems(listOf(first, LiveDraftLine.make(p, mapOf("g1" to listOf("p2")), "常温")))
        }
        assertThrows(IllegalArgumentException::class.java) {
            LiveDraftLine.make(p, mapOf("g1" to listOf("p1")), "字".repeat(301))
        }
    }
}
