package com.mbox.staff

import java.net.URI
import org.json.JSONObject

data class AppRelease(
    val appId: String,
    val version: String,
    val build: Long,
    val minimumOS: Int,
    val priority: String,
    val notes: String,
    val url: String,
    val sha256: String,
    val bytes: Long,
) {
    fun verifyPayload(actualBytes: Long, actualHash: String) {
        require(actualBytes == bytes && actualHash == sha256) { "更新包不完整或校验失败，请重新下载" }
    }

    companion object {
        fun endpoint(channel: String): String {
            require(channel in listOf("preview", "stable"))
            return "https://mbox.shmbox.com/native-updates/staff/$channel.json"
        }

        const val maxBytes = 256L * 1024 * 1024

        fun trustedURL(value: String): Boolean =
            try {
                val u = URI(value)
                u.scheme == "https" &&
                    u.host == "mbox.shmbox.com" &&
                    u.port == -1 &&
                    u.rawUserInfo == null &&
                    u.rawFragment == null &&
                    u.rawQuery == null &&
                    u.rawPath.matches(Regex("/native-updates/staff/[A-Za-z0-9_./-]+\\.apk")) &&
                    !u.rawPath.contains("..") &&
                    !u.rawPath.contains("//")
            } catch (_: Exception) {
                false
            }

        fun parseManifest(text: String, appId: String, channel: String = "preview"): AppRelease? {
            require(text.toByteArray(Charsets.UTF_8).size <= 65536) { "更新信息过大" }
            val root = JSONObject(text)
            require(
                root.getInt("schemaVersion") == 1 &&
                    channel in listOf("preview", "stable") &&
                    root.getString("channel") == channel
            ) {
                "更新渠道不匹配"
            }
            val matches =
                root.getJSONArray("releases").objects().filter {
                    it.getString("platform") == "android"
                }
            require(matches.size <= 1) { "更新版本重复" }
            val j = matches.firstOrNull() ?: return null
            require(j.getString("appId") == appId && j.getString("delivery") == "apk") { "更新应用不匹配" }
            val release =
                AppRelease(
                    appId,
                    j.getString("version"),
                    j.getLong("build"),
                    j.getString("minimumOS").toInt(),
                    j.getString("priority"),
                    j.getString("notes"),
                    j.getString("url"),
                    j.getString("sha256"),
                    j.getLong("bytes"),
                )
            require(
                release.version.length in 1..40 &&
                    release.build in 1..2100000000L &&
                    release.minimumOS in 26..100 &&
                    release.priority in listOf("normal", "urgent") &&
                    release.notes.length <= 6000 &&
                    trustedURL(release.url) &&
                    release.sha256.matches(Regex("[a-f0-9]{64}")) &&
                    release.bytes in 1..maxBytes
            ) {
                "更新信息无法验证"
            }
            return release
        }

        fun verifyArchive(
            release: AppRelease,
            installedBuild: Long,
            archiveId: String,
            archiveBuild: Long,
            currentSigners: Set<String>,
            newSigners: Set<String>,
        ) {
            require(
                archiveId == release.appId &&
                    archiveBuild == release.build &&
                    archiveBuild > installedBuild
            ) {
                "更新包名称或版本不符，不能安装"
            }
            require(currentSigners.isNotEmpty() && currentSigners == newSigners) {
                "更新包签名与当前应用不一致，不能安装"
            }
        }
    }
}
