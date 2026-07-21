# M-BOX 员工端安卓验证版

## 应用信息

- 应用名称：M-BOX 现场运营验证版
- 包名：`com.superhigh.mbox.ops`
- 版本：`1.0.0-rc.14-validation.1`（versionCode `1401`）
- 最低系统：Android 8.0（API 26）
- 运行地址：`https://mbox-ops-validation-845187646287.asia-east1.run.app`
- 技术形态：Trusted Web Activity；业务更新由云端发布，APK 负责可信全屏入口。
- 在线下载页：`https://mbox-ops-validation-845187646287.asia-east1.run.app/install/android`
- 稳定下载地址：`https://mbox-ops-validation-845187646287.asia-east1.run.app/downloads/MBOX-Ops-Validation-latest.apk`

## 构建

签名文件保存在 `~/.mbox-secrets/android/mbox-ops-validation.p12`，密码只保存在 macOS 钥匙串，不能加入仓库或发送到群聊。

```bash
./scripts/build-android-validation.sh
```

构建产物位于 `deliverables/android/`：

- `MBOX-Ops-Validation-1.0.0-rc.14-validation.1.apk`：平板侧载安装包
- `MBOX-Ops-Validation-1.0.0-rc.14-validation.1.aab`：应用市场包
- `MBOX-Ops-Validation-1.0.0-rc.14-validation.1.apk.sha256`：安装包完整性校验

## 安装到平板

1. 平板开启开发者模式和 USB 调试，并保持 Chrome 为最新稳定版。
2. USB 连接电脑后确认设备：

```bash
~/.bubblewrap/android_sdk/platform-tools/adb devices
```

3. 安装或覆盖更新：

```bash
~/.bubblewrap/android_sdk/platform-tools/adb install -r \
  deliverables/android/MBOX-Ops-Validation-1.0.0-rc.14-validation.1.apk
```

## 平板验收

- 首次进入显示 M-BOX 黑金启动图，无浏览器地址栏。
- 门店验证、员工 PIN、切换员工和权限隔离正常。
- 麦克风授权后，语音命令可以开启、关闭、识别和执行。
- 摄像头授权后，收银扫码和二维码识别正常。
- 横屏、竖屏、键盘弹出、返回键和锁屏恢复不遮挡操作。
- 断网时提示明确；恢复网络后数据刷新，不重复提交现场操作。
- 耳机连接时，语音反馈从耳机输出。

验证版仍使用模拟支付和验证环境。正式商用前需要切换正式域名、正式支付、设备登记、推送通道、崩溃监控和应用分发策略。
