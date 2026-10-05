package com.mbox.staff

import android.app.Application
import android.content.ContextWrapper
import android.util.AtomicFile
import android.util.Base64
import java.io.File
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class NotificationStateStoreTest {
    private lateinit var app: Application
    private lateinit var store: KeystoreNotificationStateStore
    private lateinit var record: File
    private val key = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")

    @Before fun prepare() {
        app = RuntimeEnvironment.getApplication()
        for (purpose in NotificationStorePurpose.entries) {
            val target = File(app.noBackupFilesDir, purpose.fileName)
            listOf(target, File(target.path + ".bak"), File(target.path + ".new")).forEach { it.delete() }
        }
        record = File(app.noBackupFilesDir, NotificationStorePurpose.OPEN.fileName)
        store = KeystoreNotificationStateStore(app) { key }
    }

    @Test fun missingStateIsEmptyWithoutAccessingKeystore() {
        assertNull(KeystoreNotificationStateStore(app) { error("空存储不应请求密钥") }.read())
        assertFalse(record.exists())
    }

    @Test fun encryptedStateRoundTripsAndReplacesWithFreshCiphertext() {
        val first = "{\"token\":\"private-token\",\"ref\":\"原通知😀\"}"
        store.write(first)
        val bytes = record.readBytes()
        assertEquals(app.noBackupFilesDir, record.parentFile)
        assertFalse(record.readText().contains("private-token"))
        assertEquals(first, KeystoreNotificationStateStore(app) { key }.read())
        store.write(first)
        assertFalse(bytes.contentEquals(record.readBytes()))
        store.write("replacement")
        assertEquals("replacement", store.read())
        store.write("")
        assertEquals("", store.read())
    }

    @Test fun interruptedAtomicReplacementRecoversPreviousCompleteState() {
        store.write("saved-original-request")
        val atomic = AtomicFile(record)
        atomic.startWrite().use { it.write("unfinished-write".toByteArray()) }
        assertEquals("saved-original-request", store.read())
        store.write("confirmed-next-state")
        assertEquals("confirmed-next-state", store.read())
    }

    @Test fun explicitRemovalDeletesStateAndAtomicCompanions() {
        store.write("state")
        store.remove()
        assertNull(store.read())
        assertTrue(listOf(record, File(record.path + ".bak"), File(record.path + ".new")).none { it.exists() })
        store.remove()
    }

    @Test fun openAndRegistrationHaveIndependentFilesAndAuthenticatedPurposes() {
        val registration = KeystoreNotificationStateStore(app, NotificationStorePurpose.REGISTRATION) { key }
        val registrationFile = File(app.noBackupFilesDir, NotificationStorePurpose.REGISTRATION.fileName)
        registration.write("registration-token-and-revocation")
        store.write("original-notification-open-reference")
        assertEquals("registration-token-and-revocation", registration.read())
        assertEquals("original-notification-open-reference", store.read())
        val savedRegistration = registrationFile.readBytes()
        registrationFile.writeBytes(record.readBytes())
        assertThrows(IllegalStateException::class.java) { registration.read() }
        registrationFile.writeBytes(savedRegistration)
        store.remove()
        assertNull(store.read())
        assertEquals("registration-token-and-revocation", registration.read())
    }

    @Test fun wrongOrUnavailableKeyNeverEmptiesOrOverwritesOriginalState() {
        store.write("original-token-and-open-reference")
        val original = record.readBytes()
        val wrong = KeystoreNotificationStateStore(app) { SecretKeySpec(ByteArray(32) { 99.toByte() }, "AES") }
        val unavailable = KeystoreNotificationStateStore(app) { error("device temporarily locked") }
        for (candidate in listOf(wrong, unavailable)) {
            assertThrows(IllegalStateException::class.java) { candidate.read() }
            assertThrows(IllegalStateException::class.java) { candidate.write("must-not-replace") }
            assertArrayEquals(original, record.readBytes())
        }
        assertEquals("original-token-and-open-reference", store.read())
    }

    @Test fun tamperingAndDifferentApplicationNamespaceAreRejected() {
        store.write("bound-to-notifications-and-this-package")
        val differentPackage = object : ContextWrapper(app) { override fun getPackageName() = "different.application" }
        assertThrows(IllegalStateException::class.java) { KeystoreNotificationStateStore(differentPackage) { key }.read() }
        val envelope = JSONObject(record.readText())
        val ciphertext = Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP)
        ciphertext[0] = (ciphertext[0].toInt() xor 1).toByte()
        record.writeText(envelope.put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP)).toString())
        val damaged = record.readBytes()
        assertThrows(IllegalStateException::class.java) { store.read() }
        assertThrows(IllegalStateException::class.java) { store.write("must-not-replace") }
        assertArrayEquals(damaged, record.readBytes())
    }

    @Test fun limitCountsUtf8BytesAndRejectsOversizeBeforeModifyingTheFile() {
        val maximum = "a".repeat(KeystoreNotificationStateStore.MAX_STATE_BYTES)
        store.write(maximum)
        assertEquals(maximum, store.read())
        val original = record.readBytes()
        for (oversize in listOf(maximum + "a", "中".repeat(21846))) {
            assertThrows(IllegalArgumentException::class.java) { store.write(oversize) }
            assertArrayEquals(original, record.readBytes())
        }
        assertThrows(IllegalArgumentException::class.java) { store.write("\uD800") }
        assertArrayEquals(original, record.readBytes())
    }

    @Test fun malformedOversizedAndUnfinishedOnlyRecordsAreNotTreatedAsEmpty() {
        for (corrupt in listOf("broken-json", "x".repeat(300_000))) {
            record.writeText(corrupt)
            assertThrows(IllegalStateException::class.java) { store.read() }
            assertThrows(IllegalStateException::class.java) { store.write("must-not-replace") }
            assertEquals(corrupt, record.readText())
        }
        record.delete()
        val unfinished = File(record.path + ".new").apply { writeText("unfinished-only-record") }
        assertThrows(IllegalStateException::class.java) { store.read() }
        assertEquals("unfinished-only-record", unfinished.readText())
        store.remove()
        assertNull(store.read())
    }
}
