# Android 通知接收与原任务恢复

更新时间：2026-10-05 23:49 CST（此前 build8/build9 记录保留为历史）

本轮接续 AUTH-10 / NATIVE-20261001-32，基于 main 91f84ff5 的独立客户端分支。只修改 Android 客户端及验证文档，已发布 build8、长期签名和 stable 清单保持不变。服务端原生推送协议及迁移由系统集成负责人独占；v1 合同已核对，本文件不替代该合同。

## 能力与边界

- 已有后台 WorkManager 每15分钟定期读取授权服务任务；这不是远程实时推送。本轮本地通知保留原员工、原登录会话、任务和桌次，冷/热启动后重新读取授权业务，再打开原事项，绝不按桌号跳转到后来开台。
- 点击只是导航，不接收、开始或完成服务任务。身份不符、登录会话结束、通知过期、原任务不可见或桌次不符时拒绝跳转；网络未知保留原引用。打开与业务完成分别记录。
- 使用通知独立 Keystore AES-GCM、noBackup 与 AtomicFile；恢复待办和注册撤销分用途存储。损坏/暂不可读不当作空记录，不覆盖旧记录；有界去重及 UI 聚焦后确认消费。
- 原生推送 v1 的 Android provider 明确为空、configured=false。客户端注册/token轮换必须本机拒绝，不制造 token、不调用 iOS APNs 注册、不选择新 SDK 或收费平台。通知界面区分实时通道与本地定期检查。
- 共用 v1 客户端支持能力/安装状态/原投递目标读取和客户端观察/撤销回执的严格核对。退出、换人、撤权立即本机关闭并保留原安装版本的撤销槽；accepted 只代表服务器受理，不等于已送达或已证实注销。

## 验证状态

本轮全量 Android 单元/Robolectric 测试 **395/395 通过（85个测试类，新增85项）**；`lintDebug` 与 `assembleDebug` 通过，`git diff --check`、商业化清单校验通过。命令：`./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`，本机使用 JDK21 / Android SDK36。完整日志保存在本机 outputs/android-notification-full2-20261005.log，测试 XML 位于 android/app/build/test-results/testDebugUnitTest。没有用线上员工账号或真实业务写入做测试。

首轮失败记录保留。回归发现并修复：加密JSON转义膨胀上界、无效新提醒触发旧意图、导航失败误消费、后台晚到核验复用、连续点击后的新意图未续读、写失败时旧磁盘意图复活、同revision旧回执恢复终态绑定、匿名空Cookie头。写失败且进程被杀时，未持久化的新意图无法保证恢复；界面保留保存失败提示，不能宣称跨崩溃恰好一次打开。

新增测试覆盖：领域恢复14、安全存储9、Intent6、实际持久化6、真实AppModel12、协议客户端11、绑定生命周期12、撤销恢复10、Retry-After5。全量测试包含既有库存、支付、订单等回归；这是代码与模拟传输证据，不是门店验收。

## 生命周期和恢复约束

- 同一安装生成稳定 UUID；代际检查拒绝退出前晚到回执，同revision终态不被旧active回执恢复，新revision不继承旧secret。已过期或非active绑定不能产生待打开/待回报引用。
- 撤销槽独立于经营未决队列，保留原installation/revision/secret和requestKey；有限批次重试，429读取Retry-After，服务器能力200仅作为受理回执。前台安全退出后，AppModel后台恢复使用全新匿名客户端，避免原StaffAPI的401或Cookie变更干扰新员工。协议协调器另具普通撤销优先路径并已测试；Android v1无注册入口，不会产生新SDK绑定。
- 通知观察的received/opened分别存储，不捏造实际物理送达；v1没有厂商回调接线，远程载荷解析/目标读取/观察API和恢复槽目前仅是后续提供方适配的共用基础。不能声称远程通知完整链路已经开发完成。
- 退出或撤销不能保证召回已经在途的系统通知；最终以当前身份/权限/原任务复验决定能否打开。后台切回前台必须重新读取，不复用后台核验焦点。
- 已核对合同勘误：`PUSH_REGISTRATION_REVOKED`不保证原PUT从未提交、不依赖其commitDisposition；Android v1本机禁PUT，无换key重发路径。

