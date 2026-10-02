import SwiftUI

func cashHandoverStatus(_ status: String) -> String {
  ["open": "待盘点", "count_submitted": "待另一人交接", "closed": "已双人交接"][status] ?? status
}
struct LiveCashHandoverView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State private var amount = ""
  @State private var reason = ""
  @State private var reference = ""
  @State private var direction = "in"
  @State private var quantities: [String: String] = [:]
  @State private var proposed: LiveCommand?
  func propose(_ action: String) {
    do {
      var denominations: [String: Int] = [:]
      for (k, v) in quantities where !v.isEmpty {
        guard let q = Int(v) else { throw CatalogError("张数须为非负整数") }
        denominations[k] = q
      }
      let parsed = amount.isEmpty ? nil : parseMoney(amount)
      if ["open", "movement", "approve"].contains(action) && parsed == nil {
        throw CatalogError("请输入实际金额，最多两位小数")
      }
      proposed = try model.prepareCashHandover(
        action: action, amount: parsed, direction: direction, reference: reference, reason: reason,
        denominations: denominations)
    } catch { model.message = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text(model.cashHandoverState).font(.caption)
          Button("刷新门店现金交接") { Task { await model.loadCashHandover() } }.buttonStyle(
            Primary(tone: .secondary, symbol: "arrow.clockwise")
          ).disabled(model.busy)
          Text("覆盖门店所有收银点的现金合计。盘点交接时暂停现金收退，现金取存不计作营业收入。").font(.caption)
          if let board = model.cashHandover {
            TextField("实际说明／差异原因，至少4字", text: $reason, axis: .vertical).textFieldStyle(
              .roundedBorder)
            if let row = board.active {
              Text("\(row.businessDate) · \(cashHandoverStatus(row.status))").font(.headline)
              Text(
                "期初 \(money(row.openingMinor)) · 取存净额 \(money(row.movementMinor))\n当前账面 \(money(row.expectedMinor))"
              ).font(.subheadline)
              if let diff = row.openingDifferenceMinor, diff != 0 {
                Text("期初衔接差异 \(money(diff))，请核对前次交接与期间现金流水。").foregroundStyle(.orange)
              }
              if row.status == "open" {
                Foldout(title: "按面额实点现金") {
                  ForEach(cashDenominations, id: \.self) { d in
                    HStack {
                      Text(money(d))
                      TextField(
                        "张／枚数",
                        text: Binding(
                          get: { quantities[String(d)] ?? "" }, set: { quantities[String(d)] = $0 })
                      ).keyboardType(.numberPad).textFieldStyle(.roundedBorder)
                    }
                  }
                  Text("未填写的面额按0计；请先确认所有收银点均已汇总。").font(.caption)
                  Button("提交实点，等待另一人交接") { propose("count") }.buttonStyle(
                    Primary(symbol: "banknote")
                  ).disabled(!model.canUseCashHandover)
                }
                if board.canManage {
                  Foldout(title: "登记实际非营业存入／取出") {
                    Picker("方向", selection: $direction) {
                      Text("存入备用金").tag("in")
                      Text("取出交存").tag("out")
                    }.pickerStyle(.segmented)
                    TextField("实际取存金额（元）", text: $amount).keyboardType(.decimalPad).textFieldStyle(
                      .roundedBorder)
                    TextField("独立凭证／交存单号", text: $reference).textFieldStyle(.roundedBorder)
                    Button("确认实际取存已完成") { propose("movement") }.buttonStyle(
                      Primary(tone: .secondary, symbol: "arrow.left.arrow.right")
                    ).disabled(!model.canUseCashHandover)
                  }
                }
              }
              if let count = row.count {
                Text(
                  "原实点 \(money(count.countedMinor)) · 差异 \(money(count.differenceMinor))\n\(count.reason)"
                )
                if count.employeeId == model.identity?.employee.id {
                  Button("撤回原盘点并重新实点") { propose("withdraw") }.buttonStyle(
                    Primary(tone: .secondary, symbol: "arrow.uturn.backward")
                  ).disabled(!model.canUseCashHandover)
                } else if board.canManage {
                  TextField("另一人独立实点金额（元）", text: $amount).keyboardType(.decimalPad).textFieldStyle(
                    .roundedBorder)
                  Button("独立核对完成，确认交接") { propose("approve") }.buttonStyle(
                    Primary(symbol: "person.badge.shield.checkmark")
                  ).disabled(!model.canUseCashHandover)
                } else {
                  Text("等待另一名财务人员实点确认。").font(.caption)
                }
              }
            } else {
              TextField("门店实际期初现金（元）", text: $amount).keyboardType(.decimalPad).textFieldStyle(
                .roundedBorder)
              Button("核对期初现金，开始本次交接") { propose("open") }.buttonStyle(Primary(symbol: "banknote"))
                .disabled(!model.canUseCashHandover)
            }
            ForEach(board.handovers.filter { $0.status == "closed" }) { row in
              Foldout(title: "\(row.businessDate) · 已交接 · \(money(row.count?.countedMinor ?? 0))") {
                Text("原记录 \(row.id)").font(.caption).textSelection(.enabled)
                Text(
                  "账面 \(money(row.count?.expectedMinor ?? 0)) · 差异 \(money(row.count?.differenceMinor ?? 0))"
                )
                Text(
                  "\(row.count?.reason ?? "")\n盘点人 \(row.count?.employeeId ?? "")\n接收人 \(row.closedBy ?? "")\n\(row.closedAt ?? "")"
                ).font(.caption)
              }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("现金盘点与交接").navigationBarTitleDisplayMode(.inline).toolbar
      { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } }
    }
    .task { await model.loadCashHandover() }.onChange(of: model.workspaceVersion) { _, _ in
      dismiss()
    }
    .sheet(item: $proposed) { c in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(c.steps[0].cashHandoverProof?["confirmation"] as? String ?? c.title)
            Button("确认以上实际记录") {
              proposed = nil
              Task { await model.executeLive(c) }
            }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(!model.canExecuteLive(c))
          }.padding(20)
        }.navigationTitle(c.title).navigationBarTitleDisplayMode(.inline).toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("返回修改") { proposed = nil } }
        }
      }
    }
  }
}
