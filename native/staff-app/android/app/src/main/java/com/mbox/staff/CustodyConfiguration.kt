package com.mbox.staff

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

@Composable
fun CustodyConfiguration(m: AppModel, board: CustodyBoard, propose: (()->LiveCommand)->Unit) {
    var draft by remember(board.config) { mutableStateOf(JSONObject(board.policy.toString())) }
    var reason by remember { mutableStateOf("") }; var extraLabel by remember { mutableStateOf("") }; var extraType by remember { mutableStateOf("text") }; var extraRequired by remember { mutableStateOf(false) }
    var categoryId by remember { mutableStateOf<String?>(null) }; var code by remember { mutableStateOf("") }; var name by remember { mutableStateOf("") }; var days by remember { mutableStateOf("20") }; var sort by remember { mutableStateOf("0") }; var active by remember { mutableStateOf(true) }
    fun patch(key: String, value: Any) { draft=JSONObject(draft.toString()).put(key,value) }
    Foldout("存酒规则与凭证") {
        Text("提醒和取酒验证码依赖所选服务号。授权订阅与真实送达另行核对。修改规则不会抹去历史单据。")
        for((key,label) in listOf("enabled" to "启用新存酒","remindersEnabled" to "启用到期提醒","allowPartial" to "允许部分取酒及再存","allowRestorage" to "允许余酒再存","requireOriginalOrder" to "再存必须沿用原单")) Row { Text(label,Modifier.weight(1f)); Switch(draft.getBoolean(key),{ patch(key,it) }) }
        AssignmentChoice("归档方式",draft.getString("archiveMode"),listOf("automatic" to "全部取酒处理后自动归档","manual" to "人工归档")) { patch("archiveMode",it) }
        for((key,label) in listOf("defaultDays" to "默认存期（1—3660天）","codeDigits" to "验证码位数（4—8）","codeTtlSeconds" to "验证码有效秒数（60—600）","resendSeconds" to "重发间隔秒数（30—600）","maximumAttempts" to "最大错误次数（1—10）")) CustodyField(label,draft.get(key).toString(),5) { patch(key,it) }
        var reminderDays by remember(board.config) { mutableStateOf(board.policy.getJSONArray("reminderDays").let { array -> (0 until array.length()).joinToString(",") { array.getInt(it).toString() } }) }
        var reminderTime by remember(board.config) { mutableStateOf(board.policy.getInt("sendMinute").let { "%02d:%02d".format(it/60,it%60) }) }
        CustodyField("到期前提醒天数，逗号分隔，最多12档",reminderDays,100) { reminderDays=it }
        CustodyField("提醒时间 HH:mm（16:00—17:00）",reminderTime,5) { reminderTime=it }
        AssignmentChoice("发送服务号",draft.textOrNull("serviceAccountId").orEmpty(),listOf("" to "未绑定") + board.config.getJSONArray("accounts").objects().map { it.getString("id") to it.getString("name") }) { patch("serviceAccountId",it.takeIf { it.isNotBlank() } ?: JSONObject.NULL) }
        for((key,label,max) in listOf(Triple("numberPattern","存酒编号格式：须保留 {date} {time} {member} {serial}",200),Triple("printTitle","凭证标题",100),Triple("printFooter","凭证页脚",300),Triple("reminderText","提醒内容",500))) CustodyField(label,draft.getString(key),max) { patch(key,it) }
        for((key,choices) in listOf("printFields" to linkedMapOf("category" to "品类","item" to "酒名","quantity" to "原存量","remaining" to "剩余量","expiry" to "到期时间","location" to "存放位置","status" to "状态","source" to "原购凭证"),"reportDimensions" to linkedMapOf("category" to "品类","status" to "状态","date" to "日期"))) {
            Text(if(key=="printFields") "凭证字段" else "报表维度")
            for((value,label) in choices) { val values=draft.getJSONArray(key).let { a -> (0 until a.length()).map { a.getString(it) } }; Row { Checkbox(value in values,{ checked -> patch(key,JSONArray(if(checked) values+value else values-value)) }); Text(label) } }
        }
        Text("自定义登记项目（最多20项，历史单据保留原项目名称）")
        val definitions=draft.getJSONArray("extraFieldDefinitions").objects()
        for(field in definitions) Row { Text(field.getString("label") + if(field.getBoolean("required")) " · 必填" else " · 选填",Modifier.weight(1f)); TextButton(onClick={ patch("extraFieldDefinitions",JSONArray(definitions.filter { it.getString("key")!=field.getString("key") })) }) { Text("移除") } }
        CustodyField("新项目名称",extraLabel,30) { extraLabel=it }
        AssignmentChoice("填写方式",extraType,listOf("text" to "文字","number" to "数字","date" to "日期")) { extraType=it }
        Row { Text("必填",Modifier.weight(1f)); Switch(extraRequired,{ extraRequired=it }) }
        SecondaryAction(onClick={ val field=JSONObject().put("key","field_"+java.util.UUID.randomUUID().toString().replace("-","").take(24)).put("label",extraLabel.trim()).put("type",extraType).put("required",extraRequired); patch("extraFieldDefinitions",JSONArray(definitions+field)); extraLabel="" },enabled=definitions.size<20 && extraLabel.isNotBlank()) { Text("添加到待保存规则") }
        CustodyField("规则修改原因",reason,300) { reason=it }
        PrimaryAction(onClick={ propose {
            val policy=JSONObject(draft.toString())
            for(key in listOf("defaultDays","codeDigits","codeTtlSeconds","resendSeconds","maximumAttempts")) policy.put(key,policy.get(key).toString().toInt())
            val time=java.time.LocalTime.parse(reminderTime); require(time.hour*60+time.minute in 960..1020); policy.put("sendMinute",time.hour*60+time.minute)
            policy.put("reminderDays",JSONArray(reminderDays.split(',', '，').map { it.trim().toInt() }))
            custodyCommand(m.identity!!,"policy",JSONObject().put("policy",policy).put("version",board.config.getInt("version")).put("reason",reason),"保存存酒规则\n启用新存酒：${policy.getBoolean("enabled")} · 部分领取：${policy.getBoolean("allowPartial")}\n默认${policy.getInt("defaultDays")}天 · 提醒${if(policy.getBoolean("remindersEnabled")) "开启" else "关闭"}\n原因：$reason\n将按刚才编辑的服务号、验证码限制和打印字段保存；不会主动向会员发送测试消息。")
        } },enabled=m.canUseCustody && m.identity?.allows("member.card.manage")==true) { Text("核对并保存规则") }
    }
    Foldout("存酒品类管理") {
        for(row in board.categories) Row { Text("${row.getString("name")} · ${row.getInt("default_days")}天 · ${if(row.getBoolean("active")) "启用" else "停用"}",Modifier.weight(1f)); TextButton(onClick={ categoryId=row.getString("id"); code=row.getString("code"); name=row.getString("name"); days=row.getInt("default_days").toString(); sort=row.getInt("sort_order").toString(); active=row.getBoolean("active") }) { Text("编辑") } }
        CustodyField("品类编码",code,40) { code=it }; CustodyField("品类名称",name,60) { name=it }; CustodyField("默认存期天数",days,4) { days=it }; CustodyField("排序",sort,5) { sort=it }; Row { Text("启用",Modifier.weight(1f)); Switch(active,{ active=it }) }
        SecondaryAction(onClick={ propose { val body=JSONObject().put("code",code.trim()).put("name",name.trim()).put("defaultDays",days.toInt()).put("sortOrder",sort.toInt()).put("active",active); categoryId?.let { body.put("id",it) }; custodyCommand(m.identity!!,"category",body,"保存存酒品类\n$name · $code · 默认${days}天 · ${if(active) "启用" else "停用"}",category=board.categories.find { it.getString("id")==categoryId }) } },enabled=m.canUseCustody && m.identity?.allows("member.card.manage")==true) { Text("核对并保存品类") }
        TextButton(onClick={ categoryId=null; code=""; name=""; days="20"; sort="0"; active=true }) { Text("清空并新增品类") }
    }
}
@Composable
fun CustodyReports(m: AppModel, propose: (()->LiveCommand)->Unit) {
    var scopeName by remember { mutableStateOf("custody") }; var member by remember { mutableStateOf("") }; var category by remember { mutableStateOf("") }; var from by remember { mutableStateOf("") }; var to by remember { mutableStateOf("") }; var report by remember { mutableStateOf<JSONObject?>(null) }; var notice by remember { mutableStateOf("") }; val coroutine=rememberCoroutineScope()
    fun filters()=mapOf("scope" to scopeName,"memberNo" to member.trim(),"category" to category.trim()) + custodyDateRange(from,to)
    fun load(offset: Int=0) { try { val query=custodyQuery(filters() + ("offset" to offset.toString())); report=null; coroutine.launch { try { report=m.readCustodyExtra("/report?$query"); notice="" } catch(e: Exception) { notice=e.message ?: "读取失败" } } } catch(e: Exception) { notice=e.message ?: "请核对筛选" } }
    Text("登记价值与消费应付分别统计，均不等于实收收入。筛选商品品类时，消费报表计入符合条件的整笔订单。")
    AssignmentChoice("统计范围",scopeName,listOf("custody" to "存酒单") + if(m.identity?.allows("order.history.all")==true) listOf("sales" to "消费订单","all" to "全部，分别汇总") else emptyList()) { scopeName=it; report=null }
    CustodyField("会员号，可留空",member,64) { member=it; report=null }; CustodyField("品类名称或编码",category,64) { category=it; report=null }; CustodyField("开始日期 YYYY-MM-DD",from,10) { from=it; report=null }; CustodyField("结束日期 YYYY-MM-DD",to,10) { to=it; report=null }
    PrimaryAction(onClick={ load() },enabled=!m.busy) { Text("查询统计") }
    SecondaryAction(onClick={ propose { custodyCommand(m.identity!!,"report_export",JSONObject(filters().filterValues { it.isNotBlank() }),"导出存酒统计\n范围：${if(scopeName=="custody") "存酒" else if(scopeName=="sales") "消费" else "存酒与消费分别汇总"}\n登记价值不是营业收入，文件含会员经营信息。") } },enabled=m.canUseCustody && m.identity?.allows("bottle.custody.export")==true) { Text("导出所选统计") }
    if(notice.isNotBlank()) Text(notice)
    report?.let { data ->
        for(row in data.getJSONArray("summary").objects()) Text("${if(row.getString("type")=="custody") "存酒" else "消费"} ${row.getString("count")}单 · ${if(row.getString("type")=="custody") "登记价值" else "应付金额"} ${BusinessReports.amount(row,"amount_minor",row.getString("currency"))} · 未登记金额${row.getString("unknown_amount_count")}单")
        for(row in data.getJSONArray("items").objects()) Panel { Text(row.getString("public_id")); Text("${row.textOrNull("member_no") ?: "无会员关联"} · ${row.getString("category")} · ${historyExportTime(row.getString("occurred_at"))}"); Text(row.getString("amount_basis") + " " + BusinessReports.amount(row,"amount_minor",row.getString("currency"))) }
        if(!data.isNull("nextOffset")) SecondaryAction(onClick={ load(data.getInt("nextOffset")) },enabled=!m.busy) { Text("下一页报表") }
    }
}
