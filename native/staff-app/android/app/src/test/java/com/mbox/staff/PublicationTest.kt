package com.mbox.staff
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
class PublicationTest{
 @Test fun independentPublicationRejectsSelfAndSealsFullDraftText(){
  val actor=StaffIdentity("s","e","manager","经理","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("privacy.policy.manage","privacy.policy.publish"),emptySet());val id=UUID.randomUUID().toString();val row=JSONObject().put("id",id).put("policyVersion","PRIVACY-1").put("status","draft").put("draftedByEmployeeId","e")
  val b=PublicationBoard(JSONObject().put("employeeId","e").put("protocol",1).put("durableCommands",true).put("permissions",JSONArray(actor.permissions.toList())).put("employees",JSONArray()).put("profiles",JSONArray()).put("policies",JSONArray().put(row)).put("versions",JSONObject().put("privacy","a".repeat(64))))
  val publish=JSONObject().put("policyVersion","PRIVACY-1").put("approvedBy","测试独立人员").put("approvalReference","REAL-APPROVAL-001").put("reason","发布原已复核内容");assertThrows(IllegalArgumentException::class.java){publicationCommand(actor,b,"privacy-publish",publish,"发布政策")}
  val content="正文测试内容，敏感联系人和草稿不写入普通待办记录。".repeat(6);val body=JSONObject().put("policyVersion","PRIVACY-1").put("content",content).put("operatorName","测试主体").put("contact","test@example.test").put("dataRetentionPolicyVersion","R1").put("thirdPartyRegisterVersion","T1").put("reason","草拟测试内容");val c=publicationCommand(actor,b,"privacy-draft",body,"保存草稿");val vault=mutableMapOf<String,String>();val secured=securePublicationCommand(c){k,v->vault[k]=v};assertFalse(secured.json().toString().contains(content));assertEquals(content,JSONObject(vault[c.id]!!).getString("content"));assertEquals(secured,LiveCommand.parse(secured.json()))
  val sha=java.security.MessageDigest.getInstance("SHA-256").digest(content.toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)};val result=JSONObject().put("id",id).put("status","draft").put("policyVersion","PRIVACY-1").put("contentSha256",sha);val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("employeeId","e").put("action","privacy-draft").put("requestKey",secured.steps[0].key).put("result",result));validatePublicationReply(reply.toString(),secured.steps[0],JSONObject(vault[c.id]!!));result.put("contentSha256","0".repeat(64));assertThrows(IllegalArgumentException::class.java){validatePublicationReply(reply.toString(),secured.steps[0],JSONObject(vault[c.id]!!))}
 }
 @Test fun mediaReadsAreBoundedForOldAndroidWithoutNewInputStreamMethods(){assertEquals(204801,readMediaBytes(java.io.ByteArrayInputStream(ByteArray(300000))).size);assertEquals(42,readMediaBytes(java.io.ByteArrayInputStream(ByteArray(42))).size)}
}
