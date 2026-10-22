# 1.0.0-rc.265 微信订阅授权回写修复

1. 服务端：`wechat-loyalty-notification-api`、`wechat-member-service-notification-api`、`reservation-performance-notification-api` 的审计事件补上 `afterData`。生产 2026-10-22 07:34 的 500 即命令执行器 `audit event requires beforeData, afterData, or reason`，事务回滚，授权、幂等与审计均未写入。新增回归测试。
2. 小程序：订阅结果等回写完成后再跳转；优惠券入口刷新提示决策。小程序包需另行上传。
3. 决策引擎：把生产热修（积分过期提醒在 coupon_open、member_card、order_checkout 排首位）写入源码并加测试，避免部署后回退。

数据库仍为 schema 274，无新迁移。
