package com.mbox.staff

import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CustodyTest {
    private fun actor()=StaffIdentity("s","e","staff","员工","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("bottle.manage.all","bottle.custody.export","member.card.manage"),emptySet())
    private fun order()=JSONObject().put("id",UUID.randomUUID().toString()).put("public_id","TEST-CUSTODY").put("version",2).put("remaining_quantity","2.000000")
    @Test fun securePayloadNeverLeavesOtpPhoneOrPhotoInPendingJson() {
        val record=order(); val body=JSONObject().put("challengeId",UUID.randomUUID().toString()).put("code","123456")
        val command=custodyCommand(actor(),"verify",body,"验证原单",record)
        val secrets=mutableMapOf<String,String>(); val secured=secureCustodyCommand(command) { key,value -> secrets[key]=value }
        assertFalse(secured.json().toString().contains("123456")); assertEquals(body.toString(),secrets[command.id]); assertEquals("2",custodyHeaders(secured.steps[0])["x-custody-version"])
        assertEquals(secured,LiveCommand.parse(JSONObject(secured.json().toString())))
        assertEquals(secured,secureCustodyCommand(secured) { _,_ -> fail("must not overwrite original secret") })
        val result=JSONObject().put("verified",false).put("message","验证码错误")
        val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("operation","verify").put("employeeId","e").put("requestKey",secured.steps[0].key).put("result",result))
        assertFalse(validateCustodyReply(reply.toString(),secured.steps[0],body).getBoolean("verified"))
        reply.getJSONObject("data").put("employeeId","other")
        assertThrows(IllegalArgumentException::class.java) { validateCustodyReply(reply.toString(),secured.steps[0],body) }
    }
    @Test fun exactQuantityAndPermissionsBlockUnsafeRequests() {
        assertEquals("0.000001",custodyQuantity("0.000001").toPlainString())
        for(value in listOf("0","-1","1e2","0.0000001","NaN")) assertThrows(IllegalArgumentException::class.java) { custodyQuantity(value) }
        assertThrows(IllegalArgumentException::class.java) { custodyCommand(actor(),"request_code",JSONObject().put("quantity","3"),"取酒",order()) }
        assertThrows(IllegalArgumentException::class.java) { custodyCommand(actor().copy(denied=setOf("bottle.manage.all")),"request_code",JSONObject().put("quantity","1"),"取酒",order()) }
    }
    @Test fun printAndExportReceiptAreBoundToOriginalAction() {
        val order=order(); val command=custodyCommand(actor(),"print_prepared",JSONObject(),"打印原单",order)
        val result=JSONObject().put("publicId",order.getString("public_id")).put("document",JSONObject().put("order",order))
        val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",false)).put("data",JSONObject().put("operation","print_prepared").put("employeeId","e").put("requestKey",command.steps[0].key).put("result",result))
        validateCustodyReply(reply.toString(),command.steps[0],JSONObject())
        result.put("publicId","OTHER")
        assertThrows(IllegalArgumentException::class.java) { validateCustodyReply(reply.toString(),command.steps[0],JSONObject()) }
    }
}
