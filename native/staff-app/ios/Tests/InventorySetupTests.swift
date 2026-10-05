import Foundation
@main struct InventorySetupTests {
  @MainActor static func main() async throws {
    func bytes(_ v: Any) throws -> Data { try catalogConfigData(v) }
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1] + "/live-stock.json"))) as! [String: Any]
    var auth = fixture["auth"] as! [String: Any]; auth["permissions"] = ["inventory.manage"]
    var session = auth["session"] as! [String: Any]; session["onlineLeaseUntil"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)); session["expiresAt"] = session["onlineLeaseUntil"]; auth["session"] = session
    func actor(_ v: [String: Any]) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(v)) }
    let staff = try actor(auth), itemID = UUID().uuidString.lowercased()
    let item: [String: Any] = ["id": itemID,"sku":"GIN","name":"原金酒","itemType":"bottle","baseUnit":"ml","categoryCode":"spirits","lowStockThreshold":"0.000001","wholeUnitCount":false,"reasonableWasteQuantity":"0","packageVolumeMl":"750","status":"active","updatedAt":"2026-10-05 06:01:02.123456+00","barcodes":[["code":"6900000000001","codeType":"barcode","packageQuantity":"750.000000"]]]
    let original: [String: Any] = ["nativeInventorySetupProtocol":1,"currentEmployeeId":staff.employee.id,"items":[item]]
    func board(_ v: [String: Any]) throws -> InventorySetupBoard { try InventorySetupBoard(data: bytes(["data":v]),actor:staff) }
    let current = try board(original), row = current.items[0]
    var count = 0
    func check(_ ok: Bool, _ name: String) { precondition(ok,name); count += 1; print("PASS " + name) }
    func rejects(_ fn: () throws -> Void) -> Bool { do { try fn(); return false } catch { return true } }
    var create = InventorySetupDraft(); create.sku = "JUICE"; create.name = "新果汁"; create.category = "mixer"; create.baseUnit = "ml"; create.volume = "1000"; create.lowStock = "0.000001"
    let creation = try create.command(actor:staff,board:current,item:nil)
    check(creation.steps[0].object["lowStockThreshold"] as? String == "0.000001", "exact micro-unit threshold")
    var edit = InventorySetupDraft(kind:"edit",item:row); edit.name = "更新金酒"; edit.lowStock = ""; edit.volume = "700"
    let update = try edit.command(actor:staff,board:current,item:row)
    check(update.steps[0].object["expectedUpdatedAt"] as? String == item["updatedAt"] as? String, "original PostgreSQL microseconds retained")
    check(update.steps[0].object["lowStockThreshold"] is NSNull, "explicit threshold removal")
    var bind = InventorySetupDraft(kind:"bind",item:row); bind.barcode = "6900000000002"
    let binding = try bind.command(actor:staff,board:current,item:row)
    check(binding.steps[0].object["packageQuantity"] as? String == "750", "liquid package uses registered volume")
    for c in [creation,update,binding] { check(validInventorySetupSelection(c,board:current), "original selection valid") }
    for invalid in ["-1","0.0000001","1e3","NaN","9999999999999","1,000","+1","01"] { check(rejects { _ = try inventorySetupDecimal(invalid) }, "invalid quantity " + invalid) }
    for field in ["unit","volume","duplicate","name","category","waste"] {
      var d = create
      switch field { case "unit":d.baseUnit="bottle";case "volume":d.volume="";case "duplicate":d.sku="GIN";case "name":d.name="a\nb";case "category":d.category="Spirits";default:d.waste="-1" }
      check(rejects { _ = try d.command(actor:staff,board:current,item:nil) }, "reject invalid creation " + field)
    }
    var denied=auth;denied["deniedPermissions"]=["inventory.manage"]
    check(rejects { _ = try create.command(actor:actor(denied),board:current,item:nil) },"explicit management deny")
    var other=original; other["currentEmployeeId"]=UUID().uuidString.lowercased()
    check(rejects { _ = try board(other) },"wrong actor board")
    other=original;other["items"]=[item,item];check(rejects { _ = try board(other) },"duplicate board item")
    var changed=item;changed["updatedAt"]="2026-10-05 06:01:02.123457+00";other=original;other["items"]=[changed]
    check(!validInventorySetupSelection(update,board:try board(other)),"microsecond changed selection rejected")
    bind.packageQuantity="1";check(rejects { _ = try bind.command(actor:staff,board:current,item:row) },"one bottle not one ml")
    bind.packageQuantity="750";bind.barcode="6900000000001";bind.barcodeType="qr"
    check(rejects { _ = try bind.command(actor:staff,board:current,item:row) },"conflicting barcode type rejected")
    var old=item;old["baseUnit"]="bottle";other=original;other["items"]=[old]
    let legacy=try board(other);var legacyEdit=InventorySetupDraft(kind:"edit",item:legacy.items[0]);legacyEdit.category="snack"
    check(rejects { _ = try legacyEdit.command(actor:staff,board:legacy,item:legacy.items[0]) },"legacy liquid cannot disguise unit by category")
    for command in [creation,update,binding] {
      let step=command.steps[0],proof=step.inventorySetupProof!
      var response=step.object;response.removeValue(forKey:"expectedUpdatedAt")
      response["id"]=proof["kind"] as? String == "edit" ? itemID : UUID().uuidString.lowercased()
      if proof["kind"] as? String == "bind" { response["inventoryItemId"]=itemID }
      else {response["status"]="active";for key in ["sku","baseUnit","itemType"] where proof[key] != nil {response[key]=proof[key]};for key in ["lowStockThreshold","packageVolumeMl"] where response[key]==nil {response[key]=NSNull()} }
      let reply=try bytes(["data":response,"meta":["replayed":true]])
      try validateInventorySetupReply(reply,step:step);check(true,"matching receipt")
      var wrong=response;wrong[proof["kind"] as? String == "bind" ? "inventoryItemId" : "name"]="wrong"
      check(rejects { try validateInventorySetupReply(bytes(["data":wrong,"meta":["replayed":true]]),step:step) },"mismatched receipt rejected")
      check(rejects { try validateInventorySetupReply(bytes(["data":response,"meta":["replayed":1]]),step:step) },"numeric replay flag rejected")
      var requests:[Data]=[],keys:[String]=[]
      let api=StaffAPI { request in
        check(request.url?.path==step.path && request.httpMethod=="POST","real original route")
        requests.append(request.httpBody!);keys.append(request.value(forHTTPHeaderField:step.keyHeader)!)
        if requests.count==1 { throw URLError(.networkConnectionLost) }
        return (reply,HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
      }
      var pending=command
      func send(_ value:LiveCommand.Step) async throws { let (data,_)=try await api.raw(value.path,body:value.object,headers:[value.keyHeader:value.key]);try validateInventorySetupReply(data,step:value) }
      do {_ = try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0});preconditionFailure("lost response") } catch {check(pending.completedSteps==0,"unknown result retains original")}
      pending=try JSONDecoder().decode(LiveCommand.self,from:JSONEncoder().encode(pending))
      pending=try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0})
      check(requests[0]==requests[1] && keys==[step.key,step.key],"restart exact payload and idempotency key")
      _ = try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0});check(requests.count==2,"acknowledged operation not resent")
    }
    print("\(count) inventory setup checks passed")
  }
}
