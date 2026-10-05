package com.mbox.staff

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DeviceTest {
    private fun actor() = StaffIdentity("s","e","staff","员工","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("printer.manage"),emptySet())
    private fun device() = JSONObject().put("code","printer-1").put("name","收银打印机").put("stationCode","cashier").put("status","active").put("printBridgeId",JSONObject.NULL).put("windowsQueueName",JSONObject.NULL).put("printProfile",JSONObject.NULL)
    @Test fun exactDeviceReceiptAndOriginalRequestArePreserved() {
        val body=JSONObject().put("kind","device-create").put("device",device()).put("reason","新建收银打印机")
        val c=DeviceCommands.make(body,actor(),"收银打印机")
        assertEquals(c,LiveCommand.parse(JSONObject(c.json().toString())))
        val data=JSONObject().put("kind","device-create").put("employeeId","e").put("reason","新建收银打印机")
            .put("row",device().put("id","new-device").put("deviceType","printer"))
        val reply=JSONObject().put("data",data).put("meta",JSONObject().put("replayed",true))
        validateDeviceReply(reply.toString(),c.steps.single())
        data.getJSONObject("row").put("windowsQueueName","OTHER_QUEUE")
        assertThrows(Exception::class.java){validateDeviceReply(reply.toString(),c.steps.single())}
        assertThrows(Exception::class.java){DeviceCommands.make(body,actor().copy(denied=setOf("printer.manage")),"配置")}
    }
    @Test fun policyBoundsAndRevocationAreExplicit() {
        val body=JSONObject().put("kind","policy-save").put("expected","f".repeat(64)).put("reason","调整打印份数")
            .put("policy",JSONObject().put("ticketKind","cashier_payment").put("enabled",false).put("copies",6))
        assertThrows(Exception::class.java){DeviceCommands.make(body,actor(),"支付凭证")}
        val id="11111111-1111-4111-8111-111111111111"
        val c=DeviceCommands.make(JSONObject().put("kind","bridge-revoke").put("id",id).put("reason","更换打印电脑"),actor(),"撤销原电脑，待打票不会自动转移")
        assertEquals("/api/hardware/native-print-bridges/$id/revoke",c.steps.single().path)
        assertEquals("revoked",c.steps.single().deviceProof!!.getJSONObject("row").getString("status"))
    }
    @Test fun inheritedPolicyCopiesSurviveEditingDiskRecoveryAndExactReceiptValidation() {
        val row = JSONObject().put("ticketKind", "cashier_payment").put("enabled", true)
            .put("copies", JSONObject.NULL).put("configurationFingerprint", "f".repeat(64))
        val draft = devicePolicyDraft(row).put("reason", "恢复路由默认份数")
        assertTrue(draft.getJSONObject("policy").has("copies"))
        assertTrue(draft.getJSONObject("policy").isNull("copies"))
        assertTrue(devicePolicyCopiesLabel(draft.getJSONObject("policy")).contains("跟随"))
        val original = DeviceCommands.make(draft, actor(), "支付凭证 · 跟随打印路由份数")
        val recovered = LiveCommand.parse(JSONObject(original.json().toString()))
        assertEquals(original, recovered)
        assertTrue(JSONObject(recovered.steps.single().body).getJSONObject("policy").isNull("copies"))
        val data = JSONObject().put("kind", "policy-save").put("employeeId", "e")
            .put("reason", "恢复路由默认份数").put("row", JSONObject(draft.getJSONObject("policy").toString()))
        val reply = JSONObject().put("data", data).put("meta", JSONObject().put("replayed", true))
        validateDeviceReply(reply.toString(), recovered.steps.single())
        data.getJSONObject("row").put("copies", "null")
        assertThrows(Exception::class.java) { validateDeviceReply(reply.toString(), recovered.steps.single()) }
        data.getJSONObject("row").put("copies", 1)
        assertThrows(Exception::class.java) { validateDeviceReply(reply.toString(), recovered.steps.single()) }
        data.getJSONObject("row").remove("copies")
        assertThrows(Exception::class.java) { validateDeviceReply(reply.toString(), recovered.steps.single()) }
        assertThrows(Exception::class.java) { validateDeviceReply("{\"error\":{\"code\":\"UNSUPPORTED\"}}", recovered.steps.single()) }
        for (copies in listOf(0, 6, 1.5)) {
            draft.getJSONObject("policy").put("copies", copies)
            assertThrows(Exception::class.java) { DeviceCommands.make(draft, actor(), "无效份数") }
        }
        draft.getJSONObject("policy").put("copies", 3)
        val fixed = DeviceCommands.make(draft, actor(), "固定3份")
        assertEquals(3, JSONObject(fixed.steps.single().body).getJSONObject("policy").getInt("copies"))
        data.getJSONObject("row").put("copies", "3")
        assertThrows(Exception::class.java) { validateDeviceReply(reply.toString(), fixed.steps.single()) }
        data.getJSONObject("row").put("copies", 3)
        validateDeviceReply(reply.toString(), fixed.steps.single())
    }

}
