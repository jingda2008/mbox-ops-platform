package com.mbox.staff
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch

@Composable fun LiveMembershipOverviewView(m:AppModel,close:()->Unit){
 val access=remember{m.priorityAccessKey};val workspace=remember{m.workspaceVersion};val scope=rememberCoroutineScope()
 var board by remember{mutableStateOf<MembershipOverview?>(null)};var state by remember{mutableStateOf("")};var loading by remember{mutableStateOf(false)};var section by remember{mutableStateOf("points")}
 fun load(){if(loading)return;loading=true;board=null;state="正在核对已发布规则";scope.launch{try{board=m.readMembershipOverview();state="读取完成。时间状态按本机时钟展示，实际核算以服务器为准。"}catch(e:Exception){state=e.message?:"读取失败，请重试"}finally{loading=false}}}
 LaunchedEffect(Unit){load()};LaunchedEffect(m.priorityAccessKey,m.workspaceVersion){if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion){board=null;close()}};if(access!=m.priorityAccessKey||workspace!=m.workspaceVersion)return
 Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize(),color=Paper){LazyColumn(Modifier.safeDrawingPadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  item{Row{Text("等级与权益规则",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("关闭")}};Text(state,style=MaterialTheme.typography.bodySmall);TextButton(onClick={load()},enabled=!loading&&!m.busy){Text("刷新原规则")};AssignmentChoice("查看",section,listOf("points" to "积分与成长值","tiers" to "等级评定","benefits" to "等级权益","catalog" to "积分兑换")){section=it}}
  val b=board
  if(b!=null){val rows=when(section){"points"->b.points;"tiers"->b.tiers;"benefits"->b.benefits;else->b.catalog.getJSONArray("items").objects().filter{it.getString("catalogStatus")=="published"}}
   if(section=="catalog")item{val control=b.catalog.getJSONObject("control");Text("兑换运行状态："+(mapOf("disabled" to "未开放","paused" to "暂停","pilot" to "试运行","enabled" to "已启用","active" to "已启用")[control.getString("state")]?:"待核对"));control.textOrNull("reason")?.let{Text(it)};Text("展示已发布目录，当前是否可兑仍需核对会员资格、时间和库存。",style=MaterialTheme.typography.bodySmall)}
   if(rows.isEmpty())item{Text("当前没有已发布记录")}
   items(rows,key={it.getString(if(section=="catalog")"publicId"else "id")}){r->Panel{
    if(section!="catalog"){Text("第${r.getInt("version")}版 · ${membershipEffective(r)}",style=MaterialTheme.typography.titleMedium);Text(membershipPeriod(r),style=MaterialTheme.typography.bodySmall);Text(r.getString("reason"))}
    when(section){
     "points"->{Text("每 ${historyMoney(r.getLong("pointsDenominatorMinor"))} 符合条件的消费获得 ${r.getLong("pointsNumerator")} 积分");Text("每 ${historyMoney(r.getLong("growthDenominatorMinor"))} 符合条件的消费获得 ${r.getLong("growthNumerator")} 成长值");Text("积分有效期 ${r.getInt("pointsValidityMonths")} 个月");Text("取整规则："+(mapOf("floor" to "向下取整","half_up" to "四舍五入")[r.getString("roundingMode")]?:r.getString("roundingMode")))}
     "tiers"->{Text("评估窗口 ${r.getInt("evaluationWindowMonths")} 个月 · 等级周期 ${r.getInt("tierPeriodMonths")} 个月\n降级宽限 ${r.getInt("downgradeGraceDays")} 天");for((key,name)in listOf("silver" to "银卡","gold" to "金卡")){Text("$name：升级 ${r.getLong(key+"UpgradeGrowth")} 成长值 · 保级 ${r.getLong(key+"RetainGrowth")} 成长值\n积分倍率 ${membershipRatio(r,key+"PointsMultiplierNumerator",key+"PointsMultiplierDenominator")}")}}
     "benefits"->{Text("关联等级政策第${r.getInt("tierPolicyVersion")}版");for(rule in r.getJSONArray("rules").objects()){HorizontalDivider();Text("${rule.textOrNull("benefitName")?:"权益定义待核对"} · ${if(rule.getBoolean("enabled"))"规则启用"else "规则停用"}");Text("${membershipTierName(rule.getString("eligibleTier"))}${if(rule.getBoolean("inheritToHigherTiers"))"及更高等级"else "限定等级"} · ${rule.getInt("quantity")}份 · 有效 ${rule.getInt("validityDays")} 天");Text("发放时机："+listOfNotNull(if(rule.getBoolean("grantOnEntry"))"进入等级"else null,if(rule.getBoolean("grantOnRetention"))"保级"else null).joinToString("、"));Text(if(rule.getString("revocationPolicy")=="protect_until_expiry")"降级后保护到权益到期"else "降级后撤销未预留权益")}}
     "catalog"->{Text("${r.getString("name")} · ${r.getLong("pointsRequired")} 积分",style=MaterialTheme.typography.titleMedium);Text("目录第${r.getInt("catalogVersion")}版 · ${membershipTierName(r.getString("minimumTier"))}起\n${if(r.getString("status")=="active")"项目启用"else "项目停用"}");Text("${calendarLocal(r.getString("availableFrom"))} 至 ${r.textOrNull("availableUntil")?.let(::calendarLocal)?:"未设置结束时间"}");Text("总库存上限 ${r.textOrNull("totalInventory")?:"不限"} · 每日上限 ${r.textOrNull("dailyInventory")?:"不限"}\n每会员每日 ${r.getInt("memberDailyLimit")} · 滚动30天 ${r.getInt("memberRolling30DayLimit")} · 累计 ${r.textOrNull("memberLifetimeLimit")?:"不限"}");Text("${if(r.getBoolean("requiresTableSession"))"需要在桌"else "无需在桌"} · ${if(r.getBoolean("requiresEmployeeFulfillment"))"员工确认交付"else "按原系统自动履约"}");Text("${if(r.getBoolean("cancellationAllowedBeforeFulfillment"))"交付前允许取消"else "交付前不可自行取消"} · 履约时限 ${r.getInt("fulfillmentTimeoutMinutes")} 分钟\n退回过期积分保留 ${r.getInt("restoreExpiredPointsDays")} 天")}
    }
   }}
  }
 }}}
}
