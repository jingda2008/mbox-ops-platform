# 原款历史关闭与重收授权 · 2026-09-27 02:21 CST

## 实现范围

SwiftUI / Compose 两端收银工作台新增：
- 原历史欠款状态、现存重收授权金额/到期信息。
- 原款未外送本地关闭：四项权限、服务器两类flags、closed原桌次、pending_payment、可关闭白名单及完整scope；二次确认全部原订单与整笔金额。单卡分摊10000的测试使用整笔15000，验证不会混淆。
- 重收授权：原单正应收、成功退款（开放桌）/authorization_required（历史桌）、现存授权不重复；4—500字原因、客人明确同意、原补偿保留、默认30分钟单次授权提示。
- 固定原员工、原publicId/id、金额、币种和请求key/body；回执不匹配保留待核对，丢回执重试同键。授权对象没有status，不能误作付款成功。
- 内部localUnpresentedHistoryClosed被服务器公开序列化过滤；根据真实公开合同校验，不依赖内部标记。

## 本地验证

- iOS全套：core29、live36、ordering68、cashier58、update17，总208项断言通过。相应ios-recovery-*-tests.txt、ios-cashier-recovery-tests.txt。
- Android全套42个JUnit，0失败/0错误/0跳过；恢复专项新增3个用例，覆盖多权限/拒绝、完整范围缺失与错配、状态/flags阻断、持久化原键重试、原授权金额/身份/原因错配和已有授权。recovery-TEST-*.xml。
- 双端最终构建：ios-cashier-recovery-build.txt、android-cashier-recovery-build.txt。
- iOS可执行SHA256 `318592f70052f3ca46d1f81c41cc6a65e0229ce53a73937c388c02a843bfa62f`；Android APK SHA256 `125d1b57af01e0c77ae2b6e98a39e78be2df2a8106041d7c487cf70f7b6a888b`。版本仍为本地开发0.2.0（2），没有线上分发。

## 未验收与未完成

真实账号/真实API、资金写入、两端登录后新增页面逐按钮、真机、权限撤销/跨登录金融恢复、弱网并发均未验收。CUA只观察到了iPhone本机演练桌台，不作为新增收银页面验收。

历史已关桌实际补收、待定原款retry-release、渠道关闭仍未迁移。收银工作台不暴露通用待定付款的可靠单/合付范围，不能盲目显示仅单笔可用的retry-release。授权接口缺少expectedAmount/version前置参数；余额并发变化时回执可阻断App后续操作，不能宣称服务器没有生成新余额的授权，需原单核对（NATIVE-04）。

网页与服务器代码未改，没有提交、推送、部署或生产经营写入。FEATURE_PARITY逐项保留缺口，没有A验收项。

iOS实际调试代码dylib SHA256：`7b9a88738f95a2417e6b4573323fd4087e3cfcf523e1a9895dafb19265fa5c40`。

## 最终模拟器安装启动

- iOS：覆盖安装到 `MBOX iPhone Validation`（2EA116D3-018A-4D1E-9BB0-A908E2F29F7A），启动 `com.mbox.staff.native` 返回 PID 17697。
- Android：emulator-5554 `adb install -r` 返回 Success，`am start -S` 启动 `com.mbox.staff.nativeapp/com.mbox.staff.MainActivity` 成功。
- 未卸载或清除数据。上述是开发包安装启动证据，不是新增收银页面、实际重收或真实升级验收。
- 商业化清单校验 verified=true（380个历史事项）；git diff --check 及维护的未跟踪源文件空白检查通过；src/server无差异。
