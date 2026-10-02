package com.mbox.staff
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class ServiceRecoveryTest {
 private fun command():LiveCommand {
  val raw=JSONObject(javaClass.classLoader!!.getResourceAsStream("live-service.json")!!.bufferedReader().readText())
  return LiveServiceBoard(raw.getJSONObject("board")).command("task-1","complete","已核对现场情况","manager-2","normal",StaffIdentity.parse(raw.getJSONObject("auth")))
 }
 private fun reply(c:LiveCommand):JSONObject {
  val req=serviceRecoveryRequest(c,"主管已核对原任务");val b=req.getJSONObject("original")
  val normalized=JSONObject().put("taskId",req.getString("taskId")).put("action",req.getString("action")).put("employeeId",c.employeeID).put("session",b.getString("tableSessionId")).put("taskType",b.getString("taskType")).put("expectedStatus",b.getString("expectedStatus")).put("expectedPriority",b.getString("expectedPriority")).put("expectedAssigned",b.get("expectedAssignedEmployeeId")).put("note",b.getString("note").trim()).put("assigned",JSONObject.NULL).put("priority",JSONObject.NULL)
  val resolution=JSONObject().put("disposition","withdrawn").put("originalKey",req.getString("originalKey")).put("taskId",req.getString("taskId")).put("action",req.getString("action")).put("employeeId",c.employeeID).put("supervisorId",UUID.randomUUID().toString()).put("resolvedAt","2026-10-01T00:00:00Z")
  val data=JSONObject(resolution.toString()).put("original",normalized).put("receipt",JSONObject.NULL).put("resolution",resolution)
  return JSONObject().put("data",data).put("meta",JSONObject().put("replayed",false))
 }
 @Test fun acceptsOnlyMatchingPermanentWithdrawalAndNeverFlattensUnknownOrChangedContent(){
  val c=command();assertTrue(validateServiceRecoveryReply(reply(c).toString(),c).contains("未执行"))
  for(key in listOf("originalKey","taskId","employeeId","action")){val raw=reply(c);raw.getJSONObject("data").put(key,"foreign");assertThrows(Exception::class.java){validateServiceRecoveryReply(raw.toString(),c)}}
  val changed=reply(c);changed.getJSONObject("data").getJSONObject("original").put("note","different");assertThrows(Exception::class.java){validateServiceRecoveryReply(changed.toString(),c)}
  val unknown=reply(c);unknown.getJSONObject("data").put("disposition","unknown");assertThrows(Exception::class.java){validateServiceRecoveryReply(unknown.toString(),c)}
  val same=reply(c);same.getJSONObject("data").getJSONObject("resolution").put("supervisorId",c.employeeID);assertThrows(Exception::class.java){validateServiceRecoveryReply(same.toString(),c)}
 }
 @Test fun committedRequiresOriginalServiceReceiptAndMultistepCannotBeCleared(){
  val c=command();val raw=reply(c);val data=raw.getJSONObject("data");data.put("disposition","committed").put("receipt",JSONObject().put("id","task-1").put("tableSessionId","session-old").put("taskType","guest.complaint").put("status","completed"))
  assertTrue(validateServiceRecoveryReply(raw.toString(),c).contains("未重复"))
  data.getJSONObject("receipt").put("status","pending");assertThrows(Exception::class.java){validateServiceRecoveryReply(raw.toString(),c)}
  assertThrows(Exception::class.java){serviceRecoveryRequest(c.copy(steps=c.steps+c.steps),"主管现场核对")}
  assertThrows(Exception::class.java){serviceRecoveryRequest(c.copy(employeeID="other"),"主管现场核对")}
 }
}
