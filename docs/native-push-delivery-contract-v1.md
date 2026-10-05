# Native push contract v1 — frozen 2026-10-05

Root批准原则；main核实9ea632deb1a56ac1ec21b67ddb020f60edcf897b，分支feat/native-push-ios-parity-20261005。迁移261由web_visual独占；所有server共享整合也归web_visual。任何字段变更须先同步root/双端负责人。文档冻结不表示代码/平台/真机已通过。

## 1. 通用协议

- Prefix `/api/native/push`。JSON业务外壳为`{data:...,meta?:...}`。普通接口必须使用当前员工session cookie、`x-mbox-staff-session-id`、`x-mbox-staff-employee-id`三者一致；employee/session/tenant/store/device lease由服务器认证派生，不接受body自报。服务权限至少一个service.view/service.execute/service.manage/complaint.handle，按当前有效权限重验。
- 唯一例外是下述revoke-capability，仅授予指定安装版本的撤销能力，不要求旧员工cookie；不能查询或恢复注册。
- 所有响应`Cache-Control: private, no-store`；普通接口无效会话401 AUTH_REQUIRED、缺权限403 PUSH_FORBIDDEN；不同受信设备查询安装或其他员工/绑定查询通知404 PUSH_NOT_FOUND，不泄露存在性。
- `installationId`为每个App安装生成的稳定UUID，安全持久化，重装新建。服务端将其绑定到当前有效device lease的deviceKeyHash，不相信UUID自身是设备证明。相同受信设备新会话可重新绑定，不同设备不能接管已存在installation。
- 可重放写接口使用`Idempotency-Key: native-push-<lowercase UUID>`；整个header值就是`requestKey`。客户端写前原子保存完整原body/key及owner到独立push pending槽；不占用财务/库存未决队列，不阻止经营操作。token/secret不得落普通文件/日志。
- revision是0..2^53-1整数；0只用于未存在安装的首次创建，实际revision从1开始。GET状态后CAS。成功同键重放不再次加revision；同键不同内容409 PUSH_RECEIPT_CONFLICT（不得当原请求未提交）。同key的fingerprint绑定当前employee/session/设备与body内token/secret的hash，receipt不含明文。新会话不重放旧会话注册，先GET再用新key和新secret重新绑定。

## 2. 能力与安装状态

`GET /capabilities`（普通认证，disabled时仍可读取）：

```json
{"data":{"protocol":1,"employeeId":"uuid","staffSessionId":"uuid","enabled":false,"reasonCode":"PUSH_DISABLED","platforms":{"ios":{"provider":"apns","configured":false,"environment":null},"android":{"provider":null,"configured":false,"reasonCode":"PROVIDER_NOT_SELECTED"}}}}
```

开启且完整配置APNs后enabled=true、reasonCode=null、ios.configured=true、environment为sandbox或production。Android在v1始终provider=null/configured=false，不伪造注册或选SDK。

`GET /installations/:installationId`：

```json
{"data":{"protocol":1,"employeeId":"current employee uuid","staffSessionId":"current session uuid","installation":{"installationId":"uuid","revision":1,"status":"active","boundToCurrentSession":true,"expiresAt":"ISO8601","lastRequestKey":"native-push-uuid"}}}
```

status=`active|revoked|invalid_token|expired`；expiresAt为注册有效截止（不超过staff session/device lease/daily credential有效期）；后台不要求onlineLeaseUntil。不存在404 PUSH_NOT_FOUND。同受信设备但先前员工/会话绑定可读revision/status，boundToCurrentSession=false且lastRequestKey=null，顶层身份始终是当前请求身份，绝不回传前员工身份。enabled=false时仍允许查询/撤销已有安装，注册才拒绝。

## 3. 注册/轮换

`PUT /installations/:installationId`，原Idempotency-Key：

```json
{"expectedRevision":0,"platform":"ios","provider":"apns","token":"lowercase hex device token","permission":"authorized","appVersion":"0.2.0","revocationSecret":"32-random-bytes-base64url-no-padding"}
```

