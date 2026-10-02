import SwiftUI

func printStatus(_ value: String) -> String {
  [
    "pending": "等待打印", "printing": "正在打印", "printed": "打印机已回报成功", "failed": "打印失败",
    "dead": "任务已停止，核对出纸", "cancelled": "已取消", "retry": "生成失败待恢复", "skipped": "按规则跳过",
  ][value] ?? value
}
struct LivePrintingView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  var orderID: String? = nil
  var sessionID: String? = nil
  @State private var date = ""
  @State private var filter = ""
  @State private var proposed: LiveCommand?
  func propose(_ kind: String, _ target: String, _ reason: String = "", _ confirmed: Bool = false) {
    do {
      proposed = try model.preparePrint(
        kind: kind, target: target, reason: reason, confirmed: confirmed)
    } catch { model.message = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          Text(model.printState).font(.caption)
          Button("刷新票据状态") { Task { await model.loadPrinting() } }.buttonStyle(
            Primary(tone: .secondary, symbol: "arrow.clockwise")
          ).disabled(model.busy)
          if let orderID {
            Button("打印此原订单账单") { propose("order", orderID) }.buttonStyle(Primary(symbol: "printer"))
              .disabled(!model.canUsePrinting)
          }
          if let sessionID {
            Button("打印整个原桌次账单") { propose("table", sessionID) }.buttonStyle(
              Primary(tone: .secondary, symbol: "printer")
            ).disabled(!model.canUsePrinting)
          }
          if model.identity?.allows("order.bill.print") == true
            && model.identity?.allows("reconciliation.view") == true
          {
            TextField("营业日 YYYY-MM-DD", text: $date).textFieldStyle(.roundedBorder)
            Button("打印该营业日汇总与明细") { propose("report", date) }.buttonStyle(
              Primary(tone: .secondary, symbol: "doc.text")
            ).disabled(!model.canUsePrinting)
          }
          if !model.ownPrintJobs.isEmpty {
            Text("最近一次本人打印请求").font(.headline)
            ForEach(model.ownPrintJobs) { job in
              Text("\(job.stationCode) · \(printStatus(job.status)) · \(job.failureCode ?? "")")
                .font(.caption)
            }
          }
          TextField("筛选已加载的小票：订单号、设备或状态", text: $filter).textFieldStyle(.roundedBorder)
          ForEach(
            model.printJobs.filter {
              filter.isEmpty
                || [$0.sourceReference ?? "", $0.printerName ?? "", printStatus($0.status)].joined(
                  separator: " "
                ).localizedCaseInsensitiveContains(filter)
            }
          ) { job in
            PrintJobCard(job: job, act: propose)
          }
          ForEach(model.printSources) { source in PrintSourceCard(source: source, act: propose) }
          if model.printJobs.isEmpty && model.ownPrintJobs.isEmpty {
            Text("当前权限下没有已加载的打印任务；不代表订单没有收退款。").font(.caption)
          }
        }.padding(16)
      }.background(paper).navigationTitle("票据与打印").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } }
    }.task {
      date = model.cashier?.businessDate ?? model.financeSummary?.businessDate ?? ""
      await model.loadPrinting()
    }
    .onChange(of: model.workspaceVersion) { _, _ in dismiss() }
    .sheet(item: $proposed) { command in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(command.steps[0].printProof?["confirmation"] as? String ?? command.title)
            Button("确认以上打印操作") {
              proposed = nil
              Task { await model.executeLive(command) }
            }.buttonStyle(Primary(symbol: "printer")).disabled(!model.canExecuteLive(command))
          }.padding(20)
        }.navigationTitle(command.title).navigationBarTitleDisplayMode(.inline).toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("返回修改") { proposed = nil } }
        }
      }
    }
  }
}
private struct PrintJobCard: View {
  @EnvironmentObject var model: AppModel
  let job: LivePrintJob
  let act: (String, String, String, Bool) -> Void
  @State private var reason = ""
  var body: some View {
    Foldout(title: "\(printStatus(job.status)) · \(job.sourceReference ?? job.id)") {
      Text(
        "\(job.printerName ?? "打印设备") · \(job.stationCode) · \(job.connectivityStatus ?? "连接未知")"
      ).font(.caption)
      Text("任务 \(job.id)").font(.caption).textSelection(.enabled)
      if let failure = job.failureCode {
        Text("失败信息：\(failure)。检查缺纸、连接和是否已出纸，再选择恢复。").font(.caption)
      }
      if let at = job.printedAt { Text("回报时间：\(at)").font(.caption) }
      if let original = job.reprintOfJobId { Text("补打原任务：\(original)").font(.caption) }
      TextField("现场核对及重试／补打原因（至少3字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
      if job.canRetry {
        Button("已核对失败 · 重试原任务") { act("retry", job.id, reason, true) }.buttonStyle(
          Primary(tone: .secondary, symbol: "arrow.clockwise")
        ).disabled(!model.canUsePrinting)
      }
      if ["printed", "failed", "dead"].contains(job.status) {
        Button("已现场核对 · 按原小票补打") { act("reprint", job.id, reason, true) }.buttonStyle(
          Primary(tone: .secondary, symbol: "printer")
        ).disabled(!model.canUsePrinting)
      }
    }
  }
}
private struct PrintSourceCard: View {
  @EnvironmentObject var model: AppModel
  let source: LivePrintSource
  let act: (String, String, String, Bool) -> Void
  @State private var reason = ""
  var body: some View {
    Foldout(title: "票据生成 · \(source.ticketKind) · \(printStatus(source.status))") {
      Text("\(source.createdAt) · \(source.lastErrorCode ?? "等待生成")").font(.caption)
      if ["retry", "dead"].contains(source.status) {
        TextField("已修复问题和恢复原因", text: $reason).textFieldStyle(.roundedBorder)
        Button("恢复原票据生成") { act("source-retry", source.id, reason, false) }.buttonStyle(
          Primary(tone: .secondary, symbol: "arrow.clockwise")
        ).disabled(!model.canUsePrinting)
      }
    }
  }
}
