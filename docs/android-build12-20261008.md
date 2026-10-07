# Android build12 正式候选交付证据

## 不可变身份

- 版本 `0.4.0-rc.7`，versionCode `12`，包名 `com.mbox.staff.nativeapp`，最低 Android8.0／API26。
- 文件 `MBOX-Staff-0.4.0-rc.7-build12-6b10956336a7.apk`，15,657,415字节。
- SHA256 `6b10956336a736e5f982021fbabfd715aa6f9ad85304821198159b58ff057f33`。
- 签名证书 SHA256 `05362998aab4266397f069cbcb37049176aa29eb7ab778cc7d55cfb5caa4ccc0`，与线上正式build9一致。
- 从 `2236a32dfdef7443d02994917189c60a05dde67c` 的冻结归档构建，340项构建输入前后摘要一致，全部与合并主线 `c142d7cd2a44fbf13b692414fa46da8f27accb98` 一致。
- 正式Release、不可调试、生产员工登录、禁止本地演练、stable通道；不含未配置个推SDK，实时推送未启用。

不可变候选根目录：`/Users/jingda/mbox/outputs/android-release-build12-20261007`。APK位于 `distribution/`，交付说明见根目录 `交付说明.md`。候选清单中的公网URL只是预定发布位置，本轮未上传，不应当作可用下载地址。

## 实际验证

Release assemble与lint通过；lint为0错误、20警告、13提示，不声称零告警。正式包签名、版本、ZIP/ELF、RELRO及16KB对齐检查通过。[准确源提交Android CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37642119897) 同时验证默认不含SDK和实际SDK两种配置的单测、lint、debug assemble；SDK CI通过不等于本正式APK含SDK或平台已经启用。

| 环境 | 操作与结果 | 证据边界 |
|---|---|---|
| API36／4KB，新建隔离AVD | 先安装正式build9，再使用覆盖安装升级build12；UID、首次安装时间、私有QA标记均保留，无卸载或清数据；生产登录页启动通过 | QA标记保留不证明所有历史营业数据迁移；不是实体手机 |
| API35／16KB，新建隔离AVD | build12首次安装、生产登录页启动通过 | 不是历史数据覆盖升级或多品牌验收 |
| 两种页大小的原生库 | 使用此APK实际打包arm64库运行 PathIterator/conic 探针，各500轮／18000段通过 | 不替代全部UI和业务验证 |

登录页截图已检查；任务新建的两台模拟器测试后关闭。保留 `candidate-verification.json`、`source-manifest.json`、`source-and-build-verification.json`、`source-merge-verification.json`、构建日志、`distribution/verification.json`、`4kb/`、`16kb/`。

## 交付范围

本文件补记冻结包中 RELEASE_NOTES_ANDROID_0.4.0-rc.7.md 所称“尚需验证”的实际结果，不改动已签包及冻结输入。功能包含暂停新增预约时仍可办理既有预约到店接待、明确失败恢复和未知结果核对，以及已合入主线的业务/通知恢复修复；预约不预绑具体座位策略不变。

后台 [rc251／schema265已部署](release-1.0.0-rc.251.md)，个推及预约新建仍关闭。APK仅准备并本地交付，线上stable仍build9；未上传、未自动推送更新、未启用实时推送、未真实发送通知。员工设备试用/正式分发属于后续步骤，不能把候选制作完成当成全品牌商用验收通过。

安装同签名正式build9可尝试直接覆盖升级；有未决付款/退款或草稿时先核对原业务，不要卸载清数据。其他调试签名旧包、实体设备相机扫码/锁屏省电/网络切换及历史业务数据迁移仍待实机验证；真实资金、打印纸票和完整班次同样待验。iOS、原生鸿蒙和供应商采购退货不在本轮范围。
