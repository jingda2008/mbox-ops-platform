import Foundation

@main struct OwnerFinanceTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ yes: Bool, _ label: String) { precondition(yes, label); count += 1; print("PASS " + label) }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T { try JSONDecoder().decode(type, from: bytes(value)) }
    func rejects(_ block: () throws -> Void) -> Bool { do { try block(); return false } catch { return true } }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let auth: [String: Any] = ["session": ["id": "owner-session", "employeeId": id(1),
      "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"],
      "employee": ["id": id(1), "code": "owner", "displayName": "经营负责人", "roleCodes": ["OWNER"]],
      "permissions": ownerFinancePermissions, "deniedPermissions": []]
    let actor = try decode(StaffIdentity.self, auth)
    let category: [String: Any] = ["id": id(4), "code": "rent", "name": "场地租金", "systemCategory": "rent", "status": "active"]
    let center: [String: Any] = ["id": id(5), "code": "venue", "name": "营业门店", "status": "active"]
    let cost: [String: Any] = ["id": id(6), "publicId": "COST-ORIGINAL", "name": "原租金凭证", "corrected": false,
      "categoryDefinitionId": id(4), "costCenterId": id(5), "netAmountMinor": 10001, "taxAmountMinor": 100,
      "grossAmountMinor": 10101, "serviceStartDate": "2026-10-01", "serviceEndDate": "2026-10-31",
      "recognitionState": "actual", "allocationPeriod": "month", "sourceType": "lease"]
    let recurring: [String: Any] = ["id": id(15), "publicId": "RECURRING-ORIGINAL", "name": "每日租金",
      "status": "active", "version": 7, "netAmountMinor": 10001, "taxAmountMinor": 100, "grossAmountMinor": 10101]
    let rule: [String: Any] = ["id": id(7), "employeeId": id(2), "employeeName": "员工甲", "status": "active",
      "payBasis": "monthly", "baseRateMinor": 500000, "effectiveFrom": "2026-09-01", "costCenterId": id(5)]
    var ruleB = rule; ruleB["id"] = id(8); ruleB["employeeId"] = id(3); ruleB["employeeName"] = "员工乙"
    ruleB["baseRateMinor"] = 1001; ruleB["payBasis"] = "hourly"
    let run: [String: Any] = ["id": id(9), "publicId": "PAYROLL-ORIGINAL", "status": "draft", "version": 7,
      "periodStart": "2026-10-01", "periodEnd": "2026-10-31", "lineCount": 2,
      "grossPayMinor": 501201, "netPayMinor": 501101, "employerCostMinor": 502201]
    var approved = run; approved["id"] = id(10); approved["publicId"] = "PAYROLL-APPROVED"; approved["status"] = "approved"
    func line(_ n: Int, run: Int, employee: Int, base: Int) -> [String: Any] {
      var value: [String: Any] = ["id": id(n), "payrollRunId": id(run), "employeeId": id(employee),
        "employeeName": employee == 2 ? "员工甲" : "员工乙", "compensationRuleId": id(employee == 2 ? 7 : 8),
        "units": "1", "basePayMinor": base, "note": "私密工资说明"]
      for key in ownerPayrollAmounts { value[key] = 0 }
      if employee == 2 { value["bonusMinor"] = 200; value["deductionMinor"] = 100; value["employerContributionMinor"] = 1000 }
      return value
    }
    let lines = [line(11, run: 9, employee: 2, base: 500000), line(12, run: 9, employee: 3, base: 1001),
      line(13, run: 10, employee: 2, base: 500000), line(14, run: 10, employee: 3, base: 1001)]
    let source: [String: Any] = ["businessDate": "2026-10-05", "canViewCost": true, "canViewPayroll": true,
      "categories": [category], "costCenters": [center], "costs": [cost], "recurringRules": [recurring],
      "employees": [["id": id(2), "displayName": "员工甲", "employeeCode": "A", "status": "active"],
        ["id": id(3), "displayName": "员工乙", "employeeCode": "B", "status": "active"]],
      "compensationRules": [rule, ruleB], "payrollRuns": [run, approved], "payrollLines": lines]
    func board(_ data: [String: Any]? = nil, user: StaffIdentity? = nil,
      capability: [String: Any]? = nil) throws -> OwnerFinanceBoard {
      try OwnerFinanceBoard(data: bytes(["data": data ?? source]), capability: bytes(["data": capability ?? [
        "protocol": 1, "durableCommands": true, "employeeId": (user ?? actor).employee.id]]), actor: user ?? actor)
    }
    let current = try board(), original = current.rows("costs")[0], draft = current.rows("payrollRuns")[0]
    let approvedRow = current.rows("payrollRuns")[1], originalLine = current.rows("payrollLines")[0]
    let fields: [String: String] = ["displayName": "真实租金凭证", "name": "周期租金", "code": "new_code",
      "categoryDefinitionId": id(4), "costCenterId": id(5), "systemCategory": "rent", "netAmountMinor": "100.01", "taxAmountMinor": "1.00",
      "recognitionState": "actual", "allocationPeriod": "month", "sourceType": "lease", "counterparty": "收款单位",
      "serviceStartDate": "2026-10-01", "serviceEndDate": "2026-10-31", "cashPaidOn": "",
      "correctionReason": "核对原票据金额", "recurrence": "month", "startsOn": "2026-10-01", "endsOn": "",
      "throughDate": "2026-10-31", "status": "paused", "reason": "核对真实凭证和工资123456元",
      "employeeId": id(2), "payBasis": "monthly", "baseRateMinor": "5000.01", "effectiveFrom": "2026-10-01", "effectiveUntil": "",
      "periodStart": "2026-10-01", "periodEnd": "2026-10-31", "compensationRuleId": id(7), "units": "1",
      "overtimeMinor": "0", "bonusMinor": "1.01", "commissionMinor": "0", "allowanceMinor": "0", "deductionMinor": "0.01",
      "employerContributionMinor": "10", "note": "私密工资说明"]
    func command(_ op: String, values: [String: String]? = nil, target: OwnerFinanceRow? = nil,
      line: OwnerFinanceRow? = nil, remove: String? = nil, user: StaffIdentity? = nil,
      from: OwnerFinanceBoard? = nil) throws -> LiveCommand {
      try (from ?? current).command(actor: user ?? actor, operation: op, fields: values ?? fields,
        row: target, line: line, removeEmployeeID: remove)
    }
    check(try ownerMoney("100.01") == 10001 && ownerMoney("0.1") == 10 && ownerMoney("9999999999.99") == 999999999999,
      "money uses exact integer cents including maximum input")
    check(ownerMinorText(9007199254740991) == "90071992547409.91", "confirmation keeps exact cents at JS safe integer boundary")
    for value in ["-1", "1e2", "0.001", "NaN", "1,000", "01", "", "10000000000"] {
      check(rejects { _ = try ownerMoney(value) }, "money rejects invalid syntax \(value)")
    }
    for value: Any in [true, 1.5, -1, "9007199254740992", "1e2"] {
      check(rejects { _ = try ownerInteger(value) }, "financial integer refuses lossy or nonnumeric value")
    }
    check(try OwnerFinanceBoard.query(start: "", end: "") == "", "blank query uses current business month")
    for pair in [("2026-02-30", "2026-03-01"), ("2026-10-02", "2026-10-01"), ("", "2026-10-01")] {
      check(rejects { _ = try OwnerFinanceBoard.query(start: pair.0, end: pair.1) }, "financial query validates dates")
    }
    for field in ["protocol", "durableCommands", "employeeId"] {
      var cap: [String: Any] = ["protocol": 1, "durableCommands": true, "employeeId": actor.employee.id]
      cap[field] = field == "employeeId" ? id(20) : field == "durableCommands" ? 1 : 2
      check(rejects { _ = try board(capability: cap) }, "owner board rejects wrong capability \(field)")
    }
    var hidden = source; hidden["canViewPayroll"] = false
    check(rejects { _ = try board(hidden) }, "server may not leak payroll arrays behind false visibility flag")
    var unauthorized = auth; unauthorized["deniedPermissions"] = ["commercial.payroll.view"]
    check(rejects { _ = try board(user: decode(StaffIdentity.self, unauthorized)) }, "board refuses payroll visible to revoked user")
    var duplicate = source; duplicate["costs"] = [cost, cost]
    check(rejects { _ = try board(duplicate) }, "duplicate original cost rows rejected")
    let disabled = try board(capability: ["protocol": 1, "durableCommands": false, "employeeId": actor.employee.id])
    check(rejects { _ = try command("cost.create", from: disabled) }, "old capability remains readonly")
    var wrongActor = auth; var employee = wrongActor["employee"] as! [String: Any]; employee["id"] = id(20); wrongActor["employee"] = employee
    check(rejects { _ = try command("cost.create", user: decode(StaffIdentity.self, wrongActor)) }, "another employee cannot submit cached owner's board")
    for permission in ["commercial.cost.manage", "commercial.payroll.manage", "commercial.payroll.post"] {
      var denied = auth; denied["deniedPermissions"] = [permission]
      let op = permission == "commercial.cost.manage" ? "cost.create" : permission == "commercial.payroll.post" ? "payroll-run.post" : "payroll-run.approve"
      check(rejects { _ = try command(op, target: permission == "commercial.cost.manage" ? nil : permission == "commercial.payroll.post" ? approvedRow : draft,
        user: decode(StaffIdentity.self, denied)) }, "explicit \(permission) denial wins")
    }
    var expired = auth; var session = expired["session"] as! [String: Any]; session["onlineLeaseUntil"] = "2000-01-01T00:00:00Z"; expired["session"] = session
    check(rejects { _ = try command("cost.create", user: decode(StaffIdentity.self, expired)) }, "expired online lease cannot create financial request")
    let operations: [(String, OwnerFinanceRow?)] = [("cost.create", nil), ("cost.correct", original),
      ("cost-category.create", nil), ("cost-center.create", nil), ("recurring-cost.create", nil),
      ("recurring-cost.materialize", nil), ("recurring-cost.status", current.rows("recurringRules")[0]),
      ("compensation-rule.create", nil), ("payroll-run.create", nil), ("payroll-run.approve", draft),
      ("payroll-run.void", draft), ("payroll-run.post", approvedRow)]
    func receipt(_ command: LiveCommand, replayed: Bool = false) -> [String: Any] {
      let step = command.steps[0], proof = step.ownerFinanceProof!, operation = proof["operation"] as! String
      let op = String(operation.dropFirst("commercial.".count))
      let status = ["cost.create": "recorded", "cost.correct": "recorded", "recurring-cost.materialize": "completed",
        "recurring-cost.status": "paused", "payroll-run.create": "draft", "payroll-run.approve": "approved",
        "payroll-run.void": "voided", "payroll-run.post": "posted"][op] ?? "active"
      let target = proof["target"] as? String
      var result: [String: Any] = ["id": ["cost.correct"].contains(op) ? id(30) : target ?? id(30),
        "publicId": "ORIGINAL-FINANCIAL-RECEIPT", "status": status, "aggregateVersion": 8]
      if ["cost.create", "cost.correct"].contains(op) {
        result["netAmountMinor"] = step.object["netAmountMinor"]; result["taxAmountMinor"] = step.object["taxAmountMinor"]
        if op == "cost.correct" { result["correctsCostEntryId"] = target }
      }
      return ["meta": ["protocol": 1, "replayed": replayed], "data": ["operation": operation,
        "employeeId": actor.employee.id, "requestKey": step.key, "result": result]]
    }
    for (operation, target) in operations {
      let originalCommand = try command(operation, target: target), step = originalCommand.steps[0]
      let confirmation = step.ownerFinanceProof!["confirmation"] as! String
      check(confirmation.contains("只登记账务，不执行转账或扣款"), "\(operation) confirms accounting rather than bank transfer")
      var vault: [String: String] = [:]
      let secured = try secureOwnerFinanceCommand(originalCommand) { vault[$0] = $1 }
      let safeStep = secured.steps[0]
      let serialized = String(data: try JSONEncoder().encode(secured), encoding: .utf8)!
      check(!serialized.contains("123456") && !serialized.contains("私密工资说明") && !serialized.contains("员工甲")
        && safeStep.object.isEmpty && safeStep.ownerFinanceProof?["confirmation"] == nil,
        "\(operation) disk pending keeps no financial body or confirmation plaintext")
      check(rejects { _ = try secureOwnerFinanceCommand(secured) { _, _ in preconditionFailure("must not overwrite secret") } },
        "\(operation) already secured request cannot be rewrapped or replace original slot")
      let restored = try JSONDecoder().decode(LiveCommand.self, from: JSONEncoder().encode(secured))
      let body = try ownerFinanceRequestBody(restored, step: restored.steps[0], read: { vault[$0]! })
      check(NSDictionary(dictionary: body).isEqual(to: step.object), "\(operation) original secure payload survives relaunch")
      try validateOwnerFinanceReply(bytes(receipt(originalCommand)), step: safeStep, body: body)
      check(true, "\(operation) exact durable receipt accepted")
      for key in ["operation", "employeeId", "requestKey"] {
        var reply = receipt(originalCommand); var data = reply["data"] as! [String: Any]
        data[key] = "wrong"; reply["data"] = data
        check(rejects { try validateOwnerFinanceReply(bytes(reply), step: safeStep, body: body) }, "\(operation) rejects wrong \(key)")
      }
      for key in ["status", "aggregateVersion", "id"] {
        var reply = receipt(originalCommand); var data = reply["data"] as! [String: Any]; var result = data["result"] as! [String: Any]
        result[key] = key == "aggregateVersion" ? 0 : "wrong"; data["result"] = result; reply["data"] = data
        check(rejects { try validateOwnerFinanceReply(bytes(reply), step: safeStep, body: body) }, "\(operation) rejects invalid receipt \(key)")
      }
      if operation == "cost.create" || operation == "cost.correct" {
        for key in ["netAmountMinor", "taxAmountMinor"] {
          var reply = receipt(originalCommand); var data = reply["data"] as! [String: Any]; var result = data["result"] as! [String: Any]
          result[key] = 999; data["result"] = result; reply["data"] = data
          check(rejects { try validateOwnerFinanceReply(bytes(reply), step: safeStep, body: body) }, "\(operation) rejects wrong original amount \(key)")
        }
      }
      if operation == "cost.correct" {
        var reply = receipt(originalCommand); var data = reply["data"] as! [String: Any]
        var result = data["result"] as! [String: Any]; result["correctsCostEntryId"] = id(40)
        data["result"] = result; reply["data"] = data
        check(rejects { try validateOwnerFinanceReply(bytes(reply), step: safeStep, body: body) },
          "cost.correct rejects receipt bound to another original voucher")
      }
      if target != nil && operation != "cost.correct" {
        for (key, value): (String, Any) in [("id", id(40)), ("aggregateVersion", 7)] {
          var reply = receipt(originalCommand); var data = reply["data"] as! [String: Any]; var result = data["result"] as! [String: Any]
          result[key] = value; data["result"] = result; reply["data"] = data
          check(rejects { try validateOwnerFinanceReply(bytes(reply), step: safeStep, body: body) }, "\(operation) rejects wrong original object or stale version")
        }
      }
      var sends = 0, commits = 0, persisted = try JSONEncoder().encode(secured)
      let expectedHeaders = try ownerFinanceHeaders(safeStep)
      let api = StaffAPI(transport: { request in
        if request.url?.path == "/api/auth/login" {
          return (try bytes(["data": auth]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        sends += 1
        guard request.url?.path == safeStep.path, request.httpMethod == "POST",
          request.value(forHTTPHeaderField: "x-mbox-staff-employee-id") == actor.employee.id,
          expectedHeaders.allSatisfy({ request.value(forHTTPHeaderField: $0.key) == $0.value }),
          let data = request.httpBody,
          NSDictionary(dictionary: try JSONSerialization.jsonObject(with: data) as! [String: Any]).isEqual(to: body)
        else { throw StaffAPIError.invalid }
        if commits == 0 { commits += 1; throw URLError(.timedOut) }
        return (try bytes(receipt(originalCommand, replayed: true)), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      })
      _ = try await api.login(code: "owner", pin: "1234", switching: false)
      func send(_ command: LiveCommand, _ step: LiveCommand.Step) async throws {
        let body = try ownerFinanceRequestBody(command, step: step, read: { vault[$0]! })
        let data = try await api.raw(step.path, body: body, headers: ownerFinanceHeaders(step)).0
        try validateOwnerFinanceReply(data, step: step, body: body)
      }
      do { _ = try await LiveCommandRunner.advance(secured, send: { try await send(secured, $0) },
        checkpoint: { persisted = try JSONEncoder().encode($0) }); preconditionFailure("lost reply accepted") } catch {}
      let pending = try JSONDecoder().decode(LiveCommand.self, from: persisted)
      check(pending == secured && !vault.isEmpty, "\(operation) unknown result keeps secure original request")
      let complete = try await LiveCommandRunner.advance(pending, send: { try await send(pending, $0) },
        checkpoint: { persisted = try JSONEncoder().encode($0) })
      check(complete.completedSteps == 1 && sends == 2 && commits == 1,
        "\(operation) API request adapter restores original receipt after loss without second posting")
      _ = try await LiveCommandRunner.advance(complete, send: { try await send(complete, $0) }, checkpoint: { _ in })
      check(sends == 2, "\(operation) readback failure recovery never repeats checkpointed financial command")
    }
    let edit = try command("payroll-run.create", target: draft, line: originalLine)
    check(edit.steps[0].object["replaceEmployeeLine"] as? Bool == true
      && edit.steps[0].object["expectedVersion"] as? Int == 7, "payroll line edit binds original run version")
    let removal = try command("payroll-run.create", target: draft, remove: id(3))
    check((removal.steps[0].object["lines"] as? [[String: Any]])?.isEmpty == true
      && removal.steps[0].object["removeEmployeeId"] as? String == id(3), "payroll removes only selected original employee")
    check(rejects { _ = try command("payroll-run.create", target: draft) }, "payroll cannot append employee already in run")
    var singleSource = source; var singleRun = run; singleRun["lineCount"] = 1
    singleRun["grossPayMinor"] = 500200; singleRun["netPayMinor"] = 500100; singleRun["employerCostMinor"] = 501200
    singleSource["payrollRuns"] = [singleRun]; singleSource["payrollLines"] = [lines[0]]
    let single = try board(singleSource)
    check(rejects { _ = try command("payroll-run.create", target: single.rows("payrollRuns")[0], remove: id(2), from: single) },
      "last payroll line requires whole-run void instead of empty draft")
    check(rejects { _ = try command("payroll-run.approve", target: approvedRow) }
      && rejects { _ = try command("payroll-run.post", target: draft) }, "payroll state machine refuses duplicate approval or draft posting")
    var wrongFields = fields; wrongFields["compensationRuleId"] = id(8)
    check(rejects { _ = try command("payroll-run.create", values: wrongFields) }, "salary rule must belong to selected employee")
    for units in ["0", "-1", "1e2", "1.001", "2"] {
      var value = fields; value["units"] = units
      check(rejects { _ = try command("payroll-run.create", values: value) }, "monthly pay rejects invalid quantity \(units)")
    }
    var hourly = fields; hourly["employeeId"] = id(3); hourly["compensationRuleId"] = id(8); hourly["units"] = "0.50"
    let hourlyCommand = try command("payroll-run.create", values: hourly)
    check(((hourlyCommand.steps[0].object["lines"] as! [[String: Any]])[0]["basePayMinor"] as? Int) == 501,
      "hourly base uses exact decimal quantity and half-up cent rounding")
    let append = try command("payroll-run.create", values: hourly, target: single.rows("payrollRuns")[0], from: single)
    let appendBody = append.steps[0].object
    check(appendBody["draftRunId"] as? String == id(9) && appendBody["expectedVersion"] as? Int == 7
      && appendBody["replaceEmployeeLine"] == nil && appendBody["removeEmployeeId"] == nil
      && (appendBody["lines"] as! [[String: Any]])[0]["employeeId"] as? String == id(3),
      "payroll appends selected new employee while retaining original draft and version")
    var excessive = fields; excessive["deductionMinor"] = "999999.99"
    check(rejects { _ = try command("payroll-run.create", values: excessive) }, "deduction cannot exceed gross pay")
    let payrollConfirmation = edit.steps[0].ownerFinanceProof!["confirmation"] as! String
    for expected in ["员工甲", "员工乙", "2人", "2026-10-01", "整单应发", "数量", "扣款", "雇主承担"] {
      check(payrollConfirmation.contains(expected), "payroll final confirmation shows \(expected)")
    }
    let costConfirmation = try command("cost.create").steps[0].ownerFinanceProof!["confirmation"] as! String
    for expected in ["101.01", "实际", "月", "租赁合同", "场地租金", "营业门店"] {
      check(costConfirmation.contains(expected), "cost final confirmation shows \(expected)")
    }
    var vault: [String: String] = [:]
    let plain = try command("payroll-run.approve", target: draft)
    let secure = try secureOwnerFinanceCommand(plain) { vault[$0] = $1 }
    func altered(proof changes: [String: Any] = [:], path: String? = nil, key: String? = nil,
      header: String? = nil, body: Data? = nil, employee: String? = nil, permission: String? = nil) throws -> LiveCommand {
      let old = secure.steps[0]; var proof = old.ownerFinanceProof!
      proof.merge(changes) { _, new in new }
      return LiveCommand(id: secure.id, employeeID: employee ?? secure.employeeID, title: secure.title,
        permission: permission ?? secure.permission, steps: [.init(path: path ?? old.path, body: body ?? old.body,
          keyHeader: header ?? old.keyHeader, key: key ?? old.key,
          recoveryBody: try bytes(["ownerFinance": proof]))])
    }
    let mutations = try [altered(proof: ["payloadKey": "owner-finance-" + UUID().uuidString]),
      altered(proof: ["employeeId": id(20)]), altered(proof: ["operation": "commercial.cost.create"]),
      altered(proof: ["target": id(50)]), altered(proof: ["confirmation": "forbidden plaintext"]),
      altered(path: "/api/refunds/unsafe/execute"), altered(key: "new-key"), altered(header: "x-idempotency-key"),
      altered(body: bytes(["salary": 123])), altered(employee: id(20)), altered(permission: "commercial.cost.manage")]
    for (index, bad) in mutations.enumerated() {
      var reads = 0
      check(rejects { _ = try ownerFinanceRequestBody(bad, step: bad.steps[0], read: { _ in reads += 1; return "{}" }) }
        && reads == 0, "tampered secure metadata \(index) refused before reading any other secret")
    }
    check(rejects { _ = try ownerFinanceRequestBody(secure, step: secure.steps[0], read: { _ in "{\"reason\":\"other payload\"}" }) },
      "original secret digest rejects another financial payload")
    check(rejects { _ = try ownerFinanceRequestBody(secure, step: secure.steps[0], read: { _ in throw URLError(.cannotOpenFile) }) },
      "missing private slot cannot fall back to fresh request")
    check(rejects { _ = try secureOwnerFinanceCommand(plain) { _, _ in throw URLError(.cannotWriteToFile) } },
      "private slot write failure prevents constructing a disk-safe command")
    check(!StaffAPIError(status: 409, code: "OWNER_FINANCE_CONFLICT", message: "保留原请求").definitivelyRejected,
      "ambiguous owner conflict keeps original intent")
    print("Owner finance tests: \(count) passed")
  }
}
