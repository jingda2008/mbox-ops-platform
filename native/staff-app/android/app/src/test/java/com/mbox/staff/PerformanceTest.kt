package com.mbox.staff
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
class PerformanceTest {
 private fun actor()=StaffIdentity("s","e","staff","员工","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),performancePermissions,emptySet())
 @Test fun shanghaiTimesAndMonthlyBoundaryRemainExact(){
  assertEquals("2026-10-01T12:00:00Z",performanceTime("2026-10-01 20:00"));assertEquals("2026-10-02 01:00",performanceLocal("2026-10-02 01:00:00+08"))
  val body=JSONObject().put("month","2026-10").put("slots",JSONArray().put(JSONObject().put("performerId",UUID.randomUUID().toString()).put("startsAt","2026-09-30T16:00:00Z").put("endsAt","2026-10-01T01:00:00Z")))
  performanceCommand(actor(),"publish",body,"发布排班")
  body.getJSONArray("slots").getJSONObject(0).put("endsAt","2026-10-01T16:01:00Z")
  assertThrows(IllegalArgumentException::class.java){performanceCommand(actor(),"publish",body,"不能超过24小时")}
 }
 @Test fun originalScheduleReceiptCannotBeReplacedByOtherAction(){
  val id=UUID.randomUUID().toString();val body=JSONObject().put("scheduleId",id).put("expected","a".repeat(64)).put("targetStatus","performing");val command=performanceCommand(actor(),"schedule-status",body,"开始演出")
  val result=JSONObject().put("id",id).put("status","performing");val response=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("action","schedule-status").put("employeeId","e").put("requestKey",command.steps[0].key).put("result",result))
  validatePerformanceReply(response.toString(),command.steps[0]);assertEquals(command,LiveCommand.parse(command.json()))
  result.put("id",UUID.randomUUID().toString());assertThrows(IllegalArgumentException::class.java){validatePerformanceReply(response.toString(),command.steps[0])}
  assertThrows(IllegalArgumentException::class.java){performanceCommand(actor().copy(denied=setOf("song.manage")),"schedule-status",body,"开始演出")}
 }
 @Test fun bulkSongInputRejectsAmbiguousDuplicatesAndPreservesAliases(){
  val songs=parseNativeSongRows("A01 | 后来 | Hou Lai,后来的歌\n月亮代表我的心");assertEquals(2,songs.length());assertEquals(2,songs.getJSONObject(0).getJSONArray("aliases").length());assertTrue(songs.getJSONObject(1).isNull("code"))
  assertThrows(IllegalArgumentException::class.java){parseNativeSongRows("A01 | 后来\na01 | 其他歌")};assertThrows(IllegalArgumentException::class.java){parseNativeSongRows("A01 | ")};assertEquals(0,parseNativeSongRows("").length())
 }
}
