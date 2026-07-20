# M-BOX iOS 验证版

## 当前交付

- Capacitor iOS 原生工程：`ios/App/App.xcodeproj`
- 在线验证安装页：`/install/ios`
- iPhone Web Clip 配置包：`/downloads/MBOX-Ops-Validation.mobileconfig`
- IPA 构建命令：`npm run ios:build:validation`
- Simulator 回归命令：`npm run ios:test:simulator`

验证配置包会在 iPhone 主屏幕建立全屏运营入口，适合门店试用。它不是 IPA，也不替代 Apple Developer 签名。

## 本机工具

- Xcode 26.6
- CocoaPods
- Capacitor CLI / iOS / Assets
- fastlane
- ios-deploy
- xcodes

已安装 iOS 26.5 Simulator，并创建 `MBOX iPhone Validation` 专用模拟器。

## 首次授权

Xcode 安装后需要由本机管理员在终端完成：

```bash
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
```

然后在 Xcode 的 `Settings > Accounts` 登录 Apple Developer 账号，创建 Apple Development 或 Apple Distribution 证书，并为 `com.superhigh.mbox.ops` 配置 Team。

## 生成 IPA

1. 运行 `npm run ios:open`，在 Xcode 中设置 Team 和签名方式。
2. 添加含真实 Team ID、发行方式及设备范围的 `ios/ExportOptions-AdHoc.plist`。
3. 运行 `npm run ios:build:validation`。

构建脚本只对当前 Xcode 进程停用失效的全局 Git 代理，并将公开 Swift 包授权方式设为 `netrc`，不会修改用户的 `~/.gitconfig` 或读取登录钥匙串。

验证版当前通过 Capacitor `server.url` 加载 Cloud Run。商业发行前需要改为随包发布前端静态资源，并将远程地址仅用于 API。
