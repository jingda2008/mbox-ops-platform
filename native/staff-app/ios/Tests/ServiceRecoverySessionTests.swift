import Foundation
@main struct ServiceRecoverySessionTests {
 @MainActor static func main()async throws {
  var checks=0
  func check(_ v:Bool,_ label:String){precondition(v,label);checks+=1;print("PASS "+label)}
  func id(_ n:Int)->String{String(format:"00000000-0000-4000-8000-%012d",n)}
  func identity(_ employee:String)->[String:Any]{["session":["id":employee,"employeeId":employee,"expiresAt":"2099-01-01T00:00:00Z","onlineLeaseUntil":"2099-01-01T00:00:00Z"],"employee":["id":employee,"code":employee==id(1) ? "original":"manager","displayName":"测试员工","roleCodes":["OWNER"]],"permissions":["service.execute","service.manage"],"deniedPermissions":[]]}
  let originalID=id(1),managerID=id(2),commandID=id(3),taskID=id(4),sessionID=id(5),key="native-business-"+id(3)
  let originalBody:[String:Any]=["employeeId":originalID,"tableSessionId":sessionID,"taskType":"guest.water","expectedStatus":"pending","expectedPriority":"normal","expectedAssignedEmployeeId":NSNull(),"note":"原请求已核对"]
  let proof:[String:Any]=["taskId":taskID,"tableSessionId":sessionID,"taskType":"guest.water","action":"complete","status":"completed"]
  let command=LiveCommand(id:commandID,employeeID:originalID,title:"原服务请求",permission:"service.execute",steps:[.init(path:"/api/native-service-tasks/"+taskID+"/complete",body:try showBytes(originalBody),keyHeader:"idempotency-key",key:key,recoveryBody:try showBytes(["service":proof]))])
  let canonical:[String:Any]=["taskId":taskID,"action":"complete","employeeId":originalID,"session":sessionID,"taskType":"guest.water","expectedStatus":"pending","expectedPriority":"normal","expectedAssigned":NSNull(),"note":"原请求已核对","assigned":NSNull(),"priority":NSNull()]
  let data:[String:Any]=["disposition":"withdrawn","originalKey":key,"taskId":taskID,"action":"complete","employeeId":originalID,"original":canonical,"receipt":NSNull(),"resolution":["disposition":"withdrawn","originalKey":key,"taskId":taskID,"action":"complete","employeeId":originalID,"supervisorId":managerID,"resolvedAt":"2026-10-05T12:00:00Z"]]
  var mode="timeout",sends=0,logouts=0,delay:CheckedContinuation<Void,Never>?,lastCookie=""
  let api=StaffAPI(transport:{request in
   let path=request.url!.path
   func reply(_ value:Any,status:Int=200,cookie:String?=nil)throws->(Data,HTTPURLResponse){(try showBytes(value),HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:cookie.map{["Set-Cookie":$0]})!)}
   if path=="/api/auth/device-access" {return try reply(["data":["businessDate":"2026-10-05","expiresAt":"2099-01-01T00:00:00Z"]],cookie:"__Host-mbox_device_lease=lease-only; Path=/; Secure; HttpOnly; Max-Age=86400")}
   if path=="/api/auth/login" {
    let manager=try showObject(request.httpBody!)["employeeCode"] as? String=="manager"
    if manager && mode=="login-denied" {return try reply(["error":["code":"AUTH_REQUIRED","message":"主管身份已过期"]],status:401)}
    return try reply(["data":identity(manager ? managerID:originalID)],cookie:"__Host-mbox_staff_session="+(manager ? "manager-cookie":"original-cookie")+"; Path=/; Secure; HttpOnly; Max-Age=86400")
   }
   if path=="/api/native-service-recovery" {
    sends+=1
    guard request.value(forHTTPHeaderField:"x-mbox-staff-employee-id")==managerID,try showObject(request.httpBody!)["originalKey"] as? String==key else{throw StaffAPIError.invalid}
    if mode=="timeout" {throw URLError(.timedOut)}
    if mode=="late" {await withCheckedContinuation{delay=$0}}
    if mode=="malformed" {var bad=data;bad["originalKey"]="wrong";return try reply(["data":bad,"meta":["replayed":true]])}
    return try reply(["data":data,"meta":["replayed":true]])
   }
   if path=="/api/auth/logout" {logouts+=1;throw URLError(.timedOut)}
   lastCookie=request.value(forHTTPHeaderField:"Cookie") ?? ""
   return try reply(["data":[:]])
  })
  _ = try await api.grant(credential:"fixture-only",deviceKey:"fixture-only-device")
  let directory=FileManager.default.temporaryDirectory.appendingPathComponent("service-recovery-"+UUID().uuidString)
  try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true);defer{try? FileManager.default.removeItem(at:directory)}
  let pending=directory.appendingPathComponent("pending.json")
  let model=AppModel(api:api,loadPersistedState:false,trainingAllowed:false,livePendingURL:pending)
  model.identity=try await api.login(code:"original",pin:"1234",switching:false)
  model.livePending=command;let bytes=try JSONEncoder().encode(command);try bytes.write(to:pending)
  let version=model.workspaceVersion
  func run()async{await model.resolveServicePending(command:command,login:"manager",pin:"5678",reason:"原员工无法到场核对")}
  await run()
  let retained = try Data(contentsOf:pending)
  check(model.livePending==command && retained==bytes && !model.busy,"AppModel timeout preserves exact original pending file")
  check(model.identity?.employee.id==originalID && api.identity?.employee.id==originalID && logouts==1,"temporary logout failure leaves original session untouched")
  mode="login-denied";let before=sends;await run()
  check(sends==before && model.livePending==command && model.identity?.employee.id==originalID && api.identity?.employee.id==originalID,"temporary login 401 cannot clear original workspace or pending")
  mode="malformed";await run();check(model.livePending==command && FileManager.default.fileExists(atPath:pending.path),"wrong receipt cannot clear pending")
  mode="late";let work=Task{await run()}
  for _ in 0..<1000{if delay != nil{break};await Task.yield()}
  check(delay != nil,"controlled recovery response reaches late-response boundary")
  model.workspaceVersion+=1;delay?.resume();delay=nil;await work.value
  check(model.livePending==command && FileManager.default.fileExists(atPath:pending.path),"late success after workspace change keeps pending")
  mode="normal";try FileManager.default.removeItem(at:pending);await run()
  check(model.livePending==command,"local checkpoint deletion failure does not release business lock")
  try bytes.write(to:pending);await run()
  check(model.livePending==nil && !FileManager.default.fileExists(atPath:pending.path) && model.workspaceVersion>version && model.message.contains("封存"),"validated durable withdrawal removes only original pending and advances workspace")
  _ = try await api.raw("/api/probe-original")
  check(lastCookie.contains("original-cookie") && !lastCookie.contains("manager-cookie") && model.identity?.employee.id==originalID,"successful supervisor closure preserves original API cookie and actor")
  let after=sends;await run();check(sends==after,"stale sheet cannot resolve a different or absent pending request")
  print("Service recovery AppModel: \(checks) passed")
 }
}
