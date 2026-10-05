import Foundation
@main struct PhysicalClosureTests {
 @MainActor static func main() async throws {
  var count=0
  func check(_ v:Bool,_ label:String){precondition(v,label);count+=1;print("PASS "+label)}
  func rejects(_ body:()throws->Void)->Bool{do{try body();return false}catch{return true}}
  func id(_ n:Int)->String{String(format:"00000000-0000-4000-8000-%012d",n)}
  let auth:[String:Any]=["session":["id":id(1),"employeeId":id(2),"expiresAt":"2099-01-01T00:00:00Z","onlineLeaseUntil":"2099-01-01T00:00:00Z"],"employee":["id":id(2),"code":"inventory","displayName":"库存主管","roleCodes":["OWNER"]],"permissions":["refund.request","inventory.receive","inventory.waste","kds.exception.manage","order.history.view"],"deniedPermissions":[]]
  func decode<T:Decodable>(_ type:T.Type,_ data:Any)throws->T{try JSONDecoder().decode(type,from:showBytes(data))}
  let actor=try decode(StaffIdentity.self,auth)
  let row:[String:Any]=["batchId":id(3),"itemId":id(4),"taskId":id(5),"tableCode":"A1","productName":"原瓶酒","orderPublicId":"ORIGINAL-ORDER","createdAt":"2026-10-05 12:00:00.123456+00","pendingQuantity":3,"unitIds":[id(6),id(7),id(8)],"canReceive":true,"canRecordUsed":true,"returnEligibility":[id(6):["canReturn":true],id(7):["canReturn":false,"reason":"原包装证据不支持退回"],id(8):["canReturn":true]]]
  func board(_ r:[String:Any]=row,enabled:Bool=true)throws->RemakeHandoverBoard{try RemakeHandoverBoard(showBytes(["data":["employeeId":id(2),"protocol":1,"supportsNativePhysicalRecovery":enabled,"items":[r],"nextCursor":NSNull()]]),actor:actor)}
  let b=try board()
  let returned=try b.command(actor:actor,row:b.rows[0],selected:[id(6),id(8)],disposition:"returned_unopened",received:true,reason:"实际收回私密现场说明")
  let used=try b.command(actor:actor,row:b.rows[0],selected:[id(7)],disposition:"used_loss",received:false,reason:"实际耗用私密现场说明")
  check(returned.steps[0].object["unitIds"] as? [String]==[id(6),id(8)],"explicit non-contiguous selection binds exact original units")
  for plain in [returned,used] {
   var vault:[String:String]=[:];let command=try secureRemakeHandoverCommand(plain){vault[$0]=$1},step=command.steps[0],disk=try JSONEncoder().encode(command)
   check(step.object.isEmpty && !String(decoding:disk,as:UTF8.self).contains("私密"),"ordinary pending does not persist physical notes")
   let restored=try JSONDecoder().decode(LiveCommand.self,from:disk),body=try remakeHandoverRequestBody(command,step:step,read:{vault[$0]!})
   check(NSDictionary(dictionary:body).isEqual(to:plain.steps[0].object),"exact original physical body restores")
   let receipt:[String:Any]=["employeeId":id(2),"requestKey":step.key,"batchId":id(3),"itemId":id(4),"remainingQuantity":plain.permission=="inventory.receive" ? 1:2]
   let response:[String:Any]=["data":receipt,"protocol":1,"replayed":true]
   _ = try validateRemakeHandoverReply(showBytes(response),step:step);check(true,"physical receipt validates original batch item and employee")
   for field in ["employeeId","requestKey","batchId","itemId","remainingQuantity"]{var bad=receipt;bad[field]="bad";check(rejects{_ = try validateRemakeHandoverReply(showBytes(["data":bad,"protocol":1,"replayed":false]),step:step)},"wrong physical receipt "+field)}
   var sends=0,effects=0,persisted=disk
   let api=StaffAPI(transport:{request in
    if request.url?.path=="/api/auth/login" {return(try showBytes(["data":auth]),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)}
    sends+=1;guard request.url?.path==step.path,request.value(forHTTPHeaderField:"idempotency-key")==step.key,request.value(forHTTPHeaderField:"x-mbox-staff-employee-id")==id(2),NSDictionary(dictionary:try showObject(request.httpBody!)).isEqual(to:body) else{throw StaffAPIError.invalid}
    if effects==0{effects=1;throw URLError(.timedOut)};return(try showBytes(response),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
   })
   _ = try await api.login(code:"inventory",pin:"1234",switching:false)
   func send(_ c:LiveCommand,_ s:LiveCommand.Step)async throws{let bytes=try await api.raw(s.path,body:remakeHandoverRequestBody(c,step:s,read:{vault[$0]!}),headers:[s.keyHeader:s.key]).0;_ = try validateRemakeHandoverReply(bytes,step:s)}
   do{_ = try await LiveCommandRunner.advance(restored,send:{try await send(restored,$0)},checkpoint:{persisted=try JSONEncoder().encode($0)});preconditionFailure()}catch{}
   check(persisted==disk,"timeout retains original physical request")
   let resumed=try JSONDecoder().decode(LiveCommand.self,from:persisted),done=try await LiveCommandRunner.advance(resumed,send:{try await send(resumed,$0)},checkpoint:{persisted=try JSONEncoder().encode($0)})
   check(done.completedSteps==1 && sends==2 && effects==1,"actual StaffAPI transport recovery records one simulated stock effect")
   _ = try await LiveCommandRunner.advance(done,send:{try await send(done,$0)},checkpoint:{_ in});check(sends==2,"completed stock receipt cannot be resubmitted")
   check(rejects{_ = try remakeHandoverRequestBody(command,step:step,read:{_ in throw StaffAPIError.invalid})},"missing secure physical body blocks network")
  }
  for units:Set<String> in [[],[id(99)],[id(7)]]{check(rejects{_ = try b.command(actor:actor,row:b.rows[0],selected:units,disposition:"returned_unopened",received:true,reason:"实物已退回")},"empty foreign or unpackaged units cannot be returned")}
  check(rejects{_ = try b.command(actor:actor,row:b.rows[0],selected:[id(6)],disposition:"returned_unopened",received:false,reason:"实物已退回")},"cannot return without physical confirmation")
  let disabled=try board(enabled:false);check(rejects{_ = try disabled.command(actor:actor,row:disabled.rows[0],selected:[id(6)],disposition:"used_loss",received:false,reason:"实际耗用")},"disabled native capability cannot send")
  var denied=auth;denied["deniedPermissions"]=["inventory.receive"];check(rejects{_ = try b.command(actor:decode(StaffIdentity.self,denied),row:b.rows[0],selected:[id(6)],disposition:"returned_unopened",received:true,reason:"实物已退回")},"denied inventory permission wins")
  check(try RemakeHandoverBoard.path(cursor:["id":id(3),"createdAt":"2026-10-05 12:00:00+00"]).contains("%2B00"),"postgres cursor plus timezone preserved by URL encoding")
  check(rejects{_ = try RemakeHandoverBoard.path(cursor:["id":id(3)])},"incomplete cursor refused")
  check(rejects{_ = try secureRemakeHandoverCommand(returned){_,_ in throw StaffAPIError.invalid}},"vault failure prevents submission")
  let historyItem:[String:Any]=["id":id(4),"name":"原商品","quantity":5,"workQuantity":2,"preparedAt":"2026-10-05T10:00:00Z","deliveredAt":"2026-10-05 12:00:00+00"]
  let shared:[String:Any]=["receiptId":id(12),"source":"shared_pickup_device","tableCode":"A1","pickupTableCode":"A2","deliveredAt":"2026-10-05T12:00:00Z","items":[["itemId":id(4),"name":"原商品","quantity":1,"kind":"remake","specification":"原规格","itemNote":"少冰","orderNote":"等人"]]]
  let history:[String:Any]=["orders":[["id":id(13),"publicId":"ORDER-ORIGINAL","tableCode":"A1","items":[historyItem]]],"sharedDeliveries":[shared],"businessDate":"2026-10-05","generatedAt":"2026-10-05T12:00:00Z","page":0,"hasMore":false]
  let q=FulfillmentHistoryQuery(kind:"delivered",date:"2026-10-05",table:"A+")
  let h=try FulfillmentHistoryBoard(showBytes(["data":history]),query:q,page:0)
  check(h.shared.count==1 && (h.orders[0].object["items"] as? [[String:Any]])?[0]["workQuantity"] as? Int==2,"personal work quantity separate from original quantity and shared deliveries")
  check(try q.path().contains("A%2B"),"literal plus in table search preserved")
  check(rejects{_ = try FulfillmentHistoryBoard(showBytes(["data":history]),query:q,page:1)},"wrong history page refused")
  check(rejects{_ = try FulfillmentHistoryBoard(showBytes(["data":history]),query:FulfillmentHistoryQuery(kind:"prepared",date:q.date),page:0)},"shared delivered evidence cannot appear as personal prepared work")
  var wrongHistory=history;var wrongShared=shared;wrongShared["source"]="employee";wrongHistory["sharedDeliveries"]=[wrongShared];check(rejects{_ = try FulfillmentHistoryBoard(showBytes(["data":wrongHistory]),query:q,page:0)},"unknown shared source rejected")
  wrongHistory=history;wrongHistory["sharedDeliveries"]=[shared,shared];check(rejects{_ = try FulfillmentHistoryBoard(showBytes(["data":wrongHistory]),query:q,page:0)},"duplicate shared receipts rejected")
  check(rejects{_ = try FulfillmentHistoryQuery(kind:"prepared",date:"2026-02-30").path()},"invalid work date rejected")
  check(canReadFulfillmentHistory(actor) && !canReadFulfillmentHistory(nil),"history requires role visibility")
  let fixtures=try showObject(Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("live-remediation.json")))
  let kdsActor=try decode(StaffIdentity.self,fixtures["auth"]!),base=fixtures["fulfillment"] as! [String:Any]
  for status in ["pending","accepted","preparing","ready","failed"] {
   var raw=base,rows=base["workItems"] as! [[String:Any]];rows[0]["quantities"]=NSNull();rows[0]["kdsStatus"]=status;rows[0]["canManagerCancel"]=true;rows[0]["canRemake"]=false;raw["workItems"]=rows
   let kds=try decode(LiveFulfillment.self,raw),cmd=try kds.command(identity:kdsActor,taskID:kds.workItems[0].id,action:"manager-cancel",quantity:1,reason:"经理核对现场结束",confirmed:true)
   check(cmd.steps[0].path.hasSuffix("/manager-cancel") && cmd.permission=="kds.exception.manage","manager can close eligible legacy "+status)
   rows[0]["canManagerCancel"]=false;raw["workItems"]=rows;let forbidden=try decode(LiveFulfillment.self,raw);check(rejects{_ = try forbidden.command(identity:kdsActor,taskID:forbidden.workItems[0].id,action:"manager-cancel",quantity:1,reason:"经理核对现场结束",confirmed:true)},"explicit server cancellation denial wins "+status)
  }
  print("Physical closure tests: \(count) passed")
 }
}
