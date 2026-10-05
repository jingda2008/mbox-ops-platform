package com.mbox.staff

import android.app.Application
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.runtime.*
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.*

class AndroidUpdater(private val app: Application) {
    val channel = BuildConfig.UPDATE_CHANNEL

    @Suppress("DEPRECATION")
    private fun packageInfo(): PackageInfo =
        app.packageManager.getPackageInfo(app.packageName, flags())

    private fun flags() =
        (if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES
        else PackageManager.GET_SIGNATURES) or PackageManager.GET_META_DATA

    @Suppress("DEPRECATION")
    private fun version(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): Set<String> =
        (if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures)
            ?.map { sha(it.toByteArray()) }
            ?.toSet() ?: emptySet()

    val currentVersion = packageInfo().versionName ?: "未知"
    val currentBuild = version(packageInfo())
    var release by mutableStateOf<AppRelease?>(null)
        private set

    var checking by mutableStateOf(false)
        private set

    var downloading by mutableStateOf(false)
        private set

    var installing by mutableStateOf(false)
        private set

    var percent by mutableIntStateOf(0)
        private set

    var status by mutableStateOf("尚未检查更新")
        private set

    private var lastAttempt = 0L
    private var verified: File? = null
    private var verifiedRelease: AppRelease? = null
    val ready
        get() = verified != null && verifiedRelease == release && verified?.isFile == true

