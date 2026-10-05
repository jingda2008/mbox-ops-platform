import SwiftUI
struct LiveProductOperationsView:View {
 let product:CatalogConfigurationRecord
 @Environment(\.dismiss) private var dismiss
 @State private var draft:ProductOperationsDraft?
 @State private var error=""
 var body:some View {
  NavigationStack {
   Group {if let draft {ProductOperationsEditor(product:product,initial:draft)}else{Text(error.isEmpty ? "正在读取原商品规则":error)}}
    .navigationTitle("规格、推荐与出品").toolbar{Button("关闭"){dismiss()}}
  }.task{do{draft=try ProductOperationsDraft(product:product)}catch{self.error=error.localizedDescription}}
 }
}
private struct ProductOperationsEditor:View {
 let product:CatalogConfigurationRecord
 @EnvironmentObject var model:AppModel
 @Environment(\.dismiss) private var dismiss
 @State private var draft:ProductOperationsDraft
 @State private var error=""
 @State private var picking=false
 @State private var proposed:LiveCommand?
 init(product:CatalogConfigurationRecord,initial:ProductOperationsDraft){self.product=product;_draft=State(initialValue:initial)}
 private var canCost:Bool {model.identity?.allows("inventory.cost.view")==true && product.text("productKind")=="single" && product.text("inventoryControlMode")=="not_managed"}
 var body:some View {
  Form {
   Section {LivePendingView();Text(product.text("name")).font(.headline)}
   Section("销售形态与口味") {
    Picker("销售规格",selection:$draft.specification){ForEach(productSpecificationOptions.keys.sorted(),id:\.self){Text(productSpecificationOptions[$0]!).tag($0)}}
    Picker("酸度",selection:$draft.acidity){Text("未评价").tag("");ForEach(0...5,id:\.self){Text("\($0)级").tag(String($0))}}
    Picker("甜度",selection:$draft.sweetness){Text("未评价").tag("");ForEach(0...5,id:\.self){Text("\($0)级").tag(String($0))}}
    Text("规格只描述售卖形态，耗料仍按原配方。口味为门店主观等级，不代表含糖量或酸碱值。").font(.caption)
    TextField("菜单搜索别名",text:$draft.search,axis:.vertical)
   }
   Section("推荐与出品") {
    Toggle("参与推荐",isOn:$draft.enabled);Toggle("可以一次出齐",isOn:$draft.singleWave)
    ForEach(productNumberBounds.keys.sorted(),id:\.self){key in
     TextField(productNumberLabels[key]!+"（\(productNumberBounds[key]!.lowerBound)—\(productNumberBounds[key]!.upperBound)）",text:Binding(get:{draft.numbers[key] ?? ""},set:{draft.numbers[key]=$0})).keyboardType(.numberPad)
    }
    TextField("出品时限秒数（30—14400，空白用默认）",text:$draft.sla).keyboardType(.numberPad)
    Text("升级推荐："+draft.upgradeName)
    Button("选择升级商品"){picking=true}
    Button("取消升级推荐"){draft.upgradeID="";draft.upgradeName="无"}
   }
   ForEach(productTagOptions.keys.sorted(),id:\.self){key in
    Section(productTagLabels[key]!) {
     ForEach(productTagOptions[key]!.keys.sorted(),id:\.self){code in
      Toggle(productTagOptions[key]![code]!,isOn:Binding(get:{draft.tags[key]?.contains(code)==true},set:{on in var values=draft.tags[key] ?? [];if on{values.insert(code)}else{values.remove(code)};draft.tags[key]=values}))
     }
    }
   }
   if canCost {
    Section("非库存单品成本") {
     TextField("每份成本（元，空白为未知）",text:$draft.cost).keyboardType(.decimalPad)
     Text("未知成本不会按0计算。库存商品和套餐成本请通过配方核对。").font(.caption)
     if draft.cost != draft.originalCost {TextField("成本变更依据",text:$draft.reason,axis:.vertical)}
    }
   }
   if !error.isEmpty{Text(error).foregroundStyle(.red)}
   Button("核对全部规则"){
    do{guard let actor=model.identity,let board=model.catalogConfigurationBoard else{throw StaffAPIError.invalid};proposed=try draft.command(actor:actor,board:board,product:product)}catch{self.error=error.localizedDescription}
   }.disabled(!model.canUseProducts)
  }.sheet(isPresented:$picking){CatalogConfigurationPicker(excluding:product.id,choose:{p in draft.upgradeID=p.id;draft.upgradeName=p.text("name");picking=false},singleOnly:false)}
   .sheet(item:$proposed){command in CatalogConfigurationConfirmation(command:command,submitted:{dismiss()})}
   .onChange(of:model.workspaceVersion){_,_ in dismiss()}.onChange(of:model.priorityAccessKey){_,_ in dismiss()}
 }
}
