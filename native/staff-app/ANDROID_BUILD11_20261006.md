# Android 0.4.0-rc.6 / build11 正式签名候选

基于系统负责人确认的主线 `83db1a59bb9c1265655b7bc3c8b678211c4708f6`（PR345）。版本冻结提交 `944f5ae28759a4e5a99f82f9ca9520e3f606c5f9`，只调整版本默认值与交付说明，业务/测试/共享数据/发布工具保持已测源一致。此文为本地候选证据，不是公网发布回执。

## 包与来源

- 包：`MBOX-Staff-0.4.0-rc.6-build11-4a945dad1e03.apk`，15657307字节。
- APK SHA256：`4a945dad1e03bb51e8a7461cdd0a66bd694b0415b4f3ec9abccb3fd045498b02`。
- 正式证书 SHA256：`05362998aab4266397f069cbcb37049176aa29eb7ab778cc7d55cfb5caa4ccc0`，沿用已发布build9，未使用调试签名。
- 从Git archive隔离导出334项输入；完整mode/blob/字节/SHA256清单、独立源码归档和构建前后校验均留存。后续本交付文档不改变冻结输入。
- 实际APK核对包名`com.mbox.staff.nativeapp`、11/0.4.0-rc.6、minimum26/target36、非debuggable、禁本地演练、stable、签名、ZIP及四项原生库ELF/RELRO通过。

## 验证

- PR345准确597d官方Android原始XML：557/557、98类、零失败/跳过；发布保护16项，Debug lint0错误/16警告/13提示。版本业务源码不变，未重复本地557全测。
- 本冻结源正式`assembleRelease`与`lintRelease`通过；Release lint0错误/9警告/13提示。不同构建/环境的警告数各自记录，不相互替代。
- 新建API36/4KB隔离设备，先安装正式build9，再仅`adb install -r`升级11；UID、首次安装时间和私有QA标记一致，未卸载或清应用数据。登录页启动及截图通过。
- 另建API35/16KB设备首次安装11，登录页启动及截图通过。两环境都用该候选APK实际打包的arm64库执行500轮/18000段PathIterator/conic探针，通过；不拿旧包探针替代本包。
- 接待源码与rc249能力/协议逐项核对：两项布尔能力、新名额登记、整组实际桌次入座、原员工/请求键/正文恢复与回执校验均保留；43项相关回归包含在557项中。不是正式11向线上249写单验收。
- 初次QA脚本把“包不存在”的`pm path`退出码1当成错误，在任何安装前停止；仅修正测试脚本的存在性判定，保留失败日志，未改APK或重新签包。

## 交接与边界

证据目录：`/Users/jingda/mbox/outputs/android-release-build11-20261006/`。包含`source-manifest.json`、`source-and-build-verification.json`、`distribution/verification.json`、`4kb/verification.json`、`16kb/verification.json`、官方CI原始报告、截图、安装与原生探针日志。根系统负责人核对最终PR合并源与同一manifest后，唯一执行不可变上传、HTTPS摘要回读及stable CAS。

build10原包保留、不分发；线上基线为已发布build9，直接升级11。配套后台249须等候选和发布门禁就绪再激活并紧接分发11。当前本会话未部署后台、未修改线上stable、未向营业数据写入测试操作。

同签名升级的私有QA标记保留不证明全部历史业务数据迁移；模拟器不替代多品牌实体机、相机/语音、锁屏省电/杀进程送达、真实资金、纸票和整班营业。实际厂商SDK及Android后端推送合同仍是未完成软件项。供应商采购退货和iOS仍在本轮范围外。
