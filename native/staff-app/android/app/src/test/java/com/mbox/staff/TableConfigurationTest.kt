package com.mbox.staff
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
class TableConfigurationTest{
 @Test fun busyTableAndStaleAreaCannotOverwriteOriginalConfiguration(){
  val actor=StaffIdentity("s","e","manager","经理","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("table.manage"),emptySet());val area=UUID.randomUUID().toString();val table=UUID.randomUUID().toString();val stamp="2026-10-01 00:00:00+08"
  val row=JSONObject().put("id",table).put("areaId",area).put("updatedAt",stamp).put("activeSessionId",UUID.randomUUID().toString())
  val board=TableConfigurationBoard(JSONObject().put("employeeId","e").put("protocol",1).put("durableCommands",true).put("tables",JSONArray().put(row)).put("areas",JSONArray().put(JSONObject().put("id",area).put("updatedAt",stamp))))
  val tableBody=JSONObject().put("tableId",table).put("areaId",area).put("code","A01").put("displayName","原桌台").put("capacity",4).put("minimumSpendMinor",JSONObject.NULL).put("expectedUpdatedAt",stamp).put("reason","现场调整桌牌").put("status","available")
  assertThrows(IllegalArgumentException::class.java){tableConfigurationCommand(actor,board,"table-update",tableBody,"修改桌台")}
  val areaBody=JSONObject().put("areaId",area).put("name","主区域").put("areaType","indoor").put("sortOrder",10).put("expectedUpdatedAt",stamp).put("reason","现场暂停区域").put("status","paused")
  assertThrows(IllegalArgumentException::class.java){tableConfigurationCommand(actor,board,"area-update",areaBody,"暂停区域")}
  row.put("activeSessionId",JSONObject.NULL);val command=tableConfigurationCommand(actor,board,"table-update",tableBody,"调整原桌台")
  assertEquals(command,LiveCommand.parse(command.json()));tableBody.put("capacity",6);assertEquals(4,JSONObject(command.steps[0].body).getInt("capacity"))
  tableBody.put("expectedUpdatedAt","2026-09-30 00:00:00+08");assertThrows(IllegalArgumentException::class.java){tableConfigurationCommand(actor,board,"table-update",tableBody,"旧配置")}
  val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("employeeId","e").put("action","table-update").put("requestKey",command.steps[0].key).put("result",JSONObject().put("id",table).put("areaId",area).put("code","A01").put("status","available").put("capacity",4)))
  validateTableConfigurationReply(reply.toString(),command.steps[0]);reply.getJSONObject("data").getJSONObject("result").put("id",UUID.randomUUID().toString());assertThrows(IllegalArgumentException::class.java){validateTableConfigurationReply(reply.toString(),command.steps[0])}
 }
}
