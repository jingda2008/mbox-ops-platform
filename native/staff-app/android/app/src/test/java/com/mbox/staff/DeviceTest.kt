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
}
