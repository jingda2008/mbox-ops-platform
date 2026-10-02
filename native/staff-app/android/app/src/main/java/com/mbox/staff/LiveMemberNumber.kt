package com.mbox.staff
import org.json.JSONObject
import java.util.UUID
const val memberNumberRoot="/api/staff/native-member-number-policy"
fun memberNumberCommand(actor:StaffIdentity,board:JSONObject,policy:JSONObject,reason:String):LiveCommand{
 require(actor.allows("member.card.manage")&&board.getString("employeeId")==actor.employeeId&&board.getInt("protocol")==1&&board.getBoolean("durableCommands"))
 val width=policy.getInt("width");val start=policy.getLong("startNumber");val prefix=policy.getInt("maximumPrefixLength");val alphabet=policy.getString("alphabet")
 require(width in 4..12&&start in 1..999999999999L&&start< java.math.BigInteger.TEN.pow(width).toLong()&&prefix in 0..4&&width-prefix>=2){"总位数须4至12位，前缀最多4位并留至少2位数字，起始值不能超过位数"}
 require(Regex("^[A-Z]{1,26}$").matches(alphabet)&&alphabet.toSet().size==alphabet.length){"字母须为不重复的大写A至Z"};require(policy.get("padZero") is Boolean);require(reason.trim().length in 2..300)
 val b=JSONObject().put("policy",policy).put("version",board.getJSONObject("row").getInt("version")).put("reason",reason.trim());val id=UUID.randomUUID().toString()
 val proof=JSONObject().put("employeeId",actor.employeeId).put("confirmation","会员号总位数 $width · 起始数字 $start\n字母顺序 $alphabet · 最长前缀 $prefix\n${if(policy.getBoolean("padZero"))"不足位数补零"else "不足位数不补零"}\n仅影响新发号，已发会员号不变；候选号会继续跳过已占用号码。\n原因：${reason.trim()}")
 return LiveCommand(id,actor.employeeId,"调整会员号规则","member.card.manage",listOf(LiveStep(memberNumberRoot,b.toString(),"idempotency-key","native-business-$id",JSONObject().put("memberNumber",proof).toString())))
}
val LiveStep.memberNumberProof:JSONObject? get()=recoveryBody?.let{JSONObject(it).optJSONObject("memberNumber")}
fun validateMemberNumberReply(text:String,s:LiveStep){val root=JSONObject(text);val d=root.getJSONObject("data");val b=JSONObject(s.body);val p=s.memberNumberProof!!;require(root.getJSONObject("meta").getInt("protocol")==1&&root.getJSONObject("meta").get("replayed") is Boolean&&d.getString("employeeId")==p.getString("employeeId")&&d.getString("requestKey")==s.key&&calendarJson(d.getJSONObject("accepted"))==calendarJson(b));val r=d.getJSONObject("row");require(calendarJson(r.getJSONObject("policy"))==calendarJson(b.getJSONObject("policy"))&&r.getInt("version")==if(b.getInt("version")==0)2 else b.getInt("version")+1);require(r.has("nextCandidate")&&(r.isNull("nextCandidate")||Regex("^[A-Z0-9]{1,12}$").matches(r.getString("nextCandidate"))))}
