package com.mbox.staff

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

class KeystoreStaffSessionStore(private val context: Context) : StaffSessionStore {
    companion object { private val fileLock = Any() }
    override fun read(): String? = synchronized(fileLock) { readLocked() }
    override fun write(value: String) = synchronized(fileLock) { writeLocked(value) }
    override fun remove() = synchronized(fileLock) { removeLocked() }
    private val file = AtomicFile(File(context.noBackupFilesDir, "staff-session-v1.enc"))

    private fun key(): SecretKey {
        val vault = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (vault.getKey("mbox-staff-login-v1", null) as? SecretKey)?.let {
            return it
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply {
                init(
                    KeyGenParameterSpec.Builder(
                            "mbox-staff-login-v1",
                            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                        )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setRandomizedEncryptionRequired(true)
                        .build()
                )
            }
            .generateKey()
    }

    private fun readLocked(): String? {
        if (!file.baseFile.exists()) return null
        try {
            val data = JSONObject(file.openRead().bufferedReader().use { it.readText() })
            val cipher =
                Cipher.getInstance("AES/GCM/NoPadding").apply {
                    init(
                        Cipher.DECRYPT_MODE,
                        key(),
                        GCMParameterSpec(128, Base64.decode(data.getString("iv"), Base64.NO_WRAP)),
                    )
                    updateAAD((context.packageName + ":staff-session:v1").toByteArray())
                }
            return cipher
                .doFinal(Base64.decode(data.getString("ciphertext"), Base64.NO_WRAP))
                .toString(Charsets.UTF_8)
        } catch (e: Exception) {
            throw IllegalStateException("安全登录记录暂不可读取，请解锁后重试或重新登录", e)
        }
    }

    private fun writeLocked(value: String) {
        val cipher =
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, key())
                updateAAD((context.packageName + ":staff-session:v1").toByteArray())
            }
        val envelope =
            JSONObject()
                .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .put(
                    "ciphertext",
                    Base64.encodeToString(cipher.doFinal(value.toByteArray()), Base64.NO_WRAP),
                )
                .toString()
                .toByteArray()
        val stream = file.startWrite()
        try {
            stream.write(envelope)
            file.finishWrite(stream)
        } catch (e: Exception) {
            file.failWrite(stream)
            throw e
        }
    }

    private fun removeLocked() {
        file.delete()
        check(!file.baseFile.exists()) { "安全登录记录尚未清除，请解锁后重试" }
    }
}
