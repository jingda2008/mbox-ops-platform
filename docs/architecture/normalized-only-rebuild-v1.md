# M-BOX 规范化唯一数据源重建 V1

状态：已批准，实施中
基线提交：`27e9cba12947456ce83f8da16aa4eca63af731cf`
目标分支：`refactor/normalized-core-v1`

## 1. 决策

M-BOX 在正式营业数据产生前，停止为整店 `RuntimeState` 聚合、兼容投影和双写机制继续增加功能。新版本使用 PostgreSQL 规范化表作为唯一真实数据来源。

保留当前版本标签、数据库备份和发布证据，仅用于行为对照和整体回滚。测试数据库允许清空重建，不迁移模拟经营数据。

## 2. 不可妥协的边界

- 生产代码不得写入 `runtime_states` 或 `runtime_state_versions`。
- 不保留整店 JSON 到规范化表的投影，也不保留反向镜像。
- 不使用全局 `mutationTail`、整店 CAS、整店深拷贝或整店序列化。
- 业务命令只锁定目标订单、桌次、任务、库存批次或预约锁。
- 领域更新、事件、审计和 Outbox 必须在同一数据库事务提交。
- SLA、预约释放、Outbox 和营业日任务使用 `FOR UPDATE SKIP LOCKED` 分批领取。
- 退款、赠送、现金确认等高风险动作继续保留权限、人工确认和审计，不交给模型自主完成。
- API 状态码、错误信封、权限裁剪和现有页面需要的字段先冻结；兼容由查询层完成，不由双写完成。

## 3. 目标模块

### 写模型

| 领域 | 权威表 | 领域仓储 |
| --- | --- | --- |
| 桌台 | `tables`, `table_sessions`, `table_assignments` | `TableRepository`, `TableSessionRepository` |
| 服务 | `service_tasks`, `service_task_events` | `ServiceTaskRepository` |
| 订单 | `orders`, `order_items` | `OrderRepository` |
| 出品 | `kds_tasks`, `kds_task_events` | `KdsRepository` |
| 库存 | `inventory_movements`, `inventory_balances` | `InventoryRepository` |
| 支付 | `payments`, `refunds`, `reconciliation_entries` | `PaymentRepository`, `RefundRepository` |
| 预约 | `reservations`, `reservation_table_locks` | `ReservationRepository` |
| 客户 | `customers`, `customer_profiles`, `benefits` | `CustomerRepository`, `BenefitRepository` |
| 演出 | `performers`, `schedules`, `song_requests` | `PerformanceRepository` |
| 通知 | `outbox_messages`, `notifications` | `OutboxRepository`, `NotificationRepository` |
| 审计 | `audit_events` | `AuditRepository` |

商品、权限、价格和配方等历史快照可在单行中使用 JSONB；禁止将整个门店状态放入单行 JSONB。

### 读模型

页面数据由 SQL 查询服务组合。短期保持现有 HTTP JSON 字段，逐步将 `/api/bootstrap` 拆为桌台、任务、KDS、支付、演出和配置工作区接口。`revision` 改为规范化变更序号，ETag 和 304 行为保持不变。

## 4. 实施顺序

1. 建立干净迁移目录、事务上下文、RLS、幂等、审计和 Outbox。
2. 迁移开台、关台、桌台责任和客户服务任务。
3. 迁移商品、订单、KDS、库存扣减和配送任务。
4. 迁移支付、退款、对账、现金和物理 POS 证据。
5. 迁移预约、锁台、客户、权益和候位。
6. 迁移演出、点歌、通知、SOP、AI执行、硬件、成本和经营工具。
7. 拆除 Bootstrap 对 RuntimeState 的继承，删除旧仓储、投影器、运行态迁移和兼容测试。
8. 全新数据库从零初始化，执行全量功能、并发、性能、安全和浏览器验收。

第一条端到端切片固定为：

```text
开台
  -> 客户提交服务需求
  -> service_tasks + service_task_events
  -> audit_events + outbox_messages
  -> 员工查看并完成
  -> 客户轮询后需求消失
  -> SLA worker 多实例安全升级
```

## 5. 兼容契约

重构期间必须固定：

- 客户桌码、会话轮换、翻台隔离和限频。
- 各岗位可见范围、权限拒绝和错误原因。
- KDS 排序、岗位分流、取消、异常和配送流程。
- 支付验签、幂等回调、退款审批和金额来源。
- 预约锁台、跨午夜营业日和候位规则。
- API 状态码、错误信封、排序、ETag 和缓存头。

“前端不受影响”是验收目标，不是无需验证的事实。每迁移一个领域，必须用契约测试证明页面未退化。

## 6. 发布与回滚

新架构不支持“旧镜像连接新数据库”或“只回滚容器”。发布单元必须绑定：

```text
提交 SHA
+ 应用镜像摘要
+ 规范化迁移集合及校验和
+ 初始化数据版本
+ 数据库快照
+ 测试与性能证据
```

回滚时整体恢复匹配的镜像、Schema、配置和数据快照。规范化候选通过前，不切换当前阿里云员工验证环境。

## 7. 完成标准

- 生产代码中 `repository.mutate()` 为 0。
- 生产代码不引用 `runtime_states`、`RuntimeRepository` 或兼容投影。
- 不存在全局写队列、整店复制、整店序列化和整店 CAS。
- 不同桌台的 KDS、服务和订单可以并行执行。
- 5 RPS 持续负载不累计落后，错误率和不一致数为 0。
- 写入延迟 P95/P99 达到质量模型阈值。
- 全新数据库从零迁移、初始化并通过全部测试。
- 原有测试完成契约化改造，新增事务、RLS、幂等、并发领取和回滚测试。
- 只有不可变提交级 CI、证据包和部署后 SHA 一致时才允许切流。
