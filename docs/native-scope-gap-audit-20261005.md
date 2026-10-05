# 原生范围与未完成能力复核（2026-10-05）

**后台推送与尚未迁移的 iOS 能力属于原要求中的未完成软件，不能统一归为外部验收，也不能因本轮优先完善 Android 而视为用户已排除。** 本记录补充[系统审计](system-audit-20261005.md)的范围依据；代码修复、平台接入、发布和实体设备验收分别计证。源码清点基准为 `9b2cdd6e6d22d2c98273e24fcf79ac53c9024bd2`，以下正在修复项另列，不据此改变已部署后端或已分发 APK 的身份。

## 用户要求与范围边界

监督会话已通过 `read_thread` 回读直接人类消息，排除自动监督提示和代理转述，记录于[原始用户消息证据](../../outputs/system-audit-20261005/native-scope-direct-human-evidence.json)。

| 来源 | 已核实内容 | 可以得出的结论 |
|---|---|---|
| 早期原生会话 | “逐条开发，实现完整功能”“全部开发”“上述逐条开发”；另有“做苹果手机的安装包” | 存在完整原生功能与 iOS 交付意图；不能用后来 Android 优先级覆盖早期未完成项。 |
| 双端执行台账 | [BUSINESS_DEVELOPMENT.md:3–4、28](../native/staff-app/BUSINESS_DEVELOPMENT.md:3)记录 iOS、Android 同步、逐项页面/权限/异常；[FEATURE_PARITY.md:137–138](../native/staff-app/FEATURE_PARITY.md:137)要求逐项迁移和两端验收 | 双端要求有历史执行记录支撑。该措辞在首次集成 `b93a27578ef800d62960a9204543a808332e26b3` 已存在；文档记录与上行直接人类原话分开引用。 |
| 本轮 Android 指令 | “完善安卓程序做到可以商用”；手机信息答复为“多品牌的都有” | 本轮明确强调 Android 商用；已有多品牌事实，但没有由此核实具体机型、系统版本或推送通道覆盖。 |
| 本轮明确排除 | “本轮商用先不包含供应商退货” | 仅供应商采购退货明确排除本轮；不能扩展为 iOS 或后台推送也被排除。 |
| 安装条件与监督授权 | “暂时没有手机，只准备安装包”；另明确要求两会话全部修复、提交合并部署、逐条审计 | 当时没有实体 iPhone 约束安装验收，不等于取消 iOS 软件功能。提交或分发安装包不等于设备验收。 |

受检直接消息中**未找到取消 iOS 历史功能要求或后台推送的指令**；这是本次已回读证据的边界，不声称检索了所有历史消息。[Android 台账:7](../native/staff-app/ANDROID_COMPLETION.md:7)的“本轮只更新 Android”是工作记录，不能当作用户排除 iOS 的授权；[优先级:15](../native/staff-app/OPERATING_PRIORITIES.md:15)也明确后移但不删除。

## iOS：软件缺口与本轮缺陷修复分开

[功能表](../native/staff-app/FEATURE_PARITY.md:9)中 C 只代表实现及本地证据，I 包含未齐子流程，N 表示未实现。以下五组已以当前 Swift 入口和命令核对，不能只标“等真机”：

| 功能 ID / 台账位置 | 已有代码及缺口证据 |
|---|---|
| TABLE-07b，iOS N（:43） | [LiveAssignmentsView.swift:40–41](../native/staff-app/ios/Sources/LiveAssignmentsView.swift:40)明确只显示当前生效责任、没有排班历史；已有新建安排与结束当前命令，不等于已有未来安排的修改、取消和历史查询。 |
| RES-02，iOS I（:99） | [LiveReservationsView.swift:90–95](../native/staff-app/ios/Sources/LiveReservationsView.swift:90)候位只提供优先级操作；[LiveReservations.swift:91–134](../native/staff-app/ios/Sources/LiveReservations.swift:91)区分预约状态变更与候位排序，未形成 Android 已有的候位联系/到店/入座/取消流程。 |
| MEMBER-05，iOS N（:104） | [LiveMembersView.swift:32–58](../native/staff-app/ios/Sources/LiveMembersView.swift:32)是签到/奖励审批与只读规则展示，不能充当会员规则草稿、独立审批、发布和紧急控制。 |
| OPS-02，iOS N（:112） | [LiveFinance.swift:115–135、147–175](../native/staff-app/ios/Sources/LiveFinance.swift:115)是对账查询、核对跟进及关日；`fee` 是对账类型筛选，不是经营费用登记或工资管理。 |
| DEVICE-01 N / DEVICE-02 I（:115–116） | [LivePrinting.swift:22–71](../native/staff-app/ios/Sources/LivePrinting.swift:22)支持账单、日报、失败重试、补打和票据源恢复；这不包含打印机/桥接器配对、路由及票据策略管理。 |

台账另有明确 iOS N 软件项：MEMBER-04/06/07、SHOW-01/02、SET-01/02/03、NATIVE-03；与上表 TABLE-07b、MEMBER-05、OPS-02、DEVICE-01 合计 13 个主表 N 软件条目。这个数量是**台账条目数**，不是本轮发现数、独立缺陷数或功能完成率；其余条目仍需逐项实现和复核。NATIVE-07 的并发/性能/跨端验证另列，不能混算成第 14 个缺失模块。其他 I 子流程包括 SERVICE-02、ORDER-10、KDS-05、MEMBER-01/03、STOCK-01/03/04、OPS-01、NATIVE-02、AUTH-09/10；不因 Android C 或服务端接口存在而关闭。采购供应商退货仍遵守上文明确排除。

