import Foundation
@main struct ExperiencePlansTests {
 @MainActor static func main() async throws {
  var count=0
  func check(_ v:Bool,_ label:String){precondition(v,label);count+=1;print("PASS "+label)}
  func rejects(_ body:() throws -> Void)->Bool {do {try body();return false}catch{return true}}
  func id(_ n:Int)->String {String(format:"00000000-0000-4000-8000-%012d",n)}
  let hash=String(repeating:"a",count:64)
  let auth:[String:Any] = ["session":["id":id(1),"employeeId":id(2),"expiresAt":"2099-01-01T00:00:00Z","onlineLeaseUntil":"2099-01-01T00:00:00Z"],"employee":["id":id(2),"code":"manager","displayName":"主管","roleCodes":["OWNER"]],"permissions":experiencePlanPermissions,"deniedPermissions":[]]
  func actor(_ raw:[String:Any]) throws -> StaffIdentity {try JSONDecoder().decode(StaffIdentity.self,from:showBytes(raw))}
  let me=try actor(auth)
  let cue:[String:Any] = ["id":id(5),"sequence_no":1,"trigger_kind":"elapsed","status":"pending","service_task_id":NSNull(),"action_kind":"welcome"]
  let plan:[String:Any] = ["id":id(3),"table_session_id":id(4),"plan_state":"active","session_status":"open","expectedVersion":hash,"plan_version":1,"table_code":"A1","business_date":"2026-10-05","activated_at":ISO8601DateFormatter().string(from:Date().addingTimeInterval(-60)),"cues":[cue],"tasks":[]]
  func board(_ value:[String:Any]=plan,enabled:Bool=true,manage:Bool=true) throws -> ExperiencePlansBoard {try ExperiencePlansBoard(showBytes(["data":["employeeId":id(2),"protocol":1,"durableCommands":enabled,"canManage":manage,"rows":[value],"hasMore":false,"next":NSNull()]]),actor:me)}
  var paused=plan;paused["plan_state"]="paused"
  let active=try board(),stopped=try board(paused)
  let commands=try [("pause",active),("cancel",active),("resume",stopped),("reschedule",active)].map { action,b in try b.command(actor:me,row:b.rows[0],action:action,reason:"顾客现场私密需求",cueID:action=="reschedule" ? id(5):nil,minutes:action=="reschedule" ? 10:nil) }
  for plain in commands {
   var vault:[String:String]=[:]
   let command=try secureExperiencePlanCommand(plain){vault[$0]=$1},step=command.steps[0],disk=try JSONEncoder().encode(command)
   check(!String(decoding:disk,as:UTF8.self).contains("私密") && step.object.isEmpty,"private reason and payload stay outside ordinary pending")
   let restored=try JSONDecoder().decode(LiveCommand.self,from:disk),body=try experiencePlanRequestBody(command,step:step,read:{vault[$0]!})
   check(NSDictionary(dictionary:body).isEqual(to:plain.steps[0].object),"exact original body restores after relaunch")
   var receipt=step.experiencePlanProof!;receipt.removeValue(forKey:"payloadKey");receipt.removeValue(forKey:"payloadAuthentication");receipt["requestKey"]=step.key
   let response:[String:Any]=["data":receipt,"meta":["protocol":1,"replayed":true]]
   let validated=try validateExperiencePlanReply(showBytes(response),step:step)
   check(validated.planID==id(3),"receipt binds original plan and result")
   for field in ["employeeId","planId","tableSessionId","action","state","planVersion","cueId","offsetMinutes","requestKey"] {
    var bad=receipt;bad[field]="wrong";check(rejects{_ = try validateExperiencePlanReply(showBytes(["data":bad,"meta":["protocol":1,"replayed":false]]),step:step)},"reject mismatched receipt "+field)
   }
   var sends=0,commits=0,persisted=disk
   let api=StaffAPI(transport:{request in
    if request.url?.path=="/api/auth/login" {return (try showBytes(["data":auth]),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)}
    sends+=1
    guard request.url?.path==step.path,request.value(forHTTPHeaderField:"idempotency-key")==step.key,request.value(forHTTPHeaderField:"x-mbox-staff-employee-id")==me.employee.id,let bytes=request.httpBody,NSDictionary(dictionary:try showObject(bytes)).isEqual(to:body) else {throw StaffAPIError.invalid}
    if commits==0 {commits=1;throw URLError(.timedOut)}
    return(try showBytes(response),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
   })
   _ = try await api.login(code:"manager",pin:"1234",switching:false)
   func send(_ c:LiveCommand,_ s:LiveCommand.Step) async throws {let b=try experiencePlanRequestBody(c,step:s,read:{vault[$0]!});let(reply,_)=try await api.raw(s.path,body:b,headers:[s.keyHeader:s.key]);_ = try validateExperiencePlanReply(reply,step:s)}
   do {_ = try await LiveCommandRunner.advance(restored,send:{try await send(restored,$0)},checkpoint:{persisted=try JSONEncoder().encode($0)});preconditionFailure()}catch{}
   check(persisted==disk,"unknown write retains original key and body")
   let resumed=try JSONDecoder().decode(LiveCommand.self,from:persisted)
   let done=try await LiveCommandRunner.advance(resumed,send:{try await send(resumed,$0)},checkpoint:{persisted=try JSONEncoder().encode($0)})
   check(done.completedSteps==1 && commits==1 && sends==2,"real StaffAPI injection replay causes one simulated effect")
   _ = try await LiveCommandRunner.advance(done,send:{try await send(done,$0)},checkpoint:{_ in});check(sends==2,"checkpointed operation never resent")
   check(rejects{_ = try experiencePlanRequestBody(command,step:step,read:{_ in throw StaffAPIError.invalid})},"missing vault prevents send")
  }
  for mode in ["completed","planned","cancelled"] {var row=plan;row["plan_state"]=mode;let b=try board(row);check(rejects{_ = try b.command(actor:me,row:b.rows[0],action:"cancel",reason:"现场停止")},"terminal or unpaid plan cannot stop")}
  var closed=plan;closed["session_status"]="closed";let closedBoard=try board(closed);check(rejects{_ = try closedBoard.command(actor:me,row:closedBoard.rows[0],action:"cancel",reason:"现场停止")},"closed table plan cannot mutate")
  var assigned=plan;assigned["tasks"]=[["id":id(6),"status":"pending"]];let assignedBoard=try board(assigned);check(rejects{_ = try assignedBoard.command(actor:me,row:assignedBoard.rows[0],action:"pause",reason:"现场暂停")},"cannot pause dispatched tasks")
  for invalid in [-1,0,241] {check(rejects{_ = try active.command(actor:me,row:active.rows[0],action:"reschedule",reason:"现场调整",cueID:id(5),minutes:invalid)},"past or outside allowed minute rejected")}
  check(rejects{_ = try active.command(actor:me,row:active.rows[0],action:"reschedule",reason:"现场调整",cueID:id(99),minutes:10)},"other plan cue rejected")
  let disabled=try board(enabled:false);check(rejects{_ = try disabled.command(actor:me,row:disabled.rows[0],action:"pause",reason:"现场暂停")},"old/disabled server stays readonly")
  var denied=auth;denied["deniedPermissions"]=["service.manage"];check(rejects{_ = try active.command(actor:actor(denied),row:active.rows[0],action:"cancel",reason:"现场停止")},"denied permission wins")
  check(rejects{_ = try secureExperiencePlanCommand(commands[0]){_,_ in throw StaffAPIError.invalid}},"vault failure blocks command persistence")
  for (from,to) in [("2026-02-30","2026-03-01"),("2026-10-05","2026-10-04"),("2026-01-01","2026-10-05")] {check(rejects{_ = try ExperiencePlanQuery(history:true,from:from,to:to).suffix()},"invalid query rejected")}
  let query=ExperiencePlanQuery(history:true,from:"2026-10-01",to:"2026-10-05")
  check(try query.suffix(next:["beforeDate":"2026-10-02","beforeId":id(3)]).contains("from=2026-10-01"),"pagination retains original query")
  check(rejects{_ = try query.suffix(next:["beforeDate":"2026-10-02"])},"half cursor refused")
  let serviceBody:[String:Any]=["employeeId":id(2),"tableSessionId":id(4),"taskType":"guest.water","expectedStatus":"pending","expectedPriority":"normal","expectedAssignedEmployeeId":NSNull(),"note":"原现场记录"]
  let serviceProof:[String:Any]=["taskId":id(7),"tableSessionId":id(4),"taskType":"guest.water","action":"complete","status":"completed"]
  let keyID=id(8),key="native-business-"+keyID
  let original=LiveCommand(id:keyID,employeeID:id(2),title:"服务任务",permission:"service.execute",steps:[.init(path:"/api/native-service-tasks/"+id(7)+"/complete",body:try showBytes(serviceBody),keyHeader:"idempotency-key",key:key,recoveryBody:try showBytes(["service":serviceProof]))])
  let recovery=try serviceRecoveryRequest(original,reason:"原员工无法现场核对")
  check(recovery["originalKey"] as? String==key,"supervisor uses the original request key")
  let canonical:[String:Any]=["taskId":id(7),"action":"complete","employeeId":id(2),"session":id(4),"taskType":"guest.water","expectedStatus":"pending","expectedPriority":"normal","expectedAssigned":NSNull(),"note":"原现场记录","assigned":NSNull(),"priority":NSNull()]
  var recoveryData:[String:Any]=["disposition":"withdrawn","originalKey":key,"taskId":id(7),"action":"complete","employeeId":id(2),"original":canonical,"receipt":NSNull(),"resolution":["disposition":"withdrawn","originalKey":key,"taskId":id(7),"action":"complete","employeeId":id(2),"supervisorId":id(9),"resolvedAt":"2026-10-05T00:00:00Z"]]
  func validate(_ value:[String:Any]) throws -> String {try validateServiceRecoveryReply(showBytes(["data":value,"meta":["replayed":true]]),command:original,supervisorID:id(10))}
  check(try validate(recoveryData).contains("封存"),"original permanent withdrawal by earlier supervisor replays")
  recoveryData["disposition"]="committed";recoveryData["resolution"]=NSNull();recoveryData["receipt"]=["id":id(7),"tableSessionId":id(4),"taskType":"guest.water","status":"completed"]
  check(try validate(recoveryData).contains("未重复"),"exact retained completed receipt closes recovery")
  for field in ["originalKey","taskId","employeeId","action","disposition"] {var wrong=recoveryData;wrong[field]="wrong";check(rejects{_ = try validate(wrong)},"supervisor rejects mismatched "+field)}
  var other=canonical;other["note"]="另一说明";var wrong=recoveryData;wrong["original"]=other;check(rejects{_ = try validate(wrong)},"full canonical original request must match")
  check(rejects{_ = try validateServiceRecoveryReply(showBytes(["data":recoveryData,"meta":["replayed":true]]),command:original,supervisorID:id(2))},"original employee cannot supervise itself")
  check(rejects{_ = try serviceRecoveryStep(commands[0])},"non-service request cannot use supervisor withdrawal")
  check(rejects{_ = try serviceRecoveryRequest(original,reason:"短")},"recovery requires explicit meaningful reason")
  var managerAuth=auth;managerAuth["session"]=["id":id(20),"employeeId":id(10),"expiresAt":"2099-01-01T00:00:00Z","onlineLeaseUntil":"2099-01-01T00:00:00Z"];managerAuth["employee"]=["id":id(10),"code":"supervisor","displayName":"主管乙","roleCodes":["OWNER"]]
  var originalCookies="",supervisorCookies="",supervisorLoginCookies="",clearedCookies="",recoveryCalls=0,withdrawals=0
  let secureAPI=StaffAPI(transport:{request in
   let path=request.url!.path,headers:[String:String] = ["Content-Type":"application/json"]
   func response(_ value:Any,_ status:Int=200,_ extra:[String:String]=[:])throws->(Data,HTTPURLResponse){(try showBytes(value),HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:headers.merging(extra){_,b in b})!)}
   if path=="/api/auth/device-access" {return try response(["data":["businessDate":"2026-10-05","expiresAt":"2099-01-01T00:00:00Z"]],200,["Set-Cookie":"__Host-mbox_device_lease=device-lease-only; Path=/; Secure; HttpOnly; Max-Age=86400"])}
   if path=="/api/auth/login" {
    let isManager=try showObject(request.httpBody!)["employeeCode"] as? String=="supervisor"
    if isManager {supervisorLoginCookies=request.value(forHTTPHeaderField:"Cookie") ?? ""}
    return try response(["data":isManager ? managerAuth:auth],200,["Set-Cookie":"__Host-mbox_staff_session="+(isManager ? "supervisor-session":"original-session")+"; Path=/; Secure; HttpOnly; Max-Age=86400"])
   }
   if path=="/api/native-service-recovery" {
    recoveryCalls+=1;supervisorCookies=request.value(forHTTPHeaderField:"Cookie") ?? ""
    guard request.value(forHTTPHeaderField:"x-mbox-staff-employee-id")==id(10),NSDictionary(dictionary:try showObject(request.httpBody!)).isEqual(to:recovery) else{throw StaffAPIError.invalid}
    if withdrawals==0 {withdrawals=1;throw URLError(.timedOut)}
    return try response(["data":recoveryData,"meta":["replayed":true]])
   }
   if path=="/api/auth/logout" {throw URLError(.timedOut)}
   if path=="/api/probe-original" {originalCookies=request.value(forHTTPHeaderField:"Cookie") ?? "";check(request.value(forHTTPHeaderField:"x-mbox-staff-employee-id")==id(2),"supervisor does not change original employee header")}
   if path=="/api/probe-cleared" {clearedCookies=request.value(forHTTPHeaderField:"Cookie") ?? "";check(request.value(forHTTPHeaderField:"x-mbox-staff-employee-id")==nil,"temporary identity cleared after logout timeout")}
   return try response(["data":[:]])
  })
  check(rejects{_ = try secureAPI.supervisorClient()},"no device grant cannot open temporary supervisor session")
  _ = try await secureAPI.grant(credential:"fixture-device",deviceKey:"fixture-device-key")
  _ = try await secureAPI.login(code:"manager",pin:"1234",switching:false)
  let temporary=try secureAPI.supervisorClient()
  _ = try await temporary.login(code:"supervisor",pin:"5678",switching:false)
  check(supervisorLoginCookies.contains("device-lease-only") && !supervisorLoginCookies.contains("original-session"),"temporary login copies device lease only")
  do{_ = try await temporary.raw("/api/native-service-recovery",body:recovery);preconditionFailure()}catch{}
  let(reply,_)=try await temporary.raw("/api/native-service-recovery",body:recovery)
  _ = try validateServiceRecoveryReply(reply,command:original,supervisorID:id(10))
  check(recoveryCalls==2 && withdrawals==1,"supervisor timeout replays exact original request once")
  check(supervisorCookies.contains("supervisor-session") && !supervisorCookies.contains("original-session"),"supervisor business request uses isolated cookie")
  do{try await temporary.logout()}catch{}
  temporary.clearTemporarySession()
  _ = try await temporary.raw("/api/probe-cleared")
  _ = try await secureAPI.raw("/api/probe-original")
  check(clearedCookies.isEmpty,"temporary cleanup removes both staff and copied lease cookies")
  check(originalCookies.contains("original-session") && originalCookies.contains("device-lease-only") && !originalCookies.contains("supervisor-session"),"original session and device grant survive temporary logout failure")
  check(rejects{_ = try secureAPI.supervisorClient(now:Date.distantFuture)},"expired lease cannot be copied")
  print("Experience plans and service recovery tests: \(count) passed")
 }
}
