package com.mbox.staff
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class MemberNumberTest{
 private val actor=StaffIdentity("s","e","m","主管","2099-01-01T00:00:00Z","2099-01-01T00:00:00Z",emptyList(),setOf("member.card.manage"),emptySet())
 private fun policy()=JSONObject().put("width",6).put("startNumber",100001).put("padZero",true).put("alphabet","ABCDEFG").put("maximumPrefixLength",2)
 private fun board()=JSONObject().put("employeeId","e").put("protocol",1).put("durableCommands",true).put("row",JSONObject().put("version",0))
 @Test fun refusesDuplicateAlphabetAndPrefixesThatLeaveNoNumericSpace(){for(p in listOf(policy().put("alphabet","AA"),policy().put("width",4).put("maximumPrefixLength",4),policy().put("startNumber",1000000)))assertThrows(IllegalArgumentException::class.java){memberNumberCommand(actor,board(),p,"核对规则")}}
 @Test fun onlyOriginalSavedPolicyAndReceiptClearTheRequest(){val c=memberNumberCommand(actor,board(),policy(),"调整新会员号规则");assertEquals(c,LiveCommand.parse(c.json()));val r=JSONObject().put("meta",JSONObject().put("protocol",1).put("replayed",true)).put("data",JSONObject().put("employeeId","e").put("requestKey",c.steps[0].key).put("accepted",JSONObject(c.steps[0].body)).put("row",JSONObject().put("policy",policy()).put("version",2).put("nextCandidate","100001")));validateMemberNumberReply(r.toString(),c.steps[0]);r.getJSONObject("data").getJSONObject("row").getJSONObject("policy").put("width",7);assertThrows(IllegalArgumentException::class.java){validateMemberNumberReply(r.toString(),c.steps[0])}}
}
