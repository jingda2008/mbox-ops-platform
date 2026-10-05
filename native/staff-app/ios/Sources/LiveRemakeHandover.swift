import Foundation
import CryptoKit

let remakeHandoverRoot = "/api/commerce/item-after-sales"
struct RemakeHandoverBoard {
 let employeeID:String,sessionID:String
 let enabled:Bool
 let rows:[ShowRow]
 let next:[String:Any]?
 init(_ bytes:Data,actor:StaffIdentity) throws {
  let data=try showData(bytes)
  guard actor.allows("refund.request"),data["employeeId"] as? String==actor.employee.id,try showInteger(data["protocol"])==1,let items=data["items"] as? [[String:Any]] else {throw StaffAPIError.invalid}
  employeeID=actor.employee.id;sessionID=actor.session.id;enabled=try showFlag(data["supportsNativePhysicalRecovery"])
  rows=try items.map { item in
   var value=item;value["id"]=try showUUID(item["batchId"]);_ = try showUUID(item["itemId"])
   guard let ids=item["unitIds"] as? [String],!ids.isEmpty,Set(ids).count==ids.count,ids.count == (try showInteger(item["pendingQuantity"],min:1)),let eligibility=item["returnEligibility"] as? [String:Any] else {throw StaffAPIError.invalid}
   for id in ids {_ = try showUUID(id);guard let e=eligibility[id] as? [String:Any] else {throw StaffAPIError.invalid};_ = try showFlag(e["canReturn"])}
   _ = try showFlag(item["canReceive"]);_ = try showFlag(item["canRecordUsed"])
   return try ShowRow(value)
  }
  guard Set(rows.map(\.id)).count==rows.count else {throw StaffAPIError.invalid}
  next=data["nextCursor"] as? [String:Any]
  if let next {_ = try Self.path(cursor:next)}
 }
 static func path(cursor:[String:Any]?=nil) throws -> String {
  var url=URLComponents();url.path=remakeHandoverRoot+"/native-remake-handover"
  if let cursor {let id=try showUUID(cursor["id"]),at=try showString(cursor,"createdAt",max:80);guard showServerDate(at) != nil else {throw StaffAPIError.invalid};url.queryItems=[URLQueryItem(name:"cursorId",value:id),URLQueryItem(name:"createdAt",value:at)]}
  return url.string!.replacingOccurrences(of:"+",with:"%2B")
 }
 func command(actor:StaffIdentity,row:ShowRow,selected:Set<String>,disposition:String,received:Bool,reason:String) throws -> LiveCommand {
  let permission=disposition=="returned_unopened" ? "inventory.receive":"inventory.waste"
  guard enabled,rows.contains(row),employeeID==actor.employee.id,sessionID==actor.session.id,actor.allows("refund.request"),actor.allows(permission),StaffIdentity.date(actor.session.onlineLeaseUntil).map({$0>Date()})==true,["used_loss","returned_unopened"].contains(disposition),let all=row.object["unitIds"] as? [String],!selected.isEmpty,selected.count<=999,selected.isSubset(of:Set(all)),try showFlag(row.object[disposition=="returned_unopened" ? "canReceive":"canRecordUsed"]) else {throw CatalogError("当前员工、原批次或所选实物已变化，请重新读取")}
  if disposition=="returned_unopened" {
   guard received,let eligibility=row.object["returnEligibility"] as? [String:Any],try selected.allSatisfy({ id in guard let e=eligibility[id] as? [String:Any] else {return false};return try showFlag(e["canReturn"])}) else {throw CatalogError("须实际收回且未开封，并有原包装及库存证据支持")}
  }
  let reason=reason.trimmingCharacters(in:.whitespacesAndNewlines)
  guard (2...500).contains(reason.utf16.count) else {throw CatalogError("请填写2至500字实际处理依据")}
  let id=UUID().uuidString.lowercased(),body:[String:Any]=["actorId":actor.employee.id,"unitIds":all.filter(selected.contains),"disposition":disposition,"unopenedReceived":disposition=="returned_unopened" && received,"reason":reason]
  let title=disposition=="returned_unopened" ? "登记离店实物退回":"登记离店实物耗用或损耗"
  let proof:[String:Any]=["batchId":row.id,"itemId":row.text("itemId"),"employeeId":actor.employee.id,"disposition":disposition,"confirmation":title+"\n原桌 "+row.text("tableCode")+" · "+row.text("productName")+"\n原订单 "+row.text("orderPublicId")+"\n实际\(selected.count)份\n"+reason+"\n只登记本批实物去向，不收款、退款或再次制作。"]
  return LiveCommand(id:id,employeeID:employeeID,title:title,permission:permission,steps:[.init(path:remakeHandoverRoot+"/native-remakes/"+row.id+"/after-visit-physical",body:try showBytes(body),keyHeader:"idempotency-key",key:"native-remedy-"+id,recoveryBody:try showBytes(["remakeHandover":proof]))])
 }
}
extension LiveCommand.Step {var remakeHandoverProof:[String:Any]? {guard let recoveryBody else{return nil};return (try? showObject(recoveryBody))?["remakeHandover"] as? [String:Any]}}
func secureRemakeHandoverCommand(_ command:LiveCommand,store:(String,String)throws->Void)throws->LiveCommand {
 guard let step=command.steps.first,var p=step.remakeHandoverProof else{return command}
 guard command.steps.count==1,p["payloadKey"]==nil else{throw StaffAPIError.invalid}
 let data=try showBytes(["body":step.object,"proof":p]),secret=SymmetricKey(size:.bits256),key="live-remake-handover-"+command.id
 try store(key,String(decoding:try showBytes(["payload":data.base64EncodedString(),"authenticationKey":secret.withUnsafeBytes{Data($0).base64EncodedString()}]),as:UTF8.self))
 p.removeValue(forKey:"confirmation");p["payloadKey"]=key;p["payloadAuthentication"]=HMAC<SHA256>.authenticationCode(for:data,using:secret).map{String(format:"%02x",$0)}.joined()
 return LiveCommand(id:command.id,employeeID:command.employeeID,title:"待核对离店重做实物原请求",permission:command.permission,steps:[.init(path:step.path,body:Data("{}".utf8),keyHeader:step.keyHeader,key:step.key,recoveryBody:try showBytes(["remakeHandover":p]))],completedSteps:command.completedSteps,rejected:command.rejected)
}
func remakeHandoverRequestBody(_ command:LiveCommand,step:LiveCommand.Step,read:(String)throws->String)throws->[String:Any] {
 guard command.steps.count==1,command.steps.first==step,UUID(uuidString:command.id) != nil,command.id==command.id.lowercased(),step.body==Data("{}".utf8),step.keyHeader=="idempotency-key",step.key=="native-remedy-"+command.id,let p=step.remakeHandoverProof,p["employeeId"] as? String==command.employeeID,
  let disposition=p["disposition"] as? String,["used_loss","returned_unopened"].contains(disposition),command.permission==(disposition=="returned_unopened" ? "inventory.receive":"inventory.waste"),step.path==remakeHandoverRoot+"/native-remakes/"+(try showUUID(p["batchId"]))+"/after-visit-physical",let key=p["payloadKey"] as? String,key=="live-remake-handover-"+command.id,p["confirmation"]==nil,let tag=p["payloadAuthentication"] as? String else {throw StaffAPIError.invalid}
 let envelope=try showObject(Data(try read(key).utf8))
 guard let encoded=envelope["payload"] as? String,let data=Data(base64Encoded:encoded),let encodedKey=envelope["authenticationKey"] as? String,let keyData=Data(base64Encoded:encodedKey),keyData.count==32,
  HMAC<SHA256>.authenticationCode(for:data,using:SymmetricKey(data:keyData)).map({String(format:"%02x",$0)}).joined()==tag,let body=try showObject(data)["body"] as? [String:Any],var original=try showObject(data)["proof"] as? [String:Any] else{throw CatalogError("原实物安全载荷不可核对，未发送")}
 original.removeValue(forKey:"confirmation");var metadata=p;metadata.removeValue(forKey:"payloadKey");metadata.removeValue(forKey:"payloadAuthentication")
 guard NSDictionary(dictionary:original).isEqual(to:metadata),body["actorId"] as? String==command.employeeID,body["disposition"] as? String==disposition else{throw StaffAPIError.invalid};return body
}
struct RemakeHandoverReceipt:Equatable {let requestKey:String,batchID:String,itemID:String;let remainingQuantity:Int}
func validateRemakeHandoverReply(_ bytes:Data,step:LiveCommand.Step)throws->RemakeHandoverReceipt {
 let root=try showObject(bytes)
 guard try showInteger(root["protocol"])==1,let data=root["data"] as? [String:Any],let p=step.remakeHandoverProof,data["employeeId"] as? String==p["employeeId"] as? String,data["requestKey"] as? String==step.key,data["batchId"] as? String==p["batchId"] as? String,data["itemId"] as? String==p["itemId"] as? String else{throw StaffAPIError.invalid}
 _ = try showFlag(root["replayed"])
 return RemakeHandoverReceipt(requestKey:step.key,batchID:try showUUID(data["batchId"]),itemID:try showUUID(data["itemId"]),remainingQuantity:try showInteger(data["remainingQuantity"]))
}
