import Foundation
@main struct ObservationTests {
 static func main()throws{
 let f=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]).appending(path:"live-observation.json"))) as! [String:Any]
 func data(_ v:Any)throws->Data{try JSONSerialization.data(withJSONObject:v)}
 func decode<T:Decodable>(_ t:T.Type,_ v:Any)throws->T{try JSONDecoder().decode(t,from:data(v))}
 var count=0
 func check(_ v:Bool,_ label:String){precondition(v,label);count+=1;print("PASS \(label)")}
 func rejects(_ work:()throws->Void)->Bool{do{try work();return false}catch{return true}}
 let actor=try decode(StaffIdentity.self,f["auth"]!),board=try decode(ObservationBoard.self,f["board"]!),reco=try decode(RecommendationBoard.self,f["recommendation"]!)
 let parse=try board.parse(raw:board.draft!.rawContent,immediate:true,actor:actor)
 check(try JSONDecoder().decode(LiveCommand.self,from:JSONEncoder().encode(parse))==parse,"original parse request survives restart")
 try validateObservationReply(data(["data":(f["board"] as! [String:Any])["draft"]!,"meta":["replayed":true]]),step:parse.steps[0]);count+=1
 check(rejects{_=try board.confirm(candidate:"candidate-1",expression:"",type:"too_sweet",degree:"",excerpt:"客人说太甜",actor:actor)},"expression cannot be inferred silently")
 check(rejects{_=try board.confirm(candidate:"other",expression:"customer_quote",type:"too_sweet",degree:"",excerpt:"客人说太甜",actor:actor)},"unrelated candidate cannot be selected")
 let c=try board.confirm(candidate:"candidate-1",expression:"customer_quote",type:"too_sweet",degree:"",excerpt:board.draft!.rawContent,actor:actor)
 var event=(c.steps[0].object["events"] as! [[String:Any]])[0];event["id"]="event-2";event["selectedCandidateId"]=event["candidateId"]
 let good:[String:Any]=["publicId":"observation-1","status":"confirmed","serviceTaskId":"task-1","events":[event]]
 try validateObservationReply(data(["data":good,"meta":["replayed":false]]),step:c.steps[0]);count+=1
 var bad=good;bad["serviceTaskId"]=NSNull();check(rejects{try validateObservationReply(data(["data":bad,"meta":["replayed":true]]),step:c.steps[0])},"urgent observation cannot succeed without task receipt")
 bad=good;bad["publicId"]="other";check(rejects{try validateObservationReply(data(["data":bad,"meta":["replayed":true]]),step:c.steps[0])},"another observation receipt stays unknown")
 let unlinked=try board.confirm(candidate:"",expression:"staff_judgement",type:"other",degree:"unknown",excerpt:"尚未确认具体商品",actor:actor)
 let u=(unlinked.steps[0].object["events"] as! [[String:Any]])[0];check(u["scopeKind"] as? String=="table" && u["productId"] is NSNull,"uncertain observation does not invent product")
 let revise=try board.revise(publicId:"observation-old",eventID:"event-1",expression:"staff_judgement",type:"other",degree:"unknown",reason:"核对原话后纠正分类",actor:actor)
 let replacement=revise.steps[0].object["replacement"] as! [String:Any]
 check(replacement["productId"] as? String=="product-1" && replacement["candidateId"] as? String=="candidate-1" && replacement["rawExcerpt"] as? String==board.draft!.rawContent,"revision preserves original source and product")
 var revised=replacement;revised["id"]="event-3";revised["selectedCandidateId"]=revised["candidateId"];revised["eventGroupId"]="group-1";revised["revision"]=2
 try validateObservationReply(data(["data":revised,"meta":["replayed":true]]),step:revise.steps[0]);count+=1
 revised["revision"]=1;check(rejects{try validateObservationReply(data(["data":revised,"meta":["replayed":true]]),step:revise.steps[0])},"old revision is not accepted as appended correction")
 var denied=f["auth"] as! [String:Any];denied["deniedPermissions"]=["observation.confirm"];let deniedActor=try decode(StaffIdentity.self,denied)
 check(rejects{_=try board.confirm(candidate:"",expression:"objective_fact",type:"other",degree:"",excerpt:"客人已离开",actor:deniedActor)},"current deny blocks confirmation")
 let modification=try reco.command(source:"product-1",target:"product-2",reason:"customer_request",actor:actor)
 var reply:[String:Any]=["eventId":"reco-event-1","recommendationPublicId":"recommendation-1","tableSessionId":"session-1","sourceProductId":"product-1","targetProductId":"product-2","reasonCode":"customer_request","employeeId":actor.employee.id]
 try validateObservationReply(data(["data":reply,"meta":["replayed":true]]),step:modification.steps[0]);count+=1
 reply["employeeId"]="other";check(rejects{try validateObservationReply(data(["data":reply,"meta":["replayed":true]]),step:modification.steps[0])},"another employee recommendation receipt rejected")
 check(rejects{_=try reco.command(source:"product-1",target:"product-1",reason:"customer_request",actor:actor)},"no-op recommendation rejected")
 check(rejects{_=try reco.command(source:"product-1",target:"outside",reason:"customer_request",actor:actor)},"replacement outside original recommendation rejected")
 print("Observation tests: \(count) passed")
 }
}