本轮另外确认并已完成源码修复、回归两项**已有 iOS 流程中的缺陷**：

- **AUDIT-20261005-13：** 恢复登录或退出遇到超时/503 后，下一请求仍可能携带原运行时身份/cookie；真实 `StaffAPI.swift` 注入传输探针见[修前结果](../../outputs/system-audit-20261005/ios-session-existing-defect-probe-result.json)。已修复 `StaffAPI`、`AppModel`，会话和真实 AppModel 回归通过。
- **AUDIT-20261005-14：** 关联售后已批准退款的现金执行、POS/外部结果入口及原键恢复不完整，已补现有流程的操作和恢复链并通过回归；没有以此宣称会员、设备、工资等历史模块已迁移。

两项固定提交 `dc869db2` 的19组合约共788项与模拟器构建通过，629个源码文件核对一致，[完整证据](../../outputs/system-audit-20261005/ios-dc869db2-validation-result.json)。当前尚未合并、分发或真机验收；合同断言不等于完整业务场景数。修复这两项不代表历史双端完整功能已经闭环。

## AUTH-10：已实现提醒不等于远程推送

[FEATURE_PARITY.md:30](../native/staff-app/FEATURE_PARITY.md:30)将双端 AUTH-10 保留 I，后台注册/锁屏为 N；首次集成 `b93a2757` 同文件第 28 行已有此边界。[2026-09-28设计记录:7、31](../native/staff-app/evidence/operating-priority-20260928/README.md:7)明确前台提醒不是 APNs/FCM；这是原需求的未完成项。

| 层 | 当前事实与精确证据 | 尚未完成的软件 |
|---|---|---|
| Android | [MainActivity.kt:191–196](../native/staff-app/android/app/src/main/java/com/mbox/staff/MainActivity.kt:191)前台45秒心跳；[ServiceReminderWorker.kt:25–36、69–85](../native/staff-app/android/app/src/main/java/com/mbox/staff/ServiceReminderWorker.kt:25)已有通知权限、员工会话隔离、15分钟 WorkManager 拉取后生成隐私本地通知 | 受检依赖、Manifest和源码未见厂商推送 SDK、远程注册/轮换回调及接收链；不能把 POST_NOTIFICATIONS 授权当作平台注册。 |
| iOS | [MBOXApp.swift:133–138](../native/staff-app/ios/Sources/MBOXApp.swift:133)仅前台心跳；[模拟器授权文件](../native/staff-app/ios/Simulator.entitlements:3)没有推送权限 | 未见 APNs 注册/失败回调、设备目标上传、远程接收/打开恢复以及配套推送 entitlement。 |
| 服务端 | [native-service-api.ts:53–60、88](../server/normalized/native-service-api.ts:53)已有受权任务查询和业务事件 outbox；[notification-worker.ts:60–109](../server/normalized/notification-worker.ts:60)已有队列重试；[notification-repository.ts:5](../server/normalized/notification-repository.ts:5)通道为 in_app/wechat/wecom/headset/printer/sms | 未见员工 App 安装目标/token 注册与撤销持久化、原生目标解析及 APNs/Android 投递实现；已有微信/企微通道不能替代原生推送。 |

具体检索范围、权限/会话已有保护和测试边界见[只读源码复核](../../outputs/system-audit-20261005/native-push-scope-readonly-review.md)。WorkManager 周期执行受系统调度约束，不能用缩短轮询替代实时送达机制。[Android 官方说明](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work#schedule_periodic_work)

可继续执行的最小软件工作是：受权安装注册/轮换/撤销；按事件和安装目标去重的投递状态机；投递前复核当前会话、岗位、任务和原桌次；最小隐私载荷；双端冷/热启动打开通知后重新读取原任务；跨租户/员工、撤权、过期、重复、断网及未知结果回归。默认未配置关闭，不以 fake 传输或队列写入记真实送达。iOS 可先实现原生 APNs 回调及可配置服务端适配，真实签名、平台鉴权和手机送达仍须独立验收；这不要求预先购买新的聚合服务。[Apple 官方机制](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/HandlingRemoteNotifications.html)

**尚无已核实的平台方案与配置就绪证据。** 历史清单 NATIVE-20261001-32 记载当时没有厂商配置；本轮用户已说明多品牌，但具体机型/系统/既有厂商应用及权限未在本证据集中核实。不能据此断言用户没有账户或证书，更不能擅选收费平台或加入某家 SDK。正式 Android APK 的签名和分发已存在，也不等于厂商推送应用、服务端密钥或品牌覆盖已经就绪。iOS 的 Apple 团队、App ID 推送能力、有效签名及 APNs 鉴权应按真实账户核实，不制造凭据。

关闭 AUTH-10 还须证实：合法注册与注销、真实渠道接受、前后台/锁屏/省电/断网恢复、授权拒绝/撤回、换员工/撤权后不误送、多设备与过期通知处理，以及点击后受权定位原任务。**平台接受不等于设备送达，设备送达不等于员工查看，查看不等于完成任务。** 这些软件、平台和门店证据分别保留，不用已有测试总数、发布成功或页面可见替代。
