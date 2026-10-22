# 微信小程序 42 项跳过用例与 25 页完整复核（2026-10-22）

## 范围和当前结论

基线为主线 `1ff84bb04c629ed2696a23ed451b695b90f9fcd3`（PR390）。本轮重新同步远端确认无更新，在独立审计工作目录修复；原开发工作目录未改动。证据根目录：`/Users/jingda/mbox/outputs/miniprogram-full-audit-20261022`。

- 原浏览器基线的 42 项 skip 均有逐项来源与本轮通过记录：25 项原本已由专用 CI 组覆盖，17 项此前确实漏接 CI。本轮在 7 组独立数据库环境执行 49 项，全通过、无跳过/重试后通过，覆盖全部 42 项（另外 7 项为原本就覆盖的用例）。
- 增补发布入口遗漏的 8 个原生测试文件，过时的“源码必须长成某种形式”断言替换为原订单备注/逐份备注的真实页面重试验证。最终小程序发布测试 727 项通过，0 失败、0 跳过；含新增页面行为与点歌 API 恢复测试、覆盖核对器测试。不是 727 次真人操作。
- 25 个注册页面逐页核对功能入口、事件处理、状态读写、失败重试和异步恢复；既有点单、多数量确认、积分抵扣、会员绑定、订阅授权与本轮修复均保留。下面列出每页核查范围与相关测试。
- 微信/支付宝静态检查通过；此次只修改微信运行时代码。后端无业务代码或数据库迁移修改，保持已部署的 rc266，不重复部署。
- 官方上传、CI 和合并状态另记录于文末；测试通过不等于手机、真实资金、实际打印或真实消息送达已验收。

## 修复及防回归

| 问题 | 修复和验证 |
|---|---|
| 积分、社区、活动详情、预约旧请求覆盖新状态 | 读请求按页面代次校验，离页旧响应失效；积分和隐私数据在重读前清理。先复现后通过。 |
| 预约提醒在后台写入失败时仍显示“已申请” | 分别检查微信选择与服务端记录结果；保存未确认明确提示重试，同意/拒绝/禁用正常路径均覆盖。 |
| 预约原生授权或容量检查尚未结束，离页/改表单后继续提交 | 取消过期页面后续动作；核对确认时的表单快照；已发出的预约仍使用原幂等恢复机制。 |
| 活动重复点击在前置订阅/付款选择期间可并行报名 | 提前锁定一次点击流程，离页后不继续创建报名；已发出的付款保留原登记用于查单。 |
| 点歌重复点击、旧桌回执与断网重试 | 表单和桌台请求隔离，确认前重复点击只发一次；网络结果未知时复用原请求编号，成功后才允许新一次。 |
| 偏好页旧数据、无效生日选择与离页后的延迟导航 | 读写代次保护、生日范围校验、取消旧导航；保留原生头像选择前尚未保存的草稿；生日/饮食授权正常保存覆盖。 |
| 会员协议页入会后延迟导航影响其他页面 | 离页使响应与导航失效，入会接口事实仍由后续读取确认。 |
| 隐私联系方式重复更换/停用/更正、旧响应和成功提示消失 | 操作锁、确认取消、页面归属、读取后保留成功反馈；拒绝授权不写入，读取失败不伪报成功。 |
| 提醒设置旧保存释放新保存的忙碌状态 | 只有当前请求能改变状态；离页返回后的新操作不会被旧回执解锁。 |
| 42 项跳过长期无逐项闭环 | CI 增加 4 组共17项；每组要求准确数量且无 skip/flaky；汇总核对每个基线 skip 的文件名和用例名必须有专用组通过记录，否则失败。 |

初次把厨房批次与三屏派工环境同时启用时4项失败，已保留失败证据；厨房独立环境5项通过，三屏完整业务1项通过。两套工作流使用不同夹具/派工策略，永久分组执行；未删用例、放宽断言或把失败算作通过。

## 25 页功能矩阵

所有页面还通过 `miniprogram-page-bindings.test.mjs` 的模板事件/路由检查和官方上传编译。表中的脚本简称均指 `scripts/miniprogram-<名称>.test.*`；浏览器用例指 `tests/normalized-e2e/normalized-*.spec.ts`。原生行为测试执行实际页面/工具代码，但隔离网络及原生微信交互；它与员工网页浏览器测试是不同证据层。

