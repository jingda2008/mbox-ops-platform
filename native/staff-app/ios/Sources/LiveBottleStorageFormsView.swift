import SwiftUI

struct BottleStorageCreateView: View {
  @EnvironmentObject var model: AppModel
  let board: BottleStorageBoard, usable: Bool
  let propose: ([String: Any]) -> Void
  @State private var member = ""
  @State private var category = ""
  @State private var item = ""
  @State private var unit = "瓶"
  @State private var quantity = "1"
  @State private var fraction = ""
  @State private var location = ""
  @State private var note = ""
  @State private var days = "20"
  @State private var declared = ""
  @State private var sourceReference = ""
  @State private var sourcePublic = ""
  @State private var source: [String: Any]?
  @State private var extras: [String: String] = [:]
  @State private var evidence: [String: Any]?
  @State private var expires = Date().addingTimeInterval(86400 * 20)
  @State private var customExpiry = false
  @State private var notice = ""
  @State private var looking = false
  private func submit() {
    do {
      guard let evidence, let count = Int(days), !looking else { throw CatalogError("请完成实物照片和联系人核对，并填写存期") }
      var values: [String: Any] = ["evidence": evidence, "memberNo": member.trimmingCharacters(in: .whitespacesAndNewlines), "categoryId": category,
        "itemName": item.trimmingCharacters(in: .whitespacesAndNewlines), "unit": unit.trimmingCharacters(in: .whitespacesAndNewlines), "quantity": quantity,
        "location": location.trimmingCharacters(in: .whitespacesAndNewlines), "note": note.trimmingCharacters(in: .whitespacesAndNewlines),
        "extraFields": extras, "sourceOrderId": source?["id"] ?? NSNull(), "sourceReference": sourceReference.isEmpty ? NSNull() : sourceReference.trimmingCharacters(in: .whitespacesAndNewlines)]
      if customExpiry { values["expiresAt"] = bottleISO(expires) } else { values["days"] = count }
      if !declared.isEmpty {
        guard declared.range(of: "^(0|[1-9][0-9]{0,9})(\\.[0-9]{1,2})?$", options: .regularExpression) != nil else { throw CatalogError("登记价值最多两位小数") }
        let parts = declared.split(separator: ".").map(String.init)
        values["declaredValueMinor"] = Int(parts[0])! * 100 + (parts.count == 2 ? Int(parts[1].padding(toLength: 2, withPad: "0", startingAt: 0))! : 0)
      } else { values["declaredValueMinor"] = NSNull() }
      guard sourcePublic.isEmpty || source != nil else { throw CatalogError("输入的消费订单尚未核实，请查询或清空") }
      propose(values); notice = ""
    } catch { notice = error.localizedDescription }
  }
  var body: some View {
    Card {
      Text("新存酒登记").font(.title3.bold())
      Text("只登记会员寄存，不扣减商品库存，也不产生收款。既有存酒在新存酒关闭后仍可办理取用。").font(.subheadline)
      if !board.policy.enabled { Text("规则已关闭新存酒，请由有权限的负责人调整。").foregroundStyle(.orange) }
      TextField("完整会员号", text: $member).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
      Text("存酒品类").font(.caption)
      Picker("品类", selection: $category) { Text("请选择").tag(""); ForEach(board.categories.filter { $0.flag("active") }) { Text($0.text("name")).tag($0.id) } }
      TextField("物品名称", text: $item).textFieldStyle(.roundedBorder)
      Text("数量单位").font(.caption)
      TextField("单位", text: $unit).textFieldStyle(.roundedBorder)
      Text("寄存数量").font(.caption)
      TextField("寄存数量", text: $quantity).textFieldStyle(.roundedBorder).keyboardType(.decimalPad)
      if unit == "瓶" { Picker("瓶内余量比例（可不选）", selection: $fraction) { Text("自行填写数量").tag(""); ForEach(bottleStorageFractions.keys.sorted(), id: \.self) { Text($0 + " 瓶").tag($0) } } }
      TextField("存放位置", text: $location).textFieldStyle(.roundedBorder)
      TextField("备注", text: $note, axis: .vertical).textFieldStyle(.roundedBorder)
      Toggle("指定到期时间", isOn: $customExpiry)
      if customExpiry { DatePicker("到期", selection: $expires, in: Date()..., displayedComponents: [.date, .hourAndMinute]) }
      else {
        Text("存期（天）").font(.caption)
        TextField("存期（天）", text: $days).textFieldStyle(.roundedBorder).keyboardType(.numberPad)
      }
      TextField("登记价值（元，可不填；不是收入）", text: $declared).textFieldStyle(.roundedBorder).keyboardType(.decimalPad)
      TextField("外部来源说明或凭证号（可不填）", text: $sourceReference).textFieldStyle(.roundedBorder)
      TextField("原消费订单号（可不填）", text: $sourcePublic).textFieldStyle(.roundedBorder)
      Button(looking ? "正在核实…" : "核实该会员的原消费订单") {
        let number = member, publicID = sourcePublic; looking = true; source = nil
        Task {
          defer { looking = false }
          do {
            let suffix = "/source-order?memberNo=" + LiveCommand.pathPart(number) + "&publicId=" + LiveCommand.pathPart(publicID)
            let result = try bottleData(await model.readBottleStorage(suffix)); _ = try bottleUUID(result["id"])
            guard number == member, publicID == sourcePublic, result["publicId"] as? String == publicID else { return }; source = result; notice = "原消费订单已核实"
          } catch { if number == member && publicID == sourcePublic { notice = error.localizedDescription } }
        }
      }.disabled(!usable || looking || member.isEmpty || sourcePublic.isEmpty)
      ForEach(board.policy.extraFieldDefinitions) { field in
        TextField(field.label + (field.required ? "（必填）" : "（可不填）") + (field.type == "date" ? " YYYY-MM-DD" : ""), text: Binding(get: { extras[field.key] ?? "" }, set: { extras[field.key] = $0 })).textFieldStyle(.roundedBorder)
      }
      BottleStorageEvidenceView(member: member, unit: unit, quantity: quantity, fraction: fraction, usable: usable, evidence: $evidence).id(member)
      if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
      Button("核对并登记存酒") { submit() }.buttonStyle(Primary(symbol: "archivebox")).disabled(!usable || !board.policy.enabled || evidence == nil)
    }.onChange(of: member) { _, _ in source = nil; evidence = nil }
      .onChange(of: sourcePublic) { _, _ in source = nil }
      .onChange(of: category) { _, id in if let row = board.categories.first(where: { $0.id == id }) { days = row.text("default_days") } }
      .onChange(of: fraction) { _, value in if let v = bottleStorageFractions[value] { quantity = v } }
      .onChange(of: unit) { _, value in if value != "瓶" { fraction = "" } }
      .task { days = String(board.policy.defaultDays) }
  }
}
struct BottleStorageDetailView: View {
  @EnvironmentObject var model: AppModel
  let board: BottleStorageBoard, detail: BottleStorageDetail, usable: Bool
  let refresh: () -> Void
  let propose: (String, [String: Any]) -> Void
  @State private var quantity = ""
  @State private var expiry = Date().addingTimeInterval(86400)
  @State private var reason = ""
  @State private var photo: Data?
  @State private var notice = ""
  var body: some View {
    Card {
      Text("存酒详情").font(.title3.bold())
      Text(detail.order.text("public_id")).font(.headline)
      Text("会员 " + detail.order.text("member_no") + " · " + detail.order.text("item_name"))
      Text("剩余 " + detail.order.text("remaining_quantity") + detail.order.text("unit") + " / 原存 " + detail.order.text("original_quantity") + detail.order.text("unit"))
      Text("状态：" + (bottleStorageStates[detail.order.text("status")] ?? "待核对") + "\n位置：" + detail.order.text("location") + "\n到期：" + bottleDisplayTime(detail.order.text("expires_at")))
      if !detail.order.text("note").isEmpty { Text("备注：" + detail.order.text("note")) }
      DisclosureGroup("登记价值、来源与原表单") {
        Text("登记价值：" + bottleStorageMinor(detail.order.text("declared_value_minor")) + "元（非收入）")
        Text("外部来源：" + (detail.order.text("source_reference").isEmpty ? "未登记" : detail.order.text("source_reference")))
        if !detail.order.text("source_order_id").isEmpty { Text("关联消费订单：" + detail.order.text("source_order_id")).font(.caption) }
        if let fields = detail.order.object["extra_field_snapshot"] as? [[String: Any]], let values = detail.order.object["extra_fields"] as? [String: String] {
          ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
            Text(bottleText(field, "label") + "：" + (values[bottleText(field, "key")] ?? "未登记"))
          }
        }
      }
      Button("刷新这张存酒单", action: refresh).disabled(!usable)
      if detail.order.text("status") == "stored" {
        TextField("本次取酒数量", text: $quantity).textFieldStyle(.roundedBorder).keyboardType(.decimalPad)
        Button("核对并发送取酒验证码") { propose("request_code", ["quantity": quantity]) }.buttonStyle(Primary(symbol: "message")).disabled(!usable)
        Text("发送任务登记、平台接受、会员实际收到是不同状态。验证码校验通过后，仍须单独确认实物交付。").font(.caption)
      }
      ForEach(detail.challenges) { challenge in
        BottleStorageChallengeView(challenge: challenge, usable: usable && detail.order.text("status") == "stored", propose: propose)
      }
      ForEach(detail.collections.filter { $0.text("status") == "collected" }) { collection in
        BottleStorageResolveView(board: board, order: detail.order, collection: collection, usable: usable, propose: propose)
      }
      DisclosureGroup("调整到期时间与归档") {
        DatePicker("新到期时间", selection: $expiry, in: Date()..., displayedComponents: [.date, .hourAndMinute])
        TextField("办理原因（至少两字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
        Button("核对并调整到期") { propose("expiry", ["expiresAt": bottleISO(expiry), "reason": reason.trimmingCharacters(in: .whitespacesAndNewlines)]) }.disabled(!usable)
        Button("核对并归档") { propose("archive", ["reason": reason.trimmingCharacters(in: .whitespacesAndNewlines)]) }
          .disabled(!usable || detail.order.text("status") != "collected" || detail.collections.contains { $0.text("status") == "collected" })
        Text("只有已无剩余且每笔取酒均处理完成的单据可以归档。").font(.caption)
      }
      Button("生成打印凭证") { propose("print_prepared", [:]) }.disabled(!usable)
      DisclosureGroup("寄存照片与联系人留证") {
        ForEach(detail.deposits) { deposit in
          Text("\(bottleDisplayTime(deposit.text("recorded_at"))) · \(deposit.text("quantity"))\(detail.order.text("unit")) · \(deposit.text("phone_masked"))").font(.caption)
          Button("查看该次水印照片") {
            Task {
              do {
                let result = try bottleData(await model.readBottleStorage("/\(detail.order.id)/photos/\(deposit.id)"))
                guard let encoded = result["base64"] as? String, let data = Data(base64Encoded: encoded), data.count <= 1_048_576 else { throw StaffAPIError.invalid }; photo = data; notice = ""
              } catch { notice = error.localizedDescription }
            }
          }.disabled(!usable)
        }
        if let photo, let image = UIImage(data: photo) { Image(uiImage: image).resizable().scaledToFit(); Button("收起照片") { self.photo = nil } }
      }
      DisclosureGroup("取酒、再存与操作历史") {
        ForEach(detail.collections) { row in Text("\(bottleDisplayTime(row.text("collected_at"))) 取走 \(row.text("quantity")) / 再存 \(row.text("returned_quantity")) · \(bottleStorageStates[row.text("status")] ?? row.text("status"))").font(.caption) }
        ForEach(Array(detail.events.enumerated()), id: \.offset) { _, event in
          Text("\(bottleDisplayTime(bottleText(event, "occurred_at"))) · \(bottleStorageEventName(bottleText(event, "event_type"))) · \(bottleText(event, "employee_name"))\n\(bottleText(event, "reason"))").font(.caption)
        }
      }
      DisclosureGroup("到期提醒发送记录") {
        ForEach(Array(detail.reminders.enumerated()), id: \.offset) { _, row in Text("提前\(bottleText(row, "days_before"))天 · \(bottleStorageStates[bottleText(row, "status")] ?? bottleText(row, "status")) · \(bottleDisplayTime(bottleText(row, "due_at")))").font(.caption) }
      }
      if !notice.isEmpty { Text(notice).foregroundStyle(.red) }
    }.task { quantity = detail.order.text("remaining_quantity"); expiry = bottleStoredDate(detail.order.text("expires_at")) ?? Date().addingTimeInterval(86400) }
  }
}
private struct BottleStorageChallengeView: View {
  let challenge: BottleStorageRow, usable: Bool
  let propose: (String, [String: Any]) -> Void
  @State private var code = ""
  private var active: Bool { challenge.text("consumed_at").isEmpty && challenge.text("invalidated_at").isEmpty && bottleStoredDate(challenge.text("expires_at")).map { $0 > Date() } == true }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Divider()
      Text("取酒 \(challenge.text("quantity")) · \(bottleStorageStates[challenge.text("delivery_status")] ?? "待核对")").font(.headline)
      Text("验证码截至 " + bottleDisplayTime(challenge.text("expires_at"))).font(.caption)
      if active && challenge.text("delivery_status") == "accepted" {
        if challenge.text("verified_at").isEmpty {
          SecureField("会员提供的验证码", text: $code).textFieldStyle(.roundedBorder).keyboardType(.numberPad)
          Button("核对验证码") { propose("verify", ["challengeId": challenge.id, "code": code]); code = "" }.disabled(!usable)
        } else {
          Text("验证码已通过；尚需现场确认实物交付。").font(.subheadline)
          Button("核对并确认实物已取走") { propose("collect", ["challengeId": challenge.id]) }.buttonStyle(Primary(symbol: "checkmark.seal")).disabled(!usable)
        }
      } else if !active { Text("本次验证码已使用或失效，请刷新后核对。").font(.caption) }
    }
  }
}
private struct BottleStorageResolveView: View {
  let board: BottleStorageBoard, order: BottleStorageRow, collection: BottleStorageRow, usable: Bool
  let propose: (String, [String: Any]) -> Void
  @State private var restore = false
  @State private var quantity = ""
  @State private var mode = "original"
  @State private var reason = ""
  @State private var fraction = ""
  @State private var evidence: [String: Any]?
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Divider(); Text("本次取走 \(collection.text("quantity"))\(order.text("unit")) · 待处理").font(.headline)
      Toggle("还有余量，需要再次寄存", isOn: $restore).disabled(!board.policy.allowRestorage)
      if restore {
        TextField("再次寄存数量", text: $quantity).textFieldStyle(.roundedBorder).keyboardType(.decimalPad)
        if order.text("unit") == "瓶" { Picker("瓶内余量比例", selection: $fraction) { Text("自行填写").tag(""); ForEach(bottleStorageFractions.keys.sorted(), id: \.self) { Text($0).tag($0) } } }
        Picker("再存方式", selection: $mode) { Text("沿用原单与到期日").tag("original"); if !board.policy.requireOriginalOrder { Text("生成新单").tag("new") } }
        BottleStorageEvidenceView(member: order.text("member_no"), unit: order.text("unit"), quantity: quantity, fraction: fraction, usable: usable, evidence: $evidence)
      }
      TextField("饮用完毕或再存说明（至少两字）", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
      Button(restore ? "核对并再次寄存" : "核对并确认本次已饮用完毕") {
        var body: [String: Any] = ["collectionId": collection.id, "quantity": restore ? quantity : NSNull(), "restorageMode": mode, "reason": reason.trimmingCharacters(in: .whitespacesAndNewlines)]
        if restore, let evidence { body["evidence"] = evidence }; propose("resolve_collection", body)
      }.disabled(!usable || (restore && evidence == nil))
    }.task { quantity = collection.text("quantity") }
      .onChange(of: fraction) { _, value in if let amount = bottleStorageFractions[value] { quantity = amount } }
      .onChange(of: restore) { _, _ in evidence = nil }
  }
}
func bottleStorageEventName(_ code: String) -> String {
  ["stored": "登记存酒", "created": "登记存酒", "code_requested": "登记验证码发送", "code_verified": "验证码通过", "code_rejected": "验证码不符", "collected": "已取走", "restored": "再次寄存", "collection_closed": "本次饮用完毕", "archived": "归档", "expiry_changed": "调整到期时间", "printed": "生成打印内容"][code] ?? "存酒记录"
}
