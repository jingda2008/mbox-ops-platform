package com.mbox.staff

import java.net.CookieManager
import java.net.CookiePolicy
import java.net.HttpCookie
import java.net.HttpURLConnection
import java.net.URI
import java.time.Instant
import org.json.JSONObject

class StaffAPIError(
    val status: Int,
    val code: String,
    override val message: String,
    val commitDisposition: String? = null,
) : Exception(message) {
    val definitivelyRejected
        get() =
            if (
                code in
                    listOf(
                        "FINANCE_REVIEW_FAILED",
                        "CASH_HANDOVER_CHANGED",
                        "VOUCHER_OPERATION_REVIEW",
                    )
            )
                status in 400..499 && commitDisposition == "not_committed"
            else if (
                (code == "HISTORICAL_COLLECTION_CHANGED" ||
                    code == "TABLE_ASSIGNMENT_NOT_COMMITTED" ||
                    code == "NATIVE_PHYSICAL_NOT_COMMITTED" ||
                    code == "TABLE_PARTICIPANT_NOT_COMMITTED" ||
                    code == "NATIVE_BUSINESS_NOT_COMMITTED")
            )
                status == 409 && commitDisposition == "not_committed"
            else if (code.startsWith("PICKUP_"))
                status in 400..499 &&
                    commitDisposition == "not_committed" &&
                    code in
                        setOf(
                            "PICKUP_INVALID",
                            "PICKUP_STALE",
                            "PICKUP_TABLE_MOVED",
                            "PICKUP_UNDO_UNAVAILABLE",
                            "PICKUP_ADMISSION_PAUSED",
                            "PICKUP_RECEIPT_NOT_FOUND",
                        )
            else
                status in 400..499 &&
                    code in
                        setOf(
                            "KITCHEN_CHANGED",
                            "KITCHEN_OWNER_CHANGED",
                            "KITCHEN_ADMISSION_PAUSED",
                            "KITCHEN_BATCH_NOT_FOUND",
                            "TABLE_REQUEST_INVALID",
                            "REQUEST_INVALID",
                            "CAPACITY_OVERRIDE_REASON_REQUIRED",
                            "TABLE_SESSION_UNSETTLED",
                            "SERVICE_TASK_SESSION_MISMATCH",
                            "TABLE_UNAVAILABLE",
                            "TABLE_ALREADY_OPEN",
                            "TABLE_SESSION_TRANSITION_CONFLICT",
                            "SERVICE_TASK_TRANSITION_CONFLICT",
                        )
}

fun invalidResponse(): Nothing = throw StaffAPIError(0, "INVALID_RESPONSE", "服务器数据格式不兼容，请刷新重试")

data class StaffIdentity(
    val sessionId: String,
    val employeeId: String,
    val employeeCode: String,
    val displayName: String,
    val expiresAt: String,
    val onlineLeaseUntil: String,
    val roles: List<String>,
    val permissions: Set<String>,
    val denied: Set<String>,
    val navigationRoutes: List<String>? = null,
) {
    fun allows(permission: String) = permission in permissions && permission !in denied

    val canReadTables
        get() = allows("dashboard.view")

    companion object {
        fun parse(data: JSONObject): StaffIdentity {
            try {
                val session = data.getJSONObject("session")
                val employee = data.getJSONObject("employee")
                val sid = session.getString("id")
                val eid = employee.getString("id")
                if (sid.isBlank() || eid.isBlank() || session.getString("employeeId") != eid)
                    invalidResponse()
                val expires = serverInstant(session.getString("expiresAt")).toString()
                val lease = serverInstant(session.getString("onlineLeaseUntil")).toString()
                fun strings(objectValue: JSONObject, key: String): List<String> {
                    val array = objectValue.getJSONArray(key)
                    return (0 until array.length()).map { array.getString(it) }
                }
                return StaffIdentity(
                    sid,
                    eid,
                    employee.getString("code"),
                    employee.getString("displayName"),
                    expires,
                    lease,
                    strings(employee, "roleCodes"),
                    strings(data, "permissions").toSet(),
                    strings(data, "deniedPermissions").toSet(),
                    data.optJSONArray("navigation")?.objects()?.map { it.getString("route").substringBefore('?') }?.distinct(),
                )
            } catch (e: StaffAPIError) {
                throw e
            } catch (_: Exception) {
                invalidResponse()
            }
        }
    }
}

data class APIRequest(val path: String, val body: JSONObject?, val headers: Map<String, String>)

