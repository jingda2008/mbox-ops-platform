package com.mbox.staff

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/** Notification registration and recovery state only; no employee or payment credentials. */
interface NotificationStateStore {
    fun read(): String?
    fun write(value: String)
    fun remove()
}

enum class NotificationStorePurpose(internal val fileName: String, internal val aadName: String) {
    OPEN("notification-open-v1.enc", "notification-open:v1"),
    REGISTRATION("notification-registration-v1.enc", "notification-registration:v1"),
}

class KeystoreNotificationStateStore(
    context: Context,
    purpose: NotificationStorePurpose = NotificationStorePurpose.OPEN,
    private val keyProvider: (() -> SecretKey)? = null,
) : NotificationStateStore {
    companion object {
        const val MAX_STATE_BYTES = 64 * 1024
        private const val KEY_ALIAS = "mbox-notification-state-v1"
        // Android JSONObject may escape every '/' in Base64 as '\/'. Reserve
        // the worst-case JSON expansion separately from the 64 KiB plaintext cap.
        private const val MAX_ENVELOPE_BYTES = ((MAX_STATE_BYTES + 16 + 2) / 3) * 4 * 2 + 1024
        private val lock = Any()
    }

    private val directory = context.noBackupFilesDir
    private val file = AtomicFile(File(directory, purpose.fileName))
    private val aad = (context.packageName + ":" + purpose.aadName).toByteArray(Charsets.UTF_8)
    private fun recordFiles() = listOf(file.baseFile, File(file.baseFile.path + ".bak"), File(file.baseFile.path + ".new"))

    private fun key(create: Boolean): SecretKey {
        keyProvider?.let { return it() }
        val vault = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (vault.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val anySavedPurpose = NotificationStorePurpose.entries.any { purpose ->
            listOf("", ".bak", ".new").any { suffix -> File(directory, purpose.fileName + suffix).exists() }
        }
        check(create && !anySavedPurpose) { "通知安全密钥暂不可读取" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build())
        }.generateKey()
    }

    override fun read(): String? = synchronized(lock) { readLocked() }

    private fun readLocked(): String? {
        if (recordFiles().none { it.exists() }) return null
        try {
            // openRead recovers an interrupted AtomicFile replacement. In particular,
            // a backup-only record is not an empty notification state.
            val bytes = file.openRead().use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) {
                    val count = input.read(buffer)
                    if (count == -1) break
                    check(output.size() + count <= MAX_ENVELOPE_BYTES) { "通知记录过大" }
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            val envelope = JSONObject(bytes.toString(Charsets.UTF_8))
            check(envelope.getInt("version") == 1)
            val iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)
            val encrypted = Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP)
            check(iv.size == 12 && encrypted.size in 16..MAX_STATE_BYTES + 16)
            val plain = Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(128, iv))
                updateAAD(aad)
                doFinal(encrypted)
            }
            check(plain.size <= MAX_STATE_BYTES)
            return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(plain)).toString()
        } catch (e: Exception) {
            // Never remove or replace a damaged record: it can contain an unresolved
            // registration revocation or notification-open reference.
            throw IllegalStateException("通知安全记录暂不可读取，原记录已保留，请解锁后重试", e)
        }
    }

    override fun write(value: String) = synchronized(lock) {
        require(value.length <= MAX_STATE_BYTES) { "通知状态不能超过64 KiB" }
        val encoded = try {
            val buffer = Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(value))
            ByteArray(buffer.remaining()).also { buffer.get(it) }
        } catch (e: java.nio.charset.CharacterCodingException) {
            throw IllegalArgumentException("通知状态包含无效文本", e)
        }
        require(encoded.size <= MAX_STATE_BYTES) { "通知状态不能超过64 KiB" }
        // A write must not silently destroy unreadable recovery state or replace a
        // temporarily unavailable key with a new one.
        val existing = readLocked() != null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key(create = !existing))
            updateAAD(aad)
        }
        val envelope = JSONObject().put("version", 1)
            .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(cipher.doFinal(encoded), Base64.NO_WRAP))
            .toString().toByteArray(Charsets.UTF_8)
        val output = file.startWrite()
        try {
            output.write(envelope)
            file.finishWrite(output)
        } catch (e: Exception) {
            file.failWrite(output)
            throw e
        }
        check(readLocked() == value) { "通知安全记录写入尚未确认，请重试" }
    }

    override fun remove() = synchronized(lock) {
        file.delete()
        // Android AtomicFile implementations use different companion names across
        // supported OS versions; explicitly cover both without deleting the shared key.
        recordFiles().filter { it.exists() }.forEach { it.delete() }
        check(recordFiles().none { it.exists() }) { "通知安全记录尚未清除，请解锁后重试" }
    }
}
