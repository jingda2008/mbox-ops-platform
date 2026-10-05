import Foundation
let fulfillmentHistoryPermissions=["reconciliation.view","order.history.view","order.history.all"]
func canReadFulfillmentHistory(_ actor:StaffIdentity?)->Bool {actor.map{fulfillmentHistoryPermissions.contains(where:$0.allows)} ?? false}
struct FulfillmentHistoryQuery:Equatable {
 var kind="prepared"
 var date=""
 var table=""
 func path(page:Int=0)throws->String {
  guard ["prepared","delivered"].contains(kind),(0...2000).contains(page),table.utf16.count<=80 else{throw CatalogError("请核对记录类型、桌号与页码")}
  if !date.isEmpty {_ = try ExperiencePlanQuery(history:true,from:date,to:date).suffix()}
  var url=URLComponents();url.path="/api/operations/history";url.queryItems=[URLQueryItem(name:"workKind",value:kind),URLQueryItem(name:"page",value:String(page)),URLQueryItem(name:"table",value:table.trimmingCharacters(in:.whitespacesAndNewlines))]
  if !date.isEmpty {url.queryItems?.append(URLQueryItem(name:"businessDate",value:date))}
  return url.string!.replacingOccurrences(of:"+",with:"%2B")
 }
}
struct FulfillmentHistoryBoard {
 let query:FulfillmentHistoryQuery,page:Int,hasMore:Bool,date:String,generatedAt:String
 let orders:[ShowRow],shared:[ShowRow]
 init(_ bytes:Data,query:FulfillmentHistoryQuery,page:Int)throws {
  _ = try query.path(page:page)
  let data=try showData(bytes)
  guard try showInteger(data["page"])==page,let orders=data["orders"] as? [[String:Any]],let date=data["businessDate"] as? String,let generated=data["generatedAt"] as? String,showServerDate(generated) != nil else {throw StaffAPIError.invalid}
  _ = try ExperiencePlanQuery(history:true,from:date,to:date).suffix()
  guard query.date.isEmpty || query.date==date else {throw StaffAPIError.invalid}
  self.query=query;self.page=page;self.date=date;generatedAt=generated;hasMore=try showFlag(data["hasMore"]);self.orders=try orders.map(ShowRow.init)
  for order in orders {
   guard let items=order["items"] as? [[String:Any]] else{throw StaffAPIError.invalid}
   for item in items {
    _ = try showUUID(item["id"]);_ = try showString(item,"name");_ = try showInteger(item["quantity"],min:1)
    if let number=item["workQuantity"] {_ = try showInteger(number)}
    for field in ["preparedAt","deliveredAt"] {if let date=item[field] as? String,showServerDate(date)==nil {throw StaffAPIError.invalid}}
   }
  }
  let shared=data["sharedDeliveries"] as? [[String:Any]] ?? []
  self.shared=try shared.map {entry in
   guard query.kind=="delivered",entry["source"] as? String=="shared_pickup_device",let at=entry["deliveredAt"] as? String,showServerDate(at) != nil,let items=entry["items"] as? [[String:Any]] else {throw StaffAPIError.invalid}
   var value=entry;value["id"]=try showUUID(entry["receiptId"])
   _ = try showString(entry,"tableCode");_ = try showString(entry,"pickupTableCode")
   for item in items {_ = try showUUID(item["itemId"]);_ = try showString(item,"name");_ = try showInteger(item["quantity"],min:1);guard ["original","remake"].contains(item["kind"] as? String ?? ""),["specification","itemNote","orderNote"].allSatisfy({item[$0] is String}) else{throw StaffAPIError.invalid}}
   return try ShowRow(value)
  }
  guard Set(self.orders.map(\.id)).count==orders.count,Set(self.shared.map(\.id)).count==shared.count else{throw StaffAPIError.invalid}
 }
}
