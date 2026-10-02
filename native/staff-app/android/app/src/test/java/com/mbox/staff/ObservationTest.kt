package com.mbox.staff
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
class ObservationTest {
 fun fixture()=JSONObject(javaClass.classLoader!!.getResourceAsStream("live-observation.json")!!.bufferedReader().use{it.readText()})
 fun actor()=StaffIdentity.parse(fixture().getJSONObject("auth"))
 fun reply(data:JSONObject)=JSONObject().put("data",data).put("meta",JSONObject().put("replayed",true)).toString()
 @Test fun parseAndExplicitConfirmation(){val b=ObservationBoard(fixture().getJSONObject("board"));val p=b.parse(b.draft!!.getString("rawContent"),true,actor());assertEquals(p,LiveCommand.parse(JSONObject(p.json().toString())));validateObservationReply(reply(b.draft!!),p.steps[0])
 assertThrows(Exception::class.java){b.confirm("candidate-1","","too_sweet","","客人说太甜",actor())};assertThrows(Exception::class.java){b.confirm("other","customer_quote","too_sweet","","客人说太甜",actor())}
 val c=b.confirm("candidate-1","customer_quote","too_sweet","",b.draft!!.getString("rawContent"),actor());val event=JSONObject(c.steps[0].body).getJSONArray("events").getJSONObject(0).put("id","event-2");event.put("selectedCandidateId",event.get("candidateId"));val data=JSONObject().put("publicId","observation-1").put("status","confirmed").put("serviceTaskId","task-1").put("events",JSONArray().put(event));validateObservationReply(reply(data),c.steps[0]);data.put("serviceTaskId",JSONObject.NULL);assertThrows(Exception::class.java){validateObservationReply(reply(data),c.steps[0])}
 val unlinked=b.confirm("","staff_judgement","other","unknown","尚未确认具体商品",actor());val u=JSONObject(unlinked.steps[0].body).getJSONArray("events").getJSONObject(0);assertEquals("table",u.getString("scopeKind"));assertTrue(u.isNull("productId"))
 }
 @Test fun revisionRetainsSource(){val b=ObservationBoard(fixture().getJSONObject("board"));val c=b.revise("observation-old","event-1","staff_judgement","other","unknown","核对原话后纠正分类",actor());val e=JSONObject(c.steps[0].body).getJSONObject("replacement");assertEquals("product-1",e.getString("productId"));assertEquals("candidate-1",e.getString("candidateId"));assertEquals(b.draft!!.getString("rawContent"),e.getString("rawExcerpt"));e.put("id","event-3").put("eventGroupId","group-1").put("revision",2).put("selectedCandidateId",e.get("candidateId"));validateObservationReply(reply(e),c.steps[0]);e.put("revision",1);assertThrows(Exception::class.java){validateObservationReply(reply(e),c.steps[0])}
 b.history.getJSONObject("permissions").put("canViewRaw",false);assertThrows(Exception::class.java){b.revise("observation-old","event-1","staff_judgement","other","unknown","核对原话后纠正分类",actor())}
 }
 @Test fun recommendationBindings(){val b=RecommendationBoard(fixture().getJSONObject("recommendation"));val c=b.command("product-1","product-2","customer_request",actor());val data=JSONObject(c.steps[0].body).put("eventId","event-1").put("recommendationPublicId","recommendation-1").put("tableSessionId","session-1").put("employeeId",actor().employeeId);validateObservationReply(reply(data),c.steps[0]);data.put("employeeId","other");assertThrows(Exception::class.java){validateObservationReply(reply(data),c.steps[0])};assertThrows(Exception::class.java){b.command("product-1","product-1","customer_request",actor())};assertThrows(Exception::class.java){b.command("product-1","outside","customer_request",actor())}
 }
}
