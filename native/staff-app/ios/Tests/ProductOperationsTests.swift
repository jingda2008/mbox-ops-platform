import Foundation

@main struct ProductOperationsTests {
  @MainActor static func main() async throws {
    func bytes(_ value: Any) throws -> Data { try catalogConfigData(value) }
    func actor(_ value: [String: Any]) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(value)) }
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1] + "/live-stock.json"))) as! [String: Any]
    var auth = fixture["auth"] as! [String: Any]; auth["permissions"] = ["catalog.product.manage", "catalog.price.manage", "inventory.cost.view"]
    var session = auth["session"] as! [String: Any]; session["onlineLeaseUntil"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)); session["expiresAt"] = session["onlineLeaseUntil"]; auth["session"] = session
    let staff = try actor(auth)
    let category: [String: Any] = ["id": UUID().uuidString.lowercased(), "code": "drinks", "displayName": "饮品", "parentCode": NSNull(), "updatedAt": "2026-10-05 06:01:02.123456+00", "sortOrder": 10, "guestVisible": true]
    var leaf = category; leaf["id"] = UUID().uuidString.lowercased(); leaf["code"] = "soft"; leaf["parentCode"] = "drinks"; leaf["displayName"] = "软饮"
    var product: [String: Any] = ["id": UUID().uuidString.lowercased(), "code": "TEA", "name": "原茶饮", "categoryCode": "soft", "productKind": "single", "nativeVersion": String(repeating: "a", count: 64), "fulfillmentStation": "bar", "inventoryControlMode": "tracked", "maxOrderQuantity": 99, "allowedChannels": ["guest_qr", "cashier"], "availableFrom": NSNull(), "availableUntil": NSNull(), "productSnapshot": ["description": "原说明"], "bundleComponents": [], "bundleChoiceGroups": []]
    product["recommendationEnabled"] = true; product["recommendationSingleWaveEligible"] = false
    product["fulfillmentSlaSeconds"] = NSNull(); product["recommendationUpgradeProductId"] = NSNull(); product["searchText"] = "原茶"
    for key in productNumberBounds.keys { product[key] = key.contains("Guests") ? 2 : 0 }
    for key in productTagOptions.keys { product[key] = [] }
    product["productSnapshot"] = ["description": "原说明", "salesSpecificationType":"whole_bottle", "tasteProfile":["acidity":NSNull(),"sweetness":2,"legacy":"原字段"], "imageUrl":"https://mbox.shmbox.com/menu.jpg"]
    let original: [String: Any] = ["currentEmployeeId": staff.employee.id, "configurationProtocol": 1, "operationalProtocol":1, "durableProducts": true, "canPrice": true, "offset": 0, "limit": 40, "products": [product], "categories": [category, leaf]]
    func board(_ value: [String: Any]) throws -> CatalogConfigurationBoard { try CatalogConfigurationBoard(data: bytes(["data": value]), actor: staff) }
    let current = try board(original), item = current.products[0]
    var n = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); n += 1; print("PASS " + label) }
    func rejects(_ fn: () throws -> Void) -> Bool { do { try fn(); return false } catch { return true } }
    var draft = try ProductOperationsDraft(product: item); draft.acidity = "3"; draft.search = " 金酒 搜索 "
    let command = try draft.command(actor:staff,board:current,product:item), step = command.steps[0]
    let patch = step.object["patch"] as! [String:Any], snapshot = patch["productSnapshot"] as! [String:Any]
    check((snapshot["tasteProfile"] as? [String:Any])?["legacy"] as? String == "原字段", "preserve legacy taste fields")
    check(snapshot["imageUrl"] as? String == "https://mbox.shmbox.com/menu.jpg", "preserve original selected media")
    check(patch["searchText"] as? String == "金酒 搜索", "trim search aliases")
    for key in productNumberBounds.keys {var bad=draft;bad.numbers[key]="99999";check(rejects{_ = try bad.command(actor:staff,board:current,product:item)},"bound "+key)}
    for key in productTagOptions.keys {var bad=draft;bad.tags[key]=["unknown"];check(rejects{_ = try bad.command(actor:staff,board:current,product:item)},"reject unknown "+key)}
    for field in ["acidity","sweetness","sla","upgrade","search","range","cost"] {
      var bad=draft
      switch field {case "acidity":bad.acidity="1.5";case "sweetness":bad.sweetness="6";case "sla":bad.sla="29";case "upgrade":bad.upgradeID=item.id;case "search":bad.search=String(repeating:"a",count:2001);case "range":bad.numbers["recommendationMinGuests"]="10";default:bad.cost="1.00";bad.reason="实际成本"}
      check(rejects{_ = try bad.command(actor:staff,board:current,product:item)},"invalid operation "+field)
    }
    let companion = try companionProductDraft(item)
    let companionCommand = try companion.command(actor:staff,board:current,product:nil)
    check(companionCommand.steps[0].object["status"] as? String == "inactive", "companion starts inactive")
    check(companionCommand.steps[0].object["standardPrice"] == nil && companionCommand.steps[0].object["costAmountMinor"] == nil,"companion does not copy price or cost")
    check((companionCommand.steps[0].object["productSnapshot"] as? [String:Any])?["salesSpecificationType"] as? String == "glass", "whole bottle companion becomes glass")
    check(companion.code == "TEA_GLASS", "companion has distinct proposed code")
    var unmanaged=product;unmanaged["inventoryControlMode"]="not_managed";unmanaged["costAmountMinor"]="1234"
    var modified=original;modified["products"]=[unmanaged];let unmanagedBoard=try board(modified),unmanagedItem=unmanagedBoard.products[0]
    var manual=try ProductOperationsDraft(product:unmanagedItem);check(manual.originalCost=="12.34","exact original manual cost")
    manual.cost="";manual.reason="原成本缺少证据"
    let removeCost=try manual.command(actor:staff,board:unmanagedBoard,product:unmanagedItem)
    check((removeCost.steps[0].object["patch"] as? [String:Any])?["costAmountMinor"] is NSNull,"unknown manual cost not zero")
    manual.cost="0.01";let setCost=try manual.command(actor:staff,board:unmanagedBoard,product:unmanagedItem)
    check((setCost.steps[0].object["patch"] as? [String:Any])?["costAmountMinor"] as? Int == 1,"exact cent manual cost")
    var denied=auth;denied["deniedPermissions"]=["inventory.cost.view"]
    check(rejects{_ = try manual.command(actor:actor(denied),board:unmanagedBoard,product:unmanagedItem)},"explicit cost deny")
    for c in [command,removeCost,setCost,companionCommand] {
      let step=c.steps[0], proof=step.catalogConfigurationProof!
      var response=proof["expected"] as! [String:Any];response.removeValue(forKey:"costChangeReason")
      response["id"]=proof["creating"] as? Bool == true ? UUID().uuidString.lowercased() : proof["id"]!
      if let value=response["costAmountMinor"] as? Int {response["costAmountMinor"]=String(value)}
      let reply=try bytes(["data":response,"meta":["replayed":true]])
      try validateCatalogConfigurationReply(reply,step:step);check(true,"original operation receipt accepted")
      var wrong=response
      if response["recommendationEnabled"] != nil {wrong["recommendationEnabled"]=1}else{wrong["status"]="active"}
      check(rejects{try validateCatalogConfigurationReply(bytes(["data":wrong,"meta":["replayed":true]]),step:step)},"altered or numeric flag receipt rejected")
      var bodies:[Data]=[],keys:[String]=[]
      let api=StaffAPI {request in
        check(request.url?.path==step.path && request.httpMethod=="POST","original operation route")
        bodies.append(request.httpBody!);keys.append(request.value(forHTTPHeaderField:step.keyHeader)!)
        if bodies.count==1 {throw URLError(.networkConnectionLost)}
        return(reply,HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
      }
      var pending=c
      func send(_ s:LiveCommand.Step) async throws {let(data,_)=try await api.raw(s.path,body:s.object,headers:[s.keyHeader:s.key]);try validateCatalogConfigurationReply(data,step:s)}
      do{_ = try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0});preconditionFailure()}catch{check(pending.completedSteps==0,"lost response retained")}
      pending=try JSONDecoder().decode(LiveCommand.self,from:JSONEncoder().encode(pending));pending=try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0})
      check(bodies[0]==bodies[1] && keys==[step.key,step.key],"original operation body/key restored")
      _ = try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0});check(bodies.count==2,"completed operation not resent")
    }
    print("\(n) product operations checks passed")
  }
}
