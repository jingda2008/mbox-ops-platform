import AVFoundation
import SwiftUI
import VisionKit

struct LiveMembersView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  @State var rewards = false
  @State var code = ""
  @State var reason = ""
  @State var filter = "pending"
  @State var error = ""
  @State var selected: Set<String> = []
  @State var proposed: LiveCommand?
  @State var physical = false
  @State var scan = false
  func propose(_ work: () throws -> LiveCommand) {
    do {
      proposed = try work()
      physical = false
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          LivePendingView()
          if model.identity?.allows("loyalty.account.view") == true
            && model.identity?.allows("loyalty.configuration.view") == true
          {
            Picker("会员工作", selection: $rewards) {
              Text("会员与签到").tag(false)
              Text("签到奖励审批").tag(true)
            }.pickerStyle(.segmented)
          }
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
          if rewards {
            Text(model.memberRewardState).font(.caption)
            Picker("状态", selection: $filter) {
              Text("待审批").tag("pending")
              Text("已发券").tag("issued")
              Text("已驳回").tag("rejected")
              Text("已失效").tag("invalid")
              Text("全部").tag("all")
            }
            Button("读取奖励记录") {
              selected = []
              Task { await model.loadMemberRewards(status: filter) }
            }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.clockwise")).disabled(model.busy)
            if let board = model.memberRewards {
              Foldout(title: "签到奖励规则 · \(board.rules.count)条") {
                ForEach(board.rules) { rule in
                  Text("\(rule.name) · 每\(rule.required_visits)个营业日到店 / \(rule.quantity)份")
                  Text("\(rule.products ?? "商品待核对") · \(rule.status=="active" ? "生效中":"已停用")").font(
                    .caption)
                }
              }
              ForEach(board.items) { row in
                Card {
                  HStack {
                    Text(row.member_no).font(.headline)
                    Spacer()
                    Text(memberRewardLabel(row.status)).font(.caption)
                  }
                  Text(row.name + " · " + String(row.quantity) + "份")
                  Text(row.products ?? "商品待核对").font(.caption)
                  Text("签到日：" + row.visit_dates.joined(separator: "、")).font(.caption)
                  Text("已领取 \(row.quantity_redeemed)份 · 撤回签到 \(row.cancelled_sources)次").font(
                    .caption)
                  if let reason = row.decision_reason { Text(reason).font(.caption) }
                  if row.status == "pending"
                    && model.identity?.allows("loyalty.configuration.approve") == true
                  {
                    Toggle(
                      "选择本条",
                      isOn: Binding(
                        get: { selected.contains(row.id) },
                        set: { if $0 { selected.insert(row.id) } else { selected.remove(row.id) } })
                    )
                  }
                }
              }
              if board.items.isEmpty { Text("当前范围没有奖励记录").foregroundStyle(.secondary) }
              if board.nextCursor != nil {
                Button("继续读取下一页") {
                  Task { await model.loadMemberRewards(status: filter, more: true) }
                }.disabled(model.busy || model.memberRewardFilter != filter)
              }
              if model.identity?.allows("loyalty.configuration.approve") == true {
                TextField("审批 / 驳回说明（2—300字）", text: $reason, axis: .vertical).textFieldStyle(
                  .roundedBorder)
                HStack {
                  Button("批准发券 · \(selected.count)条") {
                    propose {
                      try board.command(
                        ids: selected, approve: true, reason: reason, actor: model.identity!)
                    }
                  }.buttonStyle(Primary(symbol: "checkmark.seal"))
                  Button("驳回") {
                    propose {
                      try board.command(
                        ids: selected, approve: false, reason: reason, actor: model.identity!)
                    }
                  }.buttonStyle(Primary(tone: .danger, symbol: "xmark.circle"))
                }.disabled(
                  !model.canUseMemberRewards || filter != model.memberRewardFilter
                    || selected.isEmpty)
              }
            }
          } else {
            TextField("输入完整会员号", text: $code).textFieldStyle(.roundedBorder)
              .textInputAutocapitalization(.never)
            HStack {
              Button("扫描会员码") {
                Task {
                  guard DataScannerViewController.isSupported else {
                    error = "模拟器或本设备不支持扫码，可手动输入会员号"
                    return
                  }
                  guard await AVCaptureDevice.requestAccess(for: .video),
                    DataScannerViewController.isAvailable
                  else {
                    error = "请允许相机权限，或手动输入会员号"
                    return
                  }
                  scan = true
                }
              }.buttonStyle(Primary(tone: .secondary, symbol: "qrcode.viewfinder"))
              Button("查询会员") { Task { await model.loadMember(code) } }.buttonStyle(
                Primary(symbol: "magnifyingglass"))
            }.disabled(model.busy)
            Text(model.memberState).font(.caption)
            if let account = model.memberAccount, let part = model.memberParticipation,
              let visit = model.memberVisit
            {
              Card {
                Text(part.displayName ?? "会员").font(.title3.bold())
                Text(account.memberNo).font(.caption)
                HStack {
                  Text("等级 · " + (["member":"普卡","silver":"银卡","gold":"金卡"][account.tier] ?? "待核对"))
                  Spacer()
                  Text(account.membershipStatus == "active" ? "有效会员" : "会员状态需核对")
                }
                Text("可用积分 \(account.availablePoints) · 待追回 \(account.pendingRecoveryPoints)")
                Text("资格成长 \(account.qualificationGrowth) · 累计成长 \(account.lifetimeGrowth)").font(
                  .caption)
                if let ends = account.tierPeriodEndsAt {
                  Text("等级周期结束 · " + reservationTime(ends)).font(.caption)
                }
              }
              Card {
                Text("到店签到 · " + visit.businessDate).font(.headline)
                if let v = visit.visit {
                  Text(v.status == "checked_in" ? "已签到" : "已撤销")
                  Text(v.employeeName + " · " + reservationTime(v.checkedInAt)).font(.caption)
                } else {
                  Text("本营业日尚未签到")
                }
                if visit.visit?.status == "checked_in" {
                  TextField("撤销原因", text: $reason).textFieldStyle(.roundedBorder)
                  Button("撤销这次签到") {
                    propose {
                      try visit.command(cancel: true, reason: reason, actor: model.identity!)
                    }
                  }.buttonStyle(Primary(tone: .danger, symbol: "arrow.uturn.backward")).disabled(
                    !model.canUseMember || (try? MemberCommands.code(code)) != visit.memberNo)
                } else {
                  Button("确认会员本人已到店") {
                    propose { try visit.command(cancel: false, reason: "", actor: model.identity!) }
                  }.buttonStyle(Primary(symbol: "person.crop.circle.badge.checkmark")).disabled(
                    !model.canUseMember || (try? MemberCommands.code(code)) != visit.memberNo)
                }
                ForEach(Array((visit.rewards ?? []).enumerated()), id: \.offset) { _, progress in
                  Text(
                    "\(progress.name)：还需\(progress.remainingVisits)次；待审批\(progress.pending)轮 / 已发券\(progress.issued)轮"
                  ).font(.caption)
                }
              }
              Foldout(title: "当前权益 · \(part.benefits.count)项") {
                ForEach(part.benefits, id: \.id) { b in
                  Text("\(b.title) · \(b.quantity)份").font(.headline)
                  Text(b.guidance).font(.caption)
                  if let until = b.validUntil {
                    Text("有效至 " + reservationTime(until)).font(.caption)
                  }
                }
              }
              if part.activitiesVisible {
                Foldout(title: "活动与报名") {
                  ForEach(part.registrations, id: \.publicId) { a in
                    Text(a.title + " · " + String(a.partySize) + "人")
                    Text(a.guidance).font(.caption)
                  }
                  ForEach(part.activities, id: \.publicId) { a in
                    Text(a.title)
                    Text(a.guidance).font(.caption)
                  }
                }
              }
              Foldout(title: "最近20条积分流水") {
                ForEach(Array(account.pointEntries.enumerated()), id: \.offset) { _, e in
                  Text("\(e.delta>0 ? "+":"")\(e.delta) · 余额\(e.balanceAfter)")
                  Text(e.reason + " · " + reservationTime(e.occurredAt)).font(.caption)
                }
              }
              Foldout(title: "最近20条成长流水") {
                ForEach(Array(account.growthEntries.enumerated()), id: \.offset) { _, e in
                  Text("\(e.delta>0 ? "+":"")\(e.delta) · 余额\(e.balanceAfter)")
                  Text(e.reason + " · " + reservationTime(e.occurredAt)).font(.caption)
                }
              }
            }
          }
        }.padding(16)
      }.background(paper).navigationTitle("会员服务").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
      }
    }
    .onChange(of: model.workspaceVersion) { _, _ in dismiss() }.task {
      if model.identity?.allows("loyalty.account.view") != true {
        rewards = true
        await model.loadMemberRewards()
      }
    }
    .sheet(isPresented: $scan) {
      NativePaymentScanner(
        memberMode: true,
        received: {
          code = $0
          scan = false
        },
        failed: {
          error = $0
          scan = false
        })
    }
    .sheet(item: $proposed) { command in
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text(command.steps[0].memberProof?["confirmation"] as? String ?? "请核对会员")
            Toggle("已核对会员、现场事实及处理范围", isOn: $physical)
            Button("确认执行") {
              proposed = nil
              selected = []
              Task { await model.executeLive(command) }
            }.buttonStyle(Primary(symbol: "checkmark.shield")).disabled(
              !physical || !model.canExecuteLive(command))
          }.padding(20)
        }.navigationTitle(command.title).toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("返回") { proposed = nil } }
        }
      }
    }
  }
}
func memberRewardLabel(_ value: String) -> String {
  ["pending": "待审批", "issued": "已发券", "rejected": "已驳回", "invalid": "已失效"][value] ?? "待核对"
}
