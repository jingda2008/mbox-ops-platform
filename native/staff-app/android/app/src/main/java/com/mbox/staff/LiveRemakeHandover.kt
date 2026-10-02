package com.mbox.staff
import java.util.UUID
import org.json.JSONObject
import org.json.JSONArray
const val remakeHandoverRoot="/api/commerce/item-after-sales"
class RemakeHandoverBoard(val data:JSONObject){val employee=data.getString("employeeId");val enabled=data.getBoolean("supportsNativePhysicalRecovery")&&data.getInt("protocol")==1;val rows=data.getJSONArray("items").objects()}
fun remakeHandoverCommand(actor:StaffIdentity,row:JSONObject,quantity:Int,disposition:String,received:Boolean,reason:String):LiveCommand{
 require(actor.allows("refund.request"));require(disposition in setOf("used_loss","returned_unopened"));val permission=if(disposition=="returned_unopened")"inventory.receive" else "inventory.waste";require(actor.allows(permission))
 val all=row.getJSONArray("unitIds");require(quantity in 1..minOf(999,all.length())){"请选择本批实际份数"};val ids=(0 until quantity).map{all.getString(it)};require(ids.distinct().size==quantity);ids.forEach{UUID.fromString(it)}
 require(row.getBoolean(if(disposition=="returned_unopened")"canReceive" else "canRecordUsed")){"当前岗位不能登记此实物去向"}
 if(disposition=="returned_unopened"){require(received){"须确认实物已收回且未开封"};val eligibility=row.getJSONObject("returnEligibility");require(ids.all{eligibility.optJSONObject(it)?.optBoolean("canReturn")==true}){"原包装或库存证据不支持退回，请核对"}}
 require(reason.trim().length in 2..500){"请填写2至500字实际原因"};val batch=row.getString("batchId");UUID.fromString(batch);val item=row.getString("itemId");UUID.fromString(item)
 val body=JSONObject().put("actorId",actor.employeeId).put("unitIds",JSONArray(ids)).put("disposition",disposition).put("unopenedReceived",disposition=="returned_unopened"&&received).put("reason",reason.trim())
 val title=if(disposition=="returned_unopened")"登记离店实物退回" else "登记离店实物耗用或损耗"
 val proof=JSONObject().put("batchId",batch).put("itemId",item).put("employeeId",actor.employeeId).put("confirmation","$title\n原桌 ${row.getString("tableCode")} · ${row.getString("productName")}\n原订单 ${row.getString("orderPublicId")}\n实际 $quantity 份\n${reason.trim()}\n这里只登记本批实物去向，不执行收款、退款或重复重做。")
 val id=UUID.randomUUID().toString();return LiveCommand(id,actor.employeeId,title,permission,listOf(LiveStep("$remakeHandoverRoot/native-remakes/$batch/after-visit-physical",body.toString(),"idempotency-key","native-remedy-$id",JSONObject().put("remakeHandover",proof).toString())))
}
val LiveStep.remakeHandoverProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("remakeHandover")}
fun validateRemakeHandoverReply(text:String,step:LiveStep){
 val root=JSONObject(text);val data=root.getJSONObject("data");val p=step.remakeHandoverProof!!;require(root.getInt("protocol")==1&&root.get("replayed") is Boolean)
 require(data.getString("employeeId")==p.getString("employeeId")&&data.getString("requestKey")==step.key&&data.getString("batchId")==p.getString("batchId")&&data.getString("itemId")==p.getString("itemId")&&data.getInt("remainingQuantity")>=0)
}
