package com.mbox.staff
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.util.UUID
class OwnerFinanceTest {
    private fun actor()=StaffIdentity("s","e","staff","员工","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),ownerPermissions,emptySet())
    @Test fun payrollApprovalIsBoundToOriginalVersionActorAndEncryptedInput() {
        val row=JSONObject().put("id",UUID.randomUUID().toString()).put("version",7);val body=JSONObject().put("reason","核对员工工资123456元")
        val command=ownerCommand(actor(),"payroll-run.approve",body,"确认工资123456元",row)
        val saved=mutableMapOf<String,String>();val secure=secureOwnerCommand(command){k,v->saved[k]=v}
        assertFalse(secure.json().toString().contains("123456"));assertEquals(body.toString(),saved[command.id]);assertEquals("7",ownerHeaders(secure.steps[0])["x-owner-version"])
        assertEquals(secure,LiveCommand.parse(JSONObject(secure.json().toString())))
        val result=JSONObject().put("id",row.getString("id")).put("publicId","payroll-original").put("aggregateVersion",8).put("status","approved")
        val reply=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("operation","commercial.payroll-run.approve").put("employeeId","e").put("requestKey",secure.steps[0].key).put("result",result))
        validateOwnerReply(reply.toString(),secure.steps[0],body)
        result.put("aggregateVersion",7);assertThrows(IllegalArgumentException::class.java){validateOwnerReply(reply.toString(),secure.steps[0],body)}
        result.put("aggregateVersion",8).put("id",UUID.randomUUID().toString());assertThrows(IllegalArgumentException::class.java){validateOwnerReply(reply.toString(),secure.steps[0],body)}
    }
    @Test fun exactMoneyAndExplicitPermissions() {
        assertEquals(1001L,ownerMoney("10.01"));for(v in listOf("-1","0.001","1e2","NaN",""))assertThrows(IllegalArgumentException::class.java){ownerMoney(v)}
        assertThrows(IllegalArgumentException::class.java){ownerCommand(actor().copy(denied=setOf("commercial.payroll.manage")),"compensation-rule.create",JSONObject(),"修改工资")}
        assertEquals("commercial.payroll.post",ownerPermission("payroll-run.post"))
        assertEquals("commercial.cost.manage",ownerPermission("cost.correct"))
    }
}
