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

class PaymentSecrets(private val context: Context, private val namespace: String = "payment-code") {
    init { require(namespace in setOf("payment-code", "custody-receipt", "reservation-create", "reservation-seat", "reservation-legacy-create")) }
    private val keyAlias get() = when(namespace) { "payment-code" -> "mbox-payment-codes"; "custody-receipt" -> "mbox-custody-receipts"; else -> "mbox-$namespace" }
    private fun file(key: String): AtomicFile {
        require(Regex("^[a-f0-9-]{36}$").matches(key))
        return AtomicFile(File(context.filesDir, "$namespace-$key.enc"))
    }

    private fun encryptionKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let {
            return it
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply {
                init(
                    KeyGenParameterSpec.Builder(
                            keyAlias,
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

    fun store(key: String, code: String) {
        val target = file(key)
        if (target.baseFile.exists() || File(target.baseFile.path + ".bak").exists()) {
            require(read(key) == code) { "安全存储与原请求不一致，未发送" }
            return
        }
        val cipher =
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, encryptionKey())
                updateAAD(key.toByteArray())
            }
        val ciphertext = cipher.doFinal(code.toByteArray())
        val data =
            JSONObject()
                .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .toString()
                .toByteArray()
        val stream = target.startWrite()
        try {
            stream.write(data)
            target.finishWrite(stream)
        } catch (e: Exception) {
            target.failWrite(stream)
            throw e
        }
    }

    fun read(key: String): String {
        try {
            val data = JSONObject(file(key).openRead().bufferedReader().use { it.readText() })
            val cipher =
                Cipher.getInstance("AES/GCM/NoPadding").apply {
                    init(
                        Cipher.DECRYPT_MODE,
                        encryptionKey(),
                        GCMParameterSpec(128, Base64.decode(data.getString("iv"), Base64.NO_WRAP)),
                    )
                    updateAAD(key.toByteArray())
                }
            return String(
                cipher.doFinal(Base64.decode(data.getString("ciphertext"), Base64.NO_WRAP))
            )
        } catch (_: Exception) {
            error(when { namespace.startsWith("reservation-") -> "预约原请求安全记录暂不可读，请解锁设备后核对原请求；不要重新建单"; namespace == "payment-code" -> "原操作安全凭据暂不可读，请解锁设备后核对原请求；不要重复提交"; else -> "存酒原回执暂不可读，请保留原请求" })
        }
    }

    fun remove(key: String) {
        val target = file(key)
        target.delete()
        check(listOf(target.baseFile, File(target.baseFile.path + ".bak"), File(target.baseFile.path + ".new")).none { it.exists() }) { "原安全记录无法清除，请保留已确认请求并检查设备空间" }
    }
}
