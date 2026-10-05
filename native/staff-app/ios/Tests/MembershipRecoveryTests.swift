import Foundation
@main struct MembershipRecoveryTests {
  @MainActor static func main() async throws {
    var count = 0
    func check(_ condition: Bool, _ name: String) { precondition(condition,name);count += 1;print("PASS "+name) }
    func bad(_ fn: () throws -> Void) -> Bool { do { try fn();return false } catch { return true } }
    func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject:value,options:.sortedKeys) }
    func id(_ n: Int) -> String { String(format:"00000000-0000-4000-8000-%012d",n) }
    let auth: [String:Any] = ["session":["id":"recovery-session","employeeId":id(1),"expiresAt":"2099-01-01T00:00:00Z","onlineLeaseUntil":"2099-01-01T00:00:00Z"],"employee":["id":id(1),"code":"staff","displayName":"会员核验员","roleCodes":["MANAGER"]],"permissions":membershipRecoveryPermissions,"deniedPermissions":[]]
    func actor(_ value: [String:Any] = auth) throws -> StaffIdentity { try JSONDecoder().decode(StaffIdentity.self,from:bytes(value)) }
    let user = try actor(), fingerprint = String(repeating:"a",count:64), phone = "+8613900000012", member = "MEMBER_0012", reason = "已核对原始登记凭据及本人身份"
    func record(_ status: String = "manual_review", selector: String? = nil) -> [String:Any] {
      ["casePublicId":"MRC-001","nativeVersion":fingerprint,"status":status,"candidateCount":2,"maskedPhone":"+86 139****12","maskedMemberNo":status == "manual_review" ? NSNull() : "MEMB****12" as Any,"selectedCandidatePublicId":status == "manual_review" ? NSNull() : "MRCAND-001" as Any,"selectedByEmployeeId":status == "manual_review" ? NSNull() : (selector ?? id(2)) as Any,"approvedByEmployeeId":NSNull(),"createdAt":"2026-10-05T00:00:00Z","updatedAt":"2026-10-05T01:00:00Z"]
    }
    func board(_ status: String = "manual_review", rows: [[String:Any]]? = nil, history: Bool = false, enabled: Any = true, as who: StaffIdentity? = nil) throws -> MembershipRecoveryBoard {
      try MembershipRecoveryBoard(data:bytes(["data":["employeeId":id(1),"protocol":1,"durableCommands":enabled,"history":history,"rows":rows ?? [record(status)],"next":NSNull()]]),actor:who ?? user,history:history)
    }
    let manual = try board(),pending = try board("pending_review")
    let candidateRaw: [String:Any] = ["candidatePublicId":"MRCAND-001","maskedMemberNo":"MEMB****12","maskedPhone":"+86 139****12","joinedDate":"2020-05-01"]
    func options(_ input: [String:Any]? = nil, version: String? = nil, as who: StaffIdentity? = nil) throws -> MembershipRecoveryCandidates {
      try MembershipRecoveryCandidates(data:bytes(["data":["employeeId":id(1),"protocol":1,"durableCommands":true,"casePublicId":"MRC-001","caseVersion":version ?? fingerprint,"rows":[input ?? candidateRaw],"next":NSNull()]]),actor:who ?? user,row:manual.rows[0])
    }
    let selected = try options().rows[0]
    typealias Case = (String,MembershipRecoveryBoard,RecoveryRecord?,RecoveryRecord?)
    let cases: [Case] = [("contact",manual,nil,nil),("select",manual,manual.rows[0],selected),("approve",pending,pending.rows[0],nil),("reject",manual,manual.rows[0],nil),("reject",pending,pending.rows[0],nil)]
    let fields = ["memberNo":member,"phone":phone,"reason":reason]
    func command(_ c: Case, as who: StaffIdentity? = nil) throws -> LiveCommand { try c.1.command(actor:who ?? user,action:c.0,row:c.2,candidate:c.3,fields:fields,verified:true) }
    func response(_ c: Case, _ work: LiveCommand, body: [String:Any], replayed: Bool = false) -> [String:Any] {
      var accepted = body;accepted.removeValue(forKey:"phone")
      var row: [String:Any]
      if c.0 == "contact" { row = ["memberNo":member,"maskedPhone":"+86 139****12","verifiedAt":"2026-10-05T00:00:00Z"] }
      else {
        row = record(c.0 == "select" ? "pending_review" : c.0 == "approve" ? "executed" : "rejected")
        row["nativeVersion"] = String(repeating:"b",count:64)
        if c.0 == "select" { row["selectedByEmployeeId"] = id(1) }
        if c.0 == "approve" { row["approvedByEmployeeId"] = id(1) }
      }
      return ["meta":["protocol":1,"replayed":replayed],"data":["employeeId":id(1),"action":c.0,"requestKey":work.steps[0].key,"accepted":accepted,"row":row]]
    }
    for c in cases {
      let original = try command(c),originalBody = original.steps[0].object
      var vault: [String:String] = [:], stores = 0
      let work = try secureMembershipRecoveryCommand(original,store:{key,value in stores += 1;vault[key] = value}),step = work.steps[0]
      let payloadKey = step.membershipRecoveryProof!["payloadKey"] as! String
      check(payloadKey == "membership-recovery-"+original.id && stores == 1,c.0+" dedicated original safety slot")
      check(work.id == original.id && step.key == original.steps[0].key && step.path == original.steps[0].path,c.0+" secure wrapper preserves original transaction chain")
      check(step.object.isEmpty && step.body == Data("{}".utf8),c.0+" pending disk contains empty body")
      let recoveryText = String(data:step.recoveryBody!,encoding:.utf8)!
      check(!recoveryText.contains(phone) && !recoveryText.contains(member) && !recoveryText.contains(reason) && !recoveryText.contains("confirmation"),c.0+" pending proof contains no raw contact or reason")
      let encoded = try JSONEncoder().encode(work),restored = try JSONDecoder().decode(LiveCommand.self,from:encoded)
      check(restored == work,c.0+" exact secured command survives process death")
      let body = try membershipRecoveryRequestBody(restored,step:restored.steps[0],read:{vault[$0]!})
      check(membershipEqual(body,originalBody),c.0+" original sensitive body restored exactly")
      check(bad { _ = try secureMembershipRecoveryCommand(work,store:{_,_ in preconditionFailure("should not overwrite slot")}) },c.0+" already secured request cannot be rewrapped")
      check(bad { _ = try membershipRecoveryRequestBody(work,step:step,read:{_ in throw StaffAPIError.invalid}) },c.0+" missing or locked safety slot fails closed")
      check(bad { _ = try membershipRecoveryRequestBody(work,step:step,read:{_ in "{}"}) },c.0+" altered sensitive payload digest fails closed")
      var denied = auth;denied["deniedPermissions"] = [work.permission]
      check(bad { _ = try command(c,as:actor(denied)) },c.0+" current permission denial blocks new action")
      try validateMembershipRecoveryReply(bytes(response(c,work,body:body)),step:step,body:body);check(true,c.0+" original receipt accepted")
      for key in ["employeeId","action","requestKey","accepted"] {
        var r = response(c,work,body:body);var d = r["data"] as! [String:Any];d[key] = "wrong";r["data"] = d
        check(bad { try validateMembershipRecoveryReply(bytes(r),step:step,body:body) },c.0+" wrong receipt "+key+" rejected")
      }
      var r = response(c,work,body:body);r["meta"] = ["protocol":1,"replayed":1]
      check(bad { try validateMembershipRecoveryReply(bytes(r),step:step,body:body) },c.0+" exact boolean receipt required")
      let keys = c.0 == "contact" ? ["memberNo","maskedPhone","verifiedAt"] : c.0 == "select" ? ["casePublicId","nativeVersion","status","selectedCandidatePublicId","selectedByEmployeeId"] : c.0 == "approve" ? ["casePublicId","status","approvedByEmployeeId","selectedCandidatePublicId","selectedByEmployeeId"] : ["casePublicId","status"]
      for key in keys {
        var r = response(c,work,body:body);var d = r["data"] as! [String:Any];var row = d["row"] as! [String:Any];row[key] = "wrong";d["row"] = row;r["data"] = d
        check(bad { try validateMembershipRecoveryReply(bytes(r),step:step,body:body) },c.0+" wrong original outcome "+key+" rejected")
      }
      var persisted = encoded,commits = 0,sends = 0
      let api = StaffAPI(transport:{request in
        if request.url?.path == "/api/auth/login" { return (try bytes(["data":auth]),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!) }
        sends += 1
        guard request.url?.path == step.path,request.httpMethod == "POST",request.value(forHTTPHeaderField:"idempotency-key") == step.key,request.value(forHTTPHeaderField:"x-mbox-staff-employee-id") == id(1),let bytes = request.httpBody,
          NSDictionary(dictionary:try JSONSerialization.jsonObject(with:bytes) as! [String:Any]).isEqual(to:body) else { throw StaffAPIError.invalid }
        if commits == 0 { commits += 1;throw URLError(.timedOut) }
        return (try Foundation.JSONSerialization.data(withJSONObject:response(c,work,body:body,replayed:true)),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
      })
      _ = try await api.login(code:"staff",pin:"1234",switching:false)
      func send(_ s: LiveCommand.Step) async throws {
        let original = try membershipRecoveryRequestBody(work,step:s,read:{vault[$0]!})
        try validateMembershipRecoveryReply(await api.raw(s.path,body:original,headers:[s.keyHeader:s.key]).0,step:s,body:original)
      }
      do { _ = try await LiveCommandRunner.advance(work,send:send,checkpoint:{persisted = try JSONEncoder().encode($0)});preconditionFailure("unknown discarded") } catch {}
      check(try JSONDecoder().decode(LiveCommand.self,from:persisted) == work && vault[payloadKey] != nil,c.0+" lost success preserves safety slot and original command")
      let done = try await LiveCommandRunner.advance(JSONDecoder().decode(LiveCommand.self,from:persisted),send:send,checkpoint:{persisted = try JSONEncoder().encode($0)})
      check(done.completedSteps == 1 && commits == 1 && sends == 2,c.0+" actual adapter recovers one committed operation")
      _ = try await LiveCommandRunner.advance(done,send:send,checkpoint:{_ in})
      check(sends == 2,c.0+" failed refresh cannot repeat confirmed merge or contact")
      for mutation in ["id","employee","permission","path","key","header","payloadKey","digest","body","proofActor"] {
        var proof = step.membershipRecoveryProof!
        if mutation == "payloadKey" { proof["payloadKey"] = "membership-recovery-"+id(99) }
        if mutation == "digest" { proof["payloadSHA256"] = String(repeating:"0",count:64) }
        if mutation == "proofActor" { proof["employeeId"] = id(99) }
        let alteredStep = LiveCommand.Step(path:mutation == "path" ? membershipRecoveryRoot+"/approve"+"/extra" : step.path,body:mutation == "body" ? Data("{\"reason\":\"leak\"}".utf8) : step.body,keyHeader:mutation == "header" ? "other-key" : step.keyHeader,key:mutation == "key" ? "native-business-"+id(99) : step.key,recoveryBody:try bytes(["membershipRecovery":proof]))
        let altered = LiveCommand(id:mutation == "id" ? id(99) : work.id,employeeID:mutation == "employee" ? id(99) : work.employeeID,title:work.title,permission:mutation == "permission" ? "customer.view" : work.permission,steps:[alteredStep])
        var readCalled = false
        check(bad { _ = try membershipRecoveryRequestBody(altered,step:alteredStep,read:{key in readCalled = true;return vault[key] ?? "{}"}) },c.0+" tampered original "+mutation+" refused")
        if mutation != "digest" { check(!readCalled,c.0+" rejects "+mutation+" before reading private slot") }
      }
    }
    check(bad { _ = try secureMembershipRecoveryCommand(command(cases[0]),store:{_,_ in throw StaffAPIError.invalid}) },"safety-slot write failure prevents submission")
    check(bad { _ = try manual.command(actor:user,action:"contact",fields:fields,verified:false) },"manual verification checkbox mandatory")
    for badPhone in ["13900000012","+013900000012","+8612","+8613900000012x"] {
      var fields = fields;fields["phone"] = badPhone
      check(bad { _ = try manual.command(actor:user,action:"contact",fields:fields,verified:true) },"malformed international phone refused")
    }
    let own = try board("pending_review",rows:[record("pending_review",selector:id(1))])
    check(bad { _ = try own.command(actor:user,action:"approve",row:own.rows[0],fields:fields,verified:true) },"verifier cannot independently approve own candidate")
    check(bad { _ = try pending.command(actor:user,action:"select",row:pending.rows[0],candidate:selected,fields:fields,verified:true) },"cannot replace already selected candidate")
    var stale = selected.object;stale["caseVersion"] = String(repeating:"b",count:64)
    check(bad { _ = try manual.command(actor:user,action:"select",row:manual.rows[0],candidate:RecoveryRecord(stale),fields:fields,verified:true) },"stale candidate version cannot be selected")
    stale = selected.object;stale["sourceCasePublicId"] = "MRC-OTHER"
    check(bad { _ = try manual.command(actor:user,action:"select",row:manual.rows[0],candidate:RecoveryRecord(stale),fields:fields,verified:true) },"another case candidate cannot be selected")
    check(bad { _ = try options(version:String(repeating:"b",count:64)) },"candidate page rejects changed original case version")
    var unmasked = candidateRaw;unmasked["maskedPhone"] = phone
    check(bad { _ = try options(unmasked) },"unexpected raw phone never reaches candidate UI")
    unmasked = candidateRaw;unmasked["maskedMemberNo"] = member
    check(bad { _ = try options(unmasked) },"unexpected full member number never reaches candidate UI")
    var denied = auth;denied["deniedPermissions"] = membershipRecoveryPermissions
    check(bad { _ = try board(as:actor(denied)) },"no current recovery role cannot load private queue")
    check(bad { _ = try board(enabled:1) },"strict boolean durable capability")
    check(bad { _ = try board(enabled:false).command(actor:user,action:"contact",fields:fields,verified:true) },"old non-durable endpoint read only")
    check(bad { _ = try board(rows:[record(),record()]) },"duplicate recovery cases rejected")
    for cursor in ["../customer","x?history=true","a"] { check(bad { _ = try MembershipRecoveryBoard.query(cursor:cursor) },"unsafe case cursor rejected") }
    check(try MembershipRecoveryCandidates.query(row:manual.rows[0]).contains("expectedVersion="+fingerprint),"candidate query binds original case version")
    print("Membership recovery tests passed (\(count) assertions; \(cases.count) action/status recovery paths)")
  }
}