## 尚未完成的外部条件

Android厂商或聚合推送平台尚未选定并接入，未提供可验证的该项目应用配置和真实SDK token。已向用户询问现有平台名称，不索取聊天明文密钥。这里包含后续提供方适配开发，不能只写成“差真机验收”。本机只连接模拟器，各实际品牌/系统的锁屏、省电、杀进程、换人和送达需独立验证。代码、模拟传输与服务器accepted均不等于物理手机已显示通知。

已分配下一候选版本 `0.4.0-rc.4 / versionCode 9`。Android负责人负责固定源码和既有正式证书构建、逐文件源码清单及APK验证，系统负责人负责合并与统一分发。签名候选的实际结果另存交接回执；分配版本不等于已生成、已发布或已验收。网页版、已发布build8及线上stable保持不变。

## build 9 正式签名候选

冻结构建源码：`8b399dc804ebdcb6869d03cf88236782b783e5e8`。从Git archive导出，构建前后逐一核对313个Git blob，完整清单与独立源码归档留存。相对395项通过的d1c5fb13，Android构建输入仅版本默认值改为9 / 0.4.0-rc.4，业务源码与共享数据未变。本次执行Release编译、lint、真实APK签名/清单和升级元数据验证；没有重复执行已通过的业务全量测试。

- 包：`MBOX-Staff-0.4.0-rc.4-build9-a023dddfac7d.apk`，15542619字节。
- APK SHA256：`a023dddfac7dae1031fcc7f0688d5e7c048b97c3f2ad35b9ec1a038fe5a788e5`。
- 正式证书 SHA256：`05362998aab4266397f069cbcb37049176aa29eb7ab778cc7d55cfb5caa4ccc0`，与build8一致。
- 已核验包名`com.mbox.staff.nativeapp`、versionCode9、versionName0.4.0-rc.4、minimumSDK26/targetSDK36、非debuggable、禁本地演练、stable渠道及zipalign；使用build8本地已验清单证明递增且新URL不可变。
- 本机交接目录：`outputs/android-notification-release-20261005-build9/`，包含APK、local stable、verification、source-manifest和source-and-build-verification；源码归档与私有构建日志另在`outputs/android-notification-build9-20261005/`。

该候选未上传、未安装实体机，build8及线上stable保持原样。最终系统集成SHA可能不同，须逐文件比对其Android输入与本候选source-manifest后才能分发；本记录后续文档提交不改变上述冻结输入。


## build10 冻结后的通用注册与回调恢复续开发

基于 rc248 合并源 `9bf966df`，独立分支 `feat/android-push-lifecycle-20261005`。复核发现此前“剩余全依赖平台配置”的判断过宽：原请求日志、令牌排队、HTTP PUT 边界和回调持久化可以先完成。此分支不更改版本、既有候选 APK、后端合同、网页或 stable 清单。

本轮实现：

