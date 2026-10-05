import SwiftUI
struct LiveFulfillmentHistoryView:View {
 @EnvironmentObject var model:AppModel
 @Environment(\.dismiss) var dismiss
 @State private var query=FulfillmentHistoryQuery()
 @State private var applied=FulfillmentHistoryQuery()
 @State private var board:FulfillmentHistoryBoard?
 @State private var reading=false
 @State private var notice=""
 @State private var access=""
 @State private var itemID:String?
 private var accessKey:String {"\(model.workspaceVersion)|"+(model.identity?.employee.id ?? "")+"|"+(model.identity?.session.id ?? "")+"|"+(model.identity?.permissions.sorted().joined(separator:",") ?? "")+"|"+(model.identity?.deniedPermissions.sorted().joined(separator:",") ?? "")}
 private func load(page:Int=0,paging:Bool=false)async {
  guard !reading else{return};reading=true;defer{reading=false}
  let filter=paging ? applied:query,captured=accessKey
  do {let result=try await model.readFulfillmentHistory(query:filter,page:page);guard accessKey==captured else{return};board=result;applied=filter;if applied.date.isEmpty {applied.date=result.date};query=applied;notice="已读取原完成记录"}
  catch{board=nil;notice=error.localizedDescription}
 }
 var body:some View {
  NavigationStack {
   ScrollView {
    LazyVStack(alignment:.leading,spacing:16) {
     Picker("记录类型",selection:$query.kind){Text("本人制作").tag("prepared");Text("送达记录").tag("delivered")}.pickerStyle(.segmented).disabled(reading)
     TextField("营业日 YYYY-MM-DD（空为当前）",text:$query.date).textFieldStyle(.roundedBorder).disabled(reading)
     TextField("桌号（可部分文字）",text:$query.table).textFieldStyle(.roundedBorder).disabled(reading)
     Button("查询 / 刷新"){Task{await load()}}.disabled(reading || model.busy || model.heartbeatBusy)
     Text(reading ? "正在读取历史…":notice).font(.subheadline)
     Text("本人记录只显示服务端核定的完成数量；共用取餐屏记录按可见桌台显示，不计入个人送达数量。").font(.subheadline)
     if let board {
      Text("当前结果："+(board.query.kind=="prepared" ? "本人制作":"送达记录")+" · "+board.date).font(.headline)
      if board.query.kind=="delivered" {
       Text("共用取餐屏送达").font(.headline)
       if board.shared.isEmpty {Text("本页没有共用取餐屏记录。")}
       ForEach(board.shared){entry in shared(entry)}
      }
      Text(board.query.kind=="prepared" ? "本人制作记录":"本人送达记录").font(.headline)
      if board.orders.isEmpty {Text("本页没有本人完成记录。")}
      ForEach(board.orders){order in personal(order,kind:board.query.kind)}
      HStack{Button("上一页"){Task{await load(page:board.page-1,paging:true)}}.disabled(reading || board.page==0);Spacer();Text("第\(board.page+1)页");Spacer();Button("下一页"){Task{await load(page:board.page+1,paging:true)}}.disabled(reading || !board.hasMore || board.page>=2000)}
      Text("读取时间："+showTime(board.generatedAt)).font(.caption)
     }
    }.padding(16)
   }.background(paper).navigationTitle("制作与送达历史").navigationBarTitleDisplayMode(.inline).toolbar{ToolbarItem(placement:.cancellationAction){Button("关闭"){dismiss()}}}
  }.task{access=accessKey;await load()}.onChange(of:accessKey){_,value in if value != access {board=nil;itemID=nil;dismiss()}}
   .sheet(isPresented:Binding(get:{itemID != nil},set:{if !$0 {itemID=nil}})){if let itemID {LiveAfterSalesView(itemID:itemID)}}
 }
 @ViewBuilder private func personal(_ order:ShowRow,kind:String)->some View {
  Card {
   Text(order.text("tableCode")+" · "+order.text("publicId")).font(.headline)
   let items=(order.object["items"] as? [[String:Any]] ?? []).compactMap{try? ShowRow($0)}
   ForEach(items){item in
    let label=kind=="prepared" ? "制作":"送达"
    Text(item.text("name")+" · "+(item.object["workQuantity"] != nil ? "本人"+label+" "+item.text("workQuantity")+"份":"原单 "+item.text("quantity")+"份（本人数量未留存）"))
    if !item.text("note").isEmpty {Text("备注："+item.text("note"))}
    if !item.text("fulfillmentClosureNote").isEmpty {Text(item.text("fulfillmentClosureNote"))}
    let by=item.text(kind=="prepared" ? "preparedBy":"deliveredBy"),at=item.text(kind=="prepared" ? "preparedAt":"deliveredAt")
    Text((by.isEmpty ? "员工信息未留存":by)+" · "+(at.isEmpty ? "完成时间未留存":showTime(at))).font(.caption)
    if model.canReadAfterSales {Button("查看原商品处理"){itemID=item.id}}
   }
  }
 }
 @ViewBuilder private func shared(_ row:ShowRow)->some View {
  Card {
   Text(row.text("tableCode")+" · "+showTime(row.text("deliveredAt"))).font(.headline)
   if row.text("pickupTableCode") != row.text("tableCode"){Text("取走时桌号："+row.text("pickupTableCode"))}
   let values=row.object["items"] as? [[String:Any]] ?? []
   ForEach(Array(values.enumerated()),id:\.offset){_,item in
    Text(showText(item,"name")+" · 已送达 "+showText(item,"quantity")+"份"+(showText(item,"kind")=="remake" ? " · 重做":""))
    ForEach(["specification","itemNote","orderNote"],id:\.self){key in if !showText(item,key).isEmpty {Text(showText(item,key))}}
    if model.canReadAfterSales {Button("查看原商品处理"){itemID=showText(item,"itemId")}}
   }
  }
 }
}
