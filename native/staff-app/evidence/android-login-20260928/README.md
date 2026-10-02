# Android 员工登录与原品牌图标修复

更新时间：2026-09-28 20:01 CST

## 原因和修复

旧安装包默认创建 World.training() 并恢复 training-v1.bin；生产登录藏在“更多”。本次改为 live=true、空桌台/订单，身份验证前仅显示员工登录页。门店设备口令验证后，使用现有员工账号及4位PIN登录 https://mbox.shmbox.com。记住登录仍需联网校验；退出/身份失效回登录页。员工包关闭本机演练入口，并忽略旧演练数据及演练待提交指令；保留真实未决请求恢复机制。

使用用户明确确认的黑底、米白 M·BOX、红色1999原图，直接复制用户附件至 drawable-nodpi/mbox_brand_logo.png，未重绘或改色。图像SHA256：19804ea72996f791f8dc0f8c91316e4072fdee1fe31d8030327b0b6afbccd943。登录页显示原图，Android自适应图标黑底加20%安全边距。

## 验证

- Gradle testDebugUnitTest、assembleDebug成功，144测试，0失败/错误/跳过；含新增3项启动回归：首次安装、携带旧演练现金待提交指令升级、禁止切回演练。
- 包名 com.mbox.staff.nativeapp，版本0.2.1(3)，Android8/API26起。
- apksigner验证通过，与0.2.0旧APK证书SHA256一致：8a4419da1eb035b3059adc284cf7b802c99e7ab539b9f590ed54d60e6593ddbf。内部测试debug签名，非正式渠道发布。
- emulator-5554执行install -r成功，dumpsys确认版本0.2.1(3)，未清除应用数据。
- 生产只读ready为200，未认证session/operations为401 AUTH_REQUIRED。未执行真实营业写入。
- CUA当前无法发现安卓模拟器窗口，因此未完成登录页视觉/交互、键盘遮挡或真实账号门店业务验收。构建和安装成功不能替代这些验收。
- 本次只修改Android与核验文档；未部署网页/后端/数据库。该工作区其它预先存在修改保留原状。

## 安装包

`/Users/jingda/mbox/outputs/native-installers/20260928/MBOX-Staff-0.2.1-Android-login.apk`

SHA256：`393d796edf1c269a148d55202f87d4b1916f19ae340b86bbc3665a38e2b37056`

直接覆盖旧0.2.0测试包，勿先卸载，以保留真实未决请求等本机状态。首次使用门店口令验证设备，再用员工账号/PIN登录。是否可使用全部新功能仍取决于对应后台接口部署与账号权限，本包不代表营业全功能验收。