- body严格以上7字段；permission=`authorized|provisional`；token为偶数字符的hex，32..512字符（接受系统可变长度，统一小写）；appVersion非空且≤64字符；secret必须是密码学随机256bit、canonical unpadded base64url（43字符、解码32bytes），由客户端在持久化原请求前生成。客户端不得从UUID/设备ID派生secret。
- 真实SDK回调提供token；topic/environment由server配置绑定，不由HTTP body选择。Android v1不调用PUT，若提交platform/android或provider未知，返回400 PUSH_PROVIDER_UNSUPPORTED/not_committed。
- 每次创建/轮换/新会话绑定生成新secret并递增revision。原key重试必须保留原secret。旧revision秘密不能撤销新revision。禁用后重新启用也须新secret；server拒绝沿用原secret创建新revision。
- 当前有效session+deviceLease+凭据、员工active及服务权限在事务中重验。raw token以独立密钥AEAD加密入库；secret仅存hash；fingerprint包含token/secret的hash，不包含明文；审计/响应仅公开标识与revision。

成功首次201、修改/原key重放200：

```json
{"data":{"protocol":1,"employeeId":"uuid","staffSessionId":"uuid","requestKey":"native-push-uuid","installation":{"installationId":"uuid","revision":1,"status":"active","boundToCurrentSession":true,"expiresAt":"ISO8601","lastRequestKey":"native-push-uuid"}},"meta":{"replayed":false}}
```

原回执只证明该次命令，可能已被后续注册取代；客户端不以较旧revision覆盖本地当前绑定，必要时GET。超时/500保留原key/body核对，不能换key重复注册；明确409 PUSH_REVISION_CONFLICT含commitDisposition=not_committed时先GET，再生成下一次新的请求。

## 4. 普通撤销与离线撤销能力

`POST /installations/:installationId/revoke`，普通当前绑定认证、原key，body严格`{"expectedRevision":1}`。仅能撤销当前会话绑定的安装。首次把active/invalid_token改revoked且revision保持1（该版本已失效）；不会新建安装。对已撤销同revision重复调用同key或新key仍返回revoked。回执外壳与PUT相同、meta.replayed准确，lastRequestKey是该命令key；不会泄露token或secret。错revision409 PUSH_REVISION_CONFLICT/not_committed；其他会话绑定404 PUSH_NOT_FOUND。此接口不因推送disabled阻止撤销。

`POST /installations/:installationId/revoke-capability`，body严格：

```json
{"revision":1,"revocationSecret":"original 43-character secret"}
```

- 无旧session要求、无Idempotency-Key要求。只对安装id+revision+secret hash完全匹配的版本置revoked，不产生新revision、不查token、不返回安装状态、不影响后来revision。已撤销重试安全。
- 合法形状请求的回执恒为HTTP200：`{"data":{"protocol":1,"accepted":true}}`，无论不存在/旧revision/错secret/已撤销/刚撤销；accepted仅指受理撤销能力请求，**不能解释成该安装存在或确已撤销**。输入形状非法400 PUSH_INVALID_REQUEST，速率限制429 PUSH_RATE_LIMITED/Retry-After，数据库失败503 PUSH_REVOKE_UNCONFIRMED；后两者保留原槽重试，不报告成功。
- 信任scope来自部署/路由，body不可指定租户门店。secret比较恒时、日志不含body/secret/token。按来源IP统一计数限流，不按“安装存在”分支计数或回不同文案；部署间共享计数由数据库实现。
- 客户端logout/换员工/通知撤权：立即本机禁用并清通知，将原installationId+revision+secret放安全撤销槽；优先普通撤销，失败或已清cookie后用能力端点重试。能力200后移除该撤销槽，旧槽不得覆盖当前新绑定。只保留用于撤销的3字段，无旧cookie/PIN。新登录即使有旧槽也可用新revision/secret注册。若PUT结果未知还未取得revision，保留其原请求/预期revision+1的撤销能力；服务端先持久化同installationId+revision+secretHash的撤销tombstone，再返回200；即使原PUT尚未入库，随后相同secret/目标revision的PUT也会被拒绝。因此能力200后可清除此安全撤销槽；晚到的原PUT回执必须被客户端原owner/本地退出代际检查丢弃，不能恢复已退出界面或重新注册。

