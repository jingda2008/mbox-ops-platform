import SwiftUI

func voucherStatus(_ v: String) -> String {
  [
    "dispatching": "平台处理中，待核对", "unknown": "平台结果未知，禁止重复核销", "provider_succeeded": "平台已核销，待完成本地登记",
    "recorded": "已登记核销，未记作结算款", "not_consumed": "双人已核对未核销",
  ][v] ?? v
}
struct LiveVouchersView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  var orderID: String? = nil
  var sessionID: String? = nil
  @State private var associate = true
  @State private var platform = "meituan"
  @State private var code = ""
  @State private var day = ""
  @State private var search = ""
  @State private var proposed: LiveCommand?
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text(model.voucherState).font(.caption)
          Button("刷新原核销事项") { Task { await model.loadVouchers() } }.buttonStyle(
            Primary(tone: .secondary, symbol: "arrow.clockwise")
          ).disabled(model.busy)
          Foldout(title: "查询券码与确认核销") {
            Picker("正式核销平台", selection: $platform) {
              ForEach(model.voucherPlatforms) { p in
                Text(p.label + (p.usable ? "" : " · 未开放正式核销")).tag(p.code)
              }
            }
            TextField("原券码", text: $code).textFieldStyle(.roundedBorder)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
            if let orderID, sessionID != nil {
              Toggle("关联此原订单 \(orderID)", isOn: $associate)
            } else {
              Text("从收银原订单进入可关联桌次；这里默认不关联桌单。").font(.caption)
            }
            Button("查询原券，暂不核销") {
              Task { await model.prepareVoucherPreview(platform: platform, code: code) }
            }.buttonStyle(Primary(tone: .secondary, symbol: "magnifyingglass")).disabled(
              !model.canUseVouchers)
            if let preview = model.voucherPreview {
              Text("\(preview.platformLabel) · \(preview.campaignName)").font(.headline)
              Text("\(preview.voucherCodeMasked) · \(preview.quantity)份 · \(preview.statusLabel)")
              Text(
                "面额 \(money(preview.faceValueMinor)) · 平台结算额 \(money(preview.settlementAmountMinor))"
              ).font(.caption)
              Text("券有效期：\(preview.expiresAt)").font(.caption)
              Button("核对后确认核销此券") {
                do {
                  proposed = try model.prepareVoucher(
                    code: code, orderID: associate ? orderID : nil,
                    sessionID: associate ? sessionID : nil)
                } catch { model.message = error.localizedDescription }
              }.buttonStyle(Primary(symbol: "checkmark.seal")).disabled(
                !model.canUseVouchers || preview.platform != platform)
            }
          }
          Foldout(title: "查询历史核销与结算状态") {
            TextField("原营业日 YYYY-MM-DD", text: $day).textFieldStyle(.roundedBorder)
            Button("查询该营业日原核销记录") { Task { await model.loadVoucherHistory(day) } }.buttonStyle(
              Primary(tone: .secondary, symbol: "calendar")
            ).disabled(model.busy)
            Text(model.voucherHistoryState).font(.caption)
            ForEach(model.voucherHistory) { r in
              VStack(alignment: .leading, spacing: 4) {
                Text("\(r.platform) · \(r.campaignName)")
                Text("\(r.voucherCodeMasked) · \(r.publicId)").font(.caption).textSelection(
                  .enabled)
                Text(
                  "面额 \(money(r.faceValueMinor)) · 平台结算額 \(money(r.settlementAmountMinor))\n\(r.isSettled ? "已关联服务器结算流水":"尚未关联结算流水")"
                ).font(.caption)
              }
            }
          }
          TextField("筛选原事项：活动、脱敏券码或编号", text: $search).textFieldStyle(.roundedBorder)
          ForEach(
            model.voucherOperations.filter {
              search.isEmpty
                || [$0.campaignName, $0.voucherCodeMasked, $0.publicId].joined(separator: " ")
                  .localizedCaseInsensitiveContains(search)
            }
          ) { row in VoucherOperationCard(row: row, proposed: $proposed) }
          if model.voucherOperations.isEmpty {
            Text("当前没有已加载的核销事项。旧核销记录仍保留在服务器；未返回不能当作未核销。").font(.caption)
          }
        }.padding(16)
      }.background(paper).navigationTitle("团购券核销").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } }
      }
    }
    .task {
      day = model.cashier?.businessDate ?? ""
      await model.loadVouchers()
    }.onChange(of: model.workspaceVersion) { _, _ in
      code = ""
      dismiss()
    }
    .sheet(item: $proposed) { command in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(command.steps[0].voucherProof?["confirmation"] as? String ?? command.title)
            Button("确认以上原券操作") {
              proposed = nil
              Task { await model.executeLive(command) }
              code = ""
            }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
              !model.canExecuteLive(command))
          }.padding(20)
        }.navigationTitle(command.title).navigationBarTitleDisplayMode(.inline).toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("返回修改") { proposed = nil } }
        }
      }
    }
  }
}
private struct VoucherOperationCard: View {
  @EnvironmentObject var model: AppModel
  let row: VoucherOperation
  @Binding var proposed: LiveCommand?
  @State private var outcome = "consumed"
  @State private var certificate = ""
  @State private var verify = ""
  @State private var evidence = ""
  @State private var reason = ""
  func act(_ action: String) {
    do {
      proposed = try model.prepareVoucherAction(
        id: row.id, action: action, outcome: outcome, certificate: certificate, verify: verify,
        evidence: evidence, reason: reason, confirmed: action != "recover")
    } catch { model.message = error.localizedDescription }
  }
  var body: some View {
    Foldout(title: "\(row.campaignName) · \(voucherStatus(row.status))") {
      Text("\(row.voucherCodeMasked) · \(row.publicId)").font(.caption).textSelection(.enabled)
      Text(
        "原营业日 \(row.businessDate) · 面额 \(money(row.faceValueMinor)) · 结算额 \(money(row.settlementAmountMinor))"
      ).font(.caption)
      if let order = row.orderId { Text("关联原订单 \(order)，不自动抵减其应收。").font(.caption) }
      if !row.terminal {
        Button("恢复原记录 · 不再次消耗券") { act("recover") }.buttonStyle(
          Primary(tone: .secondary, symbol: "arrow.clockwise")
        ).disabled(!model.canUseVouchers)
      }
      if let review = row.review {
        Text(
          "人工平台核对：\(review.outcome == "consumed" ? "已核销" : "已证实未核销")\n证书 \(review.certificateId)\n核销号 \(review.verifyId)\n依据 \(review.evidenceReference)\n\(review.reason)"
        ).font(.caption).textSelection(.enabled)
        if review.approvedBy == nil && review.employeeId != model.identity?.employee.id
          && model.identity?.allows("reconciliation.manage") == true
        {
          TextField("驳回原因，至少4字", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
          Button("证据不符，驳回重新核对") { act("reject") }.buttonStyle(
            Primary(tone: .secondary, symbol: "arrow.uturn.backward")
          ).disabled(!model.canUseVouchers)
          Button("另一人已独立核对 · 确认结果") { act("approve") }.buttonStyle(
            Primary(symbol: "person.badge.shield.checkmark")
          ).disabled(!model.canUseVouchers)
        } else if review.approvedBy == nil {
          Text("等待另一名财务复核人员独立核对，不可自己审批。").font(.caption)
        }
      } else if ["unknown", "dispatching"].contains(row.status) {
        Text("仅在平台查询原核销凭证后填写。至少两分钟后可提交，不能用再次消费券来测试结果。").font(.caption)
        Picker("已查明结果", selection: $outcome) {
          Text("平台已核销").tag("consumed")
          Text("已证实未核销").tag("not_consumed")
        }
        TextField("平台券证书编号", text: $certificate).textFieldStyle(.roundedBorder)
        TextField("平台核销凭证号", text: $verify).textFieldStyle(.roundedBorder)
        TextField("平台查询依据／工单号", text: $evidence, axis: .vertical).textFieldStyle(.roundedBorder)
        TextField("实际核对过程与原因", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
        Button("提交实际核对证据，等待另一人复核") { act("review") }.buttonStyle(
          Primary(tone: .secondary, symbol: "doc.text.magnifyingglass")
        ).disabled(!model.canUseVouchers)
      }
    }
  }
}
