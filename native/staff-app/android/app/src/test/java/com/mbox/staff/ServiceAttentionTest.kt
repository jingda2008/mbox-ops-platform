package com.mbox.staff

import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class ServiceAttentionTest {
    @Test
    fun dedupeAndViewedDoNotCompleteTasks() {
        val now = Instant.ofEpochSecond(1000)
        val a = ServiceAttention.Entry("a", "s1", "A1", "normal")
        val b = ServiceAttention.Entry("b", "s2", "B2", "urgent")
        var state = ServiceAttention().refresh("e1", true, listOf(a, b, a), now)
        assertEquals(2, state.entries.size)
        assertEquals(b, state.firstUnread)
        state = state.viewed(b).refresh("e1", true, listOf(a, b), now)
        assertEquals(setOf(a.key), state.unread)
        assertEquals(2, state.entries.size)
        state = state.refresh("e1", true, listOf(b), now)
        assertTrue(state.unread.isEmpty())
        val escalated = b.copy(priority = "high")
        state = state.refresh("e1", true, listOf(escalated), now)
        assertEquals(escalated, state.firstUnread)
        assertTrue(state.isFresh(now))
        assertFalse(state.isFresh(now.minusSeconds(1)))
        assertFalse(state.isFresh(now.plusSeconds(90)))
        state = state.refresh("e2", true, listOf(a), now)
        assertEquals(listOf(a), state.entries)
        assertEquals(a, state.firstUnread)
        state = state.refresh("e2", false, listOf(a), now)
        assertTrue(state.entries.isEmpty())
        assertNull(state.actor)
    }
}
