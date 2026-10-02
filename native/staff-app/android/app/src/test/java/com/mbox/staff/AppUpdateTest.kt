package com.mbox.staff

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AppUpdateTest {
    private fun root() =
        JSONObject(
            javaClass.classLoader!!
                .getResourceAsStream("app-update.json")!!
                .bufferedReader()
                .readText()
        )

    private val id = "com.mbox.staff.nativeapp"

    @Test
    fun manifestUsesExactApplicationAndChannel() {
        val raw = root()
        val r = AppRelease.parseManifest(raw.toString(), id)!!
        assertEquals(3L, r.build)
        assertEquals(4096L, r.bytes)
        assertThrows(IllegalArgumentException::class.java) {
            AppRelease.parseManifest(raw.toString(), "other")
        }
        raw.put("channel", "production")
        assertThrows(IllegalArgumentException::class.java) {
            AppRelease.parseManifest(raw.toString(), id)
        }
        raw.put("channel", "preview").put("releases", JSONArray())
        assertNull(AppRelease.parseManifest(raw.toString(), id))
    }

    @Test
    fun updateURLAndPackageMetadataAreBounded() {
        listOf(
                "http://mbox.shmbox.com/native-updates/staff/app.apk",
                "https://mbox.shmbox.com.evil.example/native-updates/staff/app.apk",
                "https://user@mbox.shmbox.com/native-updates/staff/app.apk",
                "https://mbox.shmbox.com/native-updates/staff/../app.apk",
                "https://mbox.shmbox.com/native-updates/staff/%2e%2e/app.apk",
                "https://mbox.shmbox.com/native-updates/staff/app.apk?url=bad",
            )
            .forEach { assertFalse(it, AppRelease.trustedURL(it)) }
        val raw = root()
        val r = raw.getJSONArray("releases").getJSONObject(1)
        r.put("bytes", AppRelease.maxBytes + 1)
        assertThrows(IllegalArgumentException::class.java) {
            AppRelease.parseManifest(raw.toString(), id)
        }
        r.put("bytes", 4096).put("sha256", "bad")
        assertThrows(IllegalArgumentException::class.java) {
            AppRelease.parseManifest(raw.toString(), id)
        }
    }

    @Test
    fun apkRequiresSameSignerExactBuildAndNoDowngrade() {
        val r = AppRelease.parseManifest(root().toString(), id)!!
        AppRelease.verifyArchive(r, 2, id, 3, setOf("trusted"), setOf("trusted"))
        assertThrows(IllegalArgumentException::class.java) {
            AppRelease.verifyArchive(r, 3, id, 3, setOf("trusted"), setOf("trusted"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AppRelease.verifyArchive(r, 2, "foreign", 3, setOf("trusted"), setOf("trusted"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AppRelease.verifyArchive(r, 2, id, 4, setOf("trusted"), setOf("trusted"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AppRelease.verifyArchive(r, 2, id, 3, setOf("trusted"), setOf("attacker"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AppRelease.verifyArchive(r, 2, id, 3, emptySet(), emptySet())
        }
    }

    @Test
    fun incompleteAndTamperedPayloadNeverReachesInstaller() {
        val r = AppRelease.parseManifest(root().toString(), id)!!
        r.verifyPayload(4096, r.sha256)
        assertThrows(IllegalArgumentException::class.java) { r.verifyPayload(4095, r.sha256) }
        assertThrows(IllegalArgumentException::class.java) { r.verifyPayload(4097, r.sha256) }
        assertThrows(IllegalArgumentException::class.java) { r.verifyPayload(4096, "b".repeat(64)) }
    }

    @Test
    fun stableAndPreviewChannelsDoNotMix() {
        val raw = root().put("channel", "stable")
        assertThrows(IllegalArgumentException::class.java) {
            AppRelease.parseManifest(raw.toString(), id)
        }
        assertNotNull(AppRelease.parseManifest(raw.toString(), id, "stable"))
        assertEquals(
            "https://mbox.shmbox.com/native-updates/staff/stable.json",
            AppRelease.endpoint("stable"),
        )
        assertThrows(IllegalArgumentException::class.java) { AppRelease.endpoint("../foreign") }
    }
}