## 5. 通知payload、打开及客户端回报

APNs JSON（不得加员工/顾客、桌号、金额、任务正文或认证秘密）：

```json
{"aps":{"alert":{"title":"M-BOX 服务待办","body":"有待处理事项，请打开工作台核对最新状态"},"sound":"default"},"mbox":{"protocol":1,"kind":"service_task","deliveryId":"uuid"}}
```

客户端解析mbox.protocol/kind/deliveryId，冷启动等当前登录恢复和安装绑定就绪后请求`GET /deliveries/:deliveryId/target`：

```json
{"data":{"protocol":1,"employeeId":"uuid","staffSessionId":"uuid","deliveryId":"uuid","installationId":"uuid","revision":1,"kind":"service_task","taskId":"uuid","tableSessionId":"uuid"}}
```

服务器要求该delivery属于当前受信安装/员工/session/revision且仍有效，再按当前权限和源任务原桌次可见规则重验；通知内容不可直接作业务授权。无权404，已过期/任务关闭410 PUSH_TARGET_EXPIRED，显示已失效并可回当前工作台，不能匹配到别桌新任务。GET不完成任务、不记业务acknowledge。

客户端系统收到回调/用户打开后分别用原key调用`POST /deliveries/:deliveryId/observations`，严格body`{"kind":"received"}`或`{"kind":"opened"}`：

```json
{"data":{"protocol":1,"employeeId":"uuid","staffSessionId":"uuid","requestKey":"native-push-uuid","deliveryId":"uuid","kind":"opened","clientReportedReceivedAt":null,"clientReportedOpenedAt":"ISO8601"},"meta":{"replayed":false}}
```

时间取server首次记录时间，同kind不同key也不重置。opened不捏造received回调：iOS系统后台展示可能无应用received回调。仅允许sending/provider_accepted/unknown的原目标；身份/版本/过期门禁同target。记录的是经认证客户端报告，不等于服务端独立证实物理展示；不会修改服务任务状态。

## 6. 错误与恢复

所有错误`{error:{code,message,commitDisposition?}}`，message固定安全中文，不含body/token/secret。401 AUTH_REQUIRED、403 PUSH_FORBIDDEN、404 PUSH_NOT_FOUND；400 PUSH_INVALID_REQUEST或PUSH_PROVIDER_UNSUPPORTED；409 PUSH_REVISION_CONFLICT、PUSH_TOKEN_CONFLICT、PUSH_REGISTRATION_REVOKED（仅前两者not_committed；REGISTRATION_REVOKED不判断原PUT是否曾提交），PUSH_RECEIPT_CONFLICT/PUSH_REQUEST_IN_PROGRESS（保留原请求，不能判断原次失败）；410 PUSH_TARGET_EXPIRED；503 PUSH_NOT_CONFIGURED（新注册明确not_committed）、PUSH_REVOKE_UNCONFIRMED（能力撤销未知）、500 PUSH_REQUEST_UNCONFIRMED（普通写未知）。业务条件错误只有确认事务回滚才能携带not_committed。普通GET状态/撤销仍可在disabled配置下执行。

### 撤销竞态（root已批准，v1必需）

PUT与能力撤销按tenant/store/installationId取得相同稳定事务advisory锁（即使安装row尚不存在）。能力撤销将(revision,secretHash)写入append-only tombstone，再尝试撤销当前匹配绑定，二者同事务；DB失败503且不返回accepted。PUT在原key重放前及新写时检查匹配tombstone，命中409 PUSH_REGISTRATION_REVOKED（不携带commitDisposition，不判断原PUT是否曾提交）；不影响不同secret或后续revision。重复能力请求幂等；未知id/错误secret也保存其各自hash的tombstone，外部回执一致；不能凭能力创建活跃安装、读取状态或覆盖真实secret。匿名scope只由服务器可信门店配置派生，不接受body/headers租户。tombstone本批永久保留，无短TTL清理；未来清理须证明对应旧会话/旧请求不再能被接受。统一来源限流、输入尺寸及密钥格式校验，不能通过空200隐藏数据库写失败。

