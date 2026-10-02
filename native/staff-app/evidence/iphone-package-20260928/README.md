# iPhone 真机安装包准备（2026-09-28）

状态：Release 真机归档构建成功，尚未完成苹果签名，不能安装。没有生成可安装 IPA，也没有上传 TestFlight / App Store。

- 版本 0.2.0（2），最低 iOS 17.0；Mach-O 已核实 platform IOS。
- 使用 preview 更新通道；未虚构正式更新地址。
- 补 PBXResourcesBuildPhase、AppIcon 资产与编译配置；沿用仓库现有 M-BOX 图标，未改图片。
- 补 PrivacyInfo.xcprivacy：UserDefaults CA92.1（本 App 的安装标识）；SystemBootTime 35F9.1（出品本地计时）。声明对应代码用途，不代表完整商店隐私问卷已验收。
- 归档已包含 Assets.car、iPhone/iPad 图标字典和隐私声明；相机、麦克风及语音识别用途字符串保留，相机文字更新为已实现扫码范围。
- `archive-verification.json` 保存归档路径、二进制与资源哈希；`archive.log` 为构建日志。
- 补资源后的模拟器 Debug 构建同样成功（`simulator-build.log`）；`npm run checklist:verify` 与 `git diff --check` 通过。未重新执行营业全量测试，本次不包含营业逻辑变更。
- 当前阻塞：Xcode Apple Accounts 已登录，界面确认免费 Personal Team / 0 Provisioned Devices；仍无有效代码签名身份。用户明确暂时无手机、只准备包，故保留待签名状态；未购买会员或上传。
- 普通账号仅走本人真机开发安装；批量分发或 TestFlight 需适用的开发者团队及分发配置。账号登录不等于完成签名。
- 完成条件：归档签名验证、描述文件/目标设备匹配、正式导出或 Xcode 真机安装、启动及升级保留状态验收分别记录。
- 本次仅 iOS 打包资源及证据文档调整；没有部署、修改线上数据库或替换既有 Android/模拟器下载包。

苹果官方依据：[所需原因 API](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)、[开发者账号与个人团队](https://developer.apple.com/help/account/basics/about-your-developer-account)、[分发方式](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases)。

## 2026-09-28 18:16 CST 待签名文件交付

已生成 `/Users/jingda/mbox/outputs/native-installers/20260928/MBOX-Staff-0.2.0-iPhone-UNSIGNED-NOT-INSTALLABLE.ipa`，大小 2328632 字节。ZIP 完整性通过，Payload 内二进制与上述归档哈希一致。包名明确 UNSIGNED-NOT-INSTALLABLE；不能直接安装。具体路径/哈希保存在 archive-verification.json，输出目录附安装边界说明。登录与开发者协议已完成，签名、设备配置和分发未完成。
