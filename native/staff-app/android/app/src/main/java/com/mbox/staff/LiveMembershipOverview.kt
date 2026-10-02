package com.mbox.staff
import org.json.JSONObject
import java.time.Instant

data class MembershipOverview(val points:List<JSONObject>,val tiers:List<JSONObject>,val benefits:List<JSONObject>,val catalog:JSONObject)
fun publishedMembershipRows(rows:List<JSONObject>)=rows.filter{it.getString("status")=="published"}.sortedByDescending{it.getInt("version")}
fun membershipEffective(row:JSONObject,now:Instant=Instant.now()):String{
 if(row.getString("status")!="published")return "未发布"
 val start=row.textOrNull("effectiveFrom")?.let(::serverInstant)?:return "生效时间待核对"
 val end=row.textOrNull("effectiveUntil")?.let(::serverInstant)
 return when{now<start->"已发布 · 待生效";end!=null&&now>=end->"历史已结束";else->"生效时段内"}
}
fun membershipPeriod(row:JSONObject)="${row.textOrNull("effectiveFrom")?.let(::calendarLocal)?:"开始时间待核对"} 至 ${row.textOrNull("effectiveUntil")?.let(::calendarLocal)?:"未设置结束时间"}"
fun membershipTierName(t:String)=mapOf("member" to "普卡","silver" to "银卡","gold" to "金卡")[t]?:"等级待核对"
fun membershipRatio(row:JSONObject,n:String,d:String):String{val numerator=row.getLong(n);val denominator=row.getLong(d);require(numerator>=0&&denominator>0);return "$numerator / $denominator"}
