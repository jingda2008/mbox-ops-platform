package com.mbox.staff

import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LiveContractTest {
    private fun fixture() =
        JSONObject(
            javaClass.classLoader!!
                .getResourceAsStream("live-contract.json")!!
                .bufferedReader()
                .use { it.readText() }
        )

    @Test
    fun malformedSuccessIsNotAcknowledgement() {
        val f = fixture()
        val command =
            LiveCommand.make(
                "open",
                LiveOperations.parse(f.getJSONObject("operations")).tables[1],
                StaffIdentity.parse(f.getJSONObject("auth")),
                people = 2,
            )
        var response = APIResponse(200, "<html>proxy login</html>")
        val api = StaffAPI { response }
        assertThrows(StaffAPIError::class.java) { api.execute(command.steps[0]) }
        response = APIResponse(200, """{"data":{"id":"receipt"},"meta":{"replayed":true}}""")
        api.execute(command.steps[0])
    }

    @Test
    fun authenticationLifecycle() {
        val auth = fixture().getJSONObject("auth")
        var response = APIResponse(200, JSONObject().put("data", auth).toString())
        val requests = mutableListOf<APIRequest>()
        val api = StaffAPI {
            requests.add(it)
            response
        }
        assertThrows(StaffAPIError::class.java) { api.login("staff", "12", false) }
        assertEquals(0, requests.size)
        response =
            APIResponse(
                200,
                """{"data":{"businessDate":"2026-09-26","expiresAt":"2099-01-01T00:00:00Z"}}""",
            )
        api.grant("fixture-only", "android-fixture")
        assertEquals("/api/auth/device-access", requests.last().path)
        response = APIResponse(200, JSONObject().put("data", auth).toString())
        val employee = api.login(" staff ", "1234", false)
        assertFalse(employee.allows("payment.refund"))
        api.heartbeat()
        assertEquals("session-1", requests.last().headers["x-mbox-staff-session-id"])
        assertEquals("employee-1", requests.last().headers["x-mbox-staff-employee-id"])
        response =
            APIResponse(403, """{"error":{"code":"CAPABILITY_FORBIDDEN","message":"无权操作"}}""")
        assertThrows(StaffAPIError::class.java) { api.raw("/api/operations") }
        assertNotNull(api.identity)
        response = response.copy(status = 401)
        assertThrows(StaffAPIError::class.java) { api.raw("/api/operations") }
        assertNull(api.identity)
        response = APIResponse(200, JSONObject().put("data", auth).toString())
        api.login("staff", "1234", false)
        val altered = JSONObject(auth.toString())
        altered.getJSONObject("session").put("id", "other-session")
        response = APIResponse(200, JSONObject().put("data", altered).toString())
        assertThrows(StaffAPIError::class.java) { api.heartbeat() }
        assertNull(api.identity)
        response = APIResponse(200, JSONObject().put("data", auth).toString())
        api.login("staff", "1234", false)
        response = APIResponse(204, "")
        api.logout()
        assertNull(api.identity)
        val count = requests.size
        assertThrows(StaffAPIError::class.java) { api.raw("https://untrusted.invalid/api/login") }
        assertEquals(count, requests.size)
    }

    @Test
    fun actualOperationsContractAndRefundUnknown() {
        val data = fixture().getJSONObject("operations")
        val ops = LiveOperations.parse(data)
        assertEquals(0, ops.tables[0].display.due)
        assertTrue(ops.tables[0].display.service)
        data
            .getJSONArray("tables")
            .getJSONObject(0)
            .getJSONObject("activeSession")
            .put("financialState", "partially_refunded")
            .put("netCollectedAmountMinor", 8000)
        assertNull(LiveOperations.parse(data).tables[0].display.due)
    }

    @Test
    fun mutationContractsAndGuards() {
        val f = fixture()
        val actor = StaffIdentity.parse(f.getJSONObject("auth"))
        val ops = LiveOperations.parse(f.getJSONObject("operations"))
        val open = LiveCommand.make("open", ops.tables[1], actor, people = 2)
        assertEquals("x-idempotency-key", open.steps[0].keyHeader)
        assertEquals(2, JSONObject(open.steps[0].body).getInt("guestCount"))
        assertThrows(IllegalArgumentException::class.java) {
            LiveCommand.make("open", ops.tables[2], actor, people = 2)
        }
        val transfer = LiveCommand.make("transfer", ops.tables[0], actor, target = ops.tables[1])
        assertEquals(7, JSONObject(transfer.steps[0].body).getInt("expectedLocationVersion"))
        assertThrows(IllegalArgumentException::class.java) {
            LiveCommand.make("freeze", ops.tables[0], actor, frozen = true)
        }
        assertFalse(StaffAPIError(409, "TABLE_OPERATION_CONFLICT", "").definitivelyRejected)
        assertFalse(StaffAPIError(409, "IDEMPOTENCY_IN_PROGRESS", "").definitivelyRejected)
    }

    @Test
    fun closeResumesAfterLostResponseWithoutDuplicateEffects() = runBlocking {
        val f = fixture()
        val actor = StaffIdentity.parse(f.getJSONObject("auth"))
        val ops = LiveOperations.parse(f.getJSONObject("operations"))
        var disk = LiveCommand.make("close", ops.tables[0], actor)
        assertEquals(2, disk.steps.size)
        assertTrue(disk.steps[0].path.endsWith("begin-closing"))
        val applied = mutableSetOf<String>()
        val calls = mutableListOf<String>()
        var lose = true
        val send: suspend (LiveStep) -> Unit = { step ->
            calls.add(step.key)
            applied.add(step.key)
            if (step.path.endsWith("/close") && lose) {
                lose = false
                throw IOException("lost response")
            }
        }
        try {
            LiveCommandRunner.advance(disk, send) { disk = it }
            fail("must interrupt")
        } catch (_: IOException) {}
        assertEquals(1, disk.completedSteps)
        disk = LiveCommand.parse(JSONObject(disk.json().toString()))
        LiveCommandRunner.advance(disk, send) { disk = it }
        assertEquals(3, calls.size)
        assertEquals(calls[1], calls[2])
        assertEquals(2, applied.size)
        LiveCommandRunner.advance(disk, send) { disk = it }
        assertEquals(3, calls.size)
    }

    @Test
    fun failedCheckpointKeepsOriginalRequestKey() = runBlocking {
        val f = fixture()
        val command =
            LiveCommand.make(
                "open",
                LiveOperations.parse(f.getJSONObject("operations")).tables[1],
                StaffIdentity.parse(f.getJSONObject("auth")),
                people = 2,
            )
        val calls = mutableListOf<String>()
        try {
            LiveCommandRunner.advance(command, { calls.add(it.key) }) {
                throw IOException("disk full")
            }
            fail("must fail")
        } catch (_: IOException) {}
        LiveCommandRunner.advance(command, { calls.add(it.key) }) {}
        assertEquals(2, calls.size)
        assertEquals(calls[0], calls[1])
    }
}
