package com.mbox.staff
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
class StaffAdministrationTest{
 @Test fun pinAndStoreCredentialsAreEncryptedBeforePendingPersistenceAndReplayKeepsOriginal(){
  val actor=StaffIdentity("s","e","admin","管理员","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("staff.access.configure"),emptySet());val employee=UUID.randomUUID().toString();val version="a".repeat(64)
  val b=StaffAdministrationBoard(JSONObject().put("employeeId","e").put("protocol",1).put("durableCommands",true).put("credentialVersion",version).put("overview",JSONObject().put("configurationVersion",version).put("employees",JSONArray().put(JSONObject().put("id",employee))).put("roles",JSONArray())))
  val body=JSONObject().put("employeeId",employee).put("pin","7931").put("reason","管理员重置PIN")
  val original=staffAdministrationCommand(actor,b,"pin",body,"重置员工PIN");val vault=mutableMapOf<String,String>();val secured=secureStaffAdministrationCommand(original){k,v->vault[k]=v}
  assertFalse(secured.json().toString().contains("7931"));assertFalse(secured.json().toString().contains("管理员重置PIN"));assertEquals("7931",JSONObject(vault[original.id]!!).getString("pin"));assertEquals(secured,LiveCommand.parse(secured.json()))
  body.put("pin","1111");assertEquals("7931",JSONObject(vault[original.id]!!).getString("pin"));assertEquals(secured,secureStaffAdministrationCommand(secured){_,_->error("已冻结不能重写")})
  val result=JSONObject().put("employeeId",employee).put("pinConfigured",true).put("revokedSessionCount",2)
  val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("employeeId","e").put("action","pin").put("requestKey",secured.steps[0].key).put("result",result))
  validateStaffAdministrationReply(reply.toString(),secured.steps[0],JSONObject(vault[original.id]!!));result.put("employeeId",UUID.randomUUID().toString());assertThrows(IllegalArgumentException::class.java){validateStaffAdministrationReply(reply.toString(),secured.steps[0],JSONObject(vault[original.id]!!))}
  val credential=staffAdministrationCommand(actor,b,"credential",JSONObject().put("credential","unique-store-secret").put("reason","换门店口令").put("validFrom","2099-01-01T00:00:00+08:00").put("validUntil","2099-01-02T00:00:00+08:00"),"更换口令")
  assertFalse(secureStaffAdministrationCommand(credential){k,v->vault[k]=v}.json().toString().contains("unique-store-secret"));assertEquals(version,JSONObject(vault[credential.id]!!).getString("credentialVersion"))
 }
 @Test fun wholeMinuteCredentialTimesStayCanonical(){
  for(value in listOf("2099-01-01T09:00:00+08:00","2099-01-01T09:00+08:00","2099-01-01T09:00:30.123+08:00","2099-01-01T01:00Z"))assertEquals(java.time.OffsetDateTime.parse(value).toInstant(),serverInstant(staffCredentialTime(value)))
 }
 @Test fun revokedPermissionMayOnlyAttemptOwnDeploymentReceiptRecovery(){
  val proof=JSONObject().put("staffAdministration",JSONObject().put("action","deploy"))
  val command=LiveCommand("id","e","核对原发布","staff.access.configure",listOf(LiveStep("/api/staff/native-administration/deploy","{}","idempotency-key","key",proof.toString())))
  assertTrue(command.isStaffPermissionReceiptRecovery());assertFalse(command.copy(steps=command.steps+command.steps).isStaffPermissionReceiptRecovery())
  assertFalse(command.copy(steps=listOf(command.steps[0].copy(recoveryBody=JSONObject().put("staffAdministration",JSONObject().put("action","pin")).toString()))).isStaffPermissionReceiptRecovery())
 }
}
