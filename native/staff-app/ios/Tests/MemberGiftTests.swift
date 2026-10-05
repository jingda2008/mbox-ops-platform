import Foundation
@main struct MemberGiftTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ value: Bool, _ text: String) { precondition(value, text); count += 1; print("PASS " + text) }
    func bad(_ run: () throws -> Void) -> Bool { do { try run(); return false } catch { return true } }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
    func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    let auth: [String: Any] = ["session": ["id": "gift-session", "employeeId": id(1), "expiresAt": "2099-01-01T00:00:00Z", "onlineLeaseUntil": "2099-01-01T00:00:00Z"], "employee": ["id": id(1), "code": "staff", "displayName": "赠礼管理员", "roleCodes": ["MANAGER"]], "permissions": memberGiftPermissions, "deniedPermissions": []]
    func actor(_ data: [String: Any] = auth) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self, from: bytes(data)) }
    let user = try actor()
    var draft = try MemberGiftDraft(); draft.fields.merge(["code": "NIGHT_GIFT", "name": "爵士夜赠礼", "reason": "真实预算及赠送规则已核对", "minimumTier": "member", "availableFrom": "2026-10-05 20:00", "availableUntil": "2098-01-01 00:00", "quantityPerCustomer": "1", "maximumQuantity": "1000", "maximumDailyQuantity": "100", "maximumCostMinor": "10000.01", "maximumDailyCostMinor": "1000.02", "maximumUnitCostMinor": "10.03"]) { _,v in v }
    draft.selected["productIds"] = [id(50)]; draft.selected["couponCalendarVersionId"] = [id(51)]; draft.names = [id(50): "招牌小食", id(51): "门店券日历第1版"]
    let rule = try draft.body()["rule"] as! [String: Any], hash = String(repeating: "a", count: 64)
    func campaign(_ status: String = "draft") -> [String: Any] { ["id": id(10), "code": "NIGHT_GIFT", "name": "爵士夜赠礼", "version": 2, "status": status, "nativeVersion": hash, "created_by_employee_id": id(2), "approved_by_employee_id": id(3), "rule": rule, "products": [["product_id":id(50),"name":"招牌小食"]], "calendar_code":"NIGHT", "calendar_version":1] }
    let job: [String: Any] = ["id":id(20),"status":"blocked","nativeVersion":hash,"attempts":2,"quantity":1,"name":"爵士夜赠礼","customer_reference":"MEM001"]
    let refund: [String: Any] = ["id":id(30)+":"+id(31),"refund_id":id(30),"reservation_id":id(31),"nativeVersion":hash,"refund_amount_minor":"25001","currency":"CNY","benefit_code":"NIGHT_GIFT","quantity":1,"status":"redeemed","action":NSNull(),"order_reference":"ORD-001","refund_reference":"REF-001"]
    func board(_ section: String = "campaigns", rows: [[String: Any]]? = nil, as who: StaffIdentity? = nil, enabled: Any = true) throws -> MemberGiftsBoard {
      try MemberGiftsBoard(data: bytes(["data":["employeeId":id(1),"protocol":1,"durableCommands":enabled,"rows":rows ?? (section == "campaigns" ? [campaign()] : section == "jobs" ? [job] : [refund]),"next":NSNull()]]), actor: who ?? user, section: section)
    }
    let empty = try board(rows: []), base = try board(), approved = try board(rows:[campaign("approved")]), published = try board(rows:[campaign("published")]), jobs = try board("jobs"), refunds = try board("refund-pending")
    let customers = [try WalletRecord(["id":id(40),"name":"会员001","code":"CUS001"])], replacement = try WalletRecord(["id":id(32),"benefit_code":"COMPENSATED","quantity_total":2])
    var revision = try MemberGiftDraft(row: base.rows[0]); revision.fields["reason"] = "独立核对原活动预算"
    var fixed = draft; fixed.fields["pricingKind"] = "fixed_price"; fixed.fields["fixedPriceMinor"] = "1.01"; fixed.selected["stackingVersionId"] = [id(52)]; fixed.names[id(52)] = "低价叠加第1版"
    var paired = draft; paired.selected["dessertProductId"] = [id(53)]; paired.names[id(53)] = "组合小甜点"
    var entry = draft; entry.fields["trigger"] = "card_entry"; entry.selected["cardProjectId"] = [id(54)]; entry.names[id(54)] = "爵士兴趣卡"
    typealias Case = (String,String,String,MemberGiftsBoard,GiftRecord?,MemberGiftDraft?,WalletRecord?)
    let cases: [Case] = [("new","save","",empty,nil,draft,nil),("revision","save","",base,base.rows[0],revision,nil),("fixed","save","",empty,nil,fixed,nil),("paired","save","",empty,nil,paired,nil),("entry","save","",empty,nil,entry,nil),
      ("approve","decision","approve",base,base.rows[0],nil,nil),("publish","decision","publish",approved,approved.rows[0],nil,nil),("stop","decision","stop",published,published.rows[0],nil,nil),
      ("target","target","",published,published.rows[0],nil,nil),("retry","control","retry",jobs,jobs.rows[0],nil,nil),("cancel","control","cancel",jobs,jobs.rows[0],nil,nil),
      ("no_return","refund","no_return",refunds,refunds.rows[0],nil,nil),("external","refund","external_compensation",refunds,refunds.rows[0],nil,nil),("replace","refund","replacement_coupon",refunds,refunds.rows[0],nil,replacement)]
    let fields = ["reason":"已核对原活动与实际事实","cycle":"OCTOBER_001","evidence":"本店已核对的原业务凭证","compensated":"true"]
    func command(_ c: Case, as who: StaffIdentity? = nil) throws -> LiveCommand { try c.3.command(actor:who ?? user,action:c.1,fields:fields.merging(["operation":c.2]){_,v in v},row:c.4,draft:c.5,customers:c.1 == "target" ? customers : [],replacement:c.6) }
    func receipt(_ c: Case, _ work: LiveCommand, replayed: Bool = false) -> [String: Any] {
      let b = work.steps[0].object; var result: [String: Any]
      switch c.1 {
      case "save": result = ["id":id(90),"code":b["code"]!,"name":b["name"]!,"version":(b["expectedVersion"] as! Int)+1,"status":"draft","created_by_employee_id":id(1),"rule":b["rule"]!]
      case "decision": let state = ["approve":"approved","publish":"published","stop":"stopped"][c.2]!; result = ["id":id(10),"status":state,state+"_by_employee_id":id(1)]
      case "target": result = ["items":[["jobId":id(91),"status":"pending","replayed":false]]]
      case "control": result = ["jobId":id(20),"status":c.2 == "cancel" ? "cancelled" : "blocked","scheduled":c.2 == "retry"]
      default: result = refund; result["action"] = c.2; result["reason"] = b["reason"]!; result["evidence_reference"] = b["evidenceReference"]!; result["replacement_benefit_id"] = b["replacementBenefitId"] ?? NSNull(); result["replacement_quantity"] = c.6 == nil ? NSNull() : 2 as Any
      }
      return ["meta":["protocol":1,"replayed":replayed],"data":["employeeId":id(1),"action":c.1,"requestKey":work.steps[0].key,"accepted":b,"row":result]]
    }
    for c in cases {
      let work = try command(c), step = work.steps[0], encoded = try JSONEncoder().encode(work)
      check(step.key == "native-business-" + work.id && step.path == memberGiftRoot + "/" + c.1,c.0+" original key/path")
      check(try JSONDecoder().decode(LiveCommand.self,from:encoded) == work,c.0+" exact persisted operation")
      var denied = auth; denied["deniedPermissions"] = [work.permission]
      check(bad { _ = try command(c,as:actor(denied)) },c.0+" explicit current denial")
      try validateMemberGiftReply(bytes(receipt(c,work)),step:step);check(true,c.0+" accepts original reply")
      for key in ["employeeId","action","requestKey"] {
        var response = receipt(c,work), d = response["data"] as! [String:Any];d[key] = "wrong";response["data"] = d
        check(bad { try validateMemberGiftReply(bytes(response),step:step) },c.0+" wrong "+key+" refused")
      }
      var changed = receipt(c,work), d = changed["data"] as! [String:Any];var accepted = d["accepted"] as! [String:Any];accepted["reason"] = "不同依据";d["accepted"] = accepted;changed["data"] = d
      check(bad { try validateMemberGiftReply(bytes(changed),step:step) },c.0+" original full accepted payload required")
      changed = receipt(c,work); changed["meta"] = ["protocol":1,"replayed":1]
      check(bad { try validateMemberGiftReply(bytes(changed),step:step) },c.0+" boolean receipt capability required")
      var persisted = encoded, commits = 0, sends = 0
      let api = StaffAPI(transport: { request in
        if request.url?.path == "/api/auth/login" { return (try bytes(["data":auth]),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!) }
        sends += 1
        guard request.url?.path == step.path,request.httpMethod == "POST",request.value(forHTTPHeaderField:"idempotency-key") == step.key,
          request.value(forHTTPHeaderField:"x-mbox-staff-employee-id") == id(1),let body = request.httpBody,NSDictionary(dictionary:try JSONSerialization.jsonObject(with:body) as! [String:Any]).isEqual(to:step.object) else { throw StaffAPIError.invalid }
        if commits == 0 { commits += 1;throw URLError(.timedOut) }
        return (try bytes(receipt(c,work,replayed:true)),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
      })
      _ = try await api.login(code:"staff",pin:"1234",switching:false)
      func send(_ s: LiveCommand.Step) async throws { try validateMemberGiftReply(await api.raw(s.path,body:s.object,headers:[s.keyHeader:s.key]).0,step:s) }
      do { _ = try await LiveCommandRunner.advance(work,send:send,checkpoint:{persisted = try JSONEncoder().encode($0)});preconditionFailure("lost response discarded") } catch {}
      check(try JSONDecoder().decode(LiveCommand.self,from:persisted) == work,c.0+" unknown keeps original payload/key")
      let done = try await LiveCommandRunner.advance(JSONDecoder().decode(LiveCommand.self,from:persisted),send:send,checkpoint:{persisted = try JSONEncoder().encode($0)})
      check(done.completedSteps == 1 && commits == 1 && sends == 2,c.0+" StaffAPI resumes one committed action")
      _ = try await LiveCommandRunner.advance(done,send:send,checkpoint:{_ in})
      check(sends == 2,c.0+" refresh failure cannot resend checkpoint")
    }
    var invalid = draft;invalid.fields["minimumTier"] = ""
    check(bad { _ = try invalid.body() },"empty audience cannot become full membership mailing")
    invalid = draft;invalid.fields["maximumDailyQuantity"] = "1001"
    check(bad { _ = try invalid.body() },"daily quantity cannot exceed campaign")
    invalid = draft;invalid.fields["maximumDailyCostMinor"] = "10000.02"
    check(bad { _ = try invalid.body() },"daily budget cannot exceed campaign")
    invalid = paired;invalid.fields["quantityPerCustomer"] = "2"
    check(bad { _ = try invalid.body() },"paired gift exactly one per customer")
    invalid = fixed;invalid.fields["fixedPriceMinor"] = "0"
    check(bad { _ = try invalid.body() },"fixed price cannot be zero")
    invalid = draft;invalid.selected["productIds"] = [id(50),id(50)]
    check(bad { _ = try invalid.body() },"duplicate gift products rejected")
    for amount in ["1.001","1e3","-1","90071992547409.92"] { check(bad { _ = try giftMoney(amount) },"exact cents reject "+amount) }
    check(try giftMoney("90071992547409.91") == 9007199254740991,"maximum safe integer money preserved")
    invalid = draft;invalid.fields["maximumCostMinor"] = "0";invalid.fields["maximumDailyCostMinor"] = "0";invalid.fields["maximumUnitCostMinor"] = "0"
    check(try walletInteger((invalid.body()["rule"] as! [String:Any])["maximumCostMinor"]) == 0,"zero budget never maps to unlimited")
    let full = try memberGiftRuleSummary(fixed.body()["rule"] as! [String:Any],names:fixed.names)
    for value in ["1.01","10000.01","1000.02","10.03","招牌小食","门店券日历第1版","低价叠加第1版","每日总份数上限：100","自然日","00:00"] { check(full.contains(value),"confirmation retains "+value) }
    var owned = campaign();owned["created_by_employee_id"] = id(1);let ownBoard = try board(rows:[owned])
    check(bad { _ = try ownBoard.command(actor:user,action:"decision",fields:fields.merging(["operation":"approve"]){_,v in v},row:ownBoard.rows[0]) },"creator cannot self approve")
    owned = campaign("approved");owned["approved_by_employee_id"] = id(1);let ownApproval = try board(rows:[owned])
    check(bad { _ = try ownApproval.command(actor:user,action:"decision",fields:fields.merging(["operation":"publish"]){_,v in v},row:ownApproval.rows[0]) },"approver cannot self publish")
    check(bad { _ = try base.command(actor:user,action:"target",fields:fields,row:base.rows[0],customers:customers) },"unpublished activity cannot queue gifts")
    check(bad { _ = try published.command(actor:user,action:"target",fields:fields,row:published.rows[0],customers:customers+customers) },"duplicate member in batch rejected")
    var terminal = job;terminal["status"] = "issued";let terminalBoard = try board("jobs",rows:[terminal])
    check(bad { _ = try terminalBoard.command(actor:user,action:"control",fields:fields.merging(["operation":"retry"]){_,v in v},row:terminalBoard.rows[0]) },"issued task cannot resend")
    var rewritten = revision;rewritten.fields["budgetDateBasis"] = "business";rewritten.fields["budgetCutoff"] = "06:00"
    check(bad { _ = try base.command(actor:user,action:"save",row:base.rows[0],draft:rewritten) },"same campaign cannot change budget day basis")
    check(bad { _ = try refunds.command(actor:user,action:"refund",fields:fields.merging(["operation":"external_compensation","compensated":"false"]){_,v in v},row:refunds.rows[0]) },"external compensation requires actual completion confirmation")
    let refundCase = cases.last!, refundWork = try command(refundCase)
    for key in ["refund_amount_minor","currency","benefit_code","quantity","refund_id","reservation_id","replacement_quantity","replacement_benefit_id","evidence_reference"] {
      var reply = receipt(refundCase,refundWork);var data = reply["data"] as! [String:Any];var result = data["row"] as! [String:Any];result[key] = "wrong";data["row"] = result;reply["data"] = data
      check(bad { try validateMemberGiftReply(bytes(reply),step:refundWork.steps[0]) },"refund receipt rejects changed "+key)
    }
    let query = try MemberGiftOptions.query(kind:"customers",search:"会员+01&kind=products")
    let url = URLComponents(string:"https://test.invalid"+query)!
    let form = url.percentEncodedQuery!.replacingOccurrences(of:"+",with:" ")
    check(form.contains("%2B") && url.queryItems!.first(where:{$0.name == "search"})!.value == "会员+01&kind=products","literal plus and delimiter preserved in option query")
    check(bad { _ = try MemberGiftOptions.query(kind:"customers",search:"") },"no unconditional customer export")
    check(bad { _ = try MemberGiftsBoard.query(section:"refund-pending",cursor:id(30)) },"refund cursor requires both original IDs")
    check(try MemberGiftsBoard.query(section:"refund-pending",cursor:id(30)+":"+id(31)).hasPrefix(memberGiftRoot+"/refund-pending?cursor="),"composite refund cursor preserved")
    var normalized = rule;normalized["availableFrom"] = "2026-10-05T12:00:00.000Z";normalized["dessertProductId"] = NSNull()
    check(try memberGiftCanonical(rule) == memberGiftCanonical(normalized),"server normalization of time and optional dessert accepted")
    for c in cases {
      let work = try command(c)
      var reply = receipt(c,work); var data = reply["data"] as! [String:Any]; var result = data["row"] as! [String:Any]
      switch c.1 {
      case "save": var changedRule = result["rule"] as! [String:Any]; changedRule["maximumCostMinor"] = 9; result["rule"] = changedRule
      case "decision": result["status"] = "draft"
      case "target": result["items"] = []
      case "control": result["scheduled"] = c.2 == "cancel"
      default: result["reason"] = "其他实际原因"
      }
      data["row"] = result; reply["data"] = data
      check(bad { try validateMemberGiftReply(bytes(reply),step:work.steps[0]) },c.0+" rejects wrong business outcome despite matching accepted request")
    }
    var wrongNative = campaign(); wrongNative["nativeVersion"] = "not-a-hash"
    check(bad { _ = try board(rows:[wrongNative]) },"unversioned original campaign cannot be changed")
    check(bad { _ = try board(rows:[campaign(),campaign()]) },"duplicate original campaign rows rejected")
    check(bad { _ = try board(enabled:1) },"integer durable flag is invalid")
    var deniedRead = auth; deniedRead["deniedPermissions"] = ["loyalty.configuration.view"]
    check(bad { _ = try board(as:actor(deniedRead)) },"view denial hides campaign and customer scope")
    let legacy = try board(enabled:false)
    check(bad { _ = try legacy.command(actor:user,action:"save",draft:draft) },"old endpoint without permanent receipts stays read only")
    var expired = auth; expired["session"] = ["id":"gift-session","employeeId":id(1),"expiresAt":"2099-01-01T00:00:00Z","onlineLeaseUntil":"2020-01-01T00:00:00Z"]
    check(bad { _ = try command(cases[0],as:actor(expired)) },"expired lease cannot submit a new gift promise")
    var altered = rule; altered["quantityPerCustomer"] = true
    check(bad { try validateMemberGiftRule(altered) },"boolean cannot substitute for gift quantity")
    altered = rule; altered["highlightMetrics"] = ["cost","cost"]
    check(bad { try validateMemberGiftRule(altered) },"duplicate statistics configuration rejected")
    altered = rule; altered["unsupported"] = "drift"
    check(bad { try validateMemberGiftRule(altered) },"unrecognized gift rule does not silently disappear")
    for time in ["24:00","06:60","6:00","-1:00"] { check(bad { _ = try giftMinute(time) },"invalid budget cutoff rejected: "+time) }
    invalid = draft;invalid.fields["budgetDateBasis"] = "business";invalid.fields["budgetCutoff"] = "06:00"
    check(try walletInteger((invalid.body()["rule"] as! [String:Any])["budgetDayStartMinute"]) == 360,"business-day boundary preserves selected minute")
    let optionData = try bytes(["data":["employeeId":id(1),"protocol":1,"durableCommands":true,"rows":[["id":id(32),"benefit_code":"COMPENSATED","quantity_total":2]],"next":NSNull()]])
    check(try MemberGiftOptions(data:optionData,actor:user,refund:true).rows.count == 1,"actual replacement options use benefit fields not product fields")
    var noPublisher = auth;noPublisher["deniedPermissions"] = ["loyalty.policy.publish"]
    check(bad { _ = try MemberGiftOptions(data:optionData,actor:actor(noPublisher),refund:true) },"replacement options cannot be read without publish permission")
    let reviewText = refundWork.steps[0].memberGiftProof!["confirmation"] as! String
    for value in ["250.01","ORD-001","REF-001","COMPENSATED","2份","不退款、不发券、不改库存"] { check(reviewText.contains(value),"refund confirmation shows "+value) }
    print("Member gift tests passed (\(count) assertions; \(cases.count) action branches)")
  }
}
