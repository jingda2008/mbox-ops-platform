import AVFoundation
import SwiftUI
import VisionKit

struct LiveBenefitWalletView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var code = ""
  @State private var notice = ""
  @State private var issuing = false
  @State private var scan = false
  @State private var proposed: LiveCommand?
  @State private var verified = false
  @State private var access: String?
  private var accessKey: String {
    guard let actor = model.identity else { return "" }
    return actor.employee.id + ":" + actor.session.id + ":" + walletPermissions.filter(actor.allows).joined(separator: ",")
  }
  private var current: Bool { access != nil && access == accessKey && !accessKey.isEmpty }
  private func propose(_ action: () throws -> LiveCommand) {
    do { proposed = try action(); verified = false; notice = "" } catch { notice = error.localizedDescription }
  }
  private func clear() { proposed = nil; verified = false; issuing = false; scan = false; code = ""; notice = "" }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if current {
            TextField("完整会员号或会员码", text: $code).textFieldStyle(.roundedBorder)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
            HStack {
              Button("扫描会员码") {
                Task {
                  guard DataScannerViewController.isSupported else { notice = "此设备不支持扫码，可输入完整会员号"; return }
                  guard await AVCaptureDevice.requestAccess(for: .video), DataScannerViewController.isAvailable else { notice = "请允许相机权限，或输入完整会员号"; return }
                  if current { scan = true }
                }
              }.buttonStyle(Primary(tone: .secondary, symbol: "qrcode.viewfinder"))
              Button("查询会员权益") {
                proposed = nil; issuing = false
                Task { await model.loadBenefitWallet(code) }
              }.buttonStyle(Primary(symbol: "magnifyingglass"))
            }.disabled(model.busy || model.heartbeatBusy)
            Text(model.benefitWalletState).font(.caption)
            if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
            if let board = model.benefitWalletBoard, board.employeeID == model.identity?.employee.id {
              Text("已查询：\(board.memberNo) · \(board.displayName)").font(.title3.bold())
              Text("金额与折扣权益核销只登记权益使用，不会自动减免订单或退款；固定低价券和每日点心须按各自入口办理。").font(.subheadline)
              let matches = (try? MemberCommands.code(code)) == board.memberNo
              if !matches { Text("输入的会员号已变化，请重新查询后办理。").foregroundStyle(.orange) }
              if model.identity?.allows("benefit.issue") == true {
                Button(issuing ? "收起发放表单" : "按岗位额度发放权益") { issuing.toggle() }
                  .buttonStyle(Primary(tone: .secondary, symbol: "gift")).disabled(!matches || !model.canUseBenefitWallet)
              }
              if issuing && matches {
                WalletIssueFormView(board: board, propose: propose).id(board.customerID)
              }
              ForEach(board.rows) { row in
                WalletBenefitCardView(board: board, row: row, active: matches, propose: propose).id(row.id + ":" + String((try? row.integer("version")) ?? 0))
              }
              if board.rows.isEmpty { Text("当前页没有权益记录。").foregroundStyle(.secondary) }
              HStack {
                Button("回到最新") { proposed = nil; issuing = false; code = board.memberNo; Task { await model.loadBenefitWallet(board.memberNo) } }
                if let cursor = board.nextCursor {
                  Button("下一页历史") { proposed = nil; issuing = false; code = board.memberNo; Task { await model.loadBenefitWallet(board.memberNo, cursor: cursor) } }
                }
              }.disabled(model.busy || model.heartbeatBusy)
            }
          } else { Text("账号或会员访问权限已变化，请重新查询。") }
        }.padding(16)
      }.background(paper).navigationTitle("会员权益钱包").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink).task { access = accessKey }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .onChange(of: code) { _, _ in proposed = nil; issuing = false; verified = false }
      .sheet(isPresented: $scan) {
        NativePaymentScanner(memberMode: true, received: { value in
          scan = false
          guard current else { return }
          do { code = try MemberCommands.code(value) } catch { notice = error.localizedDescription }
        }, failed: { notice = $0; scan = false })
      }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              if current, command.employeeID == model.identity?.employee.id,
                command.steps.first?.object["customerId"] as? String == model.benefitWalletBoard?.customerID {
                Text(command.steps.first?.benefitWalletProof?["confirmation"] as? String ?? "原内容不可用，请重新查询")
                Toggle("已当面核对会员、权益和本次办理内容", isOn: $verified)
                Button("确认办理") {
                  proposed = nil; issuing = false; verified = false
                  Task { await model.executeLive(command) }
                }.buttonStyle(Primary(symbol: "checkmark.shield"))
                  .disabled(!verified || !model.canUseBenefitWallet || !model.canExecuteLive(command))
              } else { Text("原会员或权限已变化，确认内容已隐藏。") }
            }.padding(20)
          }.background(paper).navigationTitle(command.title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } }
        }.tint(ink)
      }
  }
}
private struct WalletBenefitCardView: View {
  @EnvironmentObject var model: AppModel
  let board: BenefitWalletBoard
  let row: WalletRecord
  let active: Bool
  let propose: (() throws -> LiveCommand) -> Void
  @State private var table = ""
  @State private var quantity = "1"
  private var ready: Bool { active && model.canUseBenefitWallet }
  var body: some View {
    Card {
      Text(row.text("title")).font(.headline)
      Text("\(walletTypeNames[row.text("type")] ?? "待核对") · \(walletStateNames[row.text("state")] ?? "待核对")")
      Text("可用 \((try? row.integer("quantityAvailable")) ?? 0) · 暂留 \((try? row.integer("quantityReserved")) ?? 0) · 已用 \((try? row.integer("quantityRedeemed")) ?? 0) / 共 \((try? row.integer("quantityTotal")) ?? 0)").font(.caption)
      Text("生效 \(membershipRecordTime(row.text("validFrom"))) · \(row.text("validUntil").isEmpty ? "未设置结束日期" : "到期 " + membershipRecordTime(row.text("validUntil")))").font(.caption)
      if let calendar = row.object["calendar"] as? [String: Any], let next = calendar["nextAvailableAt"] as? String { Text("下次可用 " + membershipRecordTime(next)).font(.caption) }
      if row.snack { Text("每日点心请使用专用核销码入口。").font(.caption) }
      else if row.lowPrice { Text("此券绑定原固定价报价，请在原订单中按券报价办理。").font(.caption) }
      else if row.text("state") == "available", model.identity?.allows("loyalty.redemption.fulfill") == true {
        if board.tables.isEmpty { Text("会员尚未关联当前可操作桌次，请先在桌边核对本人入座。").font(.caption) }
        else {
          Picker("会员实际所在桌", selection: $table) {
            Text("请选择实际桌号").tag("")
            ForEach(board.tables) { Text($0.text("code")).tag($0.id) }
          }.pickerStyle(.menu)
          TextField("本次暂留份数", text: $quantity).textFieldStyle(.roundedBorder).keyboardType(.numberPad)
          Button("核对并暂留") {
            propose {
              guard let actor = model.identity, let amount = Int(quantity), String(amount) == quantity else { throw CatalogError("请填写整数份数") }
              return try board.command(actor: actor, action: "reserve", body: ["customerId": board.customerID, "benefitId": row.id,
                "tableSessionId": table, "quantity": amount, "expectedVersion": row.integer("version")])
            }
          }.buttonStyle(Primary(tone: .secondary, symbol: "clock.badge.checkmark")).disabled(!ready)
        }
      }
      ForEach((try? row.rows("reservations")) ?? []) { hold in
        WalletHoldView(board: board, row: row, hold: hold, active: ready, propose: propose).id(hold.id)
      }
    }
  }
}
private struct WalletHoldView: View {
  @EnvironmentObject var model: AppModel
  let board: BenefitWalletBoard
  let row, hold: WalletRecord
  let active: Bool
  let propose: (() throws -> LiveCommand) -> Void
  @State private var product = ""
  @State private var reason = ""
  private func command(_ action: String) throws -> LiveCommand {
    guard let actor = model.identity else { throw StaffAPIError.invalid }
    var body: [String: Any] = ["customerId": board.customerID, "benefitId": row.id, "reservationId": hold.id,
      "tableSessionId": hold.text("tableSessionId"), "quantity": try hold.integer("quantity")]
    let explanation = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    if action == "cancel" { body["reason"] = explanation }
    else {
      if row.text("type") == "gift_product" { body["selectedProductId"] = product }
      if !explanation.isEmpty { body["substitutionReason"] = explanation }
    }
    return try board.command(actor: actor, action: action, body: body)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Divider()
      Text("原暂留 · \(hold.text("tableCode")) / \((try? hold.integer("quantity")) ?? 0)份").font(.headline)
      Text("截至 " + reservationTime(hold.text("expiresAt"))).font(.caption)
      if row.text("type") == "gift_product" && !row.snack && !row.lowPrice {
        Picker("实际兑付商品", selection: $product) {
          Text("请选择商品").tag("")
          ForEach(((try? row.rows("products")) ?? []).filter { $0.text("status") == "active" }) { Text($0.text("name")).tag($0.id) }
        }.pickerStyle(.menu)
      }
      TextField("核销说明或取消原因", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
      if !row.snack && !row.lowPrice && model.identity?.allows("loyalty.redemption.fulfill") == true {
        Button((try? hold.boolean("canRedeem")) == true ? "核对并核销" : "暂留已过期，请取消释放") { propose { try command("redeem") } }
          .buttonStyle(Primary(symbol: "checkmark.seal")).disabled(!active || (try? hold.boolean("canRedeem")) != true)
      }
      if model.identity?.allows("benefit.cancel") == true {
        Button("取消原暂留") { propose { try command("cancel") } }
          .buttonStyle(Primary(tone: .secondary, symbol: "arrow.uturn.backward")).disabled(!active)
      }
    }
  }
}
private struct WalletIssueFormView: View {
  @EnvironmentObject var model: AppModel
  let board: BenefitWalletBoard
  let propose: (() throws -> LiveCommand) -> Void
  @State private var name = ""
  @State private var code = ""
  @State private var type = "gift_product"
  @State private var amount = ""
  @State private var quantity = "1"
  @State private var limit = ""
  @State private var from = ""
  @State private var until = ""
  @State private var reason = ""
  @State private var search = ""
  @State private var applied = ""
  @State private var rows: [WalletRecord] = []
  @State private var selected: [String: WalletRecord] = [:]
  @State private var next: Int?
  @State private var error = ""
  private func load(_ offset: Int) {
    Task {
      do {
        let query = offset == 0 ? search : applied
        let page = try await model.walletProducts(search: query, offset: offset)
        if offset == 0 { applied = query }
        rows = page.rows; next = page.nextOffset; error = ""
      } catch { self.error = error.localizedDescription }
    }
  }
  private func command() throws -> LiveCommand {
    guard let actor = model.identity, let count = Int(quantity), String(count) == quantity else { throw CatalogError("请填写整数份数") }
    let products = type == "gift_product" ? selected.values.sorted { $0.id < $1.id } : []
    let body: [String: Any] = ["customerId": board.customerID, "title": name.trimmingCharacters(in: .whitespacesAndNewlines),
      "benefitCode": code.trimmingCharacters(in: .whitespacesAndNewlines), "benefitType": type,
      "valueAmountMinor": try walletMoney(amount), "quantity": count, "authorizationLimitId": limit,
      "allowedProductIds": products.map(\.id), "validFrom": try walletDateInput(from),
      "validUntil": until.isEmpty ? NSNull() : try walletDateInput(until) as Any,
      "reason": reason.trimmingCharacters(in: .whitespacesAndNewlines)]
    return try board.command(actor: actor, action: "issue", body: body, selectedProducts: products)
  }
  var body: some View {
    Card {
      Text("授权发放权益").font(.headline)
      TextField("权益名称", text: $name).textFieldStyle(.roundedBorder)
      TextField("权益编码（2—64位英文、数字等）", text: $code).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
      Picker("权益类型", selection: $type) { ForEach(walletTypeNames.keys.sorted(), id: \.self) { Text(walletTypeNames[$0]!).tag($0) } }.pickerStyle(.menu)
      TextField("每份授权价值（元）", text: $amount).textFieldStyle(.roundedBorder).keyboardType(.decimalPad)
      TextField("发放份数", text: $quantity).textFieldStyle(.roundedBorder).keyboardType(.numberPad)
      Text("金额用于核对岗位额度，并非收款。折扣或金额权益仍须按订单政策使用。").font(.caption)
      Picker("当前岗位额度", selection: $limit) {
        Text("请选择额度").tag("")
        ForEach(board.limits) { row in Text(row.text("name") + " · " + ((try? row.integer("amountMinor")).map { walletMoneyText($0) + "元" } ?? "未设金额上限")).tag(row.id) }
      }.pickerStyle(.menu)
      TextField("生效时间（北京时间 YYYY-MM-DD HH:mm）", text: $from).textFieldStyle(.roundedBorder)
      TextField("结束时间（可留空，北京时间）", text: $until).textFieldStyle(.roundedBorder)
      TextField("实际发放原因", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
      if type == "gift_product" {
        Text("允许商品：" + (selected.isEmpty ? "尚未选择" : selected.values.sorted { $0.id < $1.id }.map { $0.text("name") }.joined(separator: "、"))).font(.caption)
        TextField("搜索可用商品", text: $search).textFieldStyle(.roundedBorder)
        Button("读取商品") { load(0) }.disabled(model.busy || model.heartbeatBusy)
        ForEach(rows) { product in
          Toggle(product.text("name"), isOn: Binding(get: { selected[product.id] != nil }, set: { if $0 { selected[product.id] = product } else { selected.removeValue(forKey: product.id) } }))
        }
        if let next { Button("下一页商品") { load(next) }.disabled(model.busy || model.heartbeatBusy) }
      }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button("核对额度后发放") { propose { try command() } }
        .buttonStyle(Primary(symbol: "gift")).disabled(!model.canUseBenefitWallet)
    }
  }
}