data class APIResponse(
    val status: Int,
    val text: String,
    val headers: Map<String, List<String>> = emptyMap(),
)

interface StaffSessionStore {
    fun read(): String?

    fun write(value: String)

    fun remove()
}

/** One instance owns cookies and identity; callers serialize access on the model's IO path. */
class StaffAPI(
    private val credentialStore: StaffSessionStore? = null,
    private val transport: ((APIRequest) -> APIResponse)? = null,
) {
    var rememberSession = false
    var persistenceNotice = ""
        private set

    var identity: StaffIdentity? = null
        private set

    var deviceExpiresAt: String? = null
        private set

    private val cookies = CookieManager(null, CookiePolicy.ACCEPT_ORIGINAL_SERVER)
    private val cookieExpiry = mutableMapOf<String, Instant>()

    private fun receiveCookies(uri: URI, headers: Map<out String?, List<String>?>) {
        cookies.put(
            uri,
            headers.entries
                .filter { it.key != null && it.value != null }
                .associate { it.key!! to it.value!! },
        )
        headers
            .filterKeys { it?.equals("Set-Cookie", ignoreCase = true) == true }
            .values
            .filterNotNull()
            .flatten()
            .forEach { header ->
                runCatching { HttpCookie.parse(header) }
                    .getOrDefault(emptyList())
                    .forEach { cookie ->
                        if (
                            cookie.name in
                                listOf("__Host-mbox_staff_session", "__Host-mbox_device_lease")
                        ) {
                            if (cookie.maxAge >= 0)
                                cookieExpiry[cookie.name] = Instant.now().plusSeconds(cookie.maxAge)
                            else cookieExpiry.remove(cookie.name)
                        }
                    }
            }
    }

    fun clearIdentity() {
        runCatching { credentialStore?.remove() }
            .onFailure { persistenceNotice = "安全登录记录暂未清除，请解锁后重试" }
        identity = null
        cookies.cookieStore.cookies
            .toList()
            .filter { it.name == "__Host-mbox_staff_session" }
            .forEach { cookies.cookieStore.remove(URI("https://mbox.shmbox.com"), it) }
    }

    fun grant(credential: String, deviceKey: String) {
        if (credential.trim().length !in 6..128 || deviceKey.length < 8)
            throw StaffAPIError(0, "INPUT_INVALID", "请填写有效的门店口令")
        val result =
            data(
                "/api/auth/device-access",
                JSONObject().put("credential", credential.trim()).put("deviceKey", deviceKey),
            )
        val expires = try { serverInstant(result.getString("expiresAt")) }
            catch (_: java.time.DateTimeException) { invalidResponse() }
        if (!expires.isAfter(Instant.now())) invalidResponse()
        deviceExpiresAt = expires.toString()
    }

    fun login(code: String, pin: String, switching: Boolean): StaffIdentity {
        if (code.trim().length !in 1..64 || !Regex("[0-9]{4}").matches(pin))
            throw StaffAPIError(0, "INPUT_INVALID", "请输入员工账号和4位数字PIN")
        try {
            val result =
                StaffIdentity.parse(
                    data(
                        if (switching) "/api/auth/switch" else "/api/auth/login",
                        JSONObject().put("employeeCode", code.trim()).put("pin", pin),
                    )
                )
            identity = result
            persistSession()
            return result
        } catch (e: Exception) {
            if (switching) clearIdentity()
            throw e
        }
    }

    fun heartbeat(): StaffIdentity {
        val before = identity ?: throw StaffAPIError(401, "AUTH_REQUIRED", "请先登录员工账号")
        val next = StaffIdentity.parse(data("/api/auth/heartbeat", JSONObject()))
        if (before.sessionId != next.sessionId || before.employeeId != next.employeeId) {
            clearIdentity()
            throw StaffAPIError(401, "IDENTITY_CHANGED", "员工身份已变化，请重新登录")
        }
        identity = next
        persistSession()
        return next
    }

    fun configureRememberSession(enabled: Boolean) {
        if (enabled) {
            rememberSession = true
            persistSession()
        } else forgetSavedSession()
    }

    fun savedSessionAvailable() =
        runCatching { credentialStore?.read() != null }.getOrDefault(false)

    fun forgetSavedSession() {
        credentialStore?.remove()
        rememberSession = false
        persistenceNotice = ""
    }

    fun restoreSession(): StaffIdentity? {
        val encoded = credentialStore?.read() ?: return null
        val root: JSONObject
        val saved: StaffIdentity
        try {
            root = JSONObject(encoded)
            require(root.getInt("version") == 1)
            saved = StaffIdentity.parse(root.getJSONObject("identity"))
            require(serverInstant(saved.expiresAt).isAfter(Instant.now()))
            val rows = root.getJSONArray("cookies").objects()
            require(
                rows.size <= 2 &&
                    rows.map { it.getString("name") }.distinct().size == rows.size &&
                    rows.all {
                        it.getString("name") in
                            listOf("__Host-mbox_staff_session", "__Host-mbox_device_lease") &&
                            it.getString("value").length in 1..8192 &&
                            !it.getString("value").contains('\n') &&
                            !it.getString("value").contains('\r')
                    }
            )
            require(
                rows.any {
                    it.getString("name") == "__Host-mbox_staff_session" &&
                        serverInstant(it.getString("expiresAt")).isAfter(Instant.now()) &&
                        !serverInstant(it.getString("expiresAt"))
                            .isAfter(serverInstant(saved.expiresAt))
                }
            )
            for (row in rows) {
                val seconds =
                    java.time.Duration.between(
                            Instant.now(),
                            serverInstant(row.getString("expiresAt")),
                        )
                        .seconds
                if (seconds > 0) {
                    val cookie =
                        HttpCookie(row.getString("name"), row.getString("value")).apply {
                            path = "/"
                            secure = true
                            isHttpOnly = true
                            maxAge = seconds
                        }
                    cookieExpiry[cookie.name] = serverInstant(row.getString("expiresAt"))
                    cookies.cookieStore.add(URI("https://mbox.shmbox.com"), cookie)
                }
            }
        } catch (e: Exception) {
            runCatching { credentialStore?.remove() }
            throw IllegalStateException("原登录已过期或记录无效，请重新登录", e)
        }
        identity = saved
        deviceExpiresAt = root.textOrNull("deviceExpiresAt")
        rememberSession = true
        // Only fresh server validation returns an identity to AppModel.
        return heartbeat()
    }

    private fun persistSession() {
        val store = credentialStore ?: return
        val actor = identity
        if (!rememberSession || actor == null) {
            runCatching { store.remove() }
            return
        }
        try {
            val list =
                cookies.cookieStore.get(URI("https://mbox.shmbox.com")).mapNotNull { cookie ->
                    if (
                        cookie.name !in
                            listOf("__Host-mbox_staff_session", "__Host-mbox_device_lease") ||
                            cookie.path != "/" ||
                            !cookie.secure ||
                            cookie.hasExpired() ||
                            cookie.domain != null &&
                                cookie.domain.removePrefix(".") != "mbox.shmbox.com"
                    )
                        return@mapNotNull null
                    val boundary =
                        runCatching {
                                serverInstant(
                                    if (cookie.name == "__Host-mbox_staff_session") actor.expiresAt
                                    else deviceExpiresAt
                                )
                            }
                            .getOrNull() ?: return@mapNotNull null
                    val expiry =
                        if (cookie.maxAge >= 0)
                            minOf(
                                boundary,
                                cookieExpiry[cookie.name]
                                    ?: Instant.now().plusSeconds(cookie.maxAge),
                            )
                        else boundary
                    if (!expiry.isAfter(Instant.now())) return@mapNotNull null
                    JSONObject()
                        .put("name", cookie.name)
                        .put("value", cookie.value)
                        .put("expiresAt", expiry.toString())
                }
            require(list.any { it.getString("name") == "__Host-mbox_staff_session" })
            val auth =
                JSONObject()
                    .put(
                        "session",
                        JSONObject()
                            .put("id", actor.sessionId)
                            .put("employeeId", actor.employeeId)
                            .put("expiresAt", actor.expiresAt)
                            .put("onlineLeaseUntil", actor.onlineLeaseUntil),
                    )
                    .put(
                        "employee",
                        JSONObject()
                            .put("id", actor.employeeId)
                            .put("code", actor.employeeCode)
                            .put("displayName", actor.displayName)
                            .put("roleCodes", org.json.JSONArray(actor.roles)),
                    )
                    .put("permissions", org.json.JSONArray(actor.permissions))
                    .put("deniedPermissions", org.json.JSONArray(actor.denied))
            actor.navigationRoutes?.let { routes ->
                auth.put("navigation", org.json.JSONArray(routes.map { JSONObject().put("route", it) }))
            }
            store.write(
                JSONObject()
                    .put("version", 1)
                    .put("identity", auth)
                    .put("deviceExpiresAt", deviceExpiresAt ?: JSONObject.NULL)
                    .put("cookies", org.json.JSONArray(list))
                    .toString()
            )
            persistenceNotice = ""
        } catch (e: Exception) {
            runCatching { store.remove() }
            persistenceNotice = "未能安全保存登录；本次关闭 App 后需重新登录。"
        }
    }

    /** A supervisor session has its own employee cookie and never persists credentials. */
    fun supervisorClient(): StaffAPI {
        val client = StaffAPI(transport = transport)
        val uri = URI("https://mbox.shmbox.com")
        val lease = cookies.cookieStore.get(uri).singleOrNull { it.name == "__Host-mbox_device_lease" && !it.hasExpired() }
            ?: throw StaffAPIError(403, "DEVICE_REQUIRED", "请先使用门店口令验证这台设备，再由主管核对")
        val expiry = cookieExpiry[lease.name] ?: deviceExpiresAt?.let(::serverInstant)
            ?: throw StaffAPIError(403, "DEVICE_REQUIRED", "设备授权期限未知，请重新验证门店设备")
        require(expiry.isAfter(Instant.now())) { "门店设备授权已过期，请重新验证" }
        val copy = lease.clone() as HttpCookie
        copy.maxAge = java.time.Duration.between(Instant.now(), expiry).seconds
        client.cookies.cookieStore.add(uri, copy)
        client.cookieExpiry[copy.name] = expiry
        client.deviceExpiresAt = deviceExpiresAt
        return client
    }

    fun logout() {
        if (raw("/api/auth/logout", JSONObject()).status != 204) invalidResponse()
        clearIdentity()
    }

    fun execute(step: LiveStep) {
        if (
            step.path in
                listOf("/api/commerce/pickup-board/commands", "/api/commerce/pickup-board/device")
        ) {
            executePickup(step)
            return
        }
        val result = raw(step.path, JSONObject(step.body), mapOf(step.keyHeader to step.key))
        try {
            if (step.observationProof != null) {
                validateObservationReply(result.text, step)
                return
            }
            if (step.memberProof != null) {
                validateMemberReply(result.text, step)
                return
            }
            if (step.onlineProof != null) {
                validateOnlineReply(result.text, step)
                return
            }
            if (step.cashHandoverProof != null) {
                validateCashHandoverReply(result.text, step)
                return
            }
            if (step.voucherProof != null) {
                validateVoucherReply(result.text, step)
                return
            }
            if (step.printProof != null) {
                validatePrintReply(result.text, step)
                return
            }
            if (step.activityProof != null) {
                validateActivityReply(result.text, step)
                return
            }
            if (step.fulfillmentProof != null) {
                validateFulfillmentReply(result.text, step)
                return
            }
            if (step.afterSalesProof != null) {
                validateAfterSalesReply(result.text, step)
                return
            }
            if (step.financeProof != null) {
                validateFinanceReply(result.text, step)
                return
            }
            if (step.productManagementProof != null) {
                validateProductManagementReply(result.text, step)
                return
            }
            if (step.stockAuditProof != null) {
                validateStockAuditReply(result.text, step)
                return
            }
            if (step.stockProof != null) {
                validateStockReply(result.text, step)
                return
            }
            if (step.serviceProof != null) {
                validateServiceReply(result.text, step)
                return
            }
            if (step.deviceProof != null) {
                validateDeviceReply(result.text, step)
                return
            }
            if (step.songProof != null) {
                validateSongReply(result.text, step)
                return
            }
            if (step.reservationProof != null) {
                validateReservationReply(result.text, step)
                return
            }
            if (step.participantProof != null) {
                validateParticipantReply(result.text, step)
                return
            }
            if (step.assignmentProof != null) {
                validateAssignmentReply(result.text, step)
                return
            }
            if (step.cashierProof != null) {
                validateCashierReply(result.text, step)
                return
            }
            val root = JSONObject(result.text)
            val data = root.getJSONObject("data")
            if (step.path == "/api/commerce/kitchen-board/commands") {
                val command = JSONObject(step.body).getJSONObject("command")
                if (
                    root.get("replayed") !is Boolean ||
                        data.getString("batchId").isBlank() ||
                        data.getString("action") != command.getString("action") ||
                        data.getInt("quantity") < 0 ||
                        (command.has("batchId") &&
                            command.getString("batchId") != data.getString("batchId"))
                )
                    invalidResponse()
                val action = command.getString("action")
                val items = command.optJSONArray("items")?.objects() ?: emptyList()
                val expectedQuantity =
                    when (action) {
                        "ready" -> items.sumOf { it.getJSONArray("unitIds").length() }
                        "start",
                        "quick-ready" -> items.sumOf { it.getInt("quantity") }
                        else -> 0
                    }
                if (
                    data.getInt("quantity") != expectedQuantity ||
                        (action == "release" && !data.getBoolean("released"))
                )
                    invalidResponse()
                if (action == "handoff") {
                    val batches = command.getJSONArray("expectedBatches").objects()
                    val ids = batches.map { it.getString("batchId") }.toSet()
                    val affected = data.getJSONArray("affectedBatchIds")
                    val versions = data.getJSONObject("ownershipVersions")
                    if (
                        (0 until affected.length()).map { affected.getString(it) }.toSet() != ids ||
                            affected.length() != ids.size ||
                            versions.length() != ids.size ||
                            batches.any {
                                versions.getLong(it.getString("batchId")) !=
                                    it.getLong("expectedOwnershipVersion") + 1
                            }
                    )
                        invalidResponse()
                }
                return
            }
            if (step.path == "/api/payments/manual") {
                val body = JSONObject(step.body)
                if (
                    data.getString("status") != "succeeded" ||
                        data.getString("currency") != "CNY" ||
                        data.getString("publicId") != body.getString("publicId") ||
                        data.getLong("amountMinor") != body.getLong("amountMinor")
                )
                    invalidResponse()
            }
            if (root.getJSONObject("meta").get("replayed") !is Boolean) invalidResponse()
        } catch (_: org.json.JSONException) {
            invalidResponse()
        }
    }

    fun submitOrder(command: LiveOrderSubmission): LiveOrderReceipt =
        command.parseReceipt(
            raw(
                    "/api/commerce/orders",
                    JSONObject(command.body),
                    mapOf(
                        "idempotency-key" to command.key,
                        "x-assisted-order-context" to command.token,
                    ),
                )
                .text
        )

    fun data(path: String, body: JSONObject? = null): JSONObject =
        try {
            JSONObject(raw(path, body).text).getJSONObject("data")
        } catch (e: StaffAPIError) {
            throw e
        } catch (_: org.json.JSONException) {
            invalidResponse()
        }

    fun mediaThumbnail(publicId:String):ByteArray {
        require(Regex("^MA[0-9A-F]{32}$").matches(publicId))
        val uri=URI("https://mbox.shmbox.com/api/staff/media-assets/$publicId?size=thumbnail")
        val conn=uri.toURL().openConnection() as HttpURLConnection
        try {
            conn.instanceFollowRedirects=false;conn.connectTimeout=15000;conn.readTimeout=15000
            identity?.let{conn.setRequestProperty("x-mbox-staff-session-id",it.sessionId);conn.setRequestProperty("x-mbox-staff-employee-id",it.employeeId)}
            cookies.get(uri,emptyMap()).forEach{(k,v)->conn.setRequestProperty(k,v.joinToString("; "))}
            if(conn.responseCode!=200)throw StaffAPIError(conn.responseCode,"MEDIA_PREVIEW_FAILED","图片预览暂不可用")
            require(conn.contentType?.substringBefore(';') in setOf("image/jpeg","image/png","image/webp"))
            val bytes=conn.inputStream.use{readMediaBytes(it)};require(bytes.size<=204800);return bytes
        } finally {conn.disconnect()}
    }

    fun raw(
        path: String,
        body: JSONObject? = null,
        extraHeaders: Map<String, String> = emptyMap(),
    ): APIResponse {
        if (!path.startsWith("/api/") || path.contains("..") || path.contains("#"))
            invalidResponse()
        val uri = URI("https://mbox.shmbox.com$path")
        if (uri.host != "mbox.shmbox.com") invalidResponse()
        val headers = mutableMapOf("Accept" to "application/json")
        identity?.let {
            headers["x-mbox-staff-session-id"] = it.sessionId
            headers["x-mbox-staff-employee-id"] = it.employeeId
        }
        headers.putAll(extraHeaders)
        if (transport != null)
            cookies.get(uri, emptyMap()).forEach { (k, v) -> headers[k] = v.joinToString("; ") }
        val response =
            transport?.invoke(APIRequest(path, body, headers))
                ?: run {
                    val conn = uri.toURL().openConnection() as HttpURLConnection
                    try {
                        conn.instanceFollowRedirects = false
                        conn.connectTimeout = 20000
                        conn.readTimeout = 20000
                        conn.requestMethod = if (body == null) "GET" else "POST"
                        headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
                        cookies.get(uri, emptyMap()).forEach { (k, v) ->
                            conn.setRequestProperty(k, v.joinToString("; "))
                        }
                        if (body != null) {
                            conn.setRequestProperty("Content-Type", "application/json")
                            conn.doOutput = true
                            conn.outputStream.use {
                                it.write(body.toString().toByteArray(Charsets.UTF_8))
                            }
                        }
                        val status = conn.responseCode
                        receiveCookies(uri, conn.headerFields)
                        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
                        APIResponse(
                            status,
                            stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: "",
                        )
                    } finally {
                        conn.disconnect()
                    }
                }
        if (transport != null && response.headers.isNotEmpty())
            receiveCookies(uri, response.headers)
        if (response.status !in 200..299) {
            val error =
                try {
                    JSONObject(response.text).optJSONObject("error")
                } catch (_: Exception) {
                    null
                }
            val fallback =
                when (response.status) {
                    401 -> "登录或设备准入已过期，请重新验证"
                    403 -> "当前员工没有此操作权限"
                    429 -> "尝试过于频繁，请稍后重试"
                    else -> "连接失败，请稍后重试"
                }
            if (response.status == 401) clearIdentity()
            throw StaffAPIError(
                response.status,
                error?.optString("code") ?: "HTTP_ERROR",
                error?.optString("message")?.takeIf { it.isNotBlank() } ?: fallback,
                error?.optString("commitDisposition"),
            )
        }
        return response
    }
}

