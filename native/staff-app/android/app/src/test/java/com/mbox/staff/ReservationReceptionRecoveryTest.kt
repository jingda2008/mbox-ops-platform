package com.mbox.staff

import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

internal class MemoryReceptionSecrets : ReservationReceptionSecretStore {
    val values = mutableMapOf<String, String>()
    var failWrite = false
    var failRead = false
    var failRemove = false
    override fun store(kind: String, key: String, value: String) {
        if (failWrite) throw IOException("secure disk unavailable")
        val slot = "$kind:$key"
        require(values[slot] == null || values[slot] == value)
        values[slot] = value
    }
    override fun read(kind: String, key: String): String {
        if (failRead) throw IOException("device locked")
        return values["$kind:$key"] ?: error("missing original secure request")
    }
    override fun remove(kind: String, key: String) {
        if (failRemove) throw IOException("secure deletion failed")
        values.remove("$kind:$key")
    }
}

class ReservationReceptionRecoveryTest {
    private val f = ReceptionFixtures

    private fun perform(step: LiveStep, secrets: ReservationReceptionSecretStore, api: StaffAPI, readOnly: Boolean = false) =
        performReservationReceptionStep(step, secrets,
            read = { path -> api.raw(path).text },
            send = { original -> api.raw(original.path, JSONObject(original.body), mapOf(original.keyHeader to original.key)).text },
            readOnly = readOnly)

    @Test fun pendingJournalOmitsPrivateNameContactAndNoteButSecureSlotKeepsExactOriginalBytes() {
        val original = f.draft().copy(note = "仅供接待核对的私人备注").command(f.actor, f.options(), f.now)
        val secrets = MemoryReceptionSecrets()
        val secure = secureReservationReceptionCommand(original, secrets)
        val disk = secure.json().toString()
        for (privateValue in listOf(f.name, f.contact, "仅供接待核对的私人备注")) assertFalse(disk.contains(privateValue))
        assertEquals("{}", secure.steps.single().body)
        assertEquals(original.id, secure.id)
        assertEquals(original.employeeID, secure.employeeID)
        assertEquals(original.steps.single().key, secure.steps.single().key)
        val reopened = LiveCommand.parse(JSONObject(disk))
        assertEquals(original.steps.single().body, restoreReservationReceptionStep(reopened.steps.single(), secrets).body)
        assertEquals(1, secrets.values.size)
        assertTrue(JSONObject(secrets.values.values.single()).getString("body").contains(f.contact))
    }

    @Test fun unreadableOrReboundSecurePayloadCannotSendAnyRequest() {
        for (field in listOf("employeeId", "commandId", "path", "keyHeader", "key")) {
            val secrets = MemoryReceptionSecrets()
            val secure = secureReservationReceptionCommand(f.create(), secrets)
            val slot = secrets.values.keys.single()
            secrets.values[slot] = JSONObject(secrets.values.getValue(slot)).put(field, "wrong-original").toString()
            var calls = 0
            val api = StaffAPI { calls++; error("must not send rebound payload") }
            assertThrows(Exception::class.java) { perform(secure.steps.single(), secrets, api, readOnly = true) }
            assertEquals(0, calls)
        }
        val secrets = MemoryReceptionSecrets()
        val secure = secureReservationReceptionCommand(f.create(), secrets)
        secrets.failRead = true
        assertThrows(Exception::class.java) { restoreReservationReceptionStep(secure.steps.single(), secrets) }
        assertEquals(1, secrets.values.size)
        secrets.failRead = false
        secrets.failWrite = true
        assertThrows(Exception::class.java) { secureReservationReceptionCommand(f.create(), secrets) }
        assertEquals(1, secrets.values.size)
    }

