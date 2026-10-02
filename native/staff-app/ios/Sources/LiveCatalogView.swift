import SwiftUI

struct LiveCatalogView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let session: String
  let tableCode: String
  var replacement: LiveReplacement? = nil
  @State private var query = ""
  @State private var category = ""
  @State private var selected: LiveProduct?
  @State private var showingDraft = false
  @State private var receipt: LiveOrderReceipt?
  @State private var showCollection = false
  private var lines: [LiveDraftLine] { model.liveDraft(session, replacement: replacement) }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if let replacement {
            Text(replacement.explanation).font(.caption).foregroundStyle(.secondary)
          }
          if !model.catalogState.isEmpty { Text(model.catalogState).foregroundStyle(.secondary) }
          if model.draftStorageDamaged { Text("草稿存储异常，暂时不能加菜，请联系管理员").foregroundStyle(.red) }
          if let receipt {
            Card {
              Label(receipt.recovered ? "原订单已找回" : "订单已建立", systemImage: "checkmark.circle.fill")
                .foregroundStyle(ink)
              Text(receipt.publicId).font(.caption).textSelection(.enabled)
              Text(receipt.totalAmountMinor.map { "新单金额 " + money($0) } ?? "原单已找回，金额和状态请在账单核对")
                .font(.subheadline)
              if replacement != nil { Text("原商品退款与实物处理仍按原申请继续。").font(.caption) }
              if let actor = model.identity,
                LivePaymentOrder.permissions.contains(where: actor.allows)
              {
                Button("查看本桌待收账单") { showCollection = true }.buttonStyle(
                  Primary(symbol: "creditcard"))
              }
              if replacement != nil {
                Button("返回原商品核对售后") { dismiss() }.buttonStyle(
                  Primary(tone: .secondary, symbol: "arrow.uturn.backward"))
              }
            }
          }
          if showingDraft {
            if lines.isEmpty { Text("还没有选择商品").foregroundStyle(.secondary) }
            ForEach(lines) { line in
              Card {
                HStack {
                  Text(line.product.name).font(.headline)
                  Spacer()
                  Text(money(line.product.price))
                }
                if !line.selectionLabel.isEmpty { Text(line.selectionLabel).font(.subheadline) }
                if !line.note.isEmpty { Text("备注：" + line.note).font(.caption) }
                Button("移除这一份") {
                  model.removeLiveLine(line.id, session: session, replacement: replacement)
                }
                .buttonStyle(Primary(tone: .secondary, symbol: "minus.circle")).disabled(
                  model.busy)
              }
            }
            if !lines.isEmpty {
              LiveOrderCheckout(session: session, tableCode: tableCode, replacement: replacement)
            } else {
              LivePendingView()
            }
          } else {
            MenuFilters(
              query: $query, category: $category,
              categories: Array(Set(model.liveProducts.map(\.categoryCode))).sorted().map { code in
                (code, model.liveProducts.first { $0.categoryCode == code }?.categoryName ?? code)
              })
            let products = model.liveProducts.filter {
              $0.matches(query) && (category.isEmpty || $0.categoryCode == category)
            }
            if products.isEmpty && model.catalogUpdated != nil {
              Text("没有匹配的商品").foregroundStyle(.secondary)
            }
            ForEach(products) { product in
              Card {
                HStack(alignment: .top, spacing: 12) {
                  MenuThumbnail(
                    name: product.name, url: menuImageURL(product.productSnapshot?.imageUrl))
                  VStack(alignment: .leading, spacing: 4) {
                    Text(product.name).font(.headline)
                    Text(product.categoryName ?? product.categoryCode).font(.caption)
                      .foregroundStyle(.secondary)
                  }
                  Spacer()
                  Text(money(product.price)).font(.headline).foregroundStyle(ink)
                }
                if let specification = product.productSnapshot?.specification,
                  !specification.isEmpty
                {
                  Text(specification).font(.caption).foregroundStyle(.secondary)
                }
                let quantity = lines.filter { $0.product.id == product.id }.count
                if quantity > 0 {
                  Text("已选 \(quantity) 份").font(.caption.weight(.semibold)).foregroundStyle(ink)
                }
                if let reason = product.unavailable {
                  Text(reason).font(.caption).foregroundStyle(.secondary)
                }
                Button(product.groups.isEmpty ? "选规格 / 加入" : "选择套餐内容") { selected = product }
                  .buttonStyle(Primary(tone: .secondary, symbol: "plus"))
                  .disabled(product.unavailable != nil || model.busy || model.draftStorageDamaged)
              }
            }
          }
        }.padding(16)
      }.background(paper)
        .navigationTitle(tableCode + (replacement == nil ? " · 菜单" : " · 换品菜单"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("返回桌台") { dismiss() } }
          ToolbarItem(placement: .primaryAction) {
            Button("刷新") { Task { await model.loadLiveCatalog(replacement: replacement) } }
              .disabled(model.busy)
          }
        }
        .safeAreaInset(edge: .bottom) {
          Button {
            showingDraft.toggle()
          } label: {
            HStack {
              Text(showingDraft ? "返回菜单继续加菜" : "查看已选 \(lines.count) 份")
              Spacer()
              Text("预估 " + money(lines.reduce(0) { $0 + ($1.product.price ?? 0) }))
            }
          }.buttonStyle(Primary(symbol: "cart.fill")).padding(12).background(paper)
        }
    }.tint(ink).onChange(of: model.workspaceVersion) { _, _ in dismiss() }.task {
      await model.loadLiveCatalog(replacement: replacement)
    }
    .onChange(of: model.lastOrderReceipt?.publicId) { _, _ in receipt = model.lastOrderReceipt }
    .sheet(isPresented: $showCollection) {
      LiveCollectionView(session: session, tableCode: tableCode)
    }
    .sheet(item: $selected) { product in
      LiveProductPicker(product: product, session: session, replacement: replacement)
    }
  }
}
struct LiveProductPicker: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let product: LiveProduct
  let session: String
  var replacement: LiveReplacement? = nil
  @State private var choices: [String: [String]] = [:]
  @State private var note = ""
  @State private var error = ""
  private var complete: Bool {
    product.groups.allSatisfy { choices[$0.id]?.count == $0.selectionCount }
      && note.utf16.count <= 300
  }
  var body: some View {
    NavigationStack {
      Form {
        Section {
          HStack {
            MenuThumbnail(name: product.name, url: menuImageURL(product.productSnapshot?.imageUrl))
            Text(money(product.price)).font(.title2.bold())
          }
          if let detail = product.productSnapshot?.description, !detail.isEmpty { Text(detail) }
          if let specification = product.productSnapshot?.specification, !specification.isEmpty {
            Text(specification)
          }
        }
        if !product.bundleComponents.isEmpty {
          Section("套餐包含") {
            ForEach(Array(product.bundleComponents.enumerated()), id: \.offset) { _, item in
              Text("\(item.name) ×\(item.quantity)")
            }
          }
        }
        ForEach(product.groups) { group in
          Section("\(group.name) · 选\(group.selectionCount)款") {
            ForEach(group.options) { option in
              let checked = choices[group.id]?.contains(option.id) == true
              Button {
                var ids = choices[group.id] ?? []
                if checked { ids.removeAll { $0 == option.id } } else { ids.append(option.id) }
                choices[group.id] = ids
              } label: {
                HStack {
                  VStack(alignment: .leading) {
                    Text("\(option.name) ×\(option.quantity)")
                    if !option.available {
                      Text(option.unavailableReason ?? "当前不可选").font(.caption)
                    }
                  }
                  Spacer()
                  Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                }
              }.disabled(
                !option.available
                  || (!checked && (choices[group.id]?.count ?? 0) >= group.selectionCount)
              )
              .accessibilityValue(checked ? "已选" : "未选")
            }
          }
        }
        Section("商品备注 · 同商品共用") {
          TextField("口味或其他要求", text: $note, axis: .vertical)
          Text("\(note.utf16.count)/300").font(.caption)
        }
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
      }.navigationTitle(product.name).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        .safeAreaInset(edge: .bottom) {
          Button("加入一份 · " + money(product.price)) {
            do {
              try model.addLiveProduct(
                product, choices: choices, note: note, session: session, replacement: replacement)
              dismiss()
            } catch { self.error = error.localizedDescription }
          }.buttonStyle(Primary(symbol: "plus")).disabled(!complete || model.busy).padding(12)
            .background(paper)
        }
    }.tint(ink)
  }
}
