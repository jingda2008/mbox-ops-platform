import Foundation
@main struct MemberNumberTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ condition: Bool, _ name: String) { precondition(condition,name);count += 1;print("PASS "+name) }
    func bad(_ fn: () throws -> Void) -> Bool { do { try fn();return false } catch { return true } }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject:value,options:.sortedKeys) }
    func id(_ n: Int) -> String { String(format:"00000000-0000-4000-8000-%012d",n) }
    let auth: [String:Any] = ["session":["id":"number-session","employeeId":id(1),"expiresAt":"2099-01-01T00:00:00Z","onlineLeaseUntil":"2099-01-01T00:00:00Z"],"employee":["id":id(1),"code":"staff","displayName":"会员管理员","roleCodes":["MANAGER"]],"permissions":["member.card.manage","loyalty.policy.view"],"deniedPermissions":[]]
    func actor(_ source: [String:Any] = auth) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self,from:bytes(source)) }
    let user = try actor(),policy: [String:Any] = ["width":6,"startNumber":100001,"maximumPrefixLength":2,"alphabet":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","padZero":true]
    let fields = ["width":"8","startNumber":"10000001","maximumPrefixLength":"4","alphabet":"ABCDEFGHJKLMNPQRSTUVWXYZ"]
    func board(_ version: Int = 1, enabled: Any = true, candidate: Any = "100001", as who: StaffIdentity? = nil) throws -> MemberNumberBoard {
      try MemberNumberBoard(data:bytes(["data":["employeeId":id(1),"protocol":1,"durableCommands":enabled,"row":["policy":policy,"version":version,"nextCandidate":candidate]]]),actor:who ?? user)
    }
    check(try board(candidate:NSNull()).nextCandidate == nil,"exhausted policy remains editable")
    for version in [0,1,15] {
      let original = try board(version),work = try original.command(actor:user,fields:fields,padZero:false,reason:"真实发号规则已核对"),step = work.steps[0],encoded = try JSONEncoder().encode(work)
      func reply(_ replayed: Bool = false) -> [String:Any] { ["meta":["protocol":1,"replayed":replayed],"data":["employeeId":id(1),"requestKey":step.key,"accepted":step.object,"row":["policy":step.object["policy"]!,"version":version == 0 ? 2 : version+1,"nextCandidate":"A1000000"]]] }
      check(step.path == memberNumberRoot && step.key == "native-business-"+work.id,"number original command path and key \(version)")
      check(try JSONDecoder().decode(LiveCommand.self,from:encoded) == work,"number exact persistence \(version)")
      try validateMemberNumberReply(bytes(reply()),step:step);check(true,"original version receipt accepted \(version)")
      for key in ["employeeId","requestKey","accepted"] {
        var r = reply();var d = r["data"] as! [String:Any];d[key] = "wrong";r["data"] = d
        check(bad { try validateMemberNumberReply(bytes(r),step:step) },"wrong receipt \(key) rejected \(version)")
      }
      for key in ["policy","version","nextCandidate"] {
        var r = reply();var d = r["data"] as! [String:Any];var row = d["row"] as! [String:Any];row[key] = "wrong";d["row"] = row;r["data"] = d
        check(bad { try validateMemberNumberReply(bytes(r),step:step) },"wrong original result \(key) rejected \(version)")
      }
      var persisted = encoded,commits = 0,sends = 0
      let api = StaffAPI(transport:{request in
        if request.url?.path == "/api/auth/login" { return (try bytes(["data":auth]),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!) }
        sends += 1
        guard request.url?.path == step.path,request.httpMethod == "POST",request.value(forHTTPHeaderField:"idempotency-key") == step.key,request.value(forHTTPHeaderField:"x-mbox-staff-employee-id") == id(1),let body = request.httpBody,NSDictionary(dictionary:try JSONSerialization.jsonObject(with:body) as! [String:Any]).isEqual(to:step.object) else { throw StaffAPIError.invalid }
        if commits == 0 { commits += 1;throw URLError(.timedOut) }
        return (try bytes(reply(true)),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
      })
      _ = try await api.login(code:"staff",pin:"1234",switching:false)
      func send(_ s: LiveCommand.Step) async throws { try validateMemberNumberReply(await api.raw(s.path,body:s.object,headers:[s.keyHeader:s.key]).0,step:s) }
      do { _ = try await LiveCommandRunner.advance(work,send:send,checkpoint:{persisted = try JSONEncoder().encode($0)});preconditionFailure("unknown lost") } catch {}
      check(try JSONDecoder().decode(LiveCommand.self,from:persisted) == work,"lost number-policy reply keeps original payload/key \(version)")
      let done = try await LiveCommandRunner.advance(JSONDecoder().decode(LiveCommand.self,from:persisted),send:send,checkpoint:{persisted = try JSONEncoder().encode($0)})
      check(done.completedSteps == 1 && commits == 1 && sends == 2,"real adapter resumes original number-policy receipt \(version)")
      _ = try await LiveCommandRunner.advance(done,send:send,checkpoint:{_ in})
      check(sends == 2,"completed number update not retried after readback failure \(version)")
      let text = step.memberNumberProof!["confirmation"] as! String
      for value in ["10000001","ABCDEFGHJKLMNPQRSTUVWXYZ","最长前缀 4","不补零","已发会员号保持不变"] { check(text.contains(value),"confirmation shows \(value) \(version)") }
    }
    for (key,value) in [("width","3"),("width","13"),("width","8.0"),("startNumber","100000000"),("startNumber","1e6"),("maximumPrefixLength","5"),("alphabet","AAB"),("alphabet","abC")] {
      var input = fields;input[key] = value
      check(bad { _ = try board().command(actor:user,fields:input,padZero:true,reason:"真实依据") },"invalid member-number field \(key)=\(value)")
    }
    var narrow = fields;narrow["width"] = "4";narrow["startNumber"] = "1000";narrow["maximumPrefixLength"] = "3"
    check(bad { _ = try board().command(actor:user,fields:narrow,padZero:true,reason:"真实依据") },"prefix must leave two numeric digits")
    var max = fields;max["width"] = "12";max["startNumber"] = "999999999999"
    check(try walletInteger((board().command(actor:user,fields:max,padZero:true,reason:"真实依据").steps[0].object["policy"] as! [String:Any])["startNumber"]) == 999999999999,"maximum number remains exact integer")
    var denied = auth;denied["deniedPermissions"] = ["member.card.manage"]
    check(bad { _ = try board(as:actor(denied)) },"revoked read role cannot load member number")
    check(bad { _ = try board().command(actor:actor(denied),fields:fields,padZero:true,reason:"真实依据") },"revoked writer cannot change number policy")
    check(bad { _ = try board(enabled:false).command(actor:user,fields:fields,padZero:true,reason:"真实依据") },"legacy non-durable number endpoint read only")
    check(bad { _ = try board(enabled:1) },"strict boolean capability for number policy")
    var boolNumber = policy;boolNumber["width"] = true
    check(bad { _ = try MemberNumberPolicy(boolNumber) },"boolean not a number policy integer")
    let now = ISO8601DateFormatter().date(from:"2026-10-05T00:00:00Z")!
    func base(_ status: String = "published", version: Int = 1) -> [String:Any] { ["id":id(version+10),"status":status,"version":version,"effectiveFrom":"2026-10-01T00:00:00Z","effectiveUntil":NSNull(),"reason":"独立审阅已发布版本"] }
    var point = base();point.merge(["pointsNumerator":1,"pointsDenominatorMinor":100,"growthNumerator":2,"growthDenominatorMinor":150,"pointsValidityMonths":12,"roundingMode":"nearest"]){_,v in v}
    var future = point;future["id"] = id(12);future["version"] = 2;future["effectiveFrom"] = "2098-01-01T00:00:00Z"
    var old = point;old["id"] = id(13);old["version"] = 3;old["status"] = "draft"
    var tier = base();tier.merge(["evaluationWindowMonths":12,"tierPeriodMonths":12,"downgradeGraceDays":7,"silverUpgradeGrowth":100,"silverRetainGrowth":80,"goldUpgradeGrowth":200,"goldRetainGrowth":180,"silverPointsMultiplierNumerator":3,"silverPointsMultiplierDenominator":2,"goldPointsMultiplierNumerator":2,"goldPointsMultiplierDenominator":1]){_,v in v}
    var benefits = base();benefits["tierPolicyVersion"] = 1;benefits["rules"] = [["benefitName":"欢迎小食","eligibleTier":"silver","enabled":true,"inheritToHigherTiers":true,"grantOnEntry":true,"grantOnRetention":false,"quantity":2,"validityDays":30,"revocationPolicy":"protect_until_expiry"]]
    let item: [String:Any] = ["publicId":"RDI-001","catalogStatus":"published","catalogVersion":1,"name":"招牌小食","status":"active","minimumTier":"member","pointsRequired":100,"availableFrom":"2026-10-01T00:00:00Z","availableUntil":NSNull(),"totalInventory":0,"dailyInventory":NSNull(),"memberDailyLimit":1,"memberRolling30DayLimit":2,"memberLifetimeLimit":NSNull(),"requiresTableSession":true,"requiresEmployeeFulfillment":true,"cancellationAllowedBeforeFulfillment":true,"fulfillmentTimeoutMinutes":30,"restoreExpiredPointsDays":7]
    let pointData = try bytes(["data":[point,future,old]]),tierData = try bytes(["data":[tier]]),benefitData = try bytes(["data":["policies":[benefits]]]),catalogData = try bytes(["data":["items":[item],"control":["state":"paused","reason":"现场履约核对"]]])
    let overview = try MembershipOverview(points:pointData,tiers:tierData,benefits:benefitData,catalog:catalogData,actor:user)
    check(overview.points.count == 2 && overview.points[0].id == id(12),"overview only published versions newest first")
    check(membershipOverviewEffective(overview.points[0],now:now) == "已发布 · 待生效","published future policy not mislabeled active")
    check(membershipOverviewEffective(overview.points[1],now:now) == "生效时段内","current published period identified")
    var past = point;past["effectiveUntil"] = "2026-10-05T00:00:00Z"
    check(membershipOverviewEffective(MembershipOverviewRecord(object:past),now:now) == "历史已结束","end boundary exclusive")
    check(overview.controlState == "paused","redemption runtime pause remains visible")
    let pointsText = try membershipOverviewSummary(overview.points[1],section:"points")
    for value in ["1.00元","1.50元","2 成长值","12个月","四舍五入"] { check(pointsText.contains(value),"published points overview shows "+value) }
    check(try membershipOverviewSummary(overview.tiers[0],section:"tiers").contains("3 / 2"),"tier rational multiplier not rounded")
    let benefitText = try membershipOverviewSummary(overview.benefits[0],section:"benefits")
    for value in ["欢迎小食","2份","30天","进入等级","保护到到期"] { check(benefitText.contains(value),"published benefit details show "+value) }
    let catalogText = try membershipOverviewSummary(overview.catalog[0],section:"catalog")
    for value in ["总库存上限：0","每日库存上限：不限","滚动30天：2","员工确认交付","交付前允许取消"] { check(catalogText.contains(value),"redemption details show "+value) }
    denied = auth;denied["deniedPermissions"] = ["loyalty.policy.view"]
    check(bad { _ = try MembershipOverview(points:pointData,tiers:tierData,benefits:benefitData,catalog:catalogData,actor:actor(denied)) },"overview current view permission required")
    print("Member number and overview tests passed (\(count) assertions; 3 version recovery cases)")
  }
}
