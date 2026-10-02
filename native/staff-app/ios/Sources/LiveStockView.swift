import AVFoundation
import SwiftUI
import VisionKit

struct LiveStockView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var query = ""
  @State private var code = ""
  @State private var quantity = ""
  @State private var amount = ""
  @State private var error = ""
  @State private var page = "items"
  @State private var lowOnly = false
  @State private var scanning = false
  @State private var lookingUp = false
  @State private var selectedID: String?
  @State private var scan: StockScan?
  @State private var proposed: LiveCommand?
  private var selected: StockBoard.Item? { model.stockBoard?.items.first { $0.id == selectedID } }
  func lookup(_ value: String) {
    lookingUp = true
    Task {
      defer { lookingUp = false }
      do {
        let result = try await model.lookupStockCode(value)
        scan = result
        selectedID = result.inventoryItemId
        quantity = "1"
        error = ""
      } catch {
        self.error = error.localizedDescription
        scan = nil
        selectedID = nil
      }
    }
  }
  var body: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 12) {
            LivePendingView()
            Text(model.stockState).font(.caption).id("stock-top")
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            Picker("库存工作区", selection: $page) {
              Text("库存与收货").tag("items")
              Text("采购验收").tag("receipts")
            }.pickerStyle(.segmented)
            if let board = model.stockBoard {
              if page == "items" {
                if model.identity?.allows("inventory.receive") == true {
                  Card {
                    HStack {
                      TextField("输入物料条码", text: $code).textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                      Button("识别") { lookup(code.trimmingCharacters(in: .whitespacesAndNewlines)) }
                        .disabled(!model.canUseStock || lookingUp)
                    }
                    Button("相机扫描物料条码") {
                      Task {
                        guard DataScannerViewController.isSupported,
                          await AVCaptureDevice.requestAccess(for: .video),
                          DataScannerViewController.isAvailable
                        else {
                          error = "相机不可用，可手动输入条码或选择物料"
                          return
                        }
                        scanning = true
                      }
                    }.buttonStyle(Primary(tone: .secondary, symbol: "barcode.viewfinder")).disabled(
                      !model.canUseStock || lookingUp)
                    if let selected {
                      Text(selected.name).font(.headline)
                      Text(
                        scan.map { "按包录入，每包" + $0.packageQuantity + selected.baseUnit }
                          ?? "按实际数量录入，单位：" + selected.baseUnit
                      ).font(.caption)
                      TextField(scan == nil ? "实际数量" : "包装数量", text: $quantity).keyboardType(
                        .decimalPad
                      ).textFieldStyle(.roundedBorder)
                      TextField("本批总金额（元）", text: $amount).keyboardType(.decimalPad).textFieldStyle(
                        .roundedBorder)
                      Button("加入待验收清单") {
                        do {
                          let line = try StockLine.make(
                            item: selected, quantity: quantity, amount: amount, scan: scan)
                          guard !model.stockDraft.contains(where: { $0.id == line.id }) else {
                            throw CatalogError("清单中已有此物料，请先移除旧行再合并数量")
                          }
                          try model.saveStockDraft(model.stockDraft + [line])
                          selectedID = nil
                          scan = nil
                          quantity = ""
                          amount = ""
                          error = ""
                        } catch { self.error = error.localizedDescription }
                      }.buttonStyle(Primary(symbol: "plus")).disabled(
                        !model.canUseStock || lookingUp)
                    }
                  }
                  if !model.stockDraft.isEmpty {
                    Card {
                      Text("本员工采购草稿 · \(model.stockDraft.count)项").font(.headline)
                      ForEach(model.stockDraft) { line in
                        HStack {
                          Text(line.summary).font(.caption)
                          Spacer()
                          Button("移除") {
                            do {
                              try model.saveStockDraft(model.stockDraft.filter { $0.id != line.id })
                            } catch { self.error = error.localizedDescription }
                          }.disabled(!model.canUseStock)
                        }
                      }
                      Button("核对并建立待验收单") {
                        do {
                          proposed = try stockCommand(
                            actor: model.identity!, board: board, lines: model.stockDraft)
                        } catch { self.error = error.localizedDescription }
                      }.buttonStyle(Primary(symbol: "checklist")).disabled(!model.canUseStock)
                    }
                  }
                }
                TextField("搜索物料名称或编码", text: $query).textFieldStyle(.roundedBorder)
                Toggle("只看低库存", isOn: $lowOnly)
                let rows = board.items.filter {
                  (!lowOnly || $0.lowStock)
                    && (query.isEmpty
                      || ($0.name + " " + $0.sku).localizedCaseInsensitiveContains(query))
                }
                if rows.isEmpty { Text("没有匹配物料") }
                ForEach(rows) { item in
                  Card {
                    Text(item.name).font(.headline)
                    Text(item.sku + " · 可用 " + item.availableQuantity + item.baseUnit)
                      .foregroundStyle(item.lowStock ? Color.red : ink)
                    Text("在库 " + item.onHandQuantity + " · 已占用 " + item.reservedQuantity).font(
                      .caption)
                    if item.lowStock { Text("已到低库存阈值；请核对实物及补货安排").font(.caption) }
                    if model.identity?.allows("inventory.receive") == true {
                      Button("按此物料收货") {
                        selectedID = item.id
                        scan = nil
                        quantity = ""
                        amount = ""
                      }.disabled(!model.canUseStock)
                    }
                  }
                }
              } else {
                if board.receipts.isEmpty { Text("暂无可见采购单") }
                ForEach(board.receipts) { receipt in
                  Card {
                    Text(receipt.publicId).font(.headline)
                    Text(
                      ["draft": "待实物验收", "received": "已入库", "cancelled": "已取消"][receipt.status]
                        ?? "状态待核对"
                    ).foregroundStyle(ink)
                    ForEach(Array(receipt.lines.enumerated()), id: \.offset) { _, line in
                      Text(line.itemName + " ×" + line.quantity + line.baseUnit).font(.subheadline)
                    }
                    if board.visibility.costs, let amount = receipt.invoiceTotalMinor,
                      let value = Int(amount)
                    {
                      Text("本批总额 " + money(value))
                    }
                    if receipt.status == "draft",
                      model.identity?.allows("inventory.receive") == true
                    {
                      Button("已核对实物，确认入库") {
                        do {
                          proposed = try stockCommand(
                            actor: model.identity!, board: board, receiptID: receipt.id)
                        } catch { self.error = error.localizedDescription }
                      }.buttonStyle(Primary(symbol: "shippingbox")).disabled(!model.canUseStock)
                    }
                  }
                }
              }
            }
          }.padding(16)
        }.background(paper).navigationTitle("库存与收货").navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
            ToolbarItem(placement: .primaryAction) {
              Button("刷新") { Task { await model.loadStock() } }.disabled(model.busy || lookingUp)
            }
          }
          .onChange(of: selectedID) { _, id in
            if id != nil { withAnimation { proxy.scrollTo("stock-top", anchor: .top) } }
          }
      }
    }.task { await model.loadStock() }.onChange(of: model.workspaceVersion) { _, _ in dismiss() }
      .onChange(of: model.priorityAccessKey) { dismiss() }
      .onChange(of: model.stockReceipt?.commandID) { _, id in if id != nil { page = "receipts" } }
      .sheet(isPresented: $scanning) {
        NativePaymentScanner(inventory: true) { value in
          code = value
          scanning = false
          lookup(value)
        } failed: { message in
          error = message
          scanning = false
        }
      }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              Text(command.steps[0].stockProof?["confirmation"] as? String ?? "请刷新")
              Button(command.title) {
                proposed = nil
                Task { await model.executeLive(command) }
              }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
                !model.canExecuteLive(command))
            }.padding(20)
          }.navigationTitle("核对采购与实物").navigationBarTitleDisplayMode(.inline).toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil } }
          }
        }
      }
  }
}
