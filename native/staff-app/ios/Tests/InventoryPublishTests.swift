import Foundation
@main struct InventoryPublishTests {
 @MainActor static func main() async throws {
  func bytes(_ v:Any)throws->Data{try catalogConfigData(v)}
  let fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]+"/live-stock.json"))) as! [String:Any]
  var auth=fixture["auth"] as! [String:Any];auth["permissions"]=inventoryPublishPermissions
  var session=auth["session"] as! [String:Any];session["onlineLeaseUntil"]=ISO8601DateFormatter().string(from:Date().addingTimeInterval(3600));session["expiresAt"]=session["onlineLeaseUntil"];auth["session"]=session
  func staff(_ v:[String:Any])throws->StaffIdentity{try JSONDecoder().decode(StaffIdentity.self,from:bytes(v))}
  let actor=try staff(auth),receiptID=UUID().uuidString.lowercased(),productID=UUID().uuidString.lowercased()
  let lines:[[String:Any]]=[["itemName":"金酒","quantity":"750","baseUnit":"ml","batchCode":"实际批次"],["itemName":"柠檬","quantity":"3","baseUnit":"piece","batchCode":NSNull()]]
  let receipt:[String:Any]=["id":receiptID,"publicId":"PR-ORIGINAL","status":"draft","currency":"CNY","lines":lines]
  let raw:[String:Any]=["nativeInventoryPublishProtocol":1,"currentEmployeeId":actor.employee.id,"receipt":receipt,"products":[["id":productID,"name":"金酒调饮"]]]
  let b=try InventoryPublishBoard(data:bytes(["data":raw]),actor:actor,receiptID:receiptID)
  let source:[String:Any]=["nativeInventoryPublishProtocol":1,"currentEmployeeId":actor.employee.id,"receiptId":receiptID,"receiptPublicId":"PR-ORIGINAL","productId":productID,"productName":"金酒调饮","currency":"CNY","receiptLines":lines,"expectedVersion":String(repeating:"a",count:64),"costAmountMinor":1200,"standardPriceMinor":5000,"grossProfitMinor":3800,"recipeVersion":3,"sellableServings":10,"guestVisible":true,"allowedChannels":["guest_qr","staff_assisted"]]
  func preview(_ v:[String:Any])throws->InventoryPublishPreview{try InventoryPublishPreview(data:bytes(["data":v]),actor:actor,board:b,productID:productID)}
  let p=try preview(source)
  var n=0
  func check(_ ok:Bool,_ label:String){precondition(ok,label);n+=1;print("PASS "+label)}
  func rejects(_ f:()throws->Void)->Bool{do{try f();return false}catch{return true}}
  check(p.confirmation.contains("金酒") && p.confirmation.contains("柠檬") && p.confirmation.contains("实际批次"),"confirmation includes entire multi-line receipt")
  check(rejects{_ = try p.command(actor:actor,board:b,confirmedWholeReceipt:false)},"must explicitly verify entire physical receipt")
  let c=try p.command(actor:actor,board:b,confirmedWholeReceipt:true),step=c.steps[0]
  check(validInventoryPublishSelection(c,board:b,preview:p),"original board selection bound")
  for missing in inventoryPublishPermissions {var denied=auth;denied["deniedPermissions"]=[missing];check(rejects{_ = try p.command(actor:staff(denied),board:b,confirmedWholeReceipt:true)},"explicit deny "+missing)}
  for field in ["receiptId","receiptPublicId","productId","currentEmployeeId","currency","expectedVersion","grossProfitMinor","standardPriceMinor","costAmountMinor","receiptLines"] {
   var wrong=source
   switch field{case "grossProfitMinor":wrong[field]=3801;case "standardPriceMinor":wrong[field]=0;case "costAmountMinor":wrong[field]=NSNull();case "receiptLines":wrong[field]=[];default:wrong[field]="wrong"}
   check(rejects{_ = try preview(wrong)},"reject mismatched preview "+field)
  }
  for field in ["sellableServings","guestVisible","allowedChannels"] {
   var wrong=source
   if field=="sellableServings"{wrong[field]=0}else if field=="guestVisible"{wrong[field]=false}else{wrong[field]=["guest_qr"]}
   let notReady=try preview(wrong);check(!notReady.ready && rejects{_ = try notReady.command(actor:actor,board:b,confirmedWholeReceipt:true)},"incomplete publication condition "+field)
  }
  var different=source;different["expectedVersion"]=String(repeating:"b",count:64)
  check(!validInventoryPublishSelection(c,board:b,preview:try preview(different)),"changed recipe/stock/price fingerprint rejected")
  let response:[String:Any]=["id":receiptID,"receiptPublicId":"PR-ORIGINAL","productId":productID,"receiptStatus":"received","productStatus":"active","costAmountMinor":1200,"standardPriceMinor":5000,"grossProfitMinor":3800,"recipeCostVersionId":UUID().uuidString.lowercased(),"publishedAt":"2026-10-05T10:00:00.123Z"]
  let reply=try bytes(["data":response,"meta":["replayed":true]])
  try validateInventoryPublishReply(reply,step:step);check(true,"original atomic receipt accepted")
  for field in ["id","productId","receiptStatus","productStatus","costAmountMinor","recipeCostVersionId","publishedAt"] {
   var wrong=response;wrong[field]=field=="costAmountMinor" ? 1201 : "wrong"
   check(rejects{try validateInventoryPublishReply(bytes(["data":wrong,"meta":["replayed":true]]),step:step)},"wrong reply "+field)
  }
  check(rejects{try validateInventoryPublishReply(bytes(["data":response,"meta":["replayed":1]]),step:step)},"boolean replay strict")
  var bodies:[Data]=[],keys:[String]=[]
  let api=StaffAPI {request in
   check(request.httpMethod=="POST" && request.url?.path==step.path,"real atomic receive publish endpoint")
   bodies.append(request.httpBody!);keys.append(request.value(forHTTPHeaderField:step.keyHeader)!)
   if bodies.count==1{throw URLError(.networkConnectionLost)}
   return(reply,HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
  }
  var pending=c
  func send(_ s:LiveCommand.Step)async throws{let(data,_)=try await api.raw(s.path,body:s.object,headers:[s.keyHeader:s.key]);try validateInventoryPublishReply(data,step:s)}
  do{_ = try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0});preconditionFailure()}catch{check(pending.completedSteps==0,"lost response retains original whole receipt")}
  pending=try JSONDecoder().decode(LiveCommand.self,from:JSONEncoder().encode(pending));pending=try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0})
  check(bodies[0]==bodies[1] && keys==[step.key,step.key],"restart preserves whole original transaction and key")
  _ = try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0});check(bodies.count==2,"completed publish not resent")
  print("\(n) inventory publish checks passed")
 }
}
