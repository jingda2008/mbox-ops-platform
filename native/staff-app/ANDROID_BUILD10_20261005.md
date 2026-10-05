# Android 0.4.0-rc.5 / build 10 正式候选

本次候选修复预约页面关闭、重开、切换及员工权限变化后的旧响应回填；旧日期、刷新和确认事件在改变当前状态前被拒绝。确认命令绑定当前页面及读取代次，已保存原请求仍可沿原键恢复。继承已合并 PR333/335/339 的销售小数量、积分差额和新版预约接待。

发布脚本新增实际 APK 的原生库 ZIP/ELF/RELRO 与 Manifest 解压配置联合检查；不修改网页、服务端财务实现或现有正式更新清单。

## 固定源码与包

- 编译源码：`c4cbbcef18b01e1a5b70d2062166563957e1ecce`；323 个构建输入逐文件 SHA256，源归档和编译前后字节核验均保存。
- APK：`MBOX-Staff-0.4.0-rc.5-build10-56f3b03ee0e3.apk`，15,624,539 字节。
- SHA256：`56f3b03ee0e32aecb7dc8ddfcea92b60f1b8ed4bbb3909d363c31a27d78728b3`。
- 正式证书 SHA256：`05362998aab4266397f069cbcb37049176aa29eb7ab778cc7d55cfb5caa4ccc0`，与 build9 一致；stable 渠道、不可调试、禁用演练。
- 新整合 main `31ea829a4de863db017f608878df8adc1799d678` 和本说明只改变非构建输入；最终 PR head 的一致性单独留证。历史 build9 文件未覆盖或重发。

## 验证

- Android 91组458项全部通过，无失败/错误/跳过；其中11项真实 AppModel 延迟 transport 竞态，未触达营业数据库。
- 发布脚本16项通过，包含安全间隙与真实可写区误保护、压缩库安装配置冲突、损坏ZIP/ELF与ABI错误、失败不覆盖原分发文件。
- lintDebug 0错误/13警告/13提示；lintRelease 0错误/9警告/13提示；debug 和正式 Release 构建通过。
- API36 ARM64 / 4KB：同正式证书 build9→10 覆盖成功；UID、首次安装时间和私有 QA 标记保留；员工登录页面正常、进程无 fatal 记录。
- API35 ARM64 / 16KB：独立官方 ps16k 镜像首次安装与冷启动成功，员工登录页面正常；没有登录或营业写入。
- 两套系统分别用实际候选 APK 中的类和 ARM64 库完成500轮/18000段路径转换；圆形转二次曲线调用 JNI。该探针独立于应用登录，不能扩大为整 App 功能或所有 ABI 真机验收。

图形库保留 `simpleFormulaAligned=false` 诊断。固定 AOSP linker、全部可写段和实际16KB运行共同说明本样本的 padding 没有误保护可写数据；不因此宣称满足所有官方简化公式或全部厂商实现。未盲目升级或二进制修补第三方库。依据与原始范围在 `outputs/android-graphics-path-16kb-20261005/review.md`。

## 交付边界

证据根：`/Users/jingda/mbox/outputs/android-release-build10-20261005`。正式候选在 `distribution/`；完整源清单 `source-manifest.json`，构建证明 `source-and-build-verification.json`，覆盖证明 `emulator-upgrade-verification.json`，16KB结果 `16kb/verification.json`，最终交接 `outputs/session-supervision-20261005/android-build10-handoff.json`。

Android负责本地签名与验证，系统集成负责人唯一合并及生产发布。本次没有上传 APK 或更新在线 stable；后端 schema262/263 部署与功能开关须独立核实。不能将本地包或模拟器通过当作商用整体完成。

用户范围为仅继续安卓；供应商采购退货和iOS排除。真实厂商/聚合推送 SDK 与接收回调仍是软件待办，提供方配置未明确；多品牌实体设备安装、权限/锁屏送达、支付退款、打印和整班营业各自待验。
