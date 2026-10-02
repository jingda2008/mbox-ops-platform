package com.mbox.staff
import java.util.UUID
import org.json.JSONObject
const val benefitWalletRoot="/api/staff/native-benefit-wallet"
val walletTypeNames=linkedMapOf("gift_product" to "赠品券","discount" to "折扣权益","credit" to "金额权益","access" to "入场或服务资格","other" to "其他权益")
val walletStateNames=mapOf("available" to "可使用","upcoming" to "未生效","reserved" to "已暂留","redeemed" to "已用完","expired" to "已到期","revoked" to "已撤销","unavailable" to "不可使用","outside_window" to "不在可用时段")
class BenefitWalletBoard(val data:JSONObject){
 val employee=data.getString("employeeId");val enabled=data.getInt("protocol")==1&&data.getBoolean("durableCommands")
 val customer=data.getString("customerId");val rows=data.getJSONArray("items").objects();val tables=data.getJSONArray("tables").objects();val limits=data.getJSONArray("limits").objects()
}
fun walletPermission(action:String)=when(action){"issue"->"benefit.issue";"cancel"->"benefit.cancel";else->"loyalty.redemption.fulfill"}
fun benefitWalletCommand(actor:StaffIdentity,board:BenefitWalletBoard,action:String,body:JSONObject,confirmation:String):LiveCommand{
 require(action in setOf("issue","reserve","redeem","cancel"));require(board.enabled&&board.employee==actor.employeeId&&body.getString("customerId")==board.customer)
 require(actor.allows(walletPermission(action))){"当前岗位没有此项权益权限"};UUID.fromString(board.customer)
 for(field in listOf("benefitId","reservationId","tableSessionId","authorizationLimitId","selectedProductId"))if(body.has(field))UUID.fromString(body.getString(field))
 if(action in setOf("issue","cancel"))require(body.getString("reason").trim().length in 2..256){"请填写2至256字实际原因"}
 require(body.getInt("quantity") in 1..if(action=="issue")10000 else 100){"份数超出允许范围"}
 if(action=="issue"){
  require(Regex("^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$").matches(body.getString("benefitCode"))){"权益编码须为英文字母、数字或下划线等"}
  require(body.getString("title").trim().length in 2..100&&body.getString("benefitCode").trim().length in 2..64){"请填写名称和编码"}
  val value=body.getLong("valueAmountMinor");require(value in 0..100000000);val limit=board.limits.find{it.getString("id")==body.getString("authorizationLimitId")}?:error("请选择当前岗位审批额度")
  require(limit.getString("currency")=="CNY");limit.textOrNull("amountMinor")?.toLong()?.let{require(value*body.getInt("quantity")<=it){"总价值超过当前岗位额度"}}
  val start=serverInstant(body.getString("validFrom"));body.textOrNull("validUntil")?.let{require(serverInstant(it)>start){"结束时间须晚于生效时间"}}
  if(body.getString("benefitType")=="gift_product")require(body.getJSONArray("allowedProductIds").length()>0){"请选择实际可兑付商品"}
 }else{
  val row=board.rows.find{it.getString("id")==body.getString("benefitId")}?:error("请重新读取原权益")
  if(action=="reserve"){
   require(!row.optBoolean("snackClaim")&&row.getString("state")=="available"&&row.optJSONObject("pricePromise")==null){"此券须按原使用规则办理"}
   require(body.getInt("quantity")<=row.getInt("quantityAvailable")&&body.getInt("expectedVersion")==row.getInt("version")){"数量或版本已变化"}
   require(board.tables.any{it.getString("id")==body.getString("tableSessionId")}){"请选择会员当前实际所在桌次"}
  }else{
   val hold=row.getJSONArray("reservations").objects().find{it.getString("id")==body.getString("reservationId")}?:error("原暂留已变化")
   require(hold.getString("tableSessionId")==body.getString("tableSessionId")&&hold.getInt("quantity")==body.getInt("quantity"))
   if(action=="redeem"){require(!row.optBoolean("snackClaim")&&hold.getBoolean("canRedeem"));require(row.optJSONObject("pricePromise")==null)
    if(row.getString("type")=="gift_product")require(row.getJSONArray("products").objects().any{it.getString("id")==body.optString("selectedProductId")&&it.getString("status")=="active"}){"请选择允许的实际商品"}
   }
  }
 }
 val id=UUID.randomUUID().toString();val proof=JSONObject().put("action",action).put("employeeId",actor.employeeId).put("confirmation",confirmation)
 return LiveCommand(id,actor.employeeId,confirmation.lineSequence().first(),walletPermission(action),listOf(LiveStep("$benefitWalletRoot/commands/$action",body.toString(),"idempotency-key","native-business-$id",JSONObject().put("benefitWallet",proof).toString())))
}
val LiveStep.benefitWalletProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("benefitWallet")}
fun validateBenefitWalletReply(text:String,step:LiveStep){
 val root=JSONObject(text);val meta=root.getJSONObject("meta");require(meta.getInt("protocol")==1&&meta.get("replayed") is Boolean)
 val d=root.getJSONObject("data");val p=step.benefitWalletProof!!;val b=JSONObject(step.body);val action=p.getString("action");val result=d.getJSONObject("result")
 require(d.getString("employeeId")==p.getString("employeeId")&&d.getString("action")==action&&d.getString("requestKey")==step.key&&d.getString("customerId")==b.getString("customerId"))
 UUID.fromString(result.getString("id"))
 if(action=="issue")require(result.getString("benefitCode")==b.getString("benefitCode")&&result.getInt("quantityTotal")==b.getInt("quantity")&&result.getString("customerId")==b.getString("customerId"))
 else{require(result.getString("benefitId")==b.getString("benefitId")&&result.getString("tableSessionId")==b.getString("tableSessionId")&&result.getInt("quantity")==b.getInt("quantity"))
  if(action=="redeem")require(result.getString("benefitReservationId")==b.getString("reservationId")) else require(result.getString("status")==if(action=="cancel")"cancelled" else "reserved")
  if(action=="cancel")require(result.getString("id")==b.getString("reservationId"))
 }
}
