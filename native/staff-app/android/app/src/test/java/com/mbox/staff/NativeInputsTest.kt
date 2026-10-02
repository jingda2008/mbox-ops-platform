package com.mbox.staff

import org.junit.Assert.*
import org.junit.Test

class NativeInputsTest {
    private val tables = listOf(StaffTable("t1", "A5", 4), StaffTable("t2", "A50", 6))
    @Test fun tableCodesAreExactAndGuestSecretsAreNotUsed() {
        assertEquals("t1", resolveScannedTable(" a5 ", tables).id)
        assertEquals("t1", resolveScannedTable("https://mbox.shmbox.com/?table=A5#token=not-used", tables).id)
        assertThrows(IllegalArgumentException::class.java) { resolveScannedTable("A", tables) }
        assertThrows(IllegalArgumentException::class.java) { resolveScannedTable("A5", tables + tables[0].copy(id="t3")) }
    }
    @Test fun externalPaymentAndAmbiguousCodesAreRejected() {
        listOf("https://mbox.shmbox.com.evil.test/?table=A5", "https://evil.test/?table=A5", "https://x@mbox.shmbox.com/?table=A5", "http://mbox.shmbox.com/?table=A5", "https://mbox.shmbox.com/?table=A5&table=A50", "https://mbox.shmbox.com/?token=secret", "https://mbox.shmbox.com:9999/?table=A5", "A5\nA50").forEach {
            assertThrows(it, IllegalArgumentException::class.java) { resolveScannedTable(it, tables) }
        }
    }
    @Test fun speechOnlyYieldsBoundedDraftText() {
        assertNull(speechCandidate(listOf(" ", "x".repeat(2001))))
        assertEquals("客人需要加水", speechCandidate(listOf(" ", " 客人需要加水 ")))
    }
}
