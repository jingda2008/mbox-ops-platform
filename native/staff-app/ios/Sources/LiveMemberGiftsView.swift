import SwiftUI

struct MemberGiftEditor: Identifiable {
  let id = UUID()
  let action: String
  let operation: String
  let row: GiftRecord?
}
struct LiveMemberGiftsView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let initialSection: String
  @State private var section: String
  @State private var access: String?
  @State private var editor: MemberGiftEditor?
  @State private var proposed: LiveCommand?
  @State private var confirmed = false
  init(initialSection: String = "campaigns") { self.initialSection = initialSection; _section = State(initialValue: initialSection) }
  private var accessKey: String {
    guard let actor = model.identity else { return "" }
    return actor.employee.id + ":" + actor.session.id + ":" + memberGiftPermissions.filter(actor.allows).joined(separator: ",")
  }
  private var current: Bool { access == accessKey && !accessKey.isEmpty }
  private func clear() { editor = nil; proposed = nil; confirmed = false }
  private func load(_ cursor: String = "") { clear(); Task { await model.loadMemberGifts(section: section, cursor: cursor) } }
  private func propose(_ command: LiveCommand) { proposed = command; confirmed = false }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if current {
            Picker("查看", selection: $section) { ForEach(["campaigns", "jobs", "refund-pending", "refund-resolved"], id: \.self) { Text(memberGiftSections[$0]!).tag($0) } }.pickerStyle(.menu)
            Button("刷新当前范围") { load() }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy || model.heartbeatBusy)
            Text(model.memberGiftsState).font(.caption)
            if section.hasPrefix("refund-") { Text("退款不自动返券。此处登记实际处理结果；补发须先通过已审批的赠礼活动完成发放，再关联同会员的新券。此处不会再次退款或发券。").font(.subheadline) }
            else { Text("保存草稿、独立审批、正式发布与实际发券分别确认。发放任务仍须后台核对资格、成本、预算和券日历。").font(.subheadline) }
            if let board = model.memberGiftsBoard, board.employeeID == model.identity?.employee.id, board.section == section {
              if let editor {
                if editor.action == "save" { MemberGiftFormView(board: board, row: editor.row, close: { self.editor = nil }, propose: propose).id(editor.id) }
                else { MemberGiftOperationView(board: board, editor: editor, close: { self.editor = nil }, propose: propose).id(editor.id) }
              }
              if section == "campaigns", model.identity?.allows("loyalty.configuration.edit") == true {
                Button("新建赠礼活动草稿") { editor = .init(action: "save", operation: "", row: nil) }.buttonStyle(Primary(symbol: "plus.rectangle")).disabled(!model.canUseMemberGifts)
              }
              ForEach(board.rows) { row in
                Card {
                  if section == "campaigns" { campaign(row) }
                  else if section == "jobs" { job(row) }
                  else { refund(row) }
                }
              }
              if board.rows.isEmpty { Text("当前页没有记录。").foregroundStyle(.secondary) }
              HStack { Button("回到第一页") { load() }; if let cursor = board.nextCursor { Button("下一页") { load(cursor) } } }.disabled(model.busy || model.heartbeatBusy)
              Text(section == "campaigns" ? "每页最多20个活动版本；修订会保存新版本，历史规则保留。" : "每页最多50条；换页后请重新选择原记录。").font(.caption)
            }
          } else { Text("账号或会员活动权限已变化，请重新读取。") }
        }.padding(16)
      }.background(paper).navigationTitle("会员活动与赠礼").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { clear(); dismiss() } } }
    }.tint(ink)
      .task { access = accessKey; await model.loadMemberGifts(section: section, cursor: "") }
      .onChange(of: section) { _, _ in if current { load() } }
      .onChange(of: accessKey) { _, _ in clear(); dismiss() }
      .onChange(of: model.workspaceVersion) { _, _ in clear(); dismiss() }
      .sheet(item: $proposed) { command in
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 16) {
              if current, command.employeeID == model.identity?.employee.id {
                Text(command.steps.first?.memberGiftProof?["confirmation"] as? String ?? "请重新读取原记录")
                Toggle("已核对原规则、金额、份数、人群与实际凭证", isOn: $confirmed)
                Button("确认提交") { clear(); Task { await model.executeLive(command) } }
                  .buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!confirmed || !model.canUseMemberGifts || !model.canExecuteLive(command))
              } else { Text("账号或权限已变化，确认内容已隐藏。") }
            }.padding(20)
          }.background(paper).navigationTitle("核对赠礼操作").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回核对") { proposed = nil } } }
        }.tint(ink)
      }
  }
  @ViewBuilder private func campaign(_ row: GiftRecord) -> some View {
    Text(row.text("name") + " · " + (memberGiftStatuses[row.text("status")] ?? "待核对")).font(.headline)
    Text(row.text("code") + " · 第" + row.text("version") + "版").font(.caption)
    Foldout(title: "查看完整规则、预算与适用人群") { Text((try? memberGiftRuleSummary(row.rule, names: memberGiftOriginalNames(row))) ?? "规则数据不完整，请刷新核对") }
    if let metrics = row.object["highlights"] as? [String: Any] {
      ForEach(["issued", "redeemed", "remaining", "cost"].filter { metrics[$0] != nil }, id: \.self) { key in
        Text(giftMetrics[key]! + "：" + (key == "cost" ? ((try? walletInteger(metrics[key])).map(walletMoneyText) ?? "待核对") + "元" : membershipText(metrics[key]))).font(.caption)
      }
    }
    if model.identity?.allows("loyalty.configuration.edit") == true {
      Button("修订并保存新版本") { editor = .init(action: "save", operation: "", row: row) }.buttonStyle(Primary(tone: .secondary, symbol: "doc.on.doc")).disabled(!model.canUseMemberGifts)
    }
    ForEach(["approve", "publish", "stop", "target"], id: \.self) { operation in
      let permission = operation == "approve" ? "loyalty.configuration.approve" : "loyalty.policy.publish"
      let status = ["approve": "draft", "publish": "approved", "stop": "published", "target": "published"][operation]!
      if row.text("status") == status, model.identity?.allows(permission) == true,
        operation != "target" || row.rule["trigger"] as? String == "targeted" {
        let independent = ["target", "stop"].contains(operation) || (row.text("created_by_employee_id") != model.identity?.employee.id && (operation != "publish" || row.text("approved_by_employee_id") != model.identity?.employee.id))
        Button(independent ? memberGiftActions[operation]! : "等待其他授权员工" + (operation == "approve" ? "审批" : "发布")) {
          editor = .init(action: operation == "target" ? "target" : "decision", operation: operation, row: row)
        }.buttonStyle(Primary(tone: .secondary, symbol: "checkmark.seal")).disabled(!independent || !model.canUseMemberGifts)
      }
    }
  }
  @ViewBuilder private func job(_ row: GiftRecord) -> some View {
    Text(row.text("name") + " · " + (memberGiftStatuses[row.text("status")] ?? "待核对")).font(.headline)
    Text("会员 " + row.text("customer_reference") + " · " + row.text("quantity") + "份")
    Text("已尝试 " + row.text("attempts") + " 次 · 创建 " + membershipRecordTime(row.text("created_at"))).font(.caption)
    if !row.text("last_error_code").isEmpty { Text("受阻原因：" + (memberGiftBlockedReasons[row.text("last_error_code")] ?? "须核对后台原任务")).font(.subheadline) }
    if !row.text("benefit_id").isEmpty { Text("券已生成，可到会员权益钱包核对实际使用。").font(.caption) }
    if !row.text("next_attempt_at").isEmpty, ["pending", "blocked"].contains(row.text("status")) { Text("下次检查：" + reservationTime(row.text("next_attempt_at"))).font(.caption) }
    if !row.text("completed_at").isEmpty { Text("结束：" + membershipRecordTime(row.text("completed_at"))).font(.caption) }
    if ["pending", "blocked"].contains(row.text("status")), model.identity?.allows("loyalty.policy.publish") == true {
      ForEach(["retry", "cancel"], id: \.self) { op in Button(memberGiftActions[op]!) { editor = .init(action: "control", operation: op, row: row) }.disabled(!model.canUseMemberGifts) }
    }
  }
  @ViewBuilder private func refund(_ row: GiftRecord) -> some View {
    Text(row.text("benefit_code") + " · " + row.text("quantity") + "份").font(.headline)
    Text(memberGiftRefundSummary(row)).font(.subheadline)
    Text("券状态：" + (["reserved": "订单占用中", "redeemed": "已核销"][row.text("status")] ?? "已释放或到期")).font(.caption)
    if !row.text("action").isEmpty {
      Text("处理结果：" + (memberGiftActions[row.text("action")] ?? "待核对")); Text("原因：" + row.text("reason")); Text("凭证：" + row.text("evidence_reference"))
      if !row.text("replacement_quantity").isEmpty { Text("关联补偿券：" + row.text("replacement_quantity") + "份") }
    } else if model.identity?.allows("loyalty.policy.publish") == true {
      Button("复核此退款券权益") { editor = .init(action: "refund", operation: "", row: row) }.buttonStyle(Primary(tone: .secondary, symbol: "checkmark.shield")).disabled(!model.canUseMemberGifts)
    }
  }
}
struct MemberGiftOperationView: View {
  @EnvironmentObject var model: AppModel
  let board: MemberGiftsBoard
  let editor: MemberGiftEditor
  let close: () -> Void
  let propose: (LiveCommand) -> Void
  @State private var reason = ""
  @State private var cycle = ""
  @State private var evidence = ""
  @State private var refundAction = ""
  @State private var compensated = false
  @State private var customers: [WalletRecord] = []
  @State private var replacement: WalletRecord?
  @State private var picker = false
  @State private var error = ""
  var body: some View {
    Card {
      if let row = editor.row {
        Text(editor.action == "refund" ? "复核原退款券权益" : memberGiftActions[editor.operation] ?? "核对操作").font(.title3.bold())
        Button("返回列表", action: close)
        if editor.action == "refund" {
          Text(memberGiftRefundSummary(row))
          Picker("已确认的处理方式", selection: $refundAction) {
            Text("请选择").tag("")
            ForEach(["no_return", "external_compensation", "replacement_coupon"], id: \.self) { Text(memberGiftActions[$0]!).tag($0) }
          }.pickerStyle(.menu).onChange(of: refundAction) { _, _ in replacement = nil; compensated = false }
          if refundAction == "external_compensation" { Toggle("已在系统外实际完成补偿，并持有凭证", isOn: $compensated) }
          if refundAction == "replacement_coupon" {
            Text("仅可关联退款申请之后、已发给同会员且尚未使用、未用于其他复核的新券；后台提交时仍会核对最新状态。").font(.caption)
            if let replacement { Text(replacement.text("benefit_code") + " · " + replacement.text("quantity_total") + "份") }
            Button("读取并选择本人已发补偿券") { picker = true }.disabled(model.busy || model.heartbeatBusy)
          }
          TextField("原规则或实际补偿凭证（2—200字）", text: $evidence, axis: .vertical).textFieldStyle(.roundedBorder)
          Text("只登记实际权益结论，不再次退款、不发券、不改库存。").font(.caption)
        } else if editor.action == "target" {
          Text("本次安排任务，不表示已发券。同活动、批次与会员不会重复发放。组合甜点每人仅一次，更换批次不会再赠送。").font(.caption)
          TextField("发放批次编号", text: $cycle).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never)
          Button("查询并选择会员（\(customers.count)/50）") { picker = true }.disabled(model.busy || model.heartbeatBusy)
          ForEach(customers) { item in HStack { Text(item.text("name") + " · " + item.text("code")); Spacer(); Button("移除") { customers.removeAll { $0.id == item.id } } } }
        } else if editor.action == "decision" {
          Text(row.text("name")); Text((try? memberGiftRuleSummary(row.rule, names: memberGiftOriginalNames(row))) ?? "请刷新原规则")
          if editor.operation == "stop" { Text("只停止新发券，已发券仍按原规则使用。").font(.caption) }
        } else {
          Text(row.text("name") + " · 会员 " + row.text("customer_reference") + " · " + row.text("quantity") + "份")
          Text(editor.operation == "retry" ? "只安排原任务再次检查，不绕过活动状态、预算或资格。" : "取消待发任务不撤回已发券、不退款，也不另建同批次资格。").font(.caption)
        }
        TextField("实际处理依据（2—500字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        Button("核对提交") {
          do {
            guard let actor = model.identity else { throw StaffAPIError.invalid }
            propose(try board.command(actor: actor, action: editor.action,
              fields: ["operation": editor.action == "refund" ? refundAction : editor.operation, "reason": reason, "cycle": cycle, "evidence": evidence, "compensated": String(compensated)],
              row: row, customers: customers, replacement: replacement)); error = ""
          } catch { self.error = error.localizedDescription }
        }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canUseMemberGifts)
      }
    }.sheet(isPresented: $picker) {
      MemberGiftOptionPicker(kind: editor.action == "target" ? "customers" : "refund", maximum: editor.action == "target" ? 50 : 1, initial: customers, refundRow: editor.action == "refund" ? editor.row : nil) { rows in
        if editor.action == "target" { customers = rows } else { replacement = rows.first }
        picker = false
      }
    }
  }
}
