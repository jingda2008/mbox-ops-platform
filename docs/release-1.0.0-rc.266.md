# 1.0.0-rc.266 认领会员时绑定微信身份

1. 服务端：`enroll-with-phone` 校验 `x-mbox-wechat-identity` 微信会话，在入会事务内把微信身份绑定到会员顾客（linked / already_linked / moved_from_guest / moved_from_legacy_member / conflict_other_member），审计 afterData 记录结果与原顾客。
2. 小程序：`utils/auth.js` 新增 `obtainWechatIdentityForMembership`，`utils/api.js` 入会请求携带该令牌。小程序需重新上传。
3. 测试：`server/normalized/membership-wechat-identity-binding.test.ts`。

数据库仍为 schema 274，无新迁移。