    @Test fun malformedDecryptedBodyOrProofAndRouteMismatchFailBeforeAnyNetworkCall() {
        for (mutation in listOf("unknown-table-field", "wrong-public-id", "invalid-guest-count", "invalid-time", "wrong-route", "wrong-proof")) {
            val original = f.create(); val secrets = MemoryReceptionSecrets()
            val secure = secureReservationReceptionCommand(original, secrets)
            var step = secure.steps.single()
            val slot = secrets.values.keys.single()
            val record = JSONObject(secrets.values.getValue(slot))
            val body = JSONObject(record.getString("body"))
            when (mutation) {
                "unknown-table-field" -> body.put("tableIds", JSONArray(listOf(f.firstTable)))
                "wrong-public-id" -> body.put("publicId", "reception-not-the-original")
                "invalid-guest-count" -> body.put("guestCount", "6")
                "invalid-time" -> body.put("expectedEndAt", "not-a-date")
                "wrong-route" -> {
                    step = step.copy(path = "/api/staff/reservation-receptions/${f.reservationId}/seat")
                    record.put("path", step.path)
                }
                "wrong-proof" -> {
                    val proof = step.receptionProof!!.put("publicId", "reception-wrong-proof")
                    step = step.copy(recoveryBody = JSONObject().put("reception", proof).toString())
                }
            }
            record.put("body", body.toString()); secrets.values[slot] = record.toString()
            var calls = 0
            val api = StaffAPI { calls++; error("must reject $mutation before transport") }
            assertThrows("mutation=$mutation", Exception::class.java) { perform(step, secrets, api) }
            assertEquals("mutation=$mutation", 0, calls)
            assertEquals(1, secrets.values.size)
        }
        val original = f.seat(); val secrets = MemoryReceptionSecrets()
        val secure = secureReservationReceptionCommand(original, secrets)
        val slot = secrets.values.keys.single()
        val record = JSONObject(secrets.values.getValue(slot))
        val body = JSONObject(record.getString("body"))
        body.getJSONArray("sessions").getJSONObject(1).put("expectedGuestCount", 99)
        record.put("body", body.toString()); secrets.values[slot] = record.toString()
        var calls = 0
        assertThrows(Exception::class.java) { perform(secure.steps.single(), secrets, StaffAPI { calls++; error("different tuple must not send") }) }
        assertEquals(0, calls)
    }

