package com.mbox.staff

import java.time.Instant

// Foreground reminders are separate from business completion and remote push delivery.
data class ServiceAttention(
    val actor: String? = null,
    val entries: List<Entry> = emptyList(),
    val unread: Set<String> = emptySet(),
    private val observed: Set<String> = emptySet(),
    val updated: Instant? = null,
) {
    data class Entry(val id: String, val session: String, val table: String, val priority: String) {
        val key
            get() = "$id:$session:$priority"
    }

    val firstUnread
        get() = entries.firstOrNull { it.key in unread }

    fun refresh(
        actor: String?,
        permitted: Boolean,
        entries: List<Entry>,
        at: Instant,
    ): ServiceAttention {
        if (actor == null || !permitted) return ServiceAttention()
        val previous = if (this.actor == actor) this else ServiceAttention()
        val rank = mapOf("urgent" to 0, "high" to 1, "normal" to 2, "low" to 3)
        val rows =
            entries
                .filter { it.id.isNotBlank() && it.session.isNotBlank() }
                .distinctBy { it.id }
                .sortedWith(compareBy({ rank[it.priority] ?: 4 }, { it.table }, { it.id }))
        val active = rows.map { it.key }.toSet()
        return ServiceAttention(
            actor,
            rows,
            previous.unread.intersect(active) + (active - previous.observed),
            active,
            at,
        )
    }

    fun viewed(entry: Entry) = copy(unread = unread - entry.key)

    fun isFresh(at: Instant) =
        updated?.let { !at.isBefore(it) && at.isBefore(it.plusSeconds(90)) } == true
}
