# M-BOX 1.0.0-rc.246 系统审计修复与原生端统一交付

状态（2026-10-05 13:04 CST）：PR #327对应后端已于12:35:48 CST通过标准流程部署，Android正式build8于12:41发布到stable并完成独立HTTPS回读。后端固定提交`6e4a76a2359413f6d7e78eb1c7a37e923087f523`、标签`v1.0.0-rc.246`、schema260。初审10项及交付扩查2项分开记录，见[系统审计](system-audit-20261005.md)。后续海报保留和短期CI归档修复PR #328已于12:56:56 CST合并为`91f84ff59df0fff9007991d639edaad5c296828b`，PR CI首次运行成功。这两项只在后续主线，不在冻结后端6e4标签；双小程序最终交付候选已按91f重新生成并校验，尚未上传；6e4首批候选保留为历史，不冒称最终包。

| 发布身份 | 已核验值 |
|---|---|
| 部署完成时间 | `2026-10-05T04:35:48Z`，即12:35:48 CST，标准deploy退出0 |
| 镜像摘要 | `sha256:6ca1b4b7b38aca8e197e12f2e6d9b7b897fbc1ebb1b164710740ac74dcc96a8f` |
| Release manifest SHA256 | `a13d331bb50445f9d207ad715a7bd0e2471da516ce933dccd2b80418dc35aeda` |
| 正式发布资产 | [rc.246 Release](https://github.com/jingda2008/mbox-ops-platform/releases/tag/v1.0.0-rc.246)，12:17:47 CST发布；16个脚本资产摘要均与manifest一致 |
| 生产证据 | [部署manifest](../../outputs/system-audit-20261005/deployment-rc246/deployment-manifest.json)、同目录OSS备份／部署／完成校验均verified；[受限只读核验](../../outputs/system-audit-20261005/production-rc246-readonly.json)、[容器挂载核验](../../outputs/system-audit-20261005/production-rc246-container-readonly.json)均通过 |

## 当前实现范围

退款与活动收款恢复稳定编号并兼容仍存在的旧回执；顾客合并付款先恢复终态再执行新付款门禁；双小程序结构化错误和预约原请求恢复；网页同类预约恢复；公共预约／候位回执的本人和原请求绑定；旧退库成本及派生成本一致性；打印配置继承份数和手机布局；待办“最近全部核对成功”总时间、活动收银样式和过期资料修正。安卓PR #326已通过适用CI并合并集成，供应商采购退货不在本轮安卓范围。

预约请求键回执仍为24小时语义，原publicId绑定原顾客及原载荷并随预约保留。网页和双小程序超过23小时只查原结果，查不到不盲目新建；旧客户端未保存原编号且旧随机回执已清理时不能永久恢复。候位本轮补本人／载荷校验，不扩大为新增同样的持久创建恢复协议。

## 数据与回滚

发布包含schema259打印继承、schema260退库成本来源。迁移不批量修写历史资金或未知成本，不重写历史订单成本快照和售价；历史55条未知单价自动退库仍须原采购／成本事实。新逻辑闭合退库余额和配方／普通套餐投影，必选组套餐保留未知状态。schema260保留旧列清单写入兼容。

回滚至schema259以前版本时，旧worker不能解释启用的`cashier_payment`继承截止标记。标准自动／外部回滚先停止相关写入，再以受限runtime LOGIN及明确tenant/store只读检查；有该风险标记或停止写入／查询不可验证时拒绝旧worker恢复并留证。关闭现金票据、非现金继承标记不一律阻断，尚未应用259且新增表不存在有安全分支。外部拒绝时尝试恢复当前版本，自动失败需受控前向恢复。受限PG打印／成本20项和四类依赖并发独立探针通过；脚本及CI检查不等于实际生产回滚演练，保留旧容器也不是可回滚证明。

## 验证与交付

固定6e4提交的tag-ci、release、main-ci、android-main四个workflow均成功。tag/main常规2327通过、1349环境跳过；真实PG主套件3053项通过，内嵌跨维护账号专项130项通过，均零跳过，不相加为独立场景数；浏览器基线121通过、36功能开关跳过，三屏18及会员8通过，零flaky。Android310项、零失败／跳过，lint及debug构建通过；维护24项、实际分发器18项通过。PR和main的image规则跳过不能替代发布，本次tag的image及release已另行成功。各集合分别记录，不相加为业务覆盖率。[最终工作流及资产摘要](../../outputs/system-audit-20261005/workflows/workflow-final-summary.json)。

本次使用标准入口`./deploy/aliyun/deploy-release.sh`，沿进程专用代理→证据中继→应用主机路径，保留TLS及SSH主机密钥校验。首次SSH中断发生在切换前，原rc.245健康；[第一次尝试](../../outputs/system-audit-20261005/deploy-rc246-attempt1.log)保留，同SHA标准重试成功。部署后四路HTTP及Chromium检查通过；runtime受限LOGIN、RLS作用域、259／260迁移checksum、workers和原生更新只读挂载均核验通过。历史55条未知成本自动退库、493笔pending、1笔requested退款仍在，发布未清理或伪造历史终态。

外层首次容器探针误要求整个rootfs只读，实际新旧正常运行容器均为false；[初始结果](../../outputs/system-audit-20261005/production-rc246-container-readonly.initial.json)保留，按当前部署合同校正为检查原生更新挂载RO后通过，未改变生产配置。该校正不将整个rootfs描述为只读，也不替代真实回滚演练。

发布路径差异（AUDIT-12）：标签CI短期OSS归档的静态复制清单遗漏`publish-native-update.py`；GitHub正式资产和本次标准deploy动态复制的16脚本均完整且摘要一致。不能把短期归档当作完整发布包。工作流改为按manifest复制全部脚本的修复已通过PR CI并合并至91f，适用于后续主线，未修改或重打6e4标签／历史归档；本次业务部署和APK发布使用已核验完整的标准路径。

双小程序首批候选对应6e4，回归385/385通过；微信candidate本地门禁通过，支付宝官方离线编译0.108.16、23页通过。[首批候选证据](../../outputs/system-audit-20261005/miniprogram-rc246-final-result.md)保留原文件，不冒称最终修正包。交付扩查发现6e4遗漏已上传ui.4的4:3无框海报；PR #328已合并，仅恢复三个组件并保留七个预约／付款恢复文件；最终交付候选已按91f重新构建和绑定证据，当前尚未上传。

微信基于有来源的历史确认补运营主体／联系两项，首批upload门禁31→29，分为A17正式资料／平台附件、B7本版工具／真机／独立签名、C5实际上传回执；门禁消息数不是软件缺陷数。历史rc.245及rc.245-ui.4均有官方CLI开发版上传成功日志，不能再概括“从未上传”；这些日志不证明当前体验版选择、审核或正式发布，也不能跨版本代替本版回执。支付宝正式身份、支付、手机号和通知保持关闭。[缺口分类](../../outputs/system-audit-20261005/wechat-rc246-upload-gap-triage.md)、[历史上传回读](../../outputs/system-audit-20261005/wechat-rc245-upload-history-readback.md)。

最终双小程序交付候选的来源是后续主线`91f84ff59df0fff9007991d639edaad5c296828b`，通过git archive生成，独立于冻结后端6e4标签。下面字节数为候选源码文件合计，不是平台上传包大小；本次没有平台上传、审核或正式发布。

| 最终候选 | 来源回读与实际校验 |
|---|---|
| 微信`wechat-rc246-delivery-final` | 165文件／1,185,186字节；163文件与Git一致，2个生成runtime／project覆盖验证通过；三海报组件与ui.4一致，七个预约／付款恢复文件与新Git一致 |
| 微信manifest SHA256 | `24a5426d0a30aa0b26ca2fe07cfbaf7cae59c3ab5c59eead849dbd80507b6d62` |
| 微信阶段门禁 | candidate为ready／local_integrity_only；upload仍blocked，29项=A17／B7／C5，不冒称平台验收通过 |
| 支付宝`alipay-rc246-delivery-final` | 151文件／1,132,998字节全部与Git一致；官方0.108.16离线编译23页，exit0 |
| 支付宝manifest SHA256 | `553560e2053121f92bcd7aa23423f9903f73268074eb0ded41262df2ca7218e9` |
| 支付宝worker及归档 | 1,197,024字节；SHA256 `fe861067a493c71b332c6e3ef10971983b2ad7300d16249ed9bbceeb5b618a5d`；21个产物永久留存在`alipay-rc246-delivery-official-compiled` |

[最终交付结果](../../outputs/system-audit-20261005/miniprogram-rc246-delivery-final-result.md)及[机器可读清单](../../outputs/system-audit-20261005/miniprogram-rc246-delivery-final-result.json)绑定此次新源码和字节。微信本地门禁、支付宝官方离线编译、浏览器几何夹具均不替代本版开发者工具、真机、平台回执、审批或独立签名；支付宝正式能力仍关闭。

真实支付／退款、实体纸票、多品牌安卓手机及整班验收需要独立证据。网页活动收银已复验375/390/844/1440宽度，未声称完成200%网页文字或门店阅读条件验收。安卓签名APK、更新源、小程序候选／官方编译／平台状态均分别记录。

## 后续主线PR #328

PR #328于12:56:56 CST合并至91f84ff59df0fff9007991d639edaad5c296828b。其[CI 37264307284](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37264307284)首次运行于12:52:55 CST成功、未重跑；PR头为ab10a625，实际CI合并预览提交为1f637c8d，不把它写成最终91f的再次执行。quality、normalized_database、normalized_browser、performance、verify、classify成功，fast_quality、docs、image按规则跳过。mini385、支付宝13、全库PG3053与浏览器121／36条件跳过、三屏18、会员8通过；130项跨维护账号为嵌套子套件，不额外累计。[精确终态／计数](../../outputs/system-audit-20261005/pr328-ci-result.md)。

初审10组及扩查2项的主线实现已进入各自合并提交；不据此宣布12项营业验收完成。海报已进入91f最终候选，仍需平台交付，短期归档修复不会回写历史归档；当前后端和Android仍以本页固定6e4部署及build8回执为准。

## Android下载与更新

新增精确`/native-updates/staff`只读入口，清单no-store、APK按固定内容名缓存，未发布返回真实404；既有Caddy继续反向代理。标准normalizer、普通部署与计划维护均绑定`/opt/mbox/native-updates/staff`到容器`/run/mbox-native-updates`，只读；16个发布脚本纳入固定清单哈希。

发布器先验证真实APK的包名/build/正式渠道/禁演练/不可调试/签名，上传不可变文件，再HTTPS下载重验摘要、字节与签名，最后按原清单摘要原子更新并保留另一平台记录；提交前失败保留旧清单，提交后回读不明沿原发布恢复。远端使用已核实的Python3.7绝对路径，不更改主机Python或Caddy配置。本次12:41回执`published=true`、`publicReadbackVerified=true`，[发布回执](../../outputs/system-audit-20261005/native-update-publish-build8.json)与[独立HTTPS回读](../../outputs/system-audit-20261005/native-update-public-ehoiy6w5/result.json)均通过。

| Android正式分发 | 已核验值 |
|---|---|
| 版本与文件 | 0.4.0-rc.3 / build8，[APK下载](https://mbox.shmbox.com/native-updates/staff/MBOX-Staff-0.4.0-rc.3-build8-6c07f67441f3.apk)，15,493,467字节 |
| APK SHA256 | `6c07f67441f39736b48ca7a8fe6de98cdbb834764af4c7da04d42d959d8e7c98` |
| 正式证书SHA256 | `05362998aab4266397f069cbcb37049176aa29eb7ab778cc7d55cfb5caa4ccc0` |
| stable清单 | [stable.json](https://mbox.shmbox.com/native-updates/staff/stable.json)，SHA256 `d7711af5bc16f3f5863bb3aea3c49c302c1197275486017a0174dfed417d12e0`，200 / no-store |
| HTTP合同 | APK200、正确MIME、immutable；preview未发布404、缺失文件真实404，不返回SPA |

独立回读经进程专用proxy完成HTTPS且TLS验证通过，不证明所有员工网络。首次探针将Caddy与应用重复的`nosniff`误作单值失败，原记录保留；校正解析并确认缺失或混杂值仍拒绝后通过，未改服务器。分发可用不等于实体手机安装成功，真实手机、旧debug证书迁移、真实收退款／纸票及整班验收仍独立开放。

13:00:09 CST最后一次只读HTTPS GET再次确认后端6e4/schema260、镜像摘要、workers健康及stable原摘要均一致，[最终回读](../../outputs/system-audit-20261005/final-production-ready-and-feed.json)通过。随后停止本任务专用proxy、删除仅本任务复制的配置，四个任务端口确认无监听，未改全局代理／DNS；[清理证据](../../outputs/system-audit-20261005/operator-cleanup.json)留存。不因收尾重复访问生产或清理发布证据。
