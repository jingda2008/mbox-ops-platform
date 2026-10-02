package com.mbox.staff
import org.json.JSONObject
import org.junit.Test
import org.junit.Assert.*
class CommercePolicyTest{
 private val actor=StaffIdentity("s","e","manager","主管","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("payment.policy.manage"),emptySet())
 private fun row()=JSONObject().put("policyVersion",2).put("policyOnlinePaymentEnabled",false).put("onlinePaymentEnabled",false).put("providerConfigured",false).put("paymentReservationMinutes",10)
 private fun board(row:JSONObject)=CommercePolicyBoard(JSONObject().put("employeeId","e").put("protocol",1).put("durableCommands",true).put("row",row))
 @Test fun cannotEnableUnconfiguredProviderButCanClosePreviouslyEnabledPolicy(){val r=row();assertThrows(IllegalArgumentException::class.java){commercePolicyCommand(actor,board(r),"online-payment","true","未就绪不能开放")};r.put("policyOnlinePaymentEnabled",true);val c=commercePolicyCommand(actor,board(r),"online-payment","false","关闭新线上支付");assertFalse(JSONObject(c.steps[0].body).getBoolean("enabled"));assertEquals(c,LiveCommand.parse(c.json()));assertThrows(IllegalArgumentException::class.java){commercePolicyCommand(actor,board(r),"payment-reservation","31","核对新单库存保留")}}
 @Test fun durationReceiptCannotSilentlyChangePaymentSwitch(){val r=row().put("providerConfigured",true).put("policyOnlinePaymentEnabled",true).put("onlinePaymentEnabled",true);val c=commercePolicyCommand(actor,board(r),"payment-reservation","8","调整新单库存时限");val saved=JSONObject(r.toString()).put("policyVersion",3).put("paymentReservationMinutes",8).put("updatedByEmployeeId","e").put("reason","调整新单库存时限");val response=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("employeeId","e").put("requestKey",c.steps[0].key).put("action","payment-reservation").put("row",saved));validateCommercePolicyReply(response.toString(),c.steps[0]);saved.put("policyOnlinePaymentEnabled",false).put("onlinePaymentEnabled",false);assertThrows(IllegalArgumentException::class.java){validateCommercePolicyReply(response.toString(),c.steps[0])}}
}