| 页 | 已核查功能 | 相关行为/边界证据 |
|---|---|---|
| 1. `home` | 首页、扫码等待/换桌、演出与活动入口、推荐内容、入会邀请和分享 | home-launch-state / scan-startup / table-scope-race / membership-invite / public-share |
| 2. `brand-story` | 品牌文章、分享、独立入口返回首页 | full-page-regression / public-share |
| 3. `reservations` | 三步预约、容量/日期/演出/位置、取消、演出变更确认、提醒、原预约丢回执恢复 | reservation-recovery / full-page-regression / audit-remediation |
| 4. `order` | 分类搜索、详情图片、自选套餐、共享购物车、逐份备注、单品多数量确认、推荐、会员邀请、券/积分报价、支付及原单恢复 | quantity-review / cart-portions / checkout-coupons / checkout-upgrade / checkout-duplicate / order-entry-membership / state-recovery / portion-notes-identities |
| 5. `community` | 活动列表、有效期、报名状态、入会邀请与活动跳转 | display-recovery / activity-share / membership-invite / full-page-regression |
| 6. `community-detail` | 匿名分享预览、会员详情、套餐人数、报名条件/退款安全确认、付费/免费报名、查单取消、消息授权 | activity-share / audit-remediation / full-page-regression；数据库与浏览器活动支付相关用例 |
| 7. `profile` | 会员认领/绑定、主动退出、会员入口、偏好证据、更正撤回、积分到期提醒、兑换及记录 | membership-subscription-regression / order-entry-membership / member-progress / policy-readability / audit-remediation |
| 8. `profile-preferences` | 头像昵称、座位/服务/酒类/口味/音乐、饮食说明独立授权、生日授权与撤回 | full-page-regression / policy-readability / audit-remediation |
| 9. `profile-contact` | 门店电话、企业微信图片、客服配置与不可用提示 | full-page-regression / secondary-page-recovery / page-bindings |
| 10. `profile-coupons` | 券包、分页、去重、非会员/失败状态 | benefit-wallet / page-bindings |
| 11. `profile-cards` | 项目与卡片分页、申请确认、审核状态、撤回/退出、赠券进度 | member-cards / portion-notes-identities；浏览器 member-cards / member-gifts |
| 12. `profile-marketing` | 分渠道与用途告知、单独确认、版本冲突、撤回单渠道/全部停止 | marketing-preferences；浏览器 marketing |
| 13. `profile-bottles` | 本人存酒列表、状态、分页、刷新与会员入口 | custody；浏览器 requirements-v9 |
| 14. `profile-bottle-detail` | 本人存酒详情、取存流水、授权图片、离页清理与失败重试 | custody；浏览器 requirements-v9 |
| 15. `profile-notifications` | 积分/会员提醒状态、公众号积分逐笔通知独立开关、保存失败与重读 | official-points-notifications / membership-subscription-regression / full-page-regression |
| 16. `performances` | 日期与月份、左右翻页/滑动、场次过滤、旧日期响应隔离、分享 | public-share / audit-remediation / page-bindings |
| 17. `points` | 积分/成长值流水、零余额、到期、欠额、退款冲回、处理中、切页及重试 | full-page-regression；既有积分 API/数据库回归 |
| 18. `member-center` | 等级与进度、会员二维码时效、权益/赠品、日历与每日零食领取 | member-progress / membership-invite / audit-remediation / portion-notes-identities |
| 19. `membership-terms` | 公开协议阅读、隐私入口、明确同意与手机号授权、入会、延迟返回 | policy-readability / membership-invite / full-page-regression |
| 20. `account` | 当前桌账单/历史订单、逐份价格与备注、选单支付、旧桌与付款恢复隔离 | customer-funnel / table-scope-race / state-recovery / portion-notes-identities |
| 21. `service` | 预设/自定义服务、关联订单、负责人协助、提交幂等、进度入口 | secondary-page-recovery / recoverable-command / service-state |
| 22. `status` | 服务进度轮询、状态回读、解决/未解决反馈、换桌隔离 | service-state / audit-remediation / table-scope-race |
| 23. `complaint` | 类别、说明长度、重复点击、换桌后回执与草稿隔离 | secondary-page-recovery / recoverable-command |
| 24. `songs` | 演出选择、歌名/备注/加场意向、重复点击、换桌/离页、丢回执重试 | full-page-regression / song-recovery / recoverable-command |
| 25. `privacy` | 公开隐私政策、验证手机读取/更换/停用、报名联系更正、权限拒绝与操作结果 | policy-readability / full-page-regression / page-bindings |

## 42 项逐项核对

每行“通过组”均来自本轮 JSON 报告的成功记录。基线保留条件 skip，专用组负责实际执行；这防止混用互斥夹具，也防止以“0 skip”的表面数字掩盖未执行。