- 独立加密 REGISTRATION 记录升级为 v2，保留 v1 绑定和撤销槽；写前保存原身份、本机代次、安装、CAS revision、合同标识、请求键、body、令牌和随机撤销秘密。最新令牌另槽排队，不能覆盖结果未知的原请求；确认后重复 SDK 令牌不会再次注册。
- 首次发送前持久化 attempted 标志。中断后按原请求 GET 核对或 PUT 重放；只有原身份、原安装、目标 revision、原键同时相符的当前 active 绑定才能确认。404、他键、较新版本、超时和损坏回执保留原请求。PUT 回执后再 GET，历史回执不能直接激活当前安装。
- 明确 not_committed 仅能清除没有历史未知发送的首发；已未知后再收到 not_committed 不推定原次失败。429 尊重 Retry-After，其他未知暂停60秒；取消继续传播。退出同时保留已确认版本与未确认目标版本的撤销能力，旧会话不能借新身份重放。
- 提供方无关桥接接收 SDK token、received 和 opened，回调上下文从本机已核实绑定捕获；严格载荷只含协议、kind 和 deliveryId。opened 与观察请求一次原子保存，复用原键，绝不凭打开捏造 received。新 B 保存失败保留最新内存意图和原键、阻断旧 A；写盘恢复后先保存 B 再核对。无效新点击可持久取消旧引用。
- AppModel 已接远程投递 GET → 当前授权任务读取 → 精确 taskId/tableSessionId → UI 呈现 → 独立消费确认，后台返回重新读取，不伪造本地24小时有效期。30秒只限制刚验证的 UI 临时焦点；持久记录没有缓存授权。收到与打开原回报每轮最多4条，独立原键、先GET再POST，429退避、前台网络恢复续读，不调用任务业务写接口。
- 已消费 deliveryId 在当前绑定内安全去重（最多256条，达到容量拒绝新自动打开并保留用户提示）；原始关闭不等于消费。OPEN 安全记录兼容 v1，v2 额外保存跨来源抑制标记，跟本地 pending/consumed 同次原子写；推送库取消失败也不让旧 A 在重启后压过已打开的本地 B。标记只能抑制旧导航，不能授予权限。
- StaffAPI 增加显式 PUT，并保留默认 GET/POST 和认证头；APIRequest 诊断输出脱敏。客户端只有显式安装合约适配器才允许注册，生产没有该适配器；既有 Android 能力读取仍严格要求 provider=null、configured=false。

验证结果：本地全量 Android 单元/Robolectric **544/544 通过（98个测试类，较本分支基线新增86项）**；原请求/回调/实际AppModel采用 StaffAPI 注入传输，未向生产写入测试令牌或业务。更新发布保护16项、商业化清单及历史完整性校验通过。`lintDebug`（0错误、12警告、13提示）与 `assembleDebug` 通过，最终结果见 `outputs/android-push-lifecycle-20261005/full-final2.log`，PR CI以最终head另证；不据此宣称正式发布或实体送达。

### 仍开放的软件与验收

1. 平台确定后冻结 Android provider、token 大小与规则、SDK 权限映射、应用归属、服务端能力/DTO/迁移与发送适配。当前后端严格 ios/apns，不能靠补凭据启用 Android。新增合同接口没有生产实现，也没有通过配置绕过现有门禁。
2. 安装实际 SDK/接收组件并把真实 token/received/opened 接到现有桥接及注册协调器；供应方回调与冷启动 Intent 的来源、权限和恢复时序须按选定合同实现。AppModel 远程打开和观察消费的通用代码现已接线，离线传输验证结果已单独记录，不能当作已接入 SDK 或实际手机显示。
3. 已有本地定期提醒与点击恢复继续可用；它们不能替代远程链路。平台配置、真实SDK、多品牌锁屏/省电/杀进程送达、实际员工业务验收继续分别留证。

供应商采购退货与 iOS 不在本轮范围；这不排除 Android 实时推送的软件工作。build10 由系统负责人按原冻结 APK 单独发布，本分支不会混入该包。

存储限制：在任何存储写失败后立即断电，尚未成功保存的新意图不能承诺跨进程保留；当前进程阻断旧目的地并保留最新引用，界面显示恢复失败。UI 已打开但消费保存失败可能要求再次核对，不能承诺跨崩溃恰好一次。跨来源取消标记不受旧推送库写入成功与否影响，但自身仍须本机安全存储可写。


## 2026-10-06 服务入口政策补修（PR345续修）

独立复审确认：`service.view`仍在但认证响应显式`navigation=[]`时，本地提醒和远程通知都只核查权限，能够绕过已关闭的`/staff/tasks`入口。6个实际AppModel反例在修复前全部失败；这是客户端入口政策缺口，未据此认定后端权限绕过。

