import Foundation
@main struct RecipeConfigurationTests {
  @MainActor static func main() async throws {
    func bytes(_ v:Any) throws -> Data {try catalogConfigData(v)}
    let fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]+"/live-stock.json"))) as! [String:Any]
    var auth=fixture["auth"] as! [String:Any];auth["permissions"]=["inventory.manage","inventory.cost.view"]
    var session=auth["session"] as! [String:Any];session["onlineLeaseUntil"]=ISO8601DateFormatter().string(from:Date().addingTimeInterval(3600));session["expiresAt"]=session["onlineLeaseUntil"];auth["session"]=session
    let actor=try JSONDecoder().decode(StaffIdentity.self,from:bytes(auth)),productID=UUID().uuidString.lowercased(),itemID=UUID().uuidString.lowercased(),recipeID=UUID().uuidString.lowercased()
    let component:[String:Any]=["inventoryItemId":itemID,"quantity":"0.000001","expectedWasteQuantity":"0"]
    let recipe:[String:Any]=["id":recipeID,"productId":productID,"version":3,"yieldQuantity":1,"instructionsSnapshot":["notes":"原备注","legacy":"必须保留"],"components":[component]]
    var payload:[String:Any]=["currentEmployeeId":actor.employee.id,"nativeRecipeProtocol":1,"expectedVersion":String(repeating:"a",count:64),"product":["id":productID,"name":"鸡尾酒","product_kind":"single"],"items":[["id":itemID,"name":"原酒","sku":"GIN","baseUnit":"ml"]],"recipe":recipe]
    func board(_ v:[String:Any]) throws -> RecipeConfigurationBoard {try RecipeConfigurationBoard(data:bytes(["data":v]),actor:actor,productID:productID)}
    let current=try board(payload);var draft=RecipeConfigurationDraft(board:current);draft.notes=" 更新说明 "
    let command=try draft.command(actor:actor,board:current),step=command.steps[0]
    var count=0
    func check(_ ok:Bool,_ label:String){precondition(ok,label);count+=1;print("PASS "+label)}
    func rejects(_ fn:()throws->Void)->Bool {do {try fn();return false}catch{return true}}
    check((step.object["instructionsSnapshot"] as? [String:Any])?["legacy"] as? String == "必须保留","preserve legacy instruction fields")
    check((step.object["instructionsSnapshot"] as? [String:Any])?["notes"] as? String == "更新说明","trim explicit notes")
    check(step.object["expectedVersion"] as? String == current.version,"preserve original recipe/product fingerprint")
    for invalid in ["0","1001","1.5",""] {var d=draft;d.output=invalid;check(rejects{_ = try d.command(actor:actor,board:current)},"reject yield "+invalid)}
    for invalid in ["0","-1","1e3","0.0000001"] {var d=draft;d.lines[0].quantity=invalid;check(rejects{_ = try d.command(actor:actor,board:current)},"reject use quantity "+invalid)}
    var bad=draft;bad.lines.append(bad.lines[0]);check(rejects{_ = try bad.command(actor:actor,board:current)},"duplicate material rejected")
    bad=draft;bad.lines=[];check(rejects{_ = try bad.command(actor:actor,board:current)},"empty recipe rejected")
    bad=draft;bad.lines=[RecipeConfigurationLine(id:UUID().uuidString.lowercased())];check(rejects{_ = try bad.command(actor:actor,board:current)},"inactive or different material rejected")
    var wrong=payload;wrong["product"]=["id":productID,"name":"套餐","product_kind":"bundle"];check(rejects{_ = try draft.command(actor:actor,board:board(wrong))},"bundle cannot have direct recipe")
    let cost:[String:Any]=["productId":productID,"recipeId":recipeID,"recipeVersion":3,"currency":"CNY","costAmountMinor":NSNull(),"components":[["recipeItemId":UUID().uuidString.lowercased(),"inventoryItemId":itemID,"itemName":"原酒","baseUnit":"ml","componentQuantity":"0.000001","componentCostMinor":NSNull()]]]
    check(try RecipeCostViewData(data:bytes(["data":cost]),board:current).amountMinor == nil,"unknown cost is not zero")
    var stale=cost;stale["recipeVersion"]=2;check(rejects{_ = try RecipeCostViewData(data:bytes(["data":stale]),board:current)},"two-read recipe race rejected")
    payload["recipe"]=NSNull();let empty=try board(payload);var new=RecipeConfigurationDraft(board:empty);new.lines=draft.lines
    let create=try new.command(actor:actor,board:empty)
    for original in [command,create] {
      let step=original.steps[0],version=original.steps[0].recipeConfigurationProof!["originalVersion"] as! Int
      let response:[String:Any]=["id":UUID().uuidString.lowercased(),"version":version+1],reply=try bytes(["data":response,"meta":["replayed":true]])
      try validateRecipeConfigurationReply(reply,step:step);check(true,"new recipe version receipt accepted")
      for badVersion:Any in [version,true] {check(rejects{try validateRecipeConfigurationReply(bytes(["data":["id":recipeID,"version":badVersion],"meta":["replayed":true]]),step:step)},"non-advanced or boolean version rejected")}
      check(rejects{try validateRecipeConfigurationReply(bytes(["data":response,"meta":["replayed":1]]),step:step)},"numeric replay rejected")
      var bodies:[Data]=[],keys:[String]=[]
      let api=StaffAPI { request in
        check(request.url?.path==step.path && request.httpMethod=="POST","real original recipe endpoint")
        bodies.append(request.httpBody!);keys.append(request.value(forHTTPHeaderField:step.keyHeader)!)
        if bodies.count==1 {throw URLError(.networkConnectionLost)}
        return(reply,HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
      }
      var pending=original
      func send(_ value:LiveCommand.Step) async throws {let(data,_)=try await api.raw(value.path,body:value.object,headers:[value.keyHeader:value.key]);try validateRecipeConfigurationReply(data,step:value)}
      do {_ = try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0});preconditionFailure()}catch{check(pending.completedSteps==0,"unknown receipt retains original")}
      pending=try JSONDecoder().decode(LiveCommand.self,from:JSONEncoder().encode(pending));pending=try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0})
      check(bodies[0]==bodies[1] && keys==[step.key,step.key],"restart exact original recipe and key")
      _ = try await LiveCommandRunner.advance(pending,send:send,checkpoint:{pending=$0});check(bodies.count==2,"complete recipe not resent")
    }
    print("\(count) recipe configuration checks passed")
  }
}