| # | 文件 / 用例 | 原跳过原因 | 之前覆盖 | 本轮通过组 |
|---|---|---|---|---|
| 1 | `normalized-all-roles-business-day.spec.ts` / 离店重做实物分份登记，最后一份丢回执仍可刷新恢复 | 需要独立重做实物夹具 | 漏接CI，本轮补齐 | remake-handover：通过 |
| 2 | `normalized-button-audit.spec.ts` / 取餐异常由受限账号明确交接，有权限账号可进入原任务且不扩大取餐权限 | requires isolated three-screen fixture | 已在专用组 | three-screen：通过 |
| 3 | `normalized-coupon-refund-review.spec.ts` / coupon refund review explicit decision and layout 320px | Requires isolated member configuration fixture | 漏接CI，本轮补齐 | member-remaining：通过 |
| 4 | `normalized-coupon-refund-review.spec.ts` / coupon refund review explicit decision and layout 360px | Requires isolated member configuration fixture | 漏接CI，本轮补齐 | member-remaining：通过 |
| 5 | `normalized-kitchen-batch.spec.ts` / 完整桌号搜索不混入其他桌订单号或编号前缀 | requires isolated kitchen fixture | 漏接CI，本轮补齐 | kitchen-batches：通过 |
| 6 | `normalized-kitchen-batch.spec.ts` / 60单180份：低高度双板、真实开批、跨页草稿、出锅释放及取送状态 | requires isolated kitchen fixture | 漏接CI，本轮补齐 | kitchen-batches：通过 |
| 7 | `normalized-kitchen-batch.spec.ts` / 真实提交成功但响应丢失：刷新后原凭据恢复，不重复开批 | requires isolated kitchen fixture | 漏接CI，本轮补齐 | kitchen-batches：通过 |
| 8 | `normalized-kitchen-batch.spec.ts` / 服务员读取真实备齐数量并送达；厨师操作不冒充送达 | requires isolated kitchen fixture | 漏接CI，本轮补齐 | kitchen-batches：通过 |
| 9 | `normalized-kitchen-batch.spec.ts` / 制作已确认时立即反馈，队列读取失败只恢复读取，不重复制作 | requires isolated kitchen fixture | 漏接CI，本轮补齐 | kitchen-batches：通过 |
| 10 | `normalized-kitchen-orientation.spec.ts` / 后厨 768×1024 竖屏开做、旋转保留份数、部分完成 | requires three-screen fixture | 已在专用组 | three-screen：通过 |
| 11 | `normalized-kitchen-orientation.spec.ts` / 后厨 600×960 竖屏开做、旋转保留份数、部分完成 | requires three-screen fixture | 已在专用组 | three-screen：通过 |
| 12 | `normalized-kitchen-orientation.spec.ts` / 后厨 390×844 竖屏开做、旋转保留份数、部分完成 | requires three-screen fixture | 已在专用组 | three-screen：通过 |
| 13 | `normalized-manual-points.spec.ts` / manual points independent review and lost receipt recovery at 320px | Requires disposable manual points fixture | 已在专用组 | member：通过 |
| 14 | `normalized-manual-points.spec.ts` / manual points independent review and lost receipt recovery at 360px | Requires disposable manual points fixture | 已在专用组 | member：通过 |
| 15 | `normalized-marketing.spec.ts` / marketing independent approvals, queue and refusal at 320px | Requires isolated fixture; no external marketing | 漏接CI，本轮补齐 | member-remaining：通过 |
| 16 | `normalized-marketing.spec.ts` / marketing independent approvals, queue and refusal at 360px | Requires isolated fixture; no external marketing | 漏接CI，本轮补齐 | member-remaining：通过 |
| 17 | `normalized-member-cards.spec.ts` / ordinary member card review and lifecycle at 320px | Requires opt-in isolated card fixture; no production permission changes | 漏接CI，本轮补齐 | member-remaining：通过 |
| 18 | `normalized-member-cards.spec.ts` / ordinary member card review and lifecycle at 360px | Requires opt-in isolated card fixture; no production permission changes | 漏接CI，本轮补齐 | member-remaining：通过 |
| 19 | `normalized-member-gifts.spec.ts` / gift campaign drafting and full review layout at 320px | Requires isolated gift fixture, no real grants | 已在专用组 | member：通过 |
| 20 | `normalized-member-gifts.spec.ts` / gift campaign drafting and full review layout at 360px | Requires isolated gift fixture, no real grants | 已在专用组 | member：通过 |
| 21 | `normalized-member-participation.spec.ts` / staff can choose attendance without registration, cancel mistakes, and choose activity separately | Requires isolated member identities; exercised by the dedicated member scan CI group | 已在专用组 | member：通过 |
| 22 | `normalized-member-participation.spec.ts` / a lost attendance response can be read back and never appears on the next scanned member | Requires isolated member identities; exercised by the dedicated member scan CI group | 已在专用组 | member：通过 |
| 23 | `normalized-member-participation.spec.ts` / real member lookup is read-only, errors are visible, and claim scanning stays on the existing path | Requires isolated member identities; exercised by the dedicated member scan CI group | 已在专用组 | member：通过 |
| 24 | `normalized-member-participation.spec.ts` / a late previous member response and a failed refresh cannot leave a different member visible | Requires isolated member identities; exercised by the dedicated member scan CI group | 已在专用组 | member：通过 |
| 25 | `normalized-member-participation.spec.ts` / lookup opens the matching activity and filters the roster without submitting check-in | Requires isolated member identities; exercised by the dedicated member scan CI group | 已在专用组 | member：通过 |
| 26 | `normalized-member-visit-rewards.spec.ts` / configurable attendance rewards require individual or daily batch approval and survive a lost reply | Requires opt-in isolated reward fixture | 已在专用组 | member：通过 |
| 27 | `normalized-requirements-v9.spec.ts` / v9 custody, export and launch configuration at 360px | requires throwaway member fixture | 漏接CI，本轮补齐 | member-remaining：通过 |
| 28 | `normalized-requirements-v9.spec.ts` / v9 custody, export and launch configuration at 1280px | requires throwaway member fixture | 漏接CI，本轮补齐 | member-remaining：通过 |
| 29 | `normalized-screen-resume.spec.ts` / kitchen 休眠唤醒后权威重读前禁止操作，重读后恢复 | requires isolated three-screen fixture | 已在专用组 | three-screen：通过 |
| 30 | `normalized-screen-resume.spec.ts` / bar 休眠唤醒后权威重读前禁止操作，重读后恢复 | requires isolated three-screen fixture | 已在专用组 | three-screen：通过 |
| 31 | `normalized-table-service.spec.ts` / zero-permission employee can inspect current/history but cannot hand over or open | Requires isolated service-history fixture | 已在专用组 | service：通过 |
| 32 | `normalized-table-service.spec.ts` / manager must select a primary, can open, then hand over with durable visible history | Requires isolated service-history fixture | 已在专用组 | service：通过 |
| 33 | `normalized-table-service.spec.ts` / desktop service directory is usable and anonymous access is denied | Requires isolated service-history fixture | 已在专用组 | service：通过 |
| 34 | `normalized-table-service.spec.ts` / service directory stays open when initial workspace finishes loading | Requires isolated service-history fixture | 已在专用组 | service：通过 |
| 35 | `normalized-three-screen-entry.spec.ts` / 取餐最小权限从普通出品入口进入，不请求桌台、不反复退回登录 | requires isolated three-screen fixture | 已在专用组 | three-screen：通过 |
| 36 | `normalized-three-screen-entry.spec.ts` / 普通出品权限拒绝保留登录，不再形成登录循环 | requires isolated three-screen fixture | 已在专用组 | three-screen：通过 |
| 37 | `normalized-three-screen-entry.spec.ts` / 后厨默认入口及返回旧页后完成新批次，不再发送错误的旧命令 | requires isolated three-screen fixture | 已在专用组 | three-screen：通过 |
| 38 | `normalized-three-screen-entry.spec.ts` / 酒水默认入口及返回旧页后完成新批次，不再发送错误的旧命令 | requires isolated three-screen fixture | 已在专用组 | three-screen：通过 |
| 39 | `normalized-three-screen-entry.spec.ts` / 后厨只有在制批次时直接展示制作中，整页刷新保留份数且不提交命令 | requires isolated three-screen fixture | 已在专用组 | three-screen：通过 |
| 40 | `normalized-three-screen.spec.ts` / 正式三屏20桌80份：制作、共同取走、撤回、手机自动同步及横屏可达 | requires isolated three-screen fixture | 漏接CI，本轮补齐 | three-screen-workflow：通过 |
| 41 | `normalized-upgrade-qualification.spec.ts` / upgrade qualification real draft persists and fits 320px | Requires isolated qualification fixture | 漏接CI，本轮补齐 | member-remaining：通过 |
| 42 | `normalized-upgrade-qualification.spec.ts` / upgrade qualification real draft persists and fits 360px | Requires isolated qualification fixture | 漏接CI，本轮补齐 | member-remaining：通过 |


## 发布与证据边界

- 候选源、包哈希、官方工具回执和上传后校验保存于证据目录。上传前后核对正式 AppID、生产 API、代码提交及全部文件，防止误上传旧 DevTools 项目。
- 本轮不发起真实顾客付款/退款、发券/积分或营销通知；数据库测试为可销毁环境。真实手机授权、真实支付退款、打印出纸和消息送达仍需现场验收。
- 微信开发版本上传不等于体验版选定、提审或正式发布；不把这些平台步骤标记完成。
- 当前上传：待官方编译上传。
- CI/合并：以本分支 PR 的完整检查及最终合并记录为准；最终机器证据保存在本轮证据目录。
