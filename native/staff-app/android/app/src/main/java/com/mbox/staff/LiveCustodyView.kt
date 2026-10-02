package com.mbox.staff

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import android.graphics.BitmapFactory
import android.util.Base64
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

@Composable
fun CustodyField(label: String, value: String, max: Int = 300, change: (String)->Unit) {
    OutlinedTextField(value,change,label = { Text(label) },isError=value.length>max,
        supportingText=if(value.length>max) ({ Text("已超出${max}字限制，请完整核对后缩短；输入未被截断") }) else null,
        modifier = Modifier.fillMaxWidth())
}
fun custodyQuery(values: Map<String,String>) = values.filterValues { it.isNotBlank() }.entries.joinToString("&") { LiveCommand.part(it.key) + "=" + LiveCommand.part(it.value) }
fun custodyDateRange(from: String, to: String): Map<String,String> {
    val zone = ZoneId.of("Asia/Shanghai"); val a = from.takeIf { it.isNotBlank() }?.let(LocalDate::parse); val b = to.takeIf { it.isNotBlank() }?.let(LocalDate::parse)
    require(a == null || b == null || !b.isBefore(a)) { "结束日期不能早于开始" }
    return buildMap { a?.let { put("from",it.atStartOfDay(zone).toInstant().toString()) }; b?.let { put("to",it.plusDays(1).atStartOfDay(zone).toInstant().toString()) } }
}
@Composable
fun LiveCustodyView(m: AppModel, close: ()->Unit) {
    val original = remember { m.priorityAccessKey }; val version = remember { m.workspaceVersion }
    var section by remember { mutableStateOf("list") }; var proposed by remember { mutableStateOf<LiveCommand?>(null) }; var notice by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }; var member by remember { mutableStateOf("") }; var status by remember { mutableStateOf("stored") }; var category by remember { mutableStateOf("") }; var from by remember { mutableStateOf("") }; var to by remember { mutableStateOf("") }
    val context = LocalContext.current; var exportBytes by remember { mutableStateOf<ByteArray?>(null) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) { uri ->
        try { if(uri != null && original == m.priorityAccessKey) { context.contentResolver.openOutputStream(uri)?.use { it.write(exportBytes ?: error("导出已过期")) } ?: error("无法写入目标文件"); notice = "报表已保存" } }
        catch(e: Exception) { notice = "保存失败：${e.message}" } finally { exportBytes = null }
    }
    fun filters(): Map<String,String> = mapOf("query" to query.trim(),"memberNo" to member.trim(),"status" to status,"categoryId" to category) + custodyDateRange(from,to)
    fun propose(make: ()->LiveCommand) { try { require(m.canUseCustody) { "请刷新权限与存酒记录" }; proposed = make(); notice = "" } catch(e: Exception) { notice = e.message ?: "请核对输入" } }
    LaunchedEffect(Unit) { m.loadCustody("status=stored",null) }
    LaunchedEffect(m.priorityAccessKey,m.workspaceVersion) { if(original != m.priorityAccessKey || version != m.workspaceVersion) { proposed = null; exportBytes = null; close() } }
    if(original != m.priorityAccessKey || version != m.workspaceVersion) return
    Dialog(onDismissRequest = close,properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(),color = Paper) { LazyColumn(Modifier.safeDrawingPadding().imePadding().padding(16.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Row { Text("会员存酒",Modifier.weight(1f),style = MaterialTheme.typography.titleLarge); TextButton(onClick = { m.loadCustody() },enabled = !m.busy) { Text("刷新") }; TextButton(onClick = close) { Text("关闭") } }; LivePendingView(m); Text(m.custodyState); if(notice.isNotBlank()) Text(notice) }
            val board = m.custodyBoard
            if(board != null) {
                item { AssignmentChoice("工作区",section,listOf("list" to "存酒与取酒","create" to "新存酒","report" to "统计报表") + if(m.identity?.allows("member.card.manage") == true) listOf("policy" to "规则与品类") else emptyList()) { section = it; proposed = null } }
                m.custodyReceipt?.let { receipt -> item { Panel {
                    val result = receipt.getJSONObject("result"); val operation = receipt.getString("operation")
                    when(operation) {
                        "verify" -> Text(result.getString("message"),color = if(result.getBoolean("verified")) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
                        "request_code" -> Text("发送任务已登记。实际送达以验证码记录为准，请勿反复重发。")
                        "export", "report_export" -> { Text("报表已生成 · ${result.optInt("count")}条"); SecondaryAction(onClick = { try { exportBytes = Base64.decode(result.getString("base64"),Base64.DEFAULT); save.launch("MBOX-存酒报表.xlsx") } catch(e: Exception) { notice = "文件生成失败，请重新核对" } }) { Text("保存到文件") } }
                        "print_prepared" -> { Text("已准备原单打印内容，尚不代表出纸。"); SecondaryAction(onClick = { printCustodyDocument(context,result.getJSONObject("document")) }) { Text("选择系统打印机或保存PDF") } }
                        else -> Text("原请求已确认，请核对更新后的记录。")
                    }
                } } }
                when(section) {
                    "list" -> {
                        item { Foldout("查找存酒") {
                            CustodyField("会员号",member,64) { member = it }; CustodyField("酒名或编号模糊查询",query,100) { query = it }
                            AssignmentChoice("状态",status,custodyStatuses.toList()) { status = it }
                            AssignmentChoice("品类",category,listOf("" to "全部") + board.categories.map { it.getString("id") to it.getString("name") }) { category = it }
                            CustodyField("开始日期 YYYY-MM-DD，可留空",from,10) { from = it }; CustodyField("结束日期 YYYY-MM-DD，可留空",to,10) { to = it }
                            PrimaryAction(onClick = { try { m.loadCustody(custodyQuery(filters()),null) } catch(e: Exception) { notice = "日期格式不正确" } },enabled = !m.busy) { Text("查询") }
                            if(m.identity?.allows("bottle.custody.export") == true) SecondaryAction(onClick = { propose { custodyCommand(m.identity!!,"export",JSONObject(filters().filterValues { it.isNotBlank() }),"导出所选存酒明细\n包含会员与存酒信息，请妥善保管。登记价值不是营业收入。") } },enabled = m.canUseCustody) { Text("导出所选明细") }
                        } }
                        if(board.items.isEmpty()) item { Text("当前筛选没有存酒记录") }
                        for(order in board.items) item { Panel {
                            Text(order.getString("item_name") + " · " + (custodyStatuses[order.getString("status")] ?: "待核对"),style = MaterialTheme.typography.titleMedium)
                            Text("会员 ${order.getString("member_no")} · ${order.getString("public_id")}"); Text("剩余 ${order.getString("remaining_quantity")}${order.getString("unit")} · 到期 ${assignmentTime(order.getString("expires_at"))}")
                            SecondaryAction(onClick = { m.loadCustody(selected = order.getString("id")) },enabled = !m.busy) { Text("查看与处理") }
                        } }
                        board.next?.let { cursor -> item { SecondaryAction(onClick = { try { m.loadCustody(custodyQuery(filters() + ("cursor" to cursor)),null) } catch(e: Exception) { notice = e.message ?: "请核对筛选" } },enabled = !m.busy) { Text("下一页存酒") } } }
                        board.detail?.let { detail -> item { key(detail.getJSONObject("order").getString("id"),detail.getJSONObject("order").getInt("version")) { CustodyDetail(m,board,detail) { make -> propose(make) } } } }
                    }
                    "create" -> item { key(m.custodyReceipt) { CustodyCreate(m,board) { make -> propose(make) } } }
                    "policy" -> item { CustodyConfiguration(m,board) { make -> propose(make) } }
                    "report" -> item { CustodyReports(m) { make -> propose(make) } }
                }
            }
        } }
    }
    proposed?.let { command -> AlertDialog(onDismissRequest = { proposed = null },title = { Text("请核对存酒操作") },text = { Text(command.steps[0].custodyProof!!.getString("confirmation")) },confirmButton = { TextButton(onClick = { proposed = null; m.executeLive(command) },enabled = m.canUseCustody) { Text("确认提交") } },dismissButton = { TextButton(onClick = { proposed = null }) { Text("返回核对") } }) }
}
@Composable
private fun CustodyCreate(m: AppModel, board: CustodyBoard, propose: (()->LiveCommand)->Unit) {
    var member by remember { mutableStateOf("") }; var contactFor by remember { mutableStateOf("") }; var contact by remember { mutableStateOf<JSONObject?>(null) }; var phone by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("") }; var item by remember { mutableStateOf("") }; var unit by remember { mutableStateOf("瓶") }; var quantity by remember { mutableStateOf("1") }; var fraction by remember { mutableStateOf("1") }
    var location by remember { mutableStateOf("") }; var note by remember { mutableStateOf("") }; var source by remember { mutableStateOf("") }; var orderId by remember { mutableStateOf("") }; var sourcePublicId by remember { mutableStateOf("") }; var value by remember { mutableStateOf("") }
    var photo by remember { mutableStateOf("") }; var extras by remember { mutableStateOf(mapOf<String,String>()) }; var days by remember { mutableStateOf(board.policy.getInt("defaultDays").toString()) }; var notice by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    Text("新存酒",style = MaterialTheme.typography.titleMedium)
    if(!board.policy.getBoolean("enabled")) Text("当前停止新建存酒，已有记录仍可处理。")
    CustodyField("会员号",member,64) { member = it; contact = null; contactFor = ""; phone = ""; photo = ""; orderId = ""; sourcePublicId = "" }
    SecondaryAction(onClick = { val selected = member.trim(); scope.launch { try { val result = m.readCustodyExtra("/member-contact?memberNo="+LiveCommand.part(selected)); if(member.trim()==selected) { contact=result; contactFor=selected; notice="" } } catch(e: Exception) { notice=e.message ?: "会员查询失败" } } },enabled = !m.busy && member.isNotBlank()) { Text("核对会员与联系号码") }
    contact?.let { Text(it.textOrNull("maskedPhone")?.let { "使用会员已验证号码：$it" } ?: "会员未留有效号码，请填写本次存酒联系手机号。") }
    if(contact != null && contact!!.isNull("maskedPhone")) CustodyField("存酒联系手机号",phone,32) { phone=it }
    AssignmentChoice("品类",category,board.categories.filter { it.getBoolean("active") }.map { it.getString("id") to it.getString("name") }) { category=it; days=board.categories.find { row->row.getString("id")==it }!!.getInt("default_days").toString() }
    CustodyField("酒名",item,120) { item=it }; CustodyField("计量单位",unit,20) { unit=it; fraction="" }
    if(unit=="瓶") AssignmentChoice("剩余比例",fraction,custodyFractions.keys.map { it to if(it.isEmpty()) "自定义数量" else "$it 瓶" }) { fraction=it; if(it.isNotBlank()) quantity=custodyFractions[it]!! }
    CustodyField("存入数量",quantity,20) { quantity=it; fraction="" }; CustodyField("存放位置",location,120) { location=it }; CustodyField("存期天数",days,4) { days=it }
    CustodyField("原购凭证号（可选）",source,120) { source=it }; CustodyField("关联本店消费单号（可选）",sourcePublicId,128) { sourcePublicId=it; orderId="" }
    if(sourcePublicId.isNotBlank()) SecondaryAction(onClick={ val selected=member.trim(); val number=sourcePublicId.trim(); scope.launch { try { val result=m.readCustodyExtra("/source-order?memberNo="+LiveCommand.part(selected)+"&publicId="+LiveCommand.part(number)); if(member.trim()==selected && sourcePublicId.trim()==number) { orderId=result.getString("id"); notice="已核对该会员原消费单：${result.getString("publicId")}" } } catch(e: Exception) { notice=e.message ?: "原单核对失败" } } },enabled=!m.busy && contactFor==member.trim()) { Text("核对关联消费单") }
    CustodyField("登记价值（元，可留空，不记作营业收入）",value,14) { value=it }; CustodyField("备注",note,1000) { note=it }
    for(field in board.policy.getJSONArray("extraFieldDefinitions").objects()) CustodyField(field.getString("label") + if(field.getBoolean("required")) "（必填）" else "（选填）",extras[field.getString("key")].orEmpty(),500) { extras=extras+(field.getString("key") to it) }
    CustodyPhotoCapture(m.priorityAccessKey+":"+member, !m.busy,photo) { photo=it }
    if(notice.isNotBlank()) Text(notice)
    PrimaryAction(onClick = { propose {
        require(contactFor==member.trim() && contact!=null) { "请先核对本次会员号" }
        require(item.isNotBlank() && category.isNotBlank() && unit.isNotBlank()); require(days.toInt() in 1..3660)
        require(sourcePublicId.isBlank() || orderId.isNotBlank()) { "请先核对所填消费单号" }
        if(orderId.isNotBlank()) java.util.UUID.fromString(orderId)
        val minor = if(value.isBlank()) null else java.math.BigDecimal(value).movePointRight(2).longValueExact().also { require(it in 0..100000000000L) }
        val body=JSONObject().put("memberNo",member.trim()).put("categoryId",category).put("itemName",item.trim()).put("unit",unit.trim()).put("quantity",quantity).put("location",location).put("note",note).put("days",days.toInt()).put("sourceReference",source.takeIf { it.isNotBlank() } ?: JSONObject.NULL).put("sourceOrderId",orderId.takeIf { it.isNotBlank() } ?: JSONObject.NULL).put("declaredValueMinor",minor ?: JSONObject.NULL).put("extraFields",JSONObject(extras))
            .put("evidence",JSONObject().put("photoBase64",photo).put("fraction",fraction.takeIf { it.isNotBlank() } ?: JSONObject.NULL).put("phone",if(contact!!.isNull("maskedPhone")) phone else JSONObject.NULL))
        custodyCommand(m.identity!!,"create",body,"登记新存酒\n会员 ${member.trim()} · $item\n$quantity $unit · $days 天 · 位置 $location\n请核对实物照片、余量和联系号码。此操作不增加可售库存，不登记销售收款。")
    } },enabled = m.canUseCustody && board.policy.getBoolean("enabled")) { Text("核对并入库存酒") }
}
@Composable
private fun CustodyDetail(m: AppModel, board: CustodyBoard, detail: JSONObject, propose: (()->LiveCommand)->Unit) {
    val order=detail.getJSONObject("order"); val id=order.getString("id")
    var quantity by remember { mutableStateOf(order.getString("remaining_quantity")) }; var code by remember { mutableStateOf("") }; var reason by remember { mutableStateOf("") }; var expiry by remember { mutableStateOf(serverInstant(order.getString("expires_at"))) }
    var returnQuantity by remember { mutableStateOf("") }; var mode by remember { mutableStateOf("original") }; var photo by remember { mutableStateOf("") }; var phone by remember { mutableStateOf("") }; var fraction by remember { mutableStateOf("") }; var memberContact by remember { mutableStateOf<JSONObject?>(null) }; var notice by remember { mutableStateOf("") }; var image by remember { mutableStateOf<String?>(null) }
    val scope=rememberCoroutineScope()
    LaunchedEffect(m.custodyReceipt) { if(m.custodyReceipt?.optString("operation") == "verify") code = "" }
    Text("处理原单 · ${order.getString("public_id")}",style=MaterialTheme.typography.titleMedium)
    Text("会员 ${order.getString("member_no")} · ${order.getString("item_name")} · 剩余 ${order.getString("remaining_quantity")}${order.getString("unit")}")
    Text("位置 ${order.optString("location")} · 到期 ${historyExportTime(order.getString("expires_at"))}")
    if(order.getString("status")=="stored") {
        CustodyField("本次取酒数量",quantity,20) { quantity=it }
        SecondaryAction(onClick={ propose { custodyCommand(m.identity!!,"request_code",JSONObject().put("quantity",quantity),"发送取酒验证码\n原单 ${order.getString("public_id")} · $quantity ${order.getString("unit")}\n通过已配置服务号发送给会员；发送任务登记不等于送达。",order) } },enabled=m.canUseCustody) { Text("发送取酒验证码") }
    }
    for(challenge in detail.getJSONArray("challenges").objects()) {
        val active=challenge.isNull("consumed_at") && challenge.isNull("invalidated_at") && serverInstant(challenge.getString("expires_at"))>Instant.now()
        Text("验证码 · 取 ${challenge.getString("quantity")} · ${when(challenge.getString("delivery_status")){"accepted"->"服务号已接受发送";"failed"->"发送失败";else->"待发送/核对"}} · ${assignmentTime(challenge.getString("expires_at"))}到期")
        if(active && challenge.getString("delivery_status")=="accepted") {
            if(challenge.isNull("verified_at")) { CustodyField("会员提供的验证码",code,8) { code=it }; SecondaryAction(onClick={ propose { custodyCommand(m.identity!!,"verify",JSONObject().put("challengeId",challenge.getString("id")).put("code",code),"核验取酒验证码\n原单 ${order.getString("public_id")}\n仅核验身份，验证通过后仍需单独确认实物交付。",order) } },enabled=m.canUseCustody) { Text("核验验证码") } }
            else SecondaryAction(onClick={ propose { custodyCommand(m.identity!!,"collect",JSONObject().put("challengeId",challenge.getString("id")),"确认实物已取走\n原单 ${order.getString("public_id")}\n${challenge.getString("quantity")} ${order.getString("unit")}，请核对交给正确会员。提交后扣减该存酒单余量。",order) } },enabled=m.canUseCustody) { Text("确认实物已取走") }
        }
    }
    CustodyField("本次处理原因",reason,300) { reason=it }
    for(collection in detail.getJSONArray("collections").objects()) {
        Text("取酒 ${collection.getString("quantity")} · ${when(collection.getString("status")){"collected"->"待确认喝完或再存";"restored"->"已再存";else->"已结清"}}")
        if(collection.getString("status")=="collected") {
            SecondaryAction(onClick={ propose { custodyCommand(m.identity!!,"resolve_collection",JSONObject().put("collectionId",collection.getString("id")).put("quantity",JSONObject.NULL).put("reason",reason),"确认本次取酒已用完，不再寄存\n${order.getString("public_id")} · ${collection.getString("quantity")} ${order.getString("unit")}\n原因：$reason",order) } },enabled=m.canUseCustody) { Text("本次已用完，不再寄存") }
            if(board.policy.getBoolean("allowRestorage")) Foldout("登记本次余酒再存") {
                AssignmentChoice("再存方式",mode,listOf("original" to "沿用原单") + if(!board.policy.getBoolean("requireOriginalOrder")) listOf("new" to "创建关联新单") else emptyList()) { mode=it }
                if(order.getString("unit")=="瓶") AssignmentChoice("剩余比例",fraction,custodyFractions.keys.map { it to if(it.isBlank()) "自定义" else "$it 瓶" }) { fraction=it; if(it.isNotBlank()) returnQuantity=custodyFractions[it]!! }
                CustodyField("实际再存数量",returnQuantity,20) { returnQuantity=it; fraction="" }
                SecondaryAction(onClick={ scope.launch { try { memberContact=m.readCustodyExtra("/member-contact?memberNo="+LiveCommand.part(order.getString("member_no"))); notice="" } catch(e: Exception) { notice=e.message ?: "读取失败" } } },enabled=!m.busy) { Text("核对再存联系号码") }
                memberContact?.let { Text(it.textOrNull("maskedPhone") ?: "请填写本次联系号码"); if(it.isNull("maskedPhone")) CustodyField("再存联系手机号",phone,32) { phone=it } }
                CustodyPhotoCapture(m.priorityAccessKey+id+collection.getString("id"),!m.busy,photo) { photo=it }
                SecondaryAction(onClick={ propose { require(memberContact!=null) { "请先核对联系号码" }; require(custodyQuantity(returnQuantity)<=custodyQuantity(collection.getString("quantity"))) { "再存不能超过本次取酒量" }; custodyCommand(m.identity!!,"resolve_collection",JSONObject().put("collectionId",collection.getString("id")).put("quantity",returnQuantity).put("restorageMode",mode).put("reason",reason).put("evidence",JSONObject().put("photoBase64",photo).put("fraction",fraction.takeIf { it.isNotBlank() } ?: JSONObject.NULL).put("phone",if(memberContact!!.isNull("maskedPhone")) phone else JSONObject.NULL)),"登记余酒再存\n原单 ${order.getString("public_id")} · $returnQuantity ${order.getString("unit")}\n${if(mode=="new") "创建关联新单" else "沿用原单"}\n原因：$reason",order) } },enabled=m.canUseCustody) { Text("核对余酒并再存") }
            }
        }
    }
    Foldout("到期与归档") {
        AssignmentDatePicker("新到期时间",expiry) { expiry=it }
        SecondaryAction(onClick={ propose { require(expiry>Instant.now()); custodyCommand(m.identity!!,"expiry",JSONObject().put("expiresAt",expiry.toString()).put("reason",reason),"调整存酒到期时间\n原单 ${order.getString("public_id")}\n新到期 ${historyExportTime(expiry.toString())}\n原因：$reason",order) } },enabled=m.canUseCustody) { Text("核对到期调整") }
        SecondaryAction(onClick={ propose { custodyCommand(m.identity!!,"archive",JSONObject().put("reason",reason),"归档存酒原单\n${order.getString("public_id")}\n须无剩余存酒及未处理取酒。原因：$reason",order) } },enabled=m.canUseCustody && order.getString("status")=="collected") { Text("核对并归档") }
        SecondaryAction(onClick={ propose { custodyCommand(m.identity!!,"print_prepared",JSONObject(),"准备打印存酒凭证\n原单 ${order.getString("public_id")}\n打印凭证不代替取酒核验或确认交付。",order) } },enabled=m.canUseCustody) { Text("准备原单打印") }
    }
    Foldout("存入照片与操作记录") {
        for(deposit in detail.getJSONArray("deposits").objects()) { Text("${assignmentTime(deposit.getString("recorded_at"))} · ${deposit.getString("quantity")} · ${deposit.getString("phone_masked")}"); SecondaryAction(onClick={ scope.launch { try { image=m.readCustodyExtra("/$id/photos/${deposit.getString("id")}").getString("base64") } catch(e: Exception) { notice=e.message ?: "读取失败" } } },enabled=!m.busy) { Text("查看服务器留存照片") } }
        for(event in detail.getJSONArray("events").objects()) Text("${assignmentTime(event.getString("occurred_at"))} · ${event.textOrNull("employee_name") ?: "系统"} · ${custodyEventLabel(event.getString("event_type"))} · ${event.optString("reason")}")
        for(reminder in detail.getJSONArray("reminders").objects()) Text("到期前${reminder.getInt("days_before")}天提醒 · ${assignmentTime(reminder.getString("due_at"))} · ${custodyDeliveryLabel(reminder.getString("status"))}")
    }
    if(notice.isNotBlank()) Text(notice)
    image?.let { data -> val bitmap=remember(data) { Base64.decode(data,Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it,0,it.size) } }; AlertDialog(onDismissRequest={ image=null },confirmButton={ TextButton(onClick={ image=null }) { Text("关闭") } },text={ if(bitmap!=null) Image(bitmap.asImageBitmap(),contentDescription="服务器保存的带时间水印的存酒照片",modifier=Modifier.fillMaxWidth()) }); DisposableEffect(bitmap) { onDispose { bitmap?.recycle() } } }
}
fun custodyEventLabel(value: String) = mapOf("stored" to "存入","code_requested" to "请求验证码","code_verified" to "核验通过","code_rejected" to "验证码不符","collected" to "确认取走","restored" to "余酒再存","collection_closed" to "本次取酒结清","archived" to "归档","expiry_changed" to "调整到期","printed" to "准备打印")[value] ?: "记录更新"
fun custodyDeliveryLabel(value: String) = mapOf("pending" to "待发送","accepted" to "已接受发送","sent" to "已发送","retry" to "重试中","failed" to "发送失败","cancelled" to "已取消","skipped" to "已跳过")[value] ?: "待核对"