## 7. 服务器数据与发送语义

迁移261增加installations/events/deliveries/revocation_tombstones四表及受限事件trigger，复合FK、FORCE RLS、runtime最小权限；source service_task_event同原业务事务，失败回滚无推送。v1事件白名单created/assign/priority/backup_assigned/escalated/reminded。仅存在未过期活跃安装时产新事件，不补发历史；安装注册后仍主动读当前待办。事件TTL默认300秒，配置上限900秒；旧安装/旧事件不能因重新登录复活。

每目标状态pending/sending/retry/provider_accepted/unknown/rejected/cancelled/expired；唯一(event,installation,revision)。发送前复核session/员工/准入凭据/权限/精确任务可见范围及原桌次。APNs200仅provider_accepted；明确响应失效token仅使相同revision失效；确定未发或明确可重试响应才retry；写出后断线/超时与重启stale sending为unknown，不换ID盲重发。客户端报告独立时间列，不将accepted改写成伪造delivered。

已受理/网络在途通知无法保证召回；APNs也不保证严格遵守expiration，故通用载荷及打开时重验是必要的最后防线。不存在绝对即刻撤回保证。

## 8. 已核实官方APNs协议及实现约束

2026-10-05读取Apple官方Markdown（原文归档apns-official-docs）：[请求](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)、[token鉴权](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)、[响应错误](https://developer.apple.com/documentation/usernotifications/handling-error-responses-from-apns)。确认HTTP/2+TLS，固定sandbox/production官方端点，ES256的kid/iss/iat，provider JWT刷新间隔20–60分钟（本实现50分钟）；alert类型及topic，稳定UUID apns-id、expiration、priority10，载荷≤4096字节；200仅受理，429/500/503有重试意义，失效token与权限配置错误分开。

使用Node内置http2/crypto，默认disabled；启用时完整配置/密钥格式严格验证，凭据不入日志，不修改生产配置，不选择Android厂商SDK。正常关闭时不发送、不假报配置完成。测试注入传输仅限测试；生产主机固定允许列表并验证TLS。软件测试通过后仍须真实平台配置、签名与手机通知授权/锁屏/省电/换人/撤权/原任务打开验收。

2026-10-05 root复审勘误：PUSH_REGISTRATION_REVOKED不携带commitDisposition；tombstone可能在原注册已提交后生成，只说明该版本能力已撤销，不能宣称原注册未提交。


## 本地验证与交付边界

2026-10-05：迁移261、当前身份/撤销能力、事件/逐目标worker、APNs官方HTTP2适配及标准发布脚本已实现。受限LOGIN真实PostgreSQL25项、协议/配置/既有API与worker96项、密钥只读挂载门禁14项通过；normalized server类型检查/lint通过。完整Linux发布锁待CI，本机macOS缺flock/GNU stat；不能把mock元数据测试当成生产Linux密钥配置验收。

APNs配置拒绝保留投递rejected/failure_code及独立worker channel告警，空批次不清告警；数据库/程序错误仍进入全局worker失败。默认关闭，尚未核验真实Apple账户/授权/签名和真机送达，也没有选定Android供应商。客户端功能仍在独立实现和整包验证，此合同不代表两端全部功能完成。历史rc246及build8保持原交付身份。

匿名撤销tombstone按安装/revision/secret永久保留以覆盖注销先于未知PUT的竞态；已有IP和门店共享限流，但长期存储量仍需运维观察，清理不能破坏原未决请求注销保护。令牌密钥轮换使旧绑定安全撤销并要求客户端重新注册；已在途或被APNs受理的通知无法保证召回，载荷仅通用提示与不透明deliveryId，打开时再次授权。