    @Test fun lostCreateAcknowledgementRestartsByOriginalReceiptGetWithoutAnotherPost() = runBlocking {
        val original = f.create(); val secrets = MemoryReceptionSecrets()
        var disk = secureReservationReceptionCommand(original, secrets).json().toString()
        val requests = mutableListOf<APIRequest>(); var mutations = 0
        val api = StaffAPI { request ->
            requests += request
            if (request.body != null) { mutations++; throw IOException("committed; response lost") }
            APIResponse(200, f.receipt(original, replayed = true).toString())
        }
        try {
            LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { perform(it, secrets, api) }, { disk = it.json().toString() })
            fail("Expected lost response")
        } catch (_: IOException) { }
        assertEquals(0, LiveCommand.parse(JSONObject(disk)).completedSteps)
        LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { perform(it, secrets, api, readOnly = true) }, { disk = it.json().toString() })
        assertEquals(1, mutations)
        assertEquals(1, LiveCommand.parse(JSONObject(disk)).completedSteps)
        assertEquals(reservationReceptionCreateRecoveryPath(original.steps.single()), requests.last().path)
        assertNull(requests.last().body)
        assertEquals(original.steps.single().body, requests.first().body.toString())
        LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { error("confirmed request must not resend") }, {})
        assertEquals(2, requests.size)
    }

    @Test fun missingReceiptRemainsPendingAndExplicitRetryKeepsOriginalIdKeyDatesAndBody() = runBlocking {
        val original = f.create(); val secrets = MemoryReceptionSecrets()
        var disk = secureReservationReceptionCommand(original, secrets).json().toString()
        val before = disk; val savedSecrets = secrets.values.toMap(); val requests = mutableListOf<APIRequest>()
        val api = StaffAPI { request ->
            requests += request
            if (request.body == null) APIResponse(404, "{\"error\":{\"code\":\"RESERVATION_RECEIPT_NOT_FOUND\",\"message\":\"not found\"}}")
            else APIResponse(200, f.receipt(original, replayed = true).toString())
        }
        try {
            LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { perform(it, secrets, api, readOnly = true) }, { disk = it.json().toString() })
            fail("404 must not confirm or replace the original pending")
        } catch (failure: StaffAPIError) { assertEquals(404, failure.status) }
        assertEquals(before, disk); assertEquals(savedSecrets, secrets.values)
        LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { perform(it, secrets, api) }, { disk = it.json().toString() })
        val retry = requests.last()
        assertEquals(original.steps.single().key, retry.headers["idempotency-key"])
        assertEquals(original.steps.single().body, retry.body.toString())
        assertEquals(1, LiveCommand.parse(JSONObject(disk)).completedSteps)
        assertEquals(1, requests.count { it.body != null })
    }

    @Test fun multiTableSeatRecoveryUsesImmutableOriginalTupleAfterTablesMoveOrClose() = runBlocking {
        val original = f.seat(); val secrets = MemoryReceptionSecrets()
        var disk = secureReservationReceptionCommand(original, secrets).json().toString()
        val requests = mutableListOf<APIRequest>(); var attempts = 0
        val api = StaffAPI { request ->
            requests += request
            assertEquals(original.steps.single().path, request.path)
            // The committed receipt is valid even though current table positions/status changed.
            if (++attempts == 1) throw IOException("seat committed; acknowledgement lost")
            APIResponse(200, f.receipt(original, replayed = true).toString())
        }
        try {
            LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { perform(it, secrets, api) }, { disk = it.json().toString() })
            fail("Expected lost receipt")
        } catch (_: IOException) { }
        LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { perform(it, secrets, api) }, { disk = it.json().toString() })
        assertEquals(1, LiveCommand.parse(JSONObject(disk)).completedSteps)
        requests.forEach {
            assertEquals(original.steps.single().key, it.headers["idempotency-key"])
            assertEquals(original.steps.single().body, it.body.toString())
            assertEquals(2, it.body!!.getJSONArray("sessions").length())
        }
        assertFalse(requests.any { it.path.endsWith("table-sessions") })
    }

    @Test fun malformedReceiptOrFailedCheckpointNeverDiscardsOriginalSecureRequest() = runBlocking {
        val original = f.create(); val secrets = MemoryReceptionSecrets()
        val disk = secureReservationReceptionCommand(original, secrets).json().toString()
        val before = secrets.values.toMap()
        val bad = f.receipt(original).apply { getJSONObject("data").put("requestKey", "different-key") }
        val api = StaffAPI { APIResponse(200, bad.toString()) }
        var checkpoints = 0
        try {
            LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { perform(it, secrets, api) }, { checkpoints++ })
            fail("Wrong request key must not checkpoint")
        } catch (_: IllegalArgumentException) { }
        assertEquals(0, checkpoints); assertEquals(before, secrets.values)
        val good = StaffAPI { APIResponse(200, f.receipt(original, replayed = true).toString()) }
        try {
            LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { perform(it, secrets, good, readOnly = true) }, { throw IOException("checkpoint disk full") })
            fail("Expected disk failure")
        } catch (_: IOException) { }
        assertEquals(before, secrets.values)
        assertEquals(0, LiveCommand.parse(JSONObject(disk)).completedSteps)
    }

    @Test fun legacyTableBoundPendingKeepsOldBodyAndProtocolWhileMovingSecretsOutOfJournal() {
        val old = ReservationDraft(name = f.name, contact = f.contact, arrival = f.arrival, end = f.end,
            tables = setOf(f.firstTable)).command(f.actor, listOf(ReservationTable(f.firstTable, "A01", "大厅", 4)), f.now)
        val secrets = MemoryReceptionSecrets()
        val secure = secureReservationReceptionCommand(old, secrets)
        assertFalse(secure.json().toString().contains(f.contact)); assertFalse(secure.json().toString().contains(f.name))
        assertEquals(old.steps.single().path, secure.steps.single().path)
        val restored = restoreReservationReceptionStep(secure.steps.single(), secrets)
        assertEquals(old.steps.single().body, restored.body)
        assertEquals(old.steps.single().key, restored.key)
        val row = JSONObject(old.steps.single().body).put("id", f.reservationId).put("status", "confirmed")
            .put("tableLocks", JSONArray().put(JSONObject().put("tableId", f.firstTable)))
        val reply = JSONObject().put("data", row).put("meta", JSONObject().put("replayed", true))
        val api = StaffAPI { request ->
            assertEquals("/api/staff/native-reservations", request.path)
            assertTrue(request.body!!.has("tableIds"))
            APIResponse(200, reply.toString())
        }
        perform(secure.steps.single(), secrets, api)
    }

    @Test fun damagedLegacyRoutePublicIdOrTableListFailsBeforeMigrationOrNetwork() {
        val original = ReservationDraft(name = f.name, contact = f.contact, arrival = f.arrival, end = f.end,
            tables = setOf(f.firstTable)).command(f.actor, listOf(ReservationTable(f.firstTable, "A01", "大厅", 4)), f.now)
        for (mutation in listOf("route", "public-id", "empty-tables", "duplicate-tables", "blank-table", "non-string-table")) {
            val originalStep = original.steps.single()
            val body = JSONObject(originalStep.body)
            when (mutation) {
                "public-id" -> body.put("publicId", "NRES-another-original")
                "empty-tables" -> body.put("tableIds", JSONArray())
                "duplicate-tables" -> body.put("tableIds", JSONArray(listOf(f.firstTable, f.firstTable)))
                "blank-table" -> body.put("tableIds", JSONArray(listOf("")))
                "non-string-table" -> body.put("tableIds", JSONArray(listOf(42)))
            }
            val badStep = originalStep.copy(body = body.toString(),
                path = if (mutation == "route") "/api/payments/manual" else originalStep.path)
            val migrationSecrets = MemoryReceptionSecrets()
            assertThrows("migration=$mutation", Exception::class.java) {
                secureReservationReceptionCommand(original.copy(steps = listOf(badStep)), migrationSecrets)
            }
            assertTrue("Invalid legacy intent must not become an accepted secure record", migrationSecrets.values.isEmpty())

            val secrets = MemoryReceptionSecrets()
            val secured = secureReservationReceptionCommand(original, secrets)
            val slot = secrets.values.keys.single()
            val record = JSONObject(secrets.values.getValue(slot)).put("path", badStep.path).put("body", badStep.body)
            secrets.values[slot] = record.toString()
            val corrupted = secured.copy(steps = listOf(secured.steps.single().copy(path = badStep.path)))
            val disk = corrupted.json().toString()
            var requests = 0; var checkpoints = 0
            val api = StaffAPI { requests++; error("Invalid legacy request must not reach transport") }
            assertThrows("recovery=$mutation", Exception::class.java) {
                runBlocking { LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)),
                    { perform(it, secrets, api) }, { checkpoints++ }) }
            }
            assertEquals("mutation=$mutation", 0, requests)
            assertEquals(0, checkpoints)
            assertEquals(0, LiveCommand.parse(JSONObject(disk)).completedSteps)
            assertEquals(record.toString(), secrets.values.getValue(slot))
        }
    }

    @Test fun completedCheckpointNeedsNoSecretOrRequestWhenJournalCleanupMustRetry() = runBlocking {
        val original = f.create(); val secrets = MemoryReceptionSecrets()
        val secure = secureReservationReceptionCommand(original, secrets)
        var disk = secure.json().toString()
        val api = StaffAPI { APIResponse(200, f.receipt(original, replayed = true).toString()) }
        LiveCommandRunner.advance(LiveCommand.parse(JSONObject(disk)), { perform(it, secrets, api, readOnly = true) }, { disk = it.json().toString() })
        val confirmed = LiveCommand.parse(JSONObject(disk))
        removeReservationReceptionPayload(confirmed.steps.single(), secrets)
        assertTrue(secrets.values.isEmpty())
        secrets.failRead = true
        val reopened = LiveCommand.parse(JSONObject(disk))
        LiveCommandRunner.advance(reopened, { error("Completed step must neither decrypt nor resend") }, { error("Must not repeat checkpoint") })
        assertEquals(1, reopened.completedSteps)
        assertEquals(original.steps.single().key, reopened.steps.single().key)
    }

    @Test fun onlyExplicitRollbackDispositionCanReleaseAnUnconfirmedReceptionIntent() {
        for (code in listOf("RESERVATION_RECEPTION_CREATE_DISABLED", "RESERVATION_POLICY_CHANGED", "RESERVATION_CAPACITY_UNAVAILABLE", "RESERVATION_RECEPTION_CHANGED", "RESERVATION_RECEPTION_REQUIRED")) {
            assertTrue(reservationReceptionDefinitivelyRejected(StaffAPIError(409, code, "changed", "not_committed")))
            assertFalse(reservationReceptionDefinitivelyRejected(StaffAPIError(409, code, "unknown")))
        }
        assertTrue(reservationReceptionDefinitivelyRejected(StaffAPIError(503, "RESERVATION_RECEPTION_UNAVAILABLE", "rolled back", "not_committed")))
        for (failure in listOf(StaffAPIError(404, "RESERVATION_RECEIPT_NOT_FOUND", "unknown"),
            StaffAPIError(409, "IDEMPOTENCY_IN_PROGRESS", "unknown"), StaffAPIError(409, "IDEMPOTENCY_CONFLICT", "unknown"),
            StaffAPIError(503, "RESERVATION_RECEPTION_UNAVAILABLE", "unknown"), IOException("offline"))) {
            assertFalse(reservationReceptionDefinitivelyRejected(failure))
        }
    }
}
