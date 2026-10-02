package com.mbox.staff

import java.io.IOException
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SessionTest {
    class MemoryStore : StaffSessionStore {
        var text: String? = null
        var fail = false

        override fun read() = text

        override fun write(value: String) {
            if (fail) throw IOException("vault unavailable")
            text = value
        }

        override fun remove() {
            text = null
        }
    }

    private fun auth() =
        JSONObject(
                javaClass.classLoader!!
                    .getResourceAsStream("live-contract.json")!!
                    .bufferedReader()
                    .use { it.readText() }
            )
            .getJSONObject("auth")

    private fun reply(auth: JSONObject, cookie: Boolean = true) =
        APIResponse(
            200,
            JSONObject().put("data", auth).toString(),
            if (cookie)
                mapOf(
                    "Set-Cookie" to
                        listOf(
                            "__Host-mbox_staff_session=test-session-token; Path=/; Secure; HttpOnly; Max-Age=3600"
                        )
                )
            else emptyMap(),
        )

    @Test fun supervisorSessionCopiesOnlyDeviceLeaseAndNeverChangesOrPersistsOriginalIdentity() {
        val store=MemoryStore();val requests=mutableListOf<APIRequest>();var response=APIResponse(200,JSONObject().put("data",JSONObject().put("expiresAt","2099-01-01T00:00:00Z")).toString(),mapOf("Set-Cookie" to listOf("__Host-mbox_device_lease=device-token; Path=/; Secure; HttpOnly; Max-Age=3600")))
        val original=StaffAPI(store){requests.add(it);response};original.grant("store-pass","device-test-key");response=reply(auth());original.login("staff","1234",false);original.configureRememberSession(true)
        val saved=store.text;val before=original.identity;val supervisor=original.supervisorClient();assertNull(supervisor.identity);assertFalse(supervisor.rememberSession)
        val superAuth=auth();superAuth.getJSONObject("session").put("id","supervisor-session").put("employeeId","supervisor");superAuth.getJSONObject("employee").put("id","supervisor")
        response=APIResponse(200,JSONObject().put("data",superAuth).toString(),mapOf("Set-Cookie" to listOf("__Host-mbox_staff_session=supervisor-token; Path=/; Secure; HttpOnly; Max-Age=3600")))
        supervisor.login("boss","5678",false)
        val login=requests.last();assertNull(login.headers["x-mbox-staff-employee-id"]);assertTrue(login.headers.filterKeys{it.equals("Cookie",true)}.values.joinToString().contains("device-token"));assertFalse(login.headers.values.joinToString().contains("test-session-token"))
        response=APIResponse(204,"");supervisor.logout();assertTrue(requests.last().headers.values.joinToString().contains("supervisor-token"));assertEquals(before,original.identity);assertEquals(saved,store.text)
        response=reply(auth(),false);original.heartbeat();assertTrue(requests.last().headers.values.joinToString().contains("test-session-token"));assertFalse(requests.last().headers.values.joinToString().contains("supervisor-token"))
        assertThrows(StaffAPIError::class.java){StaffAPI().supervisorClient()}
    }

    @Test fun restartNeverExtendsOriginalCookieExpiry(){
        val store=MemoryStore();var response=reply(auth());val api=StaffAPI(store){response};api.rememberSession=true;api.login("staff","1234",false)
        val expiry=JSONObject(store.text!!).getJSONArray("cookies").getJSONObject(0).getString("expiresAt")
        response=reply(auth(),false);val restored=StaffAPI(store){response};restored.restoreSession();restored.heartbeat()
        assertEquals(expiry,JSONObject(store.text!!).getJSONArray("cookies").getJSONObject(0).getString("expiresAt"))
    }

    @Test
    fun optInAndFreshAuthorization() {
        val store = MemoryStore()
        var response = reply(auth())
        val requests = mutableListOf<APIRequest>()
        val wire: (APIRequest) -> APIResponse = {
            requests.add(it)
            response
        }
        val api = StaffAPI(store, wire)
        api.login("staff", "1234", false)
        assertNull(store.text)
        api.configureRememberSession(true)
        assertNotNull(store.text)
        assertEquals("", api.persistenceNotice)
        assertFalse(store.text!!.contains("1234"))
        assertFalse(store.text!!.contains("pin"))
        assertEquals(1, JSONObject(store.text!!).getJSONArray("cookies").length())
        val restored = StaffAPI(store, wire)
        assertNull(restored.identity)
        response =
            reply(auth().put("permissions", org.json.JSONArray(listOf("dashboard.view"))), false)
        assertFalse(restored.restoreSession()!!.allows("table.open"))
        assertEquals("/api/auth/heartbeat", requests.last().path)
        assertTrue(
            requests.last().headers.entries.any {
                it.key.equals("Cookie", true) && it.value.contains("test-session-token")
            }
        )
        assertEquals("employee-1", requests.last().headers["x-mbox-staff-employee-id"])
        assertEquals("session-1", requests.last().headers["x-mbox-staff-session-id"])
    }

    @Test
    fun timeoutRetainsButRevocationAndIdentityChangeRemove() {
        val store = MemoryStore()
        var response = reply(auth())
        var offline = false
        val wire: (APIRequest) -> APIResponse = {
            if (offline) throw IOException("timeout")
            response
        }
        val api = StaffAPI(store, wire)
        api.rememberSession = true
        api.login("staff", "1234", false)
        val original = store.text!!
        val restored = StaffAPI(store, wire)
        offline = true
        assertThrows(IOException::class.java) { restored.restoreSession() }
        assertEquals(original, store.text)
        offline = false
        response = APIResponse(401, "{}")
        assertThrows(StaffAPIError::class.java) { restored.restoreSession() }
        assertNull(store.text)
        assertNull(restored.identity)
        store.text = original
        val changed = auth()
        changed.getJSONObject("session").put("id", "different-session")
        response = reply(changed, false)
        assertThrows(StaffAPIError::class.java) { restored.restoreSession() }
        assertNull(store.text)
        assertNull(restored.identity)
    }

    @Test
    fun corruptionAndExpiryFailBeforeNetwork() {
        val store = MemoryStore()
        val api = StaffAPI(store) { reply(auth()) }
        api.rememberSession = true
        api.login("staff", "1234", false)
        val original = store.text!!
        var requests = 0
        val restored =
            StaffAPI(store) {
                requests++
                reply(auth())
            }
        store.text = "broken"
        assertThrows(IllegalStateException::class.java) { restored.restoreSession() }
        assertNull(store.text)
        assertEquals(0, requests)
        val expired = JSONObject(original)
        expired.getJSONArray("cookies").getJSONObject(0).put("expiresAt", "2000-01-01T00:00:00Z")
        store.text = expired.toString()
        assertThrows(IllegalStateException::class.java) { restored.restoreSession() }
        assertNull(store.text)
        assertEquals(0, requests)
    }

    @Test
    fun forgetAndVaultFailureAndLogout() {
        val store = MemoryStore()
        var response = reply(auth())
        val api = StaffAPI(store) { response }
        api.rememberSession = true
        api.login("staff", "1234", false)
        api.configureRememberSession(false)
        assertNull(store.text)
        assertNotNull(api.identity)
        store.fail = true
        api.configureRememberSession(true)
        assertNull(store.text)
        assertTrue(api.persistenceNotice.isNotEmpty())
        assertNotNull(api.identity)
        store.fail = false
        api.configureRememberSession(true)
        assertNotNull(store.text)
        response = APIResponse(204, "")
        api.logout()
        assertNull(store.text)
        assertNull(api.identity)
    }
}
