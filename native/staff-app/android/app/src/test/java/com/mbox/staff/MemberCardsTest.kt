package com.mbox.staff
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.util.UUID
class MemberCardsTest {
 private fun actor()=StaffIdentity("s","e","staff","员工","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),memberCardPermissions,emptySet())
 @Test fun immutableReplyBindsActorActionAndOriginalApplication(){
  val body=JSONObject().put("applicationId",UUID.randomUUID().toString()).put("decision","approve").put("reason","核对已申请会员")
  val command=memberCardCommand(actor(),"review",body,"审核通过");assertEquals(command,LiveCommand.parse(command.json()))
  val result=JSONObject().put("applicationId",body.getString("applicationId")).put("status","approved").put("cardId",UUID.randomUUID().toString())
  val data=JSONObject().put("action","review").put("employeeId","e").put("requestKey",command.steps[0].key).put("result",result)
  val reply=JSONObject().put("data",data).put("meta",JSONObject().put("protocol",1).put("replayed",true))
  validateMemberCardReply(reply.toString(),command.steps[0]);data.put("employeeId","other");assertThrows(IllegalArgumentException::class.java){validateMemberCardReply(reply.toString(),command.steps[0])}
  data.put("employeeId","e");result.put("applicationId",UUID.randomUUID().toString());assertThrows(IllegalArgumentException::class.java){validateMemberCardReply(reply.toString(),command.steps[0])}
 }
 @Test fun projectOpeningAndReviewUseSeparateAuthorities(){
  val body=JSONObject().put("projectId",UUID.randomUUID().toString()).put("expectedUpdatedAt","2026-10-01 01:02:03.000001+08").put("state","open").put("reason","独立审核开放")
  assertEquals("loyalty.policy.publish",memberCardCommand(actor(),"state",body,"开放项目").permission)
  assertThrows(IllegalArgumentException::class.java){memberCardCommand(actor().copy(denied=setOf("loyalty.policy.publish")),"state",body,"开放项目")}
  body.put("state","paused");assertEquals("member.card.manage",memberCardCommand(actor(),"state",body,"暂停申请").permission)
 }
}
