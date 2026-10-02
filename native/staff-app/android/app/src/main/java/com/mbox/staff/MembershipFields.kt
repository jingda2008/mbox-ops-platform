package com.mbox.staff
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
val membershipFieldLabels=mapOf("pointsNumerator" to "获得积分","pointsDenominatorMinor" to "消费金额（元）","growthNumerator" to "获得成长值","growthDenominatorMinor" to "消费金额（元）","roundingMode" to "取整方式","pointsValidityMonths" to "积分有效月数","evaluationWindowMonths" to "评估周期（月）","tierPeriodMonths" to "等级周期（月）","downgradeGraceDays" to "降级宽限天数","silverUpgradeGrowth" to "银卡升级值","silverRetainGrowth" to "银卡保级值","goldUpgradeGrowth" to "金卡升级值","goldRetainGrowth" to "金卡保级值","silverPointsMultiplierNumerator" to "银卡获得积分","silverPointsMultiplierDenominator" to "银卡基础积分","goldPointsMultiplierNumerator" to "金卡获得积分","goldPointsMultiplierDenominator" to "金卡基础积分","tierPolicyVersionId" to "适用等级规则","rules" to "规则","items" to "兑换项","ruleCode" to "规则编号","eligibleTier" to "适用等级","inheritToHigherTiers" to "向更高等级继承","grantOnEntry" to "入级发放","grantOnRetention" to "保级发放","benefitDefinitionId" to "发放权益","quantity" to "数量","validityDays" to "有效天数","revocationPolicy" to "降级处理","enabled" to "启用","publicId" to "公开编号","itemCode" to "兑换项编号","name" to "名称","fulfillmentKind" to "履约类型","productId" to "兑换商品","activityId" to "关联活动","pointsRequired" to "所需积分","costAmountMinor" to "成本（元）","currency" to "币种","totalInventory" to "总库存","dailyInventory" to "日库存","memberDailyLimit" to "每人每日上限","memberRolling30DayLimit" to "每人30日上限","memberLifetimeLimit" to "每人终身上限","minimumTier" to "最低等级","requiresTableSession" to "需在已开台的桌位使用","requiresEmployeeFulfillment" to "需由员工交付","cancellationAllowedBeforeFulfillment" to "交付前允许取消","restoreExpiredPointsDays" to "退回过期积分天数","availableFrom" to "可用开始时间","availableUntil" to "可用结束时间","fulfillmentTimeoutMinutes" to "履约时限（分钟）","status" to "状态","campaignCode" to "活动积分编号","stackingGroup" to "叠加组","stackingMode" to "叠加方式","priority" to "优先级","storeBudgetPoints" to "门店总预算积分","perMemberPointsLimit" to "每会员上限","pointValidityDays" to "积分有效天数","refundPolicy" to "退款冲回规则","budgetReuseAfterRefund" to "退款后释放预算","memberLimitReuseAfterRefund" to "退款后释放个人限额","eligibleMemberLevels" to "适用会员等级","triggerKind" to "触发事实","points" to "奖励积分","perMemberAwardLimit" to "每人奖励次数","minimumPaidAmountMinor" to "最低付款金额（元）","title" to "标题","summary" to "摘要","content" to "正文","notificationType" to "通知类型","authorizationPurpose" to "授权用途","authorizationContext" to "授权场景","templateId" to "微信模板ID","pagePath" to "到达页面","pointsDataKey" to "积分字段","balanceDataKey" to "余额字段","occurredAtDataKey" to "发生时间字段","expiresAtDataKey" to "到期时间字段","expiryLeadDays" to "提前提醒天数","maxPerCustomerPer24h" to "每人24小时上限","minimumIntervalMinutes" to "最短发送间隔","quietHoursStart" to "静默开始","quietHoursEnd" to "静默结束")
val membershipFieldChoices=mapOf("notificationType" to listOf("loyalty_points_credited" to "积分到账","loyalty_points_reversed" to "积分退回或扣回","loyalty_points_expiring" to "积分即将到期"),"authorizationPurpose" to listOf("loyalty_balance_change" to "积分余额变动","loyalty_expiry_reminder" to "积分到期提醒"),"authorizationContext" to listOf("loyalty_accrual" to "消费积分到账","loyalty_refund" to "退款积分调整","loyalty_expiry" to "积分到期"),"roundingMode" to listOf("floor" to "向下取整","nearest" to "四舍五入"),"eligibleTier" to listOf("member" to "普通会员","silver" to "银卡","gold" to "金卡"),"minimumTier" to listOf("member" to "普通会员","silver" to "银卡","gold" to "金卡"),"revocationPolicy" to listOf("revoke_unreserved" to "撤回未使用权益","protect_until_expiry" to "保留至到期"),"fulfillmentKind" to listOf("product" to "商品","benefit" to "权益","activity" to "活动","service" to "服务"),"status" to listOf("active" to "启用","paused" to "暂停","retired" to "退役"),"stackingMode" to listOf("stackable" to "可叠加","exclusive_highest" to "同组取最高","exclusive_first" to "同组取最先"),"refundPolicy" to listOf("reverse_on_any_refund" to "任一退款冲回","reverse_on_full_refund" to "全额退款冲回"),"triggerKind" to listOf("activity_payment" to "付款成功","activity_check_in" to "完成签到","activity_completion" to "活动完成"))
fun newMembershipContent(domain:String):JSONObject=JSONObject(when(domain){
"base_points" -> """{"domain":"base_points","pointsNumerator":1,"pointsDenominatorMinor":100,"growthNumerator":1,"growthDenominatorMinor":100,"roundingMode":"floor","pointsValidityMonths":12}"""
"tier_policy" -> """{"domain":"tier_policy","evaluationWindowMonths":12,"tierPeriodMonths":12,"downgradeGraceDays":0,"silverUpgradeGrowth":0,"silverRetainGrowth":0,"goldUpgradeGrowth":0,"goldRetainGrowth":0,"silverPointsMultiplierNumerator":1,"silverPointsMultiplierDenominator":1,"goldPointsMultiplierNumerator":1,"goldPointsMultiplierDenominator":1}"""
"tier_benefits" -> """{"domain":"tier_benefits","tierPolicyVersionId":"","rules":[]}"""
"redemption_catalog" -> """{"domain":"redemption_catalog","items":[]}"""
"promotion_points" -> """{"domain":"promotion_points","campaignCode":"","name":"","activityId":"","stackingGroup":"","stackingMode":"stackable","priority":0,"storeBudgetPoints":0,"perMemberPointsLimit":0,"pointValidityDays":30,"refundPolicy":"reverse_on_any_refund","budgetReuseAfterRefund":false,"memberLimitReuseAfterRefund":false,"eligibleMemberLevels":["member"],"rules":[]}"""
"membership_terms" -> """{"domain":"membership_terms","title":"","summary":"","content":""}"""
else->error("请选择已有托管通知草稿")
})
fun newMembershipItem(domain:String):JSONObject=JSONObject(when(domain){
"tier_benefits" -> """{"ruleCode":"","eligibleTier":"member","inheritToHigherTiers":false,"grantOnEntry":true,"grantOnRetention":false,"benefitDefinitionId":"","quantity":1,"validityDays":30,"revocationPolicy":"revoke_unreserved","enabled":true}"""
"promotion_points" -> """{"ruleCode":"","triggerKind":"activity_payment","points":0,"perMemberAwardLimit":1,"minimumPaidAmountMinor":0,"enabled":true}"""
"redemption_catalog" -> """{"publicId":"","itemCode":"","name":"","fulfillmentKind":"product","productId":null,"benefitDefinitionId":null,"activityId":null,"pointsRequired":0,"costAmountMinor":0,"currency":"CNY","totalInventory":null,"dailyInventory":null,"memberDailyLimit":1,"memberRolling30DayLimit":1,"memberLifetimeLimit":null,"minimumTier":"member","requiresTableSession":true,"requiresEmployeeFulfillment":true,"cancellationAllowedBeforeFulfillment":true,"restoreExpiredPointsDays":0,"availableFrom":"","availableUntil":null,"fulfillmentTimeoutMinutes":30,"status":"active"}"""
else->error("此规则没有明细")
}).also{if(domain=="redemption_catalog")it.put("publicId","RDI-"+UUID.randomUUID().toString())}
val membershipNullableNumbers=setOf("totalInventory","dailyInventory","memberLifetimeLimit","expiryLeadDays")
val membershipMoneyFields=setOf("pointsDenominatorMinor","growthDenominatorMinor","costAmountMinor","minimumPaidAmountMinor")
val membershipNumericFields=membershipMoneyFields+membershipNullableNumbers+setOf("pointsNumerator","growthNumerator","pointsValidityMonths","evaluationWindowMonths","tierPeriodMonths","downgradeGraceDays","silverUpgradeGrowth","silverRetainGrowth","goldUpgradeGrowth","goldRetainGrowth","silverPointsMultiplierNumerator","silverPointsMultiplierDenominator","goldPointsMultiplierNumerator","goldPointsMultiplierDenominator","quantity","validityDays","pointsRequired","memberDailyLimit","memberRolling30DayLimit","restoreExpiredPointsDays","fulfillmentTimeoutMinutes","priority","storeBudgetPoints","perMemberPointsLimit","pointValidityDays","points","perMemberAwardLimit","maxPerCustomerPer24h","minimumIntervalMinutes")
val membershipReferenceFields=setOf("tierPolicyVersionId","productId","benefitDefinitionId","activityId")
val membershipNullableText=setOf("productId","benefitDefinitionId","activityId","balanceDataKey","expiresAtDataKey","quietHoursStart","quietHoursEnd","availableUntil")
fun membershipEditingContent(source:JSONObject):JSONObject{
 fun objectValue(value:JSONObject):JSONObject {val result=JSONObject(value.toString());for(key in value.keys()){
  val v=value.get(key)
  if(v is JSONObject)result.put(key,objectValue(v))
  else if(v is JSONArray)result.put(key,JSONArray((0 until v.length()).map{if(v.get(it) is JSONObject)objectValue(v.getJSONObject(it)) else v.get(it)}))
  else if(v!=JSONObject.NULL&&key in membershipMoneyFields)result.put(key,java.math.BigDecimal(v.toString()).movePointLeft(2).toPlainString())
  else if(v!=JSONObject.NULL&&key in setOf("availableFrom","availableUntil")&&v.toString().isNotBlank())result.put(key,serverInstant(v.toString()).atZone(java.time.ZoneId.of("Asia/Shanghai")).toLocalDateTime().format(java.time.format.DateTimeFormatter.ISO_LOCAL_DATE_TIME).replace('T',' '))
 };return result};return objectValue(source)
}
fun membershipNormalizeContent(source:JSONObject):JSONObject{
 fun objectValue(value:JSONObject):JSONObject {val result=JSONObject(value.toString());for(key in value.keys()){
  val v=value.get(key);val raw=if(v==JSONObject.NULL)"" else v.toString().trim();val label=membershipFieldLabels[key]?:key
  when{
   v is JSONObject->result.put(key,objectValue(v))
   v is JSONArray->result.put(key,JSONArray((0 until v.length()).map{if(v.get(it) is JSONObject)objectValue(v.getJSONObject(it)) else v.get(it)}))
   key in membershipNumericFields->{if(raw.isBlank()&&key in membershipNullableNumbers)result.put(key,JSONObject.NULL) else {val n=try{if(key in membershipMoneyFields){require(Regex("^\\d+(\\.\\d{1,2})?$").matches(raw));java.math.BigDecimal(raw).movePointRight(2).longValueExact()}else {require(Regex("^\\d+$").matches(raw));raw.toLong()}}catch(_:Exception){error("$label 格式无效")};require(n in 0..2147483647L){"$label 超出范围"};result.put(key,n)}}
   key in setOf("availableFrom","availableUntil")->result.put(key,if(raw.isBlank()&&key=="availableUntil")JSONObject.NULL else membershipDate(raw))
   key in membershipNullableText->result.put(key,raw.takeIf{it.isNotBlank()}?:JSONObject.NULL)
   v is String->result.put(key,raw)
  }
 };return result};return objectValue(source)
}
fun membershipDate(value:String):String{
 val raw=value.trim().replace(' ','T')
 return java.time.LocalDateTime.parse(raw,java.time.format.DateTimeFormatter.ISO_LOCAL_DATE_TIME).atZone(java.time.ZoneId.of("Asia/Shanghai")).toOffsetDateTime().format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)
}
