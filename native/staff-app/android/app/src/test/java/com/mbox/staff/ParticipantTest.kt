package com.mbox.staff

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ParticipantTest {
    private fun fixture() =
        JSONObject(
            javaClass.classLoader!!
                .getResourceAsStream("live-participants.json")!!
                .bufferedReader()
                .readText()
        )

    private fun input(
        q: Int = 1,
        selected: Set<String> = setOf("person-1"),
        target: Int = 1,
    ): ParticipantInput {
        val f = fixture()
        val b = LiveOperations.parse(f.getJSONObject("operations"))
        return ParticipantInput.make(
            StaffIdentity.parse(f.getJSONObject("auth")),
            b.tables[0],
            b.tables[target],
            f.getJSONArray("members").objects().map { LiveParticipant.parse(it) },
            selected,
            q,
            "participant_split",
            "顾客分坐",
            "",
        )
    }

    private fun command(): LiveCommand {
        val f = fixture()
        return ParticipantPreview(f.getJSONObject("preview"))
            .command(input(), StaffIdentity.parse(f.getJSONObject("auth")), true)
    }

    @Test
    fun inputBoundaries() {
        assertThrows(IllegalArgumentException::class.java) { input(2) }
        assertThrows(IllegalArgumentException::class.java) { input(1, emptySet()) }
        assertThrows(IllegalArgumentException::class.java) { input(1, setOf("other")) }
        assertThrows(IllegalArgumentException::class.java) { input(1, setOf("person-1"), 2) }
    }

    @Test
    fun previewBoundaries() {
        for ((key, value) in
            listOf(
                "supportsNativeParticipantRecovery" to false,
                "selectedParticipantCount" to 2,
                "targetTableId" to "wrong",
                "projectedGuestCount" to 2,
                "requiresCapacityOverride" to true,
                "finalRevalidationRequired" to false,
            )) {
            val f = fixture()
            val p = ParticipantPreview(f.getJSONObject("preview").put(key, value))
            assertThrows(IllegalArgumentException::class.java) {
                p.command(input(), StaffIdentity.parse(f.getJSONObject("auth")), true)
            }
        }
    }

    @Test
    fun physicalConfirmation() {
        val f = fixture()
        assertThrows(IllegalArgumentException::class.java) {
            ParticipantPreview(f.getJSONObject("preview"))
                .command(input(), StaffIdentity.parse(f.getJSONObject("auth")), false)
        }
    }

    @Test
    fun stableProof() {
        val s = command().steps[0]
        assertTrue(s.path.endsWith("native-participant-movements"))
        assertEquals("x-idempotency-key", s.keyHeader)
        assertEquals(
            7,
            JSONObject(s.body).getJSONObject("nativeGuard").getInt("sourceLocationVersion"),
        )
        assertNotNull(s.participantProof)
    }

    @Test
    fun receiptMustMatch() {
        val step = command().steps[0]
        validateParticipantReply(fixture().getJSONObject("receipt").toString(), step)
        for ((key, value) in
            listOf(
                "movedParticipantCount" to 2,
                "targetGuestCountAfter" to 2,
                "targetCapacityAtMovement" to 8,
                "occurredAt" to "bad",
                "targetTableSessionId" to "",
            )) {
            val receipt = fixture().getJSONObject("receipt")
            receipt.getJSONObject("data").put(key, value)
            assertThrows(Exception::class.java) {
                validateParticipantReply(receipt.toString(), step)
            }
        }
    }
}
