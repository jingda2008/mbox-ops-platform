# Android 通知接收与原任务恢复

更新时间：2026-10-05 14:36 CST

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