新增`canOpenServiceTasks()`统一权限与导航入口判断，保持`canReadService()`的权限语义及原推送绑定。入口未开放时保留原通知；心跳、读取返回及UI消费均复核，关闭再恢复也不能沿用旧焦点。服务页面在任何子弹窗/轮询之前停止渲染，顶部入口与更多/底部共用门禁；服务读取、准备确认和发送前心跳后的原请求恢复同样复核，未发送的原请求继续保留。旧响应省略navigation的兼容语义不变。

冻结build10源码的本地提醒路径同样受影响。系统集成负责人已安排保留原build10包与证据、跳过公开分发，PR345合并后从最终主线另准备0.4.0-rc.6/build11；本分支不改版本/证书、不签包、不部署。以上build10由原包发布的历史计划已被本条后续安排取代，历史证据保留。厂商SDK、Android后端合同及实际多品牌送达仍独立开放。

最终本地验证：**557/557（98类，零失败/跳过）**，较544基线新增13项；服务通知8项覆盖入口关闭、心跳和任务读取中途收窄、较新点击以及恢复重新读取，权限矩阵2项，真实服务读取／已准备确认／心跳收窄后原请求恢复3项。lintDebug 0错误/13警告/13提示及assembleDebug通过，清单历史校验通过，独立审阅通过。证据：`outputs/android-push-lifecycle-20261005/nav-full-final.log`、`nav-test-results/`、`nav-independent-review.md`；修复前6项失败日志保留。PR的准确head CI另验，不据本地通过宣称发布。


## 2026-10-07 最小个推接入（本地候选，未发布）

用户要求“做最小开发”：本轮只有个推基础自有通道，保留既有定期检查，不接各品牌离线 SDK 或新增管理中心。上方未接 Android 合同的描述为历史状态。真实平台凭据、手机送达和正式发布尚未验证，不承诺锁屏、省电或清理进程后实时送达。

- Android 默认构建不包含 SDK；显式 `-PgetuiSdk=true` 才加入固定版本 `gtsdk:3.3.16.0` 和 `gtc:3.3.3.0`。构建环境 `MBOX_GETUI_APP_ID` 必须匹配后台应用；只有 App ID 进入安装包，App Key/Master Secret 不进入客户端。空 App ID 仅允许编译验证，包含 SDK 的正式打包会拒绝缺配置。
- 服务端新增迁移265，`MBOX_GETUI_ENABLED=false` 为默认值。启用还需 `MBOX_GETUI_APP_ID`、`MBOX_GETUI_APP_KEY`、`MBOX_GETUI_MASTER_SECRET_FILE`，以及现有32字节令牌加密密钥、key ID 和1至900秒事件TTL。与 APNs 独立，不需配置 Apple 凭据。
- 标准部署将主密钥从安装目录 `secrets/native-push/getui-master-secret` 只读挂载到容器 `/run/mbox-native-push/getui-master-secret`；必须为 root 所有、运行组可读的0440常规文件，父目录不可组/其他人写、不可符号链接。不可把密钥写入仓库、APK或日志；内联密钥和自定义发送地址会被环境归一化剔除。
- 通知内容仅固定提示和 deliveryId，打开后后台重新核查当前员工、原绑定、原任务/桌次；供应商接受不等于设备收到。超时保持未知结果，不换请求号盲目重发。
- 员工明确同意且当前服务器支持、记住登录和系统通知开启后才启动 SDK；退出/关闭实时通知沿既有绑定撤销。SDK 引入的无关权限和全局明文网络开关必须在最终合并清单中排除。

验证证据集中在 `outputs/android-getui-20261007/`；商业化状态以清单 `ANDROID-PUSH-20261007-05` 为准。本轮没有运行生产迁移、配置平台、真实发送或变更线上 stable 安装包。

提交集成 2026-10-07 22:07 CST：Android CI新增默认不含SDK与包含真实SDK两种构建，均无平台凭据且运行保持关闭；本轮仅提交、检查并合并，后端部署、迁移265生产执行、平台启用和新APK发布另行处理。既有安全告警依赖作最小修复，未恢复iOS功能开发。
