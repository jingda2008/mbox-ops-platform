import Foundation
@main struct MemberTests {
 static func main()throws{
 let f=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]).appending(path:"live-members.json"))) as! [String:Any]
 func data(_ value:Any)throws->Data{try JSONSerialization.data(withJSONObject:value)}
 func decode<T:Decodable>(_ t:T.Type,_ value:Any)throws->T{try JSONDecoder().decode(t,from:data(value))}
 var count=0
 func check(_ value:Bool,_ label:String){precondition(value,label);count+=1;print("PASS \(label)")}
 func rejects(_ work:()throws->Void)->Bool{do{try work();return false}catch{return true}}
 let actor=try decode(StaffIdentity.self,f["auth"]!),visit=try decode(MemberVisitStatus.self,f["visit"]!),board=try decode(MemberRewardBoard.self,f["reward"]!)
 check(try MemberCommands.code(" mbox_member_v1:MBX-100000 ")=="MBX-100000","member prefix normalized without changing member identity")
 for invalid in ["https://bad.invalid","MBX 100","MBOX_MEMBER_V1:"]{check(rejects{_=try MemberCommands.code(invalid)},"non-member code rejected "+invalid)}
 let c=try visit.command(cancel:false,reason:"",actor:actor)
 check(c.steps[0].object["businessDate"] as? String==visit.businessDate && c.steps[0].memberProof?["memberNo"] as? String==visit.memberNo,"check-in binds member and original business date")
 let disk=try JSONDecoder().decode(LiveCommand.self,from:JSONEncoder().encode(c));check(disk==c,"check-in retains original request after restart")
 var reply:[String:Any]=["id":"visit-1","memberNo":"MBX-100000","businessDate":"2026-09-28","checkedInAt":"2026-09-28T01:00:00Z","employeeName":"员工","status":"checked_in"]
 try validateMemberReply(data(["data":reply,"meta":["replayed":true]]),step:c.steps[0]);count+=1
 reply["memberNo"]="OTHER";check(rejects{try validateMemberReply(data(["data":reply,"meta":["replayed":true]]),step:c.steps[0])},"different member receipt remains unknown")
 var active=f["visit"] as! [String:Any];reply["memberNo"]="MBX-100000";active["visit"]=reply
 let checked=try decode(MemberVisitStatus.self,active)
 check(rejects{_=try checked.command(cancel:false,reason:"",actor:actor)},"already checked in cannot create another request")
 check(rejects{_=try checked.command(cancel:true,reason:"",actor:actor)},"cancellation requires reason")
 let cancel=try checked.command(cancel:true,reason:"误签到撤回",actor:actor);check(cancel.steps[0].object["visitId"] as? String=="visit-1","cancellation binds exact original attendance")
 active["durableNativeVisits"]=false;let legacy=try decode(MemberVisitStatus.self,active);check(rejects{_=try legacy.command(cancel:true,reason:"误签到撤回",actor:actor)},"old server capability blocks unsafe native write")
 let approved=try board.command(ids:["reward-1"],approve:true,reason:"已核对实际到店",actor:actor)
 try validateMemberReply(data(["data":["items":[["id":"reward-1","status":"issued"]]],"meta":["replayed":false]]),step:approved.steps[0]);count+=1
 check(rejects{try validateMemberReply(data(["data":["items":[]],"meta":["replayed":true]]),step:approved.steps[0])},"partial batch receipt never treated as all approved")
 var stale=f["reward"] as! [String:Any];var rows=stale["items"] as! [[String:Any]];rows[0]["cancelled_sources"]=1;stale["items"]=rows;let staleBoard=try decode(MemberRewardBoard.self,stale)
 check(rejects{_=try staleBoard.command(ids:["reward-1"],approve:true,reason:"核对",actor:actor)},"cancelled source cannot be approved")
 _=try staleBoard.command(ids:["reward-1"],approve:false,reason:"签到已撤回",actor:actor);count+=1
 var denied=f["auth"] as! [String:Any];denied["deniedPermissions"]=["loyalty.configuration.approve"];let deniedActor=try decode(StaffIdentity.self,denied)
 check(rejects{_=try board.command(ids:["reward-1"],approve:true,reason:"核对",actor:deniedActor)},"approval respects current denial")

 let bf=try decode(BenefitFulfillmentBoard.self,f["benefit"]!),row=bf.rows[0]
 let redeem=try bf.command(rowID:row.id,cancel:false,product:row.originalProductId!,reason:"",actor:actor)
 check(redeem.steps[0].object["tableSessionId"] as? String==row.tableSessionId,"benefit command binds original table session")
 let roundtrip=try JSONDecoder().decode(LiveCommand.self,from:JSONEncoder().encode(redeem))
 check(roundtrip.steps[0].memberProof?["reservationId"] as? String==row.reservationId,"benefit recovery retains original reservation")
 check(rejects{_=try bf.command(rowID:row.id,cancel:false,product:"other",reason:"替换",actor:actor)},"unapproved product blocked")
 check(rejects{_=try bf.command(rowID:row.id,cancel:false,product:row.products[1].id,reason:"",actor:actor)},"substitution requires reason")
 _=try bf.command(rowID:row.id,cancel:false,product:row.products[1].id,reason:"客人选择替代商品",actor:actor);count+=1
 check(rejects{_=try bf.command(rowID:row.id,cancel:true,product:"",reason:"",actor:actor)},"cancellation needs reason")
 let cancelled=try bf.command(rowID:row.id,cancel:true,product:"",reason:"客人取消",actor:actor)
 let cancelReply:[String:Any] = ["data":["id":row.reservationId,"benefitId":row.benefitId,"customerId":row.customerId,"tableSessionId":row.tableSessionId,"quantity":1,"status":"cancelled","cancelReason":"客人取消"],"meta":["replayed":true]]
 try validateMemberReply(data(cancelReply),step:cancelled.steps[0]);count+=1
 var receipt:[String:Any] = ["id":"redemption-1","benefitId":row.benefitId,"benefitReservationId":row.reservationId,"customerId":row.customerId,"tableSessionId":row.tableSessionId,"quantity":1,"giftOrderReference":"gift-original","redeemedAt":"2026-09-28T00:00:00Z","authorizationSource":["employeeId":actor.employee.id]]
 try validateMemberReply(data(["data":receipt,"meta":["replayed":true]]),step:redeem.steps[0]);count+=1
 for key in ["benefitId","benefitReservationId","customerId","tableSessionId","giftOrderReference"] {
   var bad=receipt;bad[key]="";check(rejects{try validateMemberReply(data(["data":bad,"meta":["replayed":true]]),step:redeem.steps[0])},"wrong benefit receipt rejected "+key)
 }
 receipt["quantity"]=2;check(rejects{try validateMemberReply(data(["data":receipt,"meta":["replayed":true]]),step:redeem.steps[0])},"changed quantity rejected")
 var expired=f["benefit"] as! [String:Any];var gifts=expired["gifts"] as! [[String:Any]];gifts[0]["expiresAt"]="2000-01-01T00:00:00Z";expired["gifts"]=gifts
 let staleBenefit=try decode(BenefitFulfillmentBoard.self,expired)
 check(rejects{_=try staleBenefit.command(rowID:row.id,cancel:false,product:row.originalProductId!,reason:"",actor:actor)},"expired reservation cannot be redeemed")
 var old=f["benefit"] as! [String:Any];old["durable"]=false;let oldBenefit=try decode(BenefitFulfillmentBoard.self,old)
 check(rejects{_=try oldBenefit.command(rowID:row.id,cancel:true,product:"",reason:"客人取消",actor:actor)},"legacy server cannot accept native benefit write")

 let snack=bf.rows[1],snackCommand=try bf.command(rowID:bf.rows[1].id,cancel:false,product:"",reason:"",actor:actor)
 check(snackCommand.steps[0].object["claimCode"] as? String==snack.claimCode,"daily snack binds original claim code")
 var used=f["benefit"] as! [String:Any];var snacks=used["snacks"] as! [[String:Any]];snacks[0]["status"]="redeemed";used["snacks"]=snacks
 let usedBoard=try decode(BenefitFulfillmentBoard.self,used)
 check(rejects{_=try usedBoard.command(rowID:snack.id,cancel:true,product:"",reason:"取消",actor:actor)},"redeemed snack cannot cancel reservation")
 check(rejects{_=try usedBoard.command(rowID:snack.id,cancel:false,product:"",reason:"",actor:actor)},"redeemed snack cannot be redeemed again")
 var revoked=f["auth"] as! [String:Any];revoked["deniedPermissions"]=["loyalty.redemption.fulfill"]
 let revokedActor=try decode(StaffIdentity.self,revoked)
 check(rejects{_=try bf.command(rowID:snack.id,cancel:false,product:"",reason:"",actor:revokedActor)},"fulfillment respects denied permission")
 print("Member tests: \(count) passed")
 }
}
