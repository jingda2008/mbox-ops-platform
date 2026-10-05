package com.mbox.staff
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class ServiceReminderTest {
 private fun fixture()=JSONObject(javaClass.classLoader!!.getResourceAsStream("live-contract.json")!!.bufferedReader().readText()).getJSONObject("auth")
 private fun saved():String {val store=SessionTest.MemoryStore();val api=StaffAPI(store){APIResponse(200,JSONObject().put("data",fixture()).toString(),mapOf("Set-Cookie" to listOf("__Host-mbox_staff_session=original; Path=/; Secure; HttpOnly; Max-Age=3600")))};api.rememberSession=true;api.login("staff","1234",false);return store.text!!}
 private fun task(id:String,status:String="pending",priority:String="normal")=JSONObject().put("id",id).put("tableSessionId","session-old").put("status",status).put("priority",priority)
 private fun read(tasks:JSONArray,employee:String="employee-1",permissions:List<String> = listOf("service.view")):ReminderSnapshot {
  val api=StaffAPI(ReadOnlySessionSnapshot(saved())){request->if(request.path=="/api/auth/heartbeat")APIResponse(200,JSONObject().put("data",fixture().put("permissions",JSONArray(permissions))).toString()) else APIResponse(200,JSONObject().put("data",JSONObject().put("currentEmployeeId",employee).put("tasks",tasks)).toString())}
  return readServiceReminder(api,"employee-1","session-1")
 }
 @Test fun noBackgroundWritesOrIdentityResurrection(){val text=saved();val snapshot=ReadOnlySessionSnapshot(text);snapshot.write("new session");snapshot.remove();assertEquals(text,snapshot.read());assertTrue(reminderSessionMatches(text,"employee-1","session-1"));assertFalse(reminderSessionMatches(null,"employee-1","session-1"));assertFalse(reminderSessionMatches(text,"employee-2","session-1"));assertFalse(reminderSessionMatches(text,"employee-1","session-2"));assertFalse(reminderSessionMatches("broken","employee-1","session-1"))}
 @Test fun scopedUnfinishedCountsDeduplicateAndPriorityChangesRetrigger(){val a=read(JSONArray().put(task("a")).put(task("a")).put(task("b","completed")));assertEquals(1,a.count);assertEquals("a",a.firstTaskId);assertEquals("session-old",a.firstTableSessionId);val b=read(JSONArray().put(task("a","in_progress")));assertEquals(a.fingerprint,b.fingerprint);assertNotEquals(a.fingerprint,read(JSONArray().put(task("a",priority="urgent"))).fingerprint);assertEquals(0,read(JSONArray()).count)}
 @Test fun revokedAndForeignResponsesAreNeverNotified(){assertThrows(Exception::class.java){read(JSONArray().put(task("a")),employee="foreign")};assertThrows(Exception::class.java){read(JSONArray(),permissions=emptyList())}}
}