data class LiveTable(
    val display: StaffTable,
    val area: String,
    val status: String,
    val sessionStatus: String?,
    val locationVersion: Int?,
    val frozen: Boolean,
)

data class LiveTask(
    val id: String,
    val tableId: String,
    val tableCode: String,
    val session: String,
    val title: String,
    val detail: String,
    val priority: String,
    val mode: String,
    val status: String = "pending",
)

data class LiveOperations(
    val actorId: String,
    val capabilities: Set<String>,
    val tables: List<LiveTable>,
    val tasks: List<LiveTask>,
) {
    companion object {
        fun parse(data: JSONObject): LiveOperations {
            val actor = data.getJSONObject("actor")
            val caps = actor.getJSONArray("capabilities")
            val taskRows = data.getJSONArray("tasks")
            val tasks =
                (0 until taskRows.length()).map { i ->
                    val t = taskRows.getJSONObject(i)
                    LiveTask(
                        t.getString("id"),
                        t.getString("tableId"),
                        t.getString("tableCode"),
                        t.getString("tableSessionId"),
                        t.getString("title"),
                        if (t.isNull("detail")) "" else t.getString("detail"),
                        t.getString("priority"),
                        t.getString("interactionMode"),
                        t.getString("status"),
                    )
                }
            val rows = data.getJSONArray("tables")
            val tables =
                (0 until rows.length()).mapNotNull { i ->
                    val r = rows.getJSONObject(i)
                    if (r.getString("status") == "retired") return@mapNotNull null
                    val s = r.optJSONObject("activeSession")
                    val financial = s?.getString("financialState")
                    val uncertain =
                        financial in
                            listOf("refund_pending", "refunded", "partially_refunded", "cancelled")
                    fun minor(key: String): Int? =
                        if (s == null || s.isNull(key)) null
                        else s.get(key).toString().toIntOrNull()?.takeIf { it >= 0 }
                    val id = r.getString("id")
                    LiveTable(
                        StaffTable(
                            id,
                            r.getString("code"),
                            r.getInt("capacity"),
                            s?.getInt("guestCount") ?: 0,
                            s?.getString("id"),
                            if (s == null) 0
                            else if (uncertain) null else minor("orderAmountMinor"),
                            if (s == null) 0
                            else if (uncertain) null else minor("netCollectedAmountMinor"),
                            financial in listOf("payment_pending", "payment_exception"),
                            tasks.any { it.tableId == id },
                        ),
                        r.getString("areaName"),
                        r.getString("status"),
                        s?.getString("status"),
                        if (s == null || s.isNull("locationVersion")) null
                        else s.getInt("locationVersion"),
                        s?.getBoolean("guestCartWritesFrozen") ?: false,
                    )
                }
            return LiveOperations(
                actor.getString("id"),
                (0 until caps.length()).map { caps.getString(it) }.toSet(),
                tables,
                tasks,
            )
        }
    }
}
