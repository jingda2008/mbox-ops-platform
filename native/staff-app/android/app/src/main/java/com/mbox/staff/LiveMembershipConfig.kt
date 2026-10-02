package com.mbox.staff
import java.util.UUID
import org.json.JSONObject
const val membershipConfigRoot="/api/staff/native-membership-config"
val membershipDomainNames=linkedMapOf("base_points" to "基础积分","tier_policy" to "会员等级","tier_benefits" to "等级权益","redemption_catalog" to "积分兑换","promotion_points" to "促销积分","membership_terms" to "入会条款","wechat_notifications" to "微信服务通知")
val membershipConfigStatus=mapOf("draft" to "待编辑与审批","approved" to "已审批待发布","published" to "已发布，按生效时间执行","paused" to "暂停","retired" to "退役")
val membershipControls=mapOf("points_accrual" to "积分累积","points_redemption" to "积分兑换","wechat_notification" to "微信通知")
class MembershipConfigBoard(val data:JSONObject){val employee=data.getString("employeeId");val enabled=data.getBoolean("durableCommands")&&data.getInt("protocol")==1;val rows=data.getJSONArray("items").objects();val references=data.getJSONArray("references").objects()}
fun membershipPermission(action:String,domain:String)=when(action){
 "control"->"loyalty.operations.control"
 "create"->when(domain){"redemption_catalog"->"loyalty.redemption.catalog.manage";"promotion_points"->"loyalty.promotion.manage";"membership_terms"->"membership.terms.manage";else->"loyalty.policy.manage"}
 "publish"->when(domain){"redemption_catalog"->"loyalty.redemption.catalog.publish";"promotion_points"->"loyalty.promotion.publish";"membership_terms"->"membership.terms.publish";else->"loyalty.policy.publish"}
 else->"loyalty.configuration.$action"
}
fun membershipConfigCommand(actor:StaffIdentity,body:JSONObject,summary:String):LiveCommand{
 val action=body.getString("action");require(action in setOf("create","edit","preview","approve","publish","control"));val domain=body.optJSONObject("content")?.getString("domain")?:body.optString("domain","")
 val permission=membershipPermission(action,domain);require(actor.allows(permission)){"当前岗位没有此项权限"}
 if(action!="preview")require(body.getString("reason").trim().length in 2..500){"请填写2至500字实际说明"}
 if(action!="control")require(domain in membershipDomainNames)
 if(action in setOf("edit","preview","approve","publish")){UUID.fromString(body.getString("configurationId"));require(body.getInt("expectedRevision")>0)}
 if(action=="control"){require(body.getString("capability") in membershipControls);require(body.getString("operation") in setOf("pause","resume"));require(body.getInt("expectedVersion")>=0)}
 val id=UUID.randomUUID().toString();val proof=JSONObject().put("action",action).put("domain",domain).put("employeeId",actor.employeeId).put("confirmation",summary)
 return LiveCommand(id,actor.employeeId,summary.lineSequence().first(),permission,listOf(LiveStep("$membershipConfigRoot/commands",body.toString(),"idempotency-key","native-business-$id",JSONObject().put("membershipConfig",proof).toString())))
}
val LiveStep.membershipConfigProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("membershipConfig")}
fun validateMembershipConfigReply(text:String,step:LiveStep){
 val body=JSONObject(step.body);val proof=step.membershipConfigProof!!;val root=JSONObject(text);val meta=root.getJSONObject("meta");require(meta.getInt("protocol")==1&&meta.get("replayed") is Boolean)
 val d=root.getJSONObject("data");val action=body.getString("action");require(d.getString("action")==action&&d.getString("domain")==proof.getString("domain")&&d.getString("employeeId")==proof.getString("employeeId")&&d.getString("requestKey")==step.key)
 val result=d.getJSONObject("result")
 if(action=="control"){require(d.isNull("configurationId"));require(result.getString("capability")==body.getString("capability")&&result.getInt("version")==body.getInt("expectedVersion")+1&&result.getString("state")==if(body.getString("operation")=="pause")"paused" else "active");return}
 val configId=d.getString("configurationId");UUID.fromString(configId);if(action!="create")require(configId==body.getString("configurationId"))
 when(action){
  "create"->require(result.getString("id")==configId&&result.getString("status")=="draft")
  "edit","approve"->{require(result.getString("publicId")==configId&&result.getString("domain")==proof.getString("domain")&&result.getString("status")==if(action=="edit")"draft" else "approved");require(result.getInt("revision")==body.getInt("expectedRevision")+if(action=="edit")1 else 0)}
  "preview"->{require(result.getString("draftPublicId")==configId&&result.getInt("draftRevision")==body.getInt("expectedRevision")&&result.getString("domain")==proof.getString("domain"));require(result.getString("publicId").startsWith("MCIP"));serverInstant(result.getString("expiresAt"));require(result.getString("fingerprint").isNotBlank())}
  "publish"->require(result.getString("id")==configId&&result.getString("status")=="published")
 }
}
