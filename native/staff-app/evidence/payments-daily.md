# 2026-09-27 原生日常支付开发证据

## 本批实现

- iOS SwiftUI / Android Compose 原生线上收款：同桌原订单选择、部分金额、原生摄像头识别顾客付款码、手动输入、确认扣款、展示本次付款二维码、过期隐藏、原付款被动状态轮询。
- iOS Keychain `WhenUnlockedThisDeviceOnly`；Android Keystore AES-GCM、逐请求 AAD 和 AtomicFile 密文；普通持久请求不保存顾客付款码。安全存储失败停止发送，原凭据不可读不新开款；收到且存好匹配回执才删除对应安全凭据。恢复优先已存回执，避免确认点保存失败后因凭据已删除而二次发送。
- 待定原款 retry-release：原因与二次确认，只授权改收，原款可能后到；不是渠道关闭。
- 日结/对账：营业日、收款/退款/费用/调整筛选、100条游标分页、原凭证追溯、跨日100条财务异常分页、接手/说明/结案、上一营业日安全结束及逐桌阻断事实。确认页可滚动，避免长原因被截断。
- 未付款整单取消、已送达未付款异常结清：原单状态/独立权限/原因/金额与原事件回执校验，付款在途或已到账阻断；异常结清不记为实际收款。
- 团购服务端只补权限前置：外部consume前查实时权限，事务内原检查不移除；撤权回归证实外部consume未调用。未接原生核销UI，外部核销的丢回执/关联失败/跨日恢复仍未完成。
- 启动截图发现安卓米白底状态栏白字、筛选默认紫色；改为深色状态栏文字，统一品牌绿/金/米白组件色。没有改网页UI。

## 验证

| 范围 | 结果 | 可复查证据 |
|---|---|---|
| iOS全客户端脚本 | 333断言通过：core29、live36、order68、cashier89、update17、assignments44、daily-payment50 | `payments-daily-ios-regression.log`，新增 `../ios/test-payments-daily.sh` |
| Android全JUnit | 66测试，0失败/错误；本批新增14个测试方法 | `payments-daily-android-build.log`、`../android/app/build/test-results/testDebugUnitTest/TEST-*.xml` |
| SwiftUI模拟器构建 | BUILD SUCCEEDED | `payments-daily-ios-build.log` |
| Android debug APK | BUILD SUCCESSFUL | `payments-daily-android-build.log` |
| 服务端相关接口/隔离数据库 | 5文件84项全部通过，无环境跳过 | `payments-daily-server-tests.log`；payment-api、commercial-ops-api、business-day-closure单元/集成、order-cancellation集成 |
| 完整服务端类型检查 | `npx tsc --noEmit -p tsconfig.server.json` exit0 | `payments-daily-server-types.log`（成功无输出） |
| 双模拟器 | 既有iOS26.5 / Android5554覆盖安装、启动；只核验本机演练首页未崩溃 | `payments-daily-ios-launch.png`、`payments-daily-android-launch.png`；不作为新增真实支付页面或真机扫码验收 |
| 修改检查 | `git diff --check` 通过 | 仅确认本批与当前工作树无空白错误，不表示既有其他改动已全部审计 |

新增用例覆盖：金额/订单集合/在途阻断、身份/权限/线上开关、模拟通道拒绝、付款码不进入普通JSON及同键恢复、错付款/金额/币种/动作回执、QR到期与成功隐藏、原款释放、日期与游标、退款负数记账、原财务跟进身份/说明/状态绑定、日结计数不匹配、原未付款取消及异常金额校验。这里的付款码、二维码与账单均为固定测试数据，不是真实渠道交易。

数据库测试使用项目隔离runner，建立独立随机数据库及受限角色、迁移至250后运行并清理；没有在门店生产库写入。临时runner已删除。

## 新增安卓依赖

- [JourneyApps zxing-android-embedded 4.3.0](https://github.com/journeyapps/zxing-android-embedded)：ScanContract/CaptureActivity、原生二维码呈现；组件随包提供，无Google Play服务下载前置。
- [ZXing core 3.5.4](https://github.com/zxing/zxing/releases)：条码/二维码编解码。
- 两者为Apache-2.0。正式分发仍需保留对应第三方许可与发行归属说明；摄像头识别、拒绝权限、设备旋转和真实门店机型验收未完成。

## 未完成与交付边界

按份售后/套餐重算、活动收退款、完整团购核销、真正通道关闭、现金实点交班、支付小票、所有财务失败恢复仍未完成，详见 [20项支付台账](../PAYMENTS_DAILY.md)。并发复用原付款、团购外部成功本地失败、取消/异常结清跨营业日指纹三个问题登记NATIVE-08/09/10；不以保持未知锁定代替完成恢复体验。

当前在已有原生工作树内继续开发，保留其他任务改动；未提交、推送、部署、正式签名或线上升级发布，未调用真实账号进行支付/退款，未认定实际收款或对账差额归零。模拟器启动不代替两端逐页真实账号、相机、通道资金、打印和门店交班验收。
