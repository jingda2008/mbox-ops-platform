import Foundation
let productSpecificationOptions = ["whole_bottle":"整瓶","glass":"单杯","shot":"小杯 Shot","cocktail":"鸡尾酒","custom":"自定义"]
let productTagOptions = [
 "recommendationSceneTags":["date":"约会","brothers":"兄弟聚会","besties":"闺蜜聚会","friends":"朋友聚会","business":"商务","celebration":"庆祝","unsure":"未确定"],
 "recommendationIntentTags":["relaxed":"放松","energetic":"热闹","ritual":"仪式感","unsure":"未确定"],
 "recommendationTasteTags":["refreshing":"清爽","layered":"层次丰富","strong":"浓烈","any":"不限"],
 "recommendationDwellTags":["one_set":"一轮演出","stay_longer":"多坐一会","no_rush":"不赶时间"]]
let productNumberBounds:[String:ClosedRange<Int>] = ["recommendationMinGuests":1...200,"recommendationMaxGuests":1...200,"recommendationPriority":0...1000,"recommendationExpectedPrepMinutes":0...240,"recommendationHoldMinutes":0...240,"kdsPriority":0...1000]
let productNumberLabels = ["recommendationMinGuests":"最少人数","recommendationMaxGuests":"最多人数","recommendationPriority":"推荐优先级","recommendationExpectedPrepMinutes":"预计准备分钟","recommendationHoldMinutes":"推荐保留分钟","kdsPriority":"出品优先级"]
let productTagLabels = ["recommendationSceneTags":"适用场景","recommendationIntentTags":"顾客意图","recommendationTasteTags":"口味偏好","recommendationDwellTags":"停留时长"]
struct ProductOperationsDraft {
 var specification = "custom", acidity = "", sweetness = "", search = "", sla = "", upgradeID = "", upgradeName = "无"
 var enabled = false, singleWave = false
 var numbers:[String:String] = [:], tags:[String:Set<String>] = [:]
 var cost = "", originalCost = "", reason = ""
 init(product:CatalogConfigurationRecord) throws {
  let p=product.object,snapshot=p["productSnapshot"] as? [String:Any] ?? [:],taste=snapshot["tasteProfile"] as? [String:Any] ?? [:]
  specification=snapshot["salesSpecificationType"] as? String ?? "custom"
  if let n=try? catalogConfigInt(taste["acidity"]) {acidity=String(n)}
  if let n=try? catalogConfigInt(taste["sweetness"]) {sweetness=String(n)}
  search=product.text("searchText");upgradeID=product.text("recommendationUpgradeProductId");upgradeName=upgradeID.isEmpty ? "无" : "已配置原商品"
  enabled=try catalogConfigBool(p["recommendationEnabled"]);singleWave=try catalogConfigBool(p["recommendationSingleWaveEligible"])
  for key in productNumberBounds.keys {numbers[key]=String(try catalogConfigInt(p[key]))}
  for key in productTagOptions.keys {guard let values=p[key] as? [String] else {throw StaffAPIError.invalid};tags[key]=Set(values)}
  if !(p["fulfillmentSlaSeconds"] is NSNull) {sla=String(try catalogConfigInt(p["fulfillmentSlaSeconds"]))}
  if let text=p["costAmountMinor"] as? String, let amount=Int(text),amount>=0 {cost=NSDecimalNumber(decimal:Decimal(amount)/100).stringValue}
  originalCost=cost
 }
 func command(actor:StaffIdentity,board:CatalogConfigurationBoard,product:CatalogConfigurationRecord) throws -> LiveCommand {
  guard board.enabled,board.operationalEnabled,board.employeeID==actor.employee.id,board.products.contains(product),actor.allows("catalog.product.manage"),
   StaffIdentity.date(actor.session.onlineLeaseUntil).map({$0>Date()})==true,productSpecificationOptions[specification] != nil,search.utf16.count<=2000 else{throw CatalogError("请重新读取原商品并核对权限、销售规格及搜索别名")}
  var patch:[String:Any]=["recommendationEnabled":enabled,"recommendationSingleWaveEligible":singleWave,"searchText":search.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? product.text("code")+" "+product.text("name"):search.trimmingCharacters(in:.whitespacesAndNewlines)]
  var detail=[product.text("name"),"规格："+productSpecificationOptions[specification]!,"酸度："+(acidity.isEmpty ? "未评价":acidity),"甜度："+(sweetness.isEmpty ? "未评价":sweetness),enabled ? "参与推荐":"不参与推荐",singleWave ? "可一次出齐":"分次出品"]
  for (key,range) in productNumberBounds {
   guard let value=Int(numbers[key] ?? ""),range.contains(value) else{throw CatalogError((productNumberLabels[key] ?? key)+"须在\(range.lowerBound)—\(range.upperBound)之间")}
   patch[key]=value;detail.append(productNumberLabels[key]!+"："+String(value))
  }
  guard (patch["recommendationMinGuests"] as! Int)<=(patch["recommendationMaxGuests"] as! Int) else{throw CatalogError("最少人数不能超过最多人数")}
  for (key,options) in productTagOptions {
   let values=tags[key] ?? [];guard values.allSatisfy({options[$0] != nil}) else{throw CatalogError("推荐标签无效")}
   patch[key]=values.sorted();detail.append(productTagLabels[key]!+"："+(values.isEmpty ? "未限制":values.sorted().compactMap{options[$0]}.joined(separator:"、")))
  }
  if sla.isEmpty {patch["fulfillmentSlaSeconds"]=NSNull()}else{guard let n=Int(sla),(30...14400).contains(n) else{throw CatalogError("出品时限须为30—14400秒，空白使用岗位默认")};patch["fulfillmentSlaSeconds"]=n}
  guard upgradeID.isEmpty || (UUID(uuidString:upgradeID) != nil && upgradeID != product.id) else{throw CatalogError("升级推荐须选择其他有效商品")}
  patch["recommendationUpgradeProductId"]=upgradeID.isEmpty ? NSNull():upgradeID as Any
  var snapshot=product.object["productSnapshot"] as? [String:Any] ?? [:],taste=snapshot["tasteProfile"] as? [String:Any] ?? [:]
  for (key,value) in [("acidity",acidity),("sweetness",sweetness)] {
   if value.isEmpty {taste[key]=NSNull()}else{guard let n=Int(value),(0...5).contains(n) else{throw CatalogError("酸甜度须为0—5级，未评价留空")};taste[key]=n}
  }
  snapshot["salesSpecificationType"]=specification;snapshot["tasteProfile"]=taste;patch["productSnapshot"]=snapshot
  if cost != originalCost {
   guard actor.allows("inventory.cost.view"),product.text("productKind")=="single",product.text("inventoryControlMode")=="not_managed" else{throw CatalogError("仅有成本权限的非库存单品可手填成本；配方和套餐成本由后台计算")}
   let reason=reason.trimmingCharacters(in:.whitespacesAndNewlines);guard (2...500).contains(reason.utf16.count) else{throw CatalogError("请填写2—500字成本变更依据")}
   if cost.isEmpty {patch["costAmountMinor"]=NSNull()}else{guard let value=nativeNonnegativeMoney(cost),value<=100_000_000 else{throw CatalogError("成本为有效人民币金额，最多两位小数")};patch["costAmountMinor"]=value}
   patch["costChangeReason"]=reason;detail += ["新成本："+(cost.isEmpty ? "未知":cost+"元"),"原因："+reason]
  }
  detail += ["出品时限："+(sla.isEmpty ? "岗位默认":sla+"秒"),"升级推荐："+upgradeName,"搜索别名："+(patch["searchText"] as! String),"口味等级是门店主观评价。配置影响后续业务，历史订单保留原快照。"]
  let id=UUID().uuidString.lowercased(),proof:[String:Any]=["kind":"product","employeeId":actor.employee.id,"id":product.id,"creating":false,"expected":patch,"confirmation":detail.joined(separator:"\n")]
  return LiveCommand(id:id,employeeID:actor.employee.id,title:"核对商品规格、推荐与出品",permission:"catalog.product.manage",steps:[.init(path:catalogConfigurationRoot+"/products/"+product.id,body:try catalogConfigData(["expectedVersion":product.text("nativeVersion"),"patch":patch]),keyHeader:"idempotency-key",key:"native-product-"+id,recoveryBody:try catalogConfigData(["catalogConfiguration":proof]))])
 }
}
func companionProductDraft(_ product:CatalogConfigurationRecord) throws -> CatalogProductDraft {
 guard product.text("productKind")=="single",product.text("inventoryControlMode")=="tracked",var snapshot=product.object["productSnapshot"] as? [String:Any],let original=snapshot["salesSpecificationType"] as? String,["whole_bottle","glass"].contains(original) else{throw CatalogError("整瓶/单杯对应商品只适用于按配方扣库的单品")}
 let target=original=="whole_bottle" ? "glass":"whole_bottle",suffix=target=="glass" ? "_GLASS":"_BOTTLE"
 var draft=try CatalogProductDraft(product:product);draft.code=String(product.text("code").prefix(64-suffix.count))+suffix;draft.name=product.text("name")+" · "+productSpecificationOptions[target]!
 snapshot["salesSpecificationType"]=target;draft.initialSnapshot=snapshot;draft.initialPrice="";draft.components=[];draft.groups=[]
 return draft
}
