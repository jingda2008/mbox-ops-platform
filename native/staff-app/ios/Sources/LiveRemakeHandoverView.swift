import SwiftUI
struct LiveRemakeHandoverView:View {
 @EnvironmentObject var model:AppModel
 @Environment(\.dismiss) var dismiss
 @State private var board:RemakeHandoverBoard?
 @State private var reading=false
 @State private var notice="请读取待处理实物"
 @State private var proposed:LiveCommand?
 @State private var itemID:String?
 @State private var access=""
 @State private var receiptKey=""
 private var accessKey:String {"\(model.workspaceVersion)|"+(model.identity?.employee.id ?? "")+"|"+(model.identity?.session.id ?? "")+"|"+(model.identity?.permissions.sorted().joined(separator:",") ?? "")+"|"+(model.identity?.deniedPermissions.sorted().joined(separator:",") ?? "")}
 private var usable:Bool {!model.busy && !model.heartbeatBusy && !reading && model.livePending==nil && model.liveOrderPending==nil && !model.liveStorageDamaged}
 private func load(cursor:[String:Any]?=nil) async {
  guard !reading else{return};reading=true;defer{reading=false}
  do {
   guard let actor=model.identity else{throw StaffAPIError.invalid};let captured=accessKey
   let bytes=try await model.readRemakeHandover(RemakeHandoverBoard.path(cursor:cursor))
   guard accessKey==captured else{return};board=try RemakeHandoverBoard(bytes,actor:actor);receiptKey=model.remakeHandoverReceipt?.requestKey ?? ""
   notice="已读取本页\(board?.rows.count ?? 0)批实物";proposed=nil
  }catch{board=nil;notice=error.localizedDescription}
 }
 var body:some View {
  NavigationStack {
   ScrollView {
    LazyVStack(alignment:.leading,spacing:16) {
     LivePendingView()
     Text("原桌次已结束或原单已取消。核对原批次实物后登记未开封退回或实际耗用；原收退款须单独处理。").font(.subheadline)
     Text(notice)
     Button("从第一页刷新待处理实物"){Task{await load()}}.disabled(!usable)
     if let board {
      if !board.enabled {Text("配套后台尚未支持可恢复原生实物操作，仅可查询。").foregroundStyle(.secondary)}
      if board.rows.isEmpty {Text("本页没有离店重做实物待办。")}
      ForEach(board.rows){row in
       RemakeHandoverCard(row:row,enabled:usable && board.enabled,openItem:{itemID=row.text("itemId")},submit:{selected,disposition,received,reason in
        do {guard let actor=model.identity else{throw StaffAPIError.invalid};proposed=try board.command(actor:actor,row:row,selected:selected,disposition:disposition,received:received,reason:reason)}catch{notice=error.localizedDescription}
       }).id(row.bytes)
      }
      if let next=board.next {Button("下一页离店实物"){Task{await load(cursor:next)}}.disabled(!usable)}
     }
    }.padding(16)
   }.background(paper).navigationTitle("离店重做实物交接").navigationBarTitleDisplayMode(.inline)
    .toolbar{ToolbarItem(placement:.cancellationAction){Button("关闭"){dismiss()}}}
  }.task{access=accessKey;await load()}
   .onChange(of:accessKey){_,value in if value != access {board=nil;proposed=nil;itemID=nil;dismiss()}}
   .onChange(of:model.busy){_,busy in if !busy,!reading,let receipt=model.remakeHandoverReceipt,receipt.requestKey != receiptKey {receiptKey=receipt.requestKey;Task{await load()}}}
   .sheet(isPresented:Binding(get:{itemID != nil},set:{if !$0 {itemID=nil}}),onDismiss:{Task{await load()}}){if let itemID {LiveAfterSalesView(itemID:itemID)}}
   .sheet(item:$proposed){command in
    NavigationStack {
     ScrollView{VStack(alignment:.leading,spacing:16){Text(command.steps.first?.remakeHandoverProof?["confirmation"] as? String ?? "原实物待核对");Button("确认实际处理"){proposed=nil;Task{await model.executeLive(command)}}.buttonStyle(Primary(symbol:"checkmark.shield")).disabled(!model.canExecuteLive(command))}.padding(16)}
      .navigationTitle("核对原实物").navigationBarTitleDisplayMode(.inline).toolbar{ToolbarItem(placement:.cancellationAction){Button("返回核对"){proposed=nil}}}
    }
   }
 }
}
private struct RemakeHandoverCard:View {
 let row:ShowRow,enabled:Bool
 let openItem:()->Void
 let submit:(Set<String>,String,Bool,String)->Void
 @State private var selected=Set<String>()
 @State private var received=false
 @State private var checked=false
 @State private var reason=""
 private var ids:[String] {row.object["unitIds"] as? [String] ?? []}
 private var eligibility:[String:Any] {row.object["returnEligibility"] as? [String:Any] ?? [:]}
 private var canReturn:Bool {!selected.isEmpty && selected.allSatisfy{(eligibility[$0] as? [String:Any])?["canReturn"] as? Bool==true}}
 var body:some View {
  Card {
   Text(row.text("tableCode")+" · "+row.text("productName")).font(.headline)
   Text("原订单 "+row.text("orderPublicId")+"\n待处理 "+row.text("pendingQuantity")+"份 · "+showTime(row.text("createdAt"))).font(.subheadline)
   Text("逐份选择本次已实际核对的原批次实物：")
   ForEach(Array(ids.enumerated()),id:\.element){index,id in
    Toggle("本批第\(index+1)份",isOn:Binding(get:{selected.contains(id)},set:{value in if value {selected.insert(id)}else{selected.remove(id)};received=false;checked=false})).disabled(!enabled)
    if let fact=eligibility[id] as? [String:Any],fact["canReturn"] as? Bool != true {Text(fact["reason"] as? String ?? "原包装与库存证据不支持退回").font(.caption).foregroundStyle(.secondary)}
   }
   TextField("本次实际处理说明（2—500字）",text:$reason,axis:.vertical).textFieldStyle(.roundedBorder)
   Toggle("已核对本批实物和所选\(selected.count)份",isOn:$checked)
   if row.object["canReceive"] as? Bool==true {
    Toggle("实物已收回且未开封",isOn:$received).disabled(!canReturn)
    Button("登记所选实物退回"){submit(selected,"returned_unopened",received,reason)}.buttonStyle(Primary(symbol:"shippingbox.and.arrow.backward")).disabled(!enabled || !checked || !canReturn || !received)
   }
   if row.object["canRecordUsed"] as? Bool==true {
    Text("只有实际耗用或损耗才选此项，不能为了清空待办而登记。").font(.caption)
    Button("登记实际耗用或损耗",role:.destructive){submit(selected,"used_loss",false,reason)}.disabled(!enabled || !checked || selected.isEmpty)
   }
   Button("查看原商品与售后",action:openItem)
  }
 }
}
