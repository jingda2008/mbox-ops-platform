import SwiftUI

extension Color {
  init(hex: UInt32) {
    self.init(
      red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255,
      blue: Double(hex & 255) / 255)
  }
}
let ink = Color(hex: 0x234031)
let paper = Color(hex: 0xF7F4EF)
let gold = Color(hex: 0xC69A68)
let textInk = Color(hex: 0x29251F)
struct BrandSurface: View {
  var body: some View {
    GeometryReader { g in
      ZStack(alignment: .topTrailing) {
        LinearGradient(
          colors: [Color(hex: 0x0D1712), ink, Color(hex: 0x101512)], startPoint: .topLeading,
          endPoint: .bottomTrailing)
        RadialGradient(
          colors: [gold.opacity(0.26), .clear], center: .topTrailing, startRadius: 0,
          endRadius: g.size.width * 0.7)
        Circle().stroke(gold.opacity(0.22), lineWidth: 1).frame(width: 270, height: 270).offset(
          x: 100, y: 55)
      }
    }.clipped()
  }
}
struct Card<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 8) { content }.padding(12).frame(
      maxWidth: .infinity, alignment: .leading
    ).background(
      Color(hex: 0xFFFDFA), in: RoundedRectangle(cornerRadius: 16)
    ).overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(hex: 0xE6DED2), lineWidth: 1))
  }
}
@main struct MBOXApp: App {
  @StateObject var model = AppModel()
  @StateObject var updater = AppUpdater()
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(model).environmentObject(updater).tint(ink).preferredColorScheme(
        .light)
    }
  }
}
struct RootView: View {
  @EnvironmentObject var updater: AppUpdater
  @EnvironmentObject var model: AppModel
  @Environment(\.scenePhase) private var scenePhase
  @State var tab = 0
  @State private var serviceTarget: ServiceAttention.Entry?
  let tabs = [
    ("桌台", "square.grid.2x2"), ("订单", "list.bullet.rectangle"), ("收银", "creditcard"),
    ("更多", "line.3.horizontal"),
  ]
  var body: some View {
    VStack(spacing: 0) {
      if model.live {
        HStack {
          Text(model.connection).font(.caption)
          Spacer()
          if model.identity?.allows("service.execute") == true,
            let entry = model.serviceAttention.firstUnread ?? model.serviceAttention.entries.first
          {
            Button {
              serviceTarget = entry
              model.serviceAttention.viewed(entry)
            } label: {
              Label(
                "服务 \(model.serviceAttention.entries.count)"
                  + (model.serviceAttention.unread.isEmpty
                    ? "" : " · 新\(model.serviceAttention.unread.count)"),
                systemImage: "bell.badge")
            }.font(.caption.weight(.semibold)).frame(minHeight: 44)
              .accessibilityLabel(
                "服务待办，\(model.serviceAttention.entries.count)项；\(entry.table)桌优先查看")
          }
          Button(model.identity == nil ? "登录" : "刷新") {
            if model.identity == nil { tab = 3 } else { Task { await model.refresh() } }
          }.font(.caption).disabled(model.busy)
        }.padding(.horizontal, 17).padding(.vertical, 6)
      }
      if let release = updater.release {
        Button("新版本 \(release.version) · 查看更新") { tab = 3 }.font(.caption).padding(.vertical, 4)
      }
      NavigationStack {
        Group {
          switch tab {
          case 0: TablesView()
          case 1: if model.live { LiveHistoryView() } else { OrdersView() }
          case 2: if model.live { LiveCashierView() } else { CashierView() }
          default: MoreView()
          }
        }.background(paper).toolbar(.hidden, for: .navigationBar)
      }.id("\(tab)-\(model.workspaceVersion)")
      HStack(spacing: 0) {
        ForEach(0..<4) { i in
          Button {
            tab = i
          } label: {
            VStack(spacing: 4) {
              Image(systemName: tabs[i].1).font(
                .system(size: 22, weight: tab == i ? .semibold : .regular)
              )
              .frame(width: 48, height: 28)
              .background(tab == i ? ink.opacity(0.09) : .clear, in: Capsule())
              Text(tabs[i].0).font(.system(size: 12, weight: tab == i ? .semibold : .regular))
              Capsule().fill(tab == i ? gold : .clear).frame(width: 24, height: 2)
            }.frame(maxWidth: .infinity, minHeight: 58).foregroundStyle(
              tab == i ? ink : Color.secondary)
          }.buttonStyle(CardPress()).accessibilityLabel(tabs[i].0)
        }
      }.background(Color(hex: 0xFFFDFA))
    }.background(paper)
      .sheet(item: $serviceTarget) { entry in
        LiveServiceView(focusedTask: entry.id, focusedSession: entry.session)
      }
      .onChange(of: model.workspaceVersion) { _, _ in serviceTarget = nil }
      .task {
        #if DEBUG && targetEnvironment(simulator)
          if let result = SimulatorKeychainCheck.run() {
            model.message = result
            return
          }
        #endif
        await model.restoreRememberedSession()
      }
      .task(id: scenePhase) { if scenePhase == .active { await updater.check() } }
      .task(id: scenePhase == .active && model.live) {
        guard scenePhase == .active && model.live else { return }
        while !Task.isCancelled {
          await model.heartbeat()
          do { try await Task.sleep(for: .seconds(45)) } catch { return }
        }
      }
      .alert(
        "M-BOX",
        isPresented: Binding(
          get: { !model.message.isEmpty }, set: { if !$0 { model.message = "" } })
      ) {
        Button("知道了") { model.message = "" }
      } message: {
        Text(model.message)
      }
  }
}
struct Heading: View {
  let title: String
  let subtitle: String
  var summary: String? = nil
  var body: some View {
    HStack(spacing: 12) {
      Text(title).font(.system(size: 20, weight: .semibold)).fixedSize(
        horizontal: true, vertical: false)
      Spacer(minLength: 0)
      if let summary {
        Text(summary).font(.system(size: 13, weight: .medium)).foregroundStyle(.white.opacity(0.9))
      }
      Text(subtitle).font(.caption).foregroundStyle(gold)
        .lineLimit(1).truncationMode(.tail)
        .padding(.horizontal, summary == nil ? 0 : 7).padding(.vertical, 4)
        .background(summary == nil ? .clear : .white.opacity(0.08), in: Capsule())
    }.padding(.horizontal, 17).padding(.vertical, 10).frame(minHeight: 48)
      .foregroundStyle(.white).background(BrandSurface())
  }
}
struct PendingView: View {
  @EnvironmentObject var model: AppModel
  var body: some View {
    if model.pending != nil {
      Button {
        model.recover()
      } label: {
        Label("原操作结果待确认 · 点击核对", systemImage: "clock.arrow.circlepath").font(.subheadline).padding()
          .frame(maxWidth: .infinity).background(
            gold.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
      }.disabled(model.busy)
    }
  }
}
struct TablesView: View {
  @EnvironmentObject var model: AppModel
  @State var query = ""
  @State var filter = "全部"
  var body: some View {
    ScrollView {
      VStack(spacing: 12) {
        Heading(
          title: "桌台", subtitle: model.live ? "门店" : "演练",
          summary:
            "营业 \(model.world.tables.filter{$0.session != nil}.count) · 待办 \(model.world.tables.filter{$0.service}.count)"
        )
        VStack(spacing: 12) {
          PendingView()
          LivePendingView()
          HStack {
            Image(systemName: "magnifyingglass")
            TextField("搜索桌号，如 A、5、A5", text: $query).textInputAutocapitalization(.characters)
              .autocorrectionDisabled()
            Button {
              model.requestCamera()
            } label: {
              Image(systemName: "qrcode.viewfinder")
            }.buttonStyle(RoundControl())
          }.padding(.leading, 12).background(.white, in: RoundedRectangle(cornerRadius: 12))
          Picker("桌台筛选", selection: $filter) {
            ForEach(["全部", "营业中", "空闲"], id: \.self) { Text($0) }
          }.pickerStyle(.segmented)
          let tables = model.world.orderedTables(query: query, filter: filter)
          if tables.isEmpty {
            ContentUnavailableView(
              "没有匹配的桌台", systemImage: "magnifyingglass", description: Text("试试部分桌号或切换筛选"))
          }
          LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
            ForEach(tables) { table in
              NavigationLink {
                TableDetail(tableID: table.id)
              } label: {
                TableTile(
                  table: table,
                  paused: model.liveOperations?.tables.first { $0.id == table.id }?.status
                    == "paused")
              }.buttonStyle(CardPress())
            }
          }
        }.padding(.horizontal, 17).padding(.bottom, 20)
      }
    }.refreshable { await model.refresh() }.background(paper)
  }
}
struct TableTile: View {
  let table: StaffTable
  var paused = false
  var body: some View {
    VStack(alignment: .leading, spacing: 11) {
      HStack {
        Text(table.code).font(.system(size: 27, weight: .semibold, design: .rounded))
        Spacer()
        if table.service { Image(systemName: "bell.badge").foregroundStyle(Color(hex: 0x795934)) }
      }
      Text(paused && table.session == nil ? "已停用" : table.status).font(
        .system(size: 12, weight: .medium)
      ).foregroundStyle(
        table.unknown ? Color(hex: 0x9A621E) : ink)
      Spacer(minLength: 0)
      HStack {
        Text(table.session == nil ? "\(table.capacity) 人桌" : "\(table.people) 人在座").font(.caption)
          .foregroundStyle(.secondary)
        Spacer()
        Text(table.session == nil ? (paused ? "暂停开台" : "开台") : money(table.due)).font(
          .system(size: 17, weight: .semibold))
      }
    }.padding(15).frame(height: 132).background(
      Color(hex: 0xFFFDFA), in: RoundedRectangle(cornerRadius: 15)
    ).overlay(
      RoundedRectangle(cornerRadius: 15).stroke(
        table.session != nil ? ink.opacity(0.27) : Color(hex: 0xE6DED2), lineWidth: 1)
    ).foregroundStyle(textInk)
  }
}
struct TableDetail: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let tableID: String
  @State var people = 2
  @State var cash = ""
  @State var target = ""
  @State var action: Command?
  @State var confirm = false
  @State private var menuDestination: MenuDestination?
  var table: StaffTable? { model.world.tables.first { $0.id == tableID } }
  func ask(_ command: Command) {
    guard !model.busy, model.pending == nil else {
      model.message = "请先核对原操作结果"
      return
    }
    action = command
    confirm = true
  }
  var body: some View {
    ScrollView {
      VStack(spacing: 12) {
        if let table {
          VStack(spacing: 12) {
            PendingView()
            if model.live { LivePendingView() }
            HStack {
              Text(table.status).font(.subheadline).foregroundStyle(
                table.unknown ? Color(hex: 0x9A621E) : ink)
              Spacer()
              Text(model.live ? "门店" : "演练").font(.caption).foregroundStyle(.secondary)
            }
            if table.session != nil {
              Card {
                HStack {
                  VStack(alignment: .leading, spacing: 7) {
                    Text("当前待收").font(.caption).foregroundStyle(.secondary)
                    Text(money(table.due)).font(
                      .system(size: 34, weight: .semibold, design: .rounded))
                  }
                  Spacer()
                  VStack(alignment: .trailing, spacing: 7) {
                    Text("账单 \(money(table.total))")
                    Text("已收 \(money(table.paid))")
                  }.font(.subheadline)
                }
              }
            }
            if model.live { LiveTableActions(tableID: tableID) }
            if !model.live {
              if let session = table.session {
                Button("点菜 / 加菜") {
                  menuDestination = MenuDestination(session: session, tableCode: table.code)
                }.buttonStyle(Primary(symbol: "fork.knife"))
                if table.unknown {
                  Card {
                    Label("原款结果待确认，暂不可再次收款", systemImage: "exclamationmark.circle").foregroundStyle(
                      Color(hex: 0x9A621E))
                    Text("当前为异常状态样例；真实通道查询尚未接入。").font(.caption).padding(.top, 6)
                  }
                }
                if table.service {
                  Button("完成本桌服务任务") {
                    ask(Command(kind: "service", tableID: table.id, expectedSession: session))
                  }.buttonStyle(Primary(tone: .secondary, symbol: "checkmark.seal"))
                }
                if let due = table.due, due > 0, !table.unknown {
                  Card {
                    VStack(alignment: .leading, spacing: 12) {
                      Text("现金收款 · 演练").font(.headline)
                      TextField("输入顾客交付现金", text: $cash).keyboardType(.decimalPad).textFieldStyle(
                        .roundedBorder)
                      if let amount = parseMoney(cash) {
                        Text("本次记账 \(money(min(amount,due))) · 找零 \(money(max(0,amount-due)))")
                          .font(.caption)
                      }
                      Button("核对并记录现金") {
                        ask(
                          Command(
                            kind: "cash", tableID: table.id, expectedSession: session,
                            given: parseMoney(cash) ?? 0))
                      }.buttonStyle(Primary(symbol: "banknote")).disabled(parseMoney(cash) == nil)
                    }
                  }
                }
                ForEach(model.world.orders.filter { $0.session == session }) { order in
                  Card {
                    VStack(alignment: .leading, spacing: 10) {
                      HStack {
                        Text(order.delivered ? "已送达" : "待送商品").font(.headline)
                        Spacer()
                        Text(money(order.amount))
                      }
                      ForEach(order.lines) { line in
                        Text("\(line.name) · \(line.variant) ×\(line.quantity)").font(.subheadline)
                      }
                      if !order.delivered {
                        Button("确认送达") {
                          ask(
                            Command(
                              kind: "deliver", tableID: table.id, expectedSession: session,
                              orderID: order.id))
                        }.buttonStyle(Primary(tone: .secondary, symbol: "checkmark.circle"))
                      }
                    }
                  }
                }
                Card {
                  VStack(spacing: 12) {
                    Picker("转到空闲桌", selection: $target) {
                      Text("选择目标桌").tag("")
                      ForEach(
                        model.world.tables.filter {
                          $0.session == nil && $0.capacity >= table.people
                        }
                      ) { Text($0.code).tag($0.id) }
                    }
                    Button("转台") {
                      ask(
                        Command(
                          kind: "transfer", tableID: table.id, expectedSession: session,
                          targetID: target))
                    }.buttonStyle(Primary(tone: .secondary, symbol: "arrow.left.arrow.right"))
                      .disabled(target.isEmpty)
                    Divider()
                    Button("结束用餐 · 释放桌台", role: .destructive) {
                      ask(Command(kind: "close", tableID: table.id, expectedSession: session))
                    }.buttonStyle(
                      Primary(tone: .danger, symbol: "rectangle.portrait.and.arrow.right"))
                    Text("结清后仍保留在座；结束用餐才释放桌台。").font(.caption).foregroundStyle(.secondary)
                  }
                }
              } else {
                Card { Stepper("用餐人数：\(people)", value: $people, in: 1...max(1, table.capacity)) }
                Button("确认开台") {
                  ask(
                    Command(kind: "open", tableID: table.id, expectedSession: nil, people: people))
                }.buttonStyle(Primary(symbol: "person.2.fill"))
              }
            }
          }.padding(.horizontal, 17).padding(
            .bottom, 24)
        }
      }
    }.fullScreenCover(item: $menuDestination) { destination in
      NavigationStack { MenuView(tableID: tableID, session: destination.session) }
    }.background(paper).toolbar(.visible, for: .navigationBar).navigationTitle(table?.code ?? "桌台")
      .navigationBarTitleDisplayMode(.inline).confirmationDialog(
        "确认本次操作？", isPresented: $confirm, titleVisibility: .visible
      ) {
        Button("确认") { if let action { model.execute(action) } }
        Button("取消", role: .cancel) { action = nil }
      } message: {
        Text(action?.kind == "cash" ? "现金 \(money(action?.given))，请确认已收到后记录。" : "将更新当前演练桌台状态。")
      }
  }
}
struct MenuView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.dismiss) var dismiss
  let tableID: String
  let session: String
  @State var variants: [String: String] = [:]
  @State var query = ""
  @State var category = ""
  @State var showingDraft = false
  @State var confirm = false
  @State var submitted = false
  var lines: [Line] { model.draft(session) }
  var categories: [(String, String)] {
    Array(Set(model.world.products.map(\.category))).sorted().map { ($0, $0) }
  }
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 12) {
        Text("演练菜单 · 样例商品；营业菜单请在“更多”登录门店").font(.caption).foregroundStyle(.secondary)
        PendingView()
        if submitted {
          Label("本桌演练订单已提交，可继续加菜", systemImage: "checkmark.circle.fill").foregroundStyle(ink)
        }
        if showingDraft {
          if lines.isEmpty { Text("还没有选择商品，返回菜单添加").foregroundStyle(.secondary) }
          ForEach(lines) { line in
            Card {
              HStack {
                Text(line.name).font(.headline)
                Spacer()
                Text(money(line.amount))
              }
              Text("\(line.variant) · \(line.quantity)份").font(.subheadline)
              Button("减少一份") {
                if let product = model.world.products.first(where: { $0.id == line.productID }) {
                  model.change(product, variant: line.variant, session: session, delta: -1)
                }
              }.buttonStyle(Primary(tone: .secondary, symbol: "minus.circle")).disabled(
                model.busy || model.pending != nil)
            }
          }
        } else {
          MenuFilters(query: $query, category: $category, categories: categories)
          let products = model.world.products.filter {
            (category.isEmpty || $0.category == category)
              && (query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || ($0.name + " " + $0.category).localizedCaseInsensitiveContains(
                  query.trimmingCharacters(in: .whitespacesAndNewlines)))
          }
          if products.isEmpty { Text("没有匹配的菜品，可切换全部菜单或清除搜索").foregroundStyle(.secondary) }
          ForEach(products) { product in
            Card {
              HStack(alignment: .top, spacing: 12) {
                MenuThumbnail(name: product.name)
                VStack(alignment: .leading, spacing: 6) {
                  Text(product.name).font(.headline)
                  Text(product.available ? product.category : "已售罄").font(.caption).foregroundStyle(
                    .secondary)
                  Text(money(product.price)).font(.title3.weight(.semibold)).foregroundStyle(ink)
                }
                Spacer()
              }
              if product.choices.count > 1 {
                Picker(
                  "规格",
                  selection: Binding(
                    get: { variants[product.id] ?? product.choices[0] },
                    set: { variants[product.id] = $0 })
                ) {
                  ForEach(product.choices, id: \.self) { Text($0) }
                }.pickerStyle(.segmented)
              }
              let variant = variants[product.id] ?? product.choices[0]
              let quantity =
                lines.first { $0.productID == product.id && $0.variant == variant }?.quantity ?? 0
              HStack {
                Text(quantity > 0 ? "已选 \(quantity)份" : "选择份数").font(.caption).foregroundStyle(
                  .secondary)
                Spacer()
                Button {
                  model.change(product, variant: variant, session: session, delta: -1)
                } label: {
                  Image(systemName: "minus")
                }
                .buttonStyle(RoundControl()).accessibilityLabel("减少\(product.name)").disabled(
                  quantity == 0 || model.busy || model.pending != nil)
                Text("\(quantity)").monospacedDigit()
                Button {
                  model.change(product, variant: variant, session: session, delta: 1)
                } label: {
                  Image(systemName: "plus")
                }
                .buttonStyle(RoundControl(prominent: true)).accessibilityLabel("添加\(product.name)")
                .disabled(!product.available || model.busy || model.pending != nil)
              }
            }
          }
        }
      }.padding(16)
    }.background(paper).navigationTitle(
      "菜单 · \(model.world.tables.first{$0.id == tableID}?.code ?? "")"
    )
    .navigationBarTitleDisplayMode(.inline).toolbar {
      ToolbarItem(placement: .cancellationAction) { Button("返回桌台") { dismiss() } }
    }
    .safeAreaInset(edge: .bottom) {
      VStack(spacing: 8) {
        Button(
          showingDraft
            ? "返回菜单继续加菜"
            : "查看已选 \(lines.reduce(0){$0+$1.quantity})份 · \(money(lines.reduce(0){$0+$1.amount}))"
        ) {
          showingDraft.toggle()
        }.buttonStyle(Primary(tone: showingDraft ? .secondary : .primary, symbol: "cart.fill"))
        if showingDraft {
          Button("核对无误，提交演练订单") { confirm = true }.buttonStyle(
            Primary(symbol: "checkmark.circle.fill")
          )
          .disabled(lines.isEmpty || model.busy || model.pending != nil)
        }
      }.padding(12).background(paper)
    }.confirmationDialog("确认当前桌号、商品及规格", isPresented: $confirm, titleVisibility: .visible) {
      Button("确认提交") {
        model.execute(
          Command(kind: "order", tableID: tableID, expectedSession: session, lines: lines))
      }
    }.onChange(of: model.world.orders.count) { _, _ in
      if model.world.orders.last?.session == session {
        submitted = true
        showingDraft = false
      }
    }.onChange(of: model.workspaceVersion) { _, _ in dismiss() }
  }
}
struct OrdersView: View {
  @EnvironmentObject var model: AppModel
  var body: some View {
    ScrollView {
      VStack(spacing: 12) {
        Heading(
          title: "订单", subtitle: model.live ? "接口待接入" : "演练",
          summary: "\(model.world.orders.count) 笔")
        if model.world.orders.isEmpty {
          ContentUnavailableView(
            "暂无订单", systemImage: "list.bullet.rectangle", description: Text("从桌台进入点单，提交后显示在这里"))
        }
        ForEach(model.world.orders.reversed()) { order in
          NavigationLink {
            if let table = model.world.tables.first(where: { $0.session == order.session }) {
              TableDetail(tableID: table.id)
            } else {
              ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                  Card {
                    Text("已结束桌次 · \(order.delivered ? "已送达" : "未送达")").font(.subheadline)
                    ForEach(order.lines) { line in
                      HStack {
                        Text("\(line.name) · \(line.variant) ×\(line.quantity)")
                        Spacer()
                        Text(money(line.amount))
                      }
                    }
                    Divider()
                    HStack {
                      Text("订单合计")
                      Spacer()
                      Text(money(order.amount)).bold()
                    }
                  }
                }.padding(17)
              }.background(paper).navigationTitle("\(order.tableCode) · 订单")
                .navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
            }
          } label: {
            Card {
              HStack {
                Text(order.tableCode).font(.title2.bold())
                VStack(alignment: .leading) {
                  Text(order.delivered ? "已送达" : "待送达")
                  Text("\(order.lines.count) 项商品").font(.caption)
                }
                Spacer()
                Text(money(order.amount))
              }
            }.padding(.horizontal, 17).foregroundStyle(textInk)
          }
        }
      }.background(paper)
    }
  }
}
struct CashierView: View {
  @EnvironmentObject var model: AppModel
  var body: some View {
    ScrollView {
      VStack(spacing: 12) {
        Heading(
          title: "收银", subtitle: model.live ? "门店" : "演练",
          summary: "\(model.world.tables.filter{$0.session != nil}.count) 桌在座")
        ForEach(model.world.orderedTables().filter { $0.session != nil }) { table in
          NavigationLink {
            TableDetail(tableID: table.id)
          } label: {
            Card {
              HStack {
                Text(table.code).font(.title2.bold())
                Text(table.status).font(.caption)
                Spacer()
                Text(money(table.due)).font(.headline)
              }
            }.padding(.horizontal, 17).foregroundStyle(textInk)
          }
        }
      }.background(paper)
    }
  }
}
struct Foldout<Content: View>: View {
  let title: String
  @ViewBuilder var content: Content
  var body: some View {
    Card {
      DisclosureGroup {
        content.padding(.top, 8)
      } label: {
        Text(title).font(.headline).frame(minHeight: 44)
      }
    }
  }
}
struct MoreView: View {
  @EnvironmentObject var updater: AppUpdater
  @EnvironmentObject var model: AppModel
  @State private var showStock = false
  @State private var showOverview = false
  @State private var showStockAudit = false
  @State private var showProducts = false
  @State private var showService = false
  @State private var showBenefits = false
  @State private var showMembers = false
  @State private var showReservations = false
  @State var code = ""
  @State var pin = ""
  @State var confirmReset = false
  @State private var showAssignments = false
  @State private var showFulfillment = false
  @State private var showKitchen = false
  @State private var showPickup = false
  var body: some View {
    ScrollView {
      VStack(spacing: 12) {
        Heading(
          title: "更多", subtitle: model.live ? model.staffName + " · 门店" : "演练")
        VStack(spacing: 12) {
          PendingView()
          LivePendingView()
          Foldout(title: model.identity == nil ? "门店登录" : "员工账号") {
            LiveAccountView()
          }
          if model.live,
            ["inventory.count", "inventory.waste", "inventory.count.approve"].contains(where: {
              model.identity?.allows($0) == true
            })
          {
            Button("盘点与报损 · 审核差异") { showStockAudit = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "checklist"))
          }
          if model.live, model.identity?.allows("commercial.profit.view") == true {
            Button("经营概览 · 收款与成本") { showOverview = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "chart.bar"))
          }
          if model.live, model.identity?.allows("catalog.product.manage") == true {
            Button("商品管理 · 售罄与改价") { showProducts = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "tag"))
          }
          if model.live, let actor = model.identity,
            StockBoard.permissions.contains(where: actor.allows)
          {
            Button("库存与收货 · 扫码入库") { showStock = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "shippingbox"))
          }
          if model.live && model.identity?.allows("service.execute") == true {
            Button("服务任务中心") { showService = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "checklist"))
          }
          if model.live
            && (model.identity?.allows("loyalty.account.view") == true
              || model.identity?.allows("loyalty.configuration.view") == true)
          {
            Button("会员服务 · 签到与奖励") { showMembers = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "person.crop.rectangle"))
          }
          if model.live && model.identity?.allows("loyalty.redemption.fulfill") == true {
            Button("权益兑付 · 礼遇与点心") { showBenefits = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "gift"))
          }
          if model.live && model.identity?.allows("reservation.view") == true {
            Button("预约与排队") { showReservations = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "calendar"))
          }
          if model.live && model.identity != nil {
            Button("人员与责任桌") { showAssignments = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "person.2"))
          }
          if model.live && model.canReadFulfillment {
            Button("出品任务 · 重做与异常") { showFulfillment = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "exclamationmark.bubble"))
          }
          if model.live && model.identity?.allows("kds.prepare") == true {
            Button("厨房 / 吧台 · 出品工作台") { showKitchen = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "flame"))
          }
          if model.live
            && (model.identity?.allows("kds.deliver") == true
              || model.identity?.allows("staff.access.configure") == true)
          {
            Button("取餐台 · 领取与撤回") { showPickup = true }.buttonStyle(
              Primary(tone: .secondary, symbol: "tray.and.arrow.up"))
          }
          Foldout(title: updater.release == nil ? "版本与更新" : "版本与更新 · 有新版本") {
            AppUpdateView(updater: updater)
          }
          Foldout(title: "设备权限") {
            VStack(alignment: .leading, spacing: 12) {

              Button("相机权限 · 扫码入口") { model.requestCamera() }.buttonStyle(
                Primary(tone: .secondary, symbol: "camera"))
              Button("麦克风与语音识别权限") { model.requestVoice() }.buttonStyle(
                Primary(tone: .secondary, symbol: "mic"))
              Text("扫码识别与语音转文字仍在开发；可手动输入。").font(.caption).foregroundStyle(.secondary)
            }
          }
          if !model.live {
            Foldout(title: "异常场景演练") {
              VStack(alignment: .leading, spacing: 12) {

                Toggle("下一次操作模拟回执中断", isOn: $model.simulateTimeout).disabled(
                  model.busy || model.pending != nil)
                PendingView()
                Button("重置演练数据", role: .destructive) { confirmReset = true }.buttonStyle(
                  Primary(tone: .danger, symbol: "arrow.counterclockwise")
                ).disabled(
                  model.busy || model.pending != nil)
              }
            }
          }
          Text("开发预览 · 仅供测试\n扫码支付、打印与推送暂不可用").font(.caption).multilineTextAlignment(
            .center
          ).foregroundStyle(.secondary)
        }.padding(.horizontal, 17).padding(.bottom, 24)
      }
    }.background(paper).sheet(isPresented: $showProducts) { LiveProductManagementView() }.sheet(
      isPresented: $showStockAudit
    ) { LiveStockAuditView() }.sheet(isPresented: $showOverview) { LiveOverviewView() }.sheet(
      isPresented: $showStock
    ) { LiveStockView() }
    .sheet(isPresented: $showService) { LiveServiceView() }.sheet(
      isPresented: $showReservations
    ) { LiveReservationsView() }.sheet(isPresented: $showMembers) { LiveMembersView() }.sheet(
      isPresented: $showBenefits
    ) { LiveBenefitsView() }.sheet(
      isPresented: $showAssignments
    ) { LiveAssignmentsView() }
    .sheet(
      isPresented: $showKitchen
    ) { LiveKitchenView() }.sheet(isPresented: $showFulfillment) { LiveFulfillmentView() }.sheet(
      isPresented: $showPickup
    ) { LivePickupView() }.confirmationDialog(
      "重置将清空本机演练订单和草稿", isPresented: $confirmReset, titleVisibility: .visible
    ) { Button("重置演练", role: .destructive) { model.reset() } }
  }
}
