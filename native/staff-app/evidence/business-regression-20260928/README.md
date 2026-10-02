# 日常经营增量汇总回归

最后更新：2026-09-28 03:43 CST

- iOS全部16个测试脚本退出码0，共581项检查；Android132个JUnit通过，两端构建成功。Swift结果见swift/results.json，Android原始XML见android-junit。
- 网页兼容：服务端/网页类型检查、326项检查、正式Web构建通过；该快速脚本13项DB跳过，不计为已通过。新增业务分别在隔离PostgreSQL运行，见拆并桌/任务/预约、安全登录/新建预约、会员、观察、体验任务各证据目录。不同批次存在重叠，不累加为唯一用例总数。
- 本轮持续补齐：人员拆并桌；服务任务中心/主管/转交；跨桌合批与参考计时/制作送达历史；预约状态/优先安排/多桌新建；安全登录恢复；会员查询/签到撤销/奖励审批；观察确认/修订/推荐调整；体验原节点与计划同步。已有支付及换品流程继续回归。
- 模拟器安装/启动：iPhone与Android均已更新。截图为本机演练启动，**不代表新增真实业务页面点击验收**。未用生产账号写营业数据。
- iOS启动实际发现Keychain -34018：原脚本关闭签名导致模拟器授权缺失。现由Xcode构建签名并嵌入Simulator.entitlements（仅iphonesimulator）；隔离非凭据探针验证真实SecItem写/读/更新/杀进程恢复/删除。16项session单测重跑通过。正式设备仍需实际Apple团队签名及真机钥匙串验收。
- 苹果授权依据：[Keychain默认应用授权](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps)、[errSecMissingEntitlement](https://developer.apple.com/documentation/security/errsecmissingentitlement)。模拟器修复结论同时以本目录实际探针日志为证。
- 未提交/推送/部署，生产网页没有本轮上线变更。库存/存酒、完整会员权益、预约配置与候位入座、未来责任安排、经营管理/演出/设备配置、制作撤销/完整实物收尾、失联员工未决接管、推送/完整录音、正式分发与升级等继续按BUSINESS_DEVELOPMENT和FEATURE_PARITY开放，**未全部完成**。
