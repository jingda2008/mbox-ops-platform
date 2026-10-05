import Foundation
let inventoryPublishPermissions = ["inventory.receive","catalog.product.manage","inventory.cost.view"]
func inventoryPublishEnvelope(_ data: Data, actor: StaffIdentity) throws -> [String: Any] {
  guard inventoryPublishPermissions.allSatisfy(actor.allows), let root = try JSONSerialization.jsonObject(with:data) as? [String:Any], let d = root["data"] as? [String:Any],
    try catalogConfigInt(d["nativeInventoryPublishProtocol"]) == 1, d["currentEmployeeId"] as? String == actor.employee.id else { throw StaffAPIError.invalid }; return d
}
func inventoryPublishLines(_ raw: Any?) throws -> [[String: Any]] {
  guard let lines = raw as? [[String:Any]], !lines.isEmpty else { throw StaffAPIError.invalid }
  for line in lines {
    guard !(line["itemName"] as? String ?? "").isEmpty, inventorySetupUnits[line["baseUnit"] as? String ?? ""] != nil else { throw StaffAPIError.invalid }
    _ = try inventorySetupDecimal(line["quantity"] as? String ?? "",zero:false)
  }
  return lines
}
struct InventoryPublishBoard {
  let employeeID: String
  let receipt: CatalogConfigurationRecord
  let products: [CatalogConfigurationRecord]
  init(data:Data,actor:StaffIdentity,receiptID:String) throws {
    let d = try inventoryPublishEnvelope(data,actor:actor)
    guard let r=d["receipt"] as? [String:Any],r["id"] as? String == receiptID,UUID(uuidString:receiptID) != nil,
      ["draft","received"].contains(r["status"] as? String ?? ""),r["currency"] as? String == "CNY",!(r["publicId"] as? String ?? "").isEmpty,
      let products=d["products"] as? [[String:Any]] else {throw StaffAPIError.invalid}
    _ = try inventoryPublishLines(r["lines"])
    self.products = try products.map(CatalogConfigurationRecord.init);receipt=try CatalogConfigurationRecord(r);employeeID=actor.employee.id
    guard Set(self.products.map(\.id)).count == self.products.count,self.products.allSatisfy({UUID(uuidString:$0.id) != nil && !$0.text("name").isEmpty}) else {throw StaffAPIError.invalid}
  }
}
struct InventoryPublishPreview {
  let data: Data
  let employeeID, receiptID, productID, version: String
  let ready: Bool
  var object: [String:Any] { (try? JSONSerialization.jsonObject(with:data)) as? [String:Any] ?? [:] }
  init(data:Data,actor:StaffIdentity,board:InventoryPublishBoard,productID:String) throws {
    let d=try inventoryPublishEnvelope(data,actor:actor)
    guard board.employeeID==actor.employee.id,d["receiptId"] as? String==board.receipt.id,d["receiptPublicId"] as? String==board.receipt.text("publicId"),
      d["productId"] as? String==productID,board.products.contains(where:{$0.id==productID}),d["currency"] as? String=="CNY",
      let version=d["expectedVersion"] as? String,version.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil,
      let channels=d["allowedChannels"] as? [String],try catalogConfigInt(d["recipeVersion"])>0 else {throw StaffAPIError.invalid}
    _ = try inventoryPublishLines(d["receiptLines"])
    let cost=try catalogConfigInt(d["costAmountMinor"]),price=try catalogConfigInt(d["standardPriceMinor"]),profit=try catalogConfigInt(d["grossProfitMinor"]),servings=try catalogConfigInt(d["sellableServings"])
    guard cost>=0,price>0,price<=100_000_000,cost<=Int.max-price,profit==price-cost,servings>=0 else {throw StaffAPIError.invalid}
    self.data=try catalogConfigData(d);employeeID=actor.employee.id;receiptID=board.receipt.id;self.productID=productID;self.version=version
    ready=try catalogConfigBool(d["guestVisible"]) && channels.contains("guest_qr") && channels.contains("staff_assisted") && servings>0
  }
  var confirmation:String {
    let d=object,lines=(d["receiptLines"] as? [[String:Any]] ?? []).map { line in
      (line["itemName"] as? String ?? "") + " · " + (line["quantity"] as? String ?? "") + " " + (line["baseUnit"] as? String ?? "") + ((line["batchCode"] as? String).map{" · 批次 "+$0} ?? "")
    }
    return "采购单 " + (d["receiptPublicId"] as? String ?? "") + "\n" + lines.joined(separator:"\n") + "\n以上全部采购行一并入库，已收货单不会重复加库存。\n发布商品：" + (d["productName"] as? String ?? "") + "\n售价 " + money((try? catalogConfigInt(d["standardPriceMinor"])) ?? 0) + " · 每份成本 " + money((try? catalogConfigInt(d["costAmountMinor"])) ?? 0) + "\n每份毛利 " + money((try? catalogConfigInt(d["grossProfitMinor"])) ?? 0) + " · 可售 " + String((try? catalogConfigInt(d["sellableServings"])) ?? 0) + " 份\n须核实整单所有实物；价格、库存或配方变化会拒绝本笔操作，须重新核对。"
  }
  func command(actor:StaffIdentity,board:InventoryPublishBoard,confirmedWholeReceipt:Bool) throws -> LiveCommand {
    guard confirmedWholeReceipt,ready,employeeID==actor.employee.id,board.employeeID==employeeID,board.receipt.id==receiptID,
      inventoryPublishPermissions.allSatisfy(actor.allows),StaffIdentity.date(actor.session.onlineLeaseUntil).map({$0>Date()})==true,
      board.products.contains(where:{$0.id==productID}) else {throw CatalogError("请逐行验收整张采购单，并核对收货、商品和成本权限以及顾客/员工渠道、配方、价格与库存")}
    let id=UUID().uuidString.lowercased();var proof:[String:Any]=["receiptId":receiptID,"receiptPublicId":board.receipt.text("publicId"),"productId":productID,"employeeId":employeeID,"confirmation":confirmation]
    for k in ["costAmountMinor","standardPriceMinor","grossProfitMinor"] {proof[k]=try catalogConfigInt(object[k])}
    return LiveCommand(id:id,employeeID:employeeID,title:"核对整单收货与商品发布",permission:"inventory.receive",steps:[.init(path:inventorySetupRoot+"/receipts/"+receiptID+"/receive-and-publish",body:try catalogConfigData(["productId":productID,"expectedVersion":version]),keyHeader:"idempotency-key",key:"native-inventory-publish-"+id,recoveryBody:try catalogConfigData(["inventoryPublish":proof]))])
  }
}
extension LiveCommand.Step {
  var inventoryPublishProof:[String:Any]? {guard let recoveryBody else{return nil};return ((try? JSONSerialization.jsonObject(with:recoveryBody)) as? [String:Any])?["inventoryPublish"] as? [String:Any]}
}
func validInventoryPublishSelection(_ command:LiveCommand,board:InventoryPublishBoard,preview:InventoryPublishPreview)->Bool {
  guard command.steps.count==1,command.permission=="inventory.receive",command.employeeID==board.employeeID,preview.employeeID==board.employeeID,preview.ready,
    board.receipt.id==preview.receiptID,let step=command.steps.first,let proof=step.inventoryPublishProof,
    proof["receiptId"] as? String==preview.receiptID,proof["productId"] as? String==preview.productID,
    step.path==inventorySetupRoot+"/receipts/"+preview.receiptID+"/receive-and-publish",step.object["expectedVersion"] as? String==preview.version,
    step.object["productId"] as? String==preview.productID else{return false}
  return ["costAmountMinor","standardPriceMinor","grossProfitMinor"].allSatisfy { key in
    guard let a=try? catalogConfigInt(proof[key]),let b=try? catalogConfigInt(preview.object[key]) else{return false};return a==b
  }
}
func validateInventoryPublishReply(_ data:Data,step:LiveCommand.Step) throws {
  guard let root=try JSONSerialization.jsonObject(with:data) as? [String:Any],let d=root["data"] as? [String:Any],let meta=root["meta"] as? [String:Any],let p=step.inventoryPublishProof,
    d["id"] as? String==p["receiptId"] as? String,d["receiptPublicId"] as? String==p["receiptPublicId"] as? String,d["productId"] as? String==p["productId"] as? String,
    d["receiptStatus"] as? String=="received",d["productStatus"] as? String=="active",UUID(uuidString:d["recipeCostVersionId"] as? String ?? "") != nil else{throw StaffAPIError.invalid}
  _ = try catalogConfigBool(meta["replayed"]);_ = try stockServerInstant(d["publishedAt"] as? String ?? "")
  for k in ["costAmountMinor","standardPriceMinor","grossProfitMinor"] {guard try catalogConfigInt(d[k])==catalogConfigInt(p[k]) else{throw StaffAPIError.invalid}}
}