    private fun connection(url: String): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.instanceFollowRedirects = false
        c.connectTimeout = 15000
        c.readTimeout = 30000
        c.useCaches = false
        c.setRequestProperty("Accept-Encoding", "identity")
        return c
    }

    suspend fun check(manual: Boolean = false) {
        if (checking || downloading || installing) return
        val now = android.os.SystemClock.elapsedRealtime()
        if (!manual && lastAttempt > 0 && now - lastAttempt < 6 * 3600_000) return
        checking = true
        lastAttempt = now
        try {
            val item =
                withContext(Dispatchers.IO) {
                    val c = connection(AppRelease.endpoint(channel))
                    try {
                        if (c.responseCode == 404) return@withContext null
                        check(c.responseCode == 200) { "更新服务暂不可用" }
                        val bytes =
                            c.inputStream.use { stream ->
                                val out = java.io.ByteArrayOutputStream()
                                val buf = ByteArray(4096)
                                val deadline = android.os.SystemClock.elapsedRealtime() + 45000
                                while (true) {
                                    check(android.os.SystemClock.elapsedRealtime() < deadline) {
                                        "检查更新超时"
                                    }
                                    ensureActive()
                                    val n = stream.read(buf)
                                    if (n < 0) break
                                    require(out.size() + n <= 65536) { "更新信息过大" }
                                    out.write(buf, 0, n)
                                }
                                out.toByteArray()
                            }
                        AppRelease.parseManifest(
                            bytes.toString(Charsets.UTF_8),
                            app.packageName,
                            channel,
                        )
                    } finally {
                        c.disconnect()
                    }
                }
            release = item?.takeIf { it.build > currentBuild }
            status =
                if (item == null) "当前渠道尚未发布版本" else if (release == null) "当前没有可用的新版本" else "发现新版本"
            if (verifiedRelease != release) {
                verified = null
                verifiedRelease = null
            }
        } catch (e: CancellationException) {
            release = null
            status = "检查已取消"
            throw e
        } catch (_: Exception) {
            release = null
            status = "检查未完成，请重试；不会影响当前业务"
        } finally {
            checking = false
        }
    }

    suspend fun download() {
        val candidate = release ?: return
        if (downloading || checking || installing) return
        if (candidate.minimumOS > Build.VERSION.SDK_INT) {
            status = "请先升级手机系统"
            return
        }
        downloading = true
        percent = 0
        verified = null
        verifiedRelease = null
        status = "正在下载更新，请保持网络连接"
        val dir = File(app.cacheDir, "updates")
        val partial = File(dir, "pending.part")
        val target = File(dir, "verified.apk")
        try {
            withContext(Dispatchers.IO) {
                check(dir.isDirectory || dir.mkdirs()) { "无法创建更新目录" }
                require(dir.usableSpace >= candidate.bytes * 2 + 20 * 1024 * 1024) {
                    "设备空间不足，请清理后重试"
                }
                val c = connection(candidate.url)
                try {
                    check(c.responseCode == 200) { "下载失败，请重试" }
                    require(c.contentLengthLong == -1L || c.contentLengthLong == candidate.bytes) {
                        "更新包大小不符"
                    }
                    val digest = MessageDigest.getInstance("SHA-256")
                    var total = 0L
                    var displayed = -1
                    val deadline = android.os.SystemClock.elapsedRealtime() + 15 * 60_000
                    c.inputStream.use { input ->
                        partial.outputStream().use { output ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                ensureActive()
                                check(android.os.SystemClock.elapsedRealtime() < deadline) {
                                    "下载超时，请重试"
                                }
                                val n = input.read(buffer)
                                if (n < 0) break
                                total += n
                                require(total <= candidate.bytes) { "更新包大小不符" }
                                digest.update(buffer, 0, n)
                                output.write(buffer, 0, n)
                                val progress = (total * 100 / candidate.bytes).toInt()
                                if (progress != displayed) {
                                    displayed = progress
                                    withContext(Dispatchers.Main) { percent = progress }
                                }
                            }
                            output.fd.sync()
                        }
                    }
                    candidate.verifyPayload(total, hex(digest.digest()))
                    verifyAPK(partial, candidate)
                    if (target.exists()) check(target.delete()) { "旧更新包无法清理" }
                    check(partial.renameTo(target)) { "更新包无法保存" }
                } finally {
                    c.disconnect()
                }
            }
            verified = target
            verifiedRelease = candidate
            status = "下载和校验完成，等待系统安装确认"
        } catch (e: CancellationException) {
            status = "下载已取消，可重新下载"
            throw e
        } catch (e: Exception) {
            status = e.message ?: "下载失败，请重试"
        } finally {
            partial.delete()
            downloading = false
        }
    }

    @Suppress("DEPRECATION")
    private fun verifyAPK(file: File, candidate: AppRelease) {
        val info =
            app.packageManager.getPackageArchiveInfo(file.path, flags()) ?: error("无法识别更新安装包")
        val application = info.applicationInfo ?: error("无法识别更新应用配置")
        val metadata = application.metaData
        AppRelease.verifyPackagedConfiguration(
            channel,
            metadata?.getString("com.mbox.staff.UPDATE_CHANNEL"),
            if (metadata?.containsKey("com.mbox.staff.ALLOW_LOCAL_DEMO") == true)
                metadata.getBoolean("com.mbox.staff.ALLOW_LOCAL_DEMO") else null,
            application.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0,
        )
        AppRelease.verifyArchive(
            candidate,
            currentBuild,
            info.packageName,
            version(info),
            signers(packageInfo()),
            signers(info),
        )
    }

    suspend fun install(isBlocked: () -> Boolean) {
        val candidate = release ?: return
        val file = verified ?: return
        if (!ready || downloading || checking || installing || isBlocked()) {
            status = "请先完成业务并核对未决结果"
            return
        }
        installing = true
        try {
            withContext(Dispatchers.IO) {
                require(file.length() == candidate.bytes) { "更新包已变化，请重新下载" }
                val digest = MessageDigest.getInstance("SHA-256")
                file.inputStream().use { input ->
                    val buffer = ByteArray(65536)
                    while (true) {
                        ensureActive()
                        val n = input.read(buffer)
                        if (n < 0) break
                        digest.update(buffer, 0, n)
                    }
                }
                require(hex(digest.digest()) == candidate.sha256) { "更新包已变化，请重新下载" }
                verifyAPK(file, candidate)
            }
            if (isBlocked()) {
                status = "请先完成业务并核对未决结果"
                return
            }
            if (!app.packageManager.canRequestPackageInstalls()) {
                app.startActivity(
                    Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:${app.packageName}"),
                        )
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
                status = "请在系统页面允许本应用安装更新，返回后再点击安装"
                return
            }
            val uri = FileProvider.getUriForFile(app, app.packageName + ".updates", file)
            app.startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK
                    )
            )
            status = "已交给系统安装；取消后可再次安装，成功后以新版本号为准"
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            status = e.message ?: "暂时无法打开系统安装器"
        } finally {
            installing = false
        }
    }

    companion object {
        private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

        private fun sha(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    }
}
