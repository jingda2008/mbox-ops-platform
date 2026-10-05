# 原生 App 在线更新

## 本批状态

当前Android候选为 **0.4.0-rc.3（build 8）**，使用固定正式证书，生产登录且禁用演练。0.2.0/build2与0.4.0-rc.1/build6是历史版本。开发构建渠道是 `preview`，正式构建渠道是 `stable`。2026-10-05只读检查线上两个清单均为404，正式包生成与线上启用分开留证，详见 `COMMERCIAL_READINESS_ANDROID_20261005.md`。

- 启动／回到前台自动检查，每次运行最多每6小时一次；更多 → 版本与更新可立即手动检查。不要求员工登录，不携带员工会话。
- 有新版本时顶部小条提示，不占用大面积桌台业务空间；显示版本、更新说明、系统要求。不存在已发布版本、404、网络失败不显示“已是最新版”。
- 普通／紧急更新均需用户选择；紧急表示建议尽快更新。应用内有正在进行的业务、未决订单／收退款、未决演练或存储错误时不启动安装。系统 App Store 自动更新或设备管理行为不由本应用控制；原请求必须先持久化。
- 不使用远程脚本热替换原生业务代码，不在收银中强退 App，不卸载旧版，不删除原请求、草稿或业务缓存。

## Android：内部 APK 渠道

更新说明 → 确认下载 → 进度 → SHA256、大小、包名、严格递增构建号与当前签名校验 → 点击安装 → 系统安装确认。没有安装来源权限时前往系统设置，由员工自行授权，返回后再次点击安装。

只允许 HTTPS `mbox.shmbox.com/native-updates/staff/` 下的APK，拒绝重定向、其他主机、用户信息、查询参数、路径穿越。单包最多256MiB；空间不足、截断、错摘要、错包名、降级及签名不符均停止。安装前再次核对文件，避免校验后文件变化。只通过 FileProvider 临时授权专用缓存文件，不申请整个存储目录权限。

安装失败／取消保留当前程序和业务文件；下载失败可重试，未实现断点续传，重新下载会重新校验。进程重启不信任上次“已验证”的内存状态，重新下载／校验。调用系统安装器不等于安装成功，重新启动后的真实版本号才是依据。

长期签名是连续更新的必要条件。历史build7安装包使用Android Debug证书；本轮build8正式证书的SHA256为 `05362998aab4266397f069cbcb37049176aa29eb7ab778cc7d55cfb5caa4ccc0`。私钥保存在Git外的受限本机配置目录，尚需持有人另做离线备份。**新正式包不能覆盖旧调试证书的包；不得为迁移而直接卸载有未决业务的旧包**。应先完成原请求核对、草稿和账户安排。此后同正式签名、递增构建号可以覆盖升级。暂不支持签名轮换。发布器同时拒绝调试证书、可调试APK、错误渠道和启用演练的正式包。

正式构建可配置环境变量 `MBOX_ANDROID_KEYSTORE`、`MBOX_ANDROID_KEYSTORE_PASSWORD`、`MBOX_ANDROID_KEY_ALIAS`、`MBOX_ANDROID_KEY_PASSWORD`；源码不保存密码或密钥。可用 `-PnativeVersionCode=8 -PnativeVersionName=0.4.0-rc.3` 指定本候选，运行 `assembleRelease`。签名未配置时构建直接失败。`scripts/package-android-release.py`从真实APK产生不可变文件名、清单与验证回执；不能把调试APK更名后当作正式包。

本构建用于门店内部 APK 分发。若改用 Google Play，需单独改为 Play In-App Updates 并移除直接安装权限／入口，不把内部 APK 下载机制直接提交到 Play。

## iPhone：官方分发更新

版本检测完成后前往配置的 App Store 或 TestFlight 链接，由该渠道安装；不尝试下载 IPA 后自行替换程序。TestFlight用于测试，正式员工分发还需按账号和设备条件选择 App Store、Unlisted App 或 Custom Apps 等。企业分发有资格要求，不能假定已有资格。

需要已有 Apple Developer 账号、签名配置、对应应用记录和可用分发链接。最终分发方式尚未选择，链接待真实发布后配置。Apple 商店／TestFlight可能自行提供更新，但版本清单不能提前宣告尚未分发成功的构建可用。iOS构建使用 `MARKETING_VERSION` 和 `CURRENT_PROJECT_VERSION`。

官方依据：[Apple分发流程](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases)、[TestFlight说明](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)、[Apple审核规则2.5.2](https://developer.apple.com/cn/app-store/review/guidelines/)、[Android签名与更新](https://developer.android.com/studio/publish/app-signing)、[Android应用内更新](https://developer.android.com/guide/playcore/in-app-updates)、[FileProvider](https://developer.android.com/reference/androidx/core/content/FileProvider)。

## 发布新版本

固定元数据地址：开发构建用 `https://mbox.shmbox.com/native-updates/staff/preview.json`，正式构建用同目录的 `stable.json`。渠道由构建固定，不接受服务器跨渠道升级；发布工具用 `--channel preview` 或 `--channel stable`。

1. 在隔离环境验证新旧版本API兼容、未决请求和草稿升级；版本号递增，变更存储结构时先写迁移和失败恢复，不覆盖原文件。
2. Android用固定正式签名打包；iOS先完成对应分发渠道的上传／审核，使目标版本实际可安装。
3. 使用 `scripts/prepare-update.py` 生成本地清单（`--help`列出参数）。Android从真实APK读取包名、版本与最低系统，验证签名并生成摘要，要求传入已确定的证书SHA256；iOS填实际版本／build和官方入口。脚本保留另一平台记录，禁止覆盖同号或降级版本，原子写文件。它不上传、不签名、不自动发布。
4. 在专用静态目录先上传不可变APK，再通过HTTPS验证大小、摘要和可下载性，最后原子替换清单。APK路径包含构建号，不能用新文件覆盖旧路径。清单必须 `Cache-Control: no-store` 或短期可重新验证缓存；不能落入网页SPA返回HTML。
5. 下载文件不放在业务上传／备份／密钥目录。可按 `distribution/nginx-location.example.conf` 增加独立静态路径，现有网页资源及路由保持原状。先核验配置与回退方案再正式启用；本批未修改生产Nginx。
6. 真机从旧版安装更新后，核对版本号、原账号处理、草稿及未决订单／资金请求；iOS、Android分别留证。确认通知到达不等于更新完成。

撤回有问题的更新时，从清单移除该候选，可保留旧文件供审计；不能向已升级设备强装更低版本。已升级的设备需要新的递增build修复包。`distribution/preview.json` 与 `distribution/stable.json` 当前均为空清单，不能当作已发布证据；`shared/fixtures/app-update.json` 是假链接测试数据，**禁止发布**。

## 尚需验收

正式Android签名已建立；线上HTTPS清单和Apple分发渠道尚未启用；两端真机实际下载与安装、来源权限拒绝／取消、弱网／磁盘满、更新中杀进程、跨版本业务数据迁移尚未验收。Android本地合同验证不替代系统安装器验收。详见 `FEATURE_PARITY.md` 与商业风险 NATIVE-20260927-05。
