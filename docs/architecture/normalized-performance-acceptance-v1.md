# M-BOX规范化架构性能与并发验收 V1

## 1. 目的与边界

本工具验证规范化写入架构在持续5个业务到达/秒时，能否保持稳定吞吐、无累计积压和KDS一致性。它不读取`runtime_states`，不依赖整店JSON、兼容投影或全局串行写队列。

工具只使用合成测试标识，不包含员工PIN、支付密钥、数据库密码、手机号或真实客户资料。授权令牌只能通过进程环境变量传入，报告不会记录令牌、URL查询参数或URL账号密码。

## 2. 场景模型

四个场景按顺序、相互隔离地分别以5 RPS运行。默认每个场景持续60秒，共300个业务到达。

| 场景 | 被测动作 | 说明 |
| --- | --- | --- |
| 不同桌台开台 | 开台 | 在至少两张测试桌之间轮换；开台延迟纳入统计，清理关闭不纳入统计 |
| 订单提交 | 服务端定价并提交订单 | 每单一个测试商品；响应必须返回真实KDS任务ID |
| KDS开始/完成 | 按订单返回的任务ID开始制作后完成 | 分别记录开始和完成延迟；检测重复任务ID、岗位越权与状态不一致 |
| 服务任务流转 | 创建、知晓、执行、完成 | 四个状态请求都纳入该业务流的延迟与错误统计 |

这里的5 RPS是**每个场景的业务到达率**。KDS和服务任务属于多请求业务流，因此该场景产生的HTTP请求数会高于5 RPS；报告会同时输出业务到达率和实际请求样本数，避免混淆。

## 3. 真实服务接口约定

默认接口如下，可通过`NORMALIZED_ACCEPTANCE_ENDPOINTS_JSON`整体覆盖：

```json
{
  "ready": "/api/ready",
  "tableOpen": "/api/table-sessions",
  "tableBeginClose": "/api/table-sessions/{sessionId}/begin-closing",
  "tableClose": "/api/table-sessions/{sessionId}/close",
  "assistedOrderContext": "/api/commerce/assisted-order-contexts",
  "orderSubmit": "/api/commerce/orders",
  "kdsAction": "/api/commerce/kds/{taskId}/actions",
  "serviceCreate": "/api/service-tasks",
  "serviceTransition": "/api/service-tasks/{taskId}/{transition}"
}
```

测试环境必须提供至少两张可反复开关的桌台；正式60秒验收建议提供10张以上，避免低性能响应与测试桌复用造成非业务冲突。还需提供一个有有效价格与配方的商品、服务员工、出品员工和KDS工位。通过`NORMALIZED_ACCEPTANCE_FIXTURES_JSON`传入：

```json
{
  "tableIds": ["test-table-uuid-1", "test-table-uuid-2"],
  "productId": "test-product-uuid",
  "serviceEmployeeId": "test-service-employee-uuid",
  "productionEmployeeId": "test-production-employee-uuid",
  "stationCode": "bar"
}
```

这些必须是专用测试数据，不得使用真实客户或真实支付资料。服务端必须允许同一测试桌次提交多单，并在订单响应中返回`kdsTaskIds`或`kdsTasks[].id`。

## 4. 运行方式

无真实规范化API时，先验证统计和门禁：

```bash
node scripts/normalized-load-acceptance.mjs --mock --duration-seconds=2
```

连接测试服务：

```bash
BASE_URL=https://validation.example.test \
NORMALIZED_ACCEPTANCE_SERVICE_TOKEN='<temporary-service-token>' \
NORMALIZED_ACCEPTANCE_PRODUCTION_TOKEN='<temporary-bartender-or-kitchen-token>' \
NORMALIZED_ACCEPTANCE_FIXTURES_JSON='<test-fixture-json>' \
node scripts/normalized-load-acceptance.mjs \
  --duration-seconds=60 \
  --output=/tmp/normalized-load-acceptance.json
```

标准输出始终是机器可读JSON。`--output`文件权限为仅当前用户可读写。门禁失败时进程退出码为1。

## 5. 默认门禁

| 门禁 | 默认标准 |
| --- | --- |
| 到达与完成吞吐 | 每场景5 RPS，实际到达率和稳定完成吞吐均不低于目标的98% |
| 错误率 | 每场景不高于0.1% |
| 延迟 | 每场景P95不高于500ms，P99不高于1000ms |
| 调度延迟 | P95不高于100ms，P99不高于200ms |
| 累计落后 | 最终客户端在途数为0，积压斜率不高于0.1个/秒 |
| 排空时间 | 最后一次到达后1000ms内完成全部在途请求 |
| KDS重复领取 | 0 |
| KDS状态不一致 | 0 |
| 幂等冲突 | 未知冲突、请求内容不一致、仍处理中均为0；安全重放单独计数但不算错误 |

阈值可以通过`NORMALIZED_ACCEPTANCE_THRESHOLDS_JSON`覆盖，但正式发布证据必须记录实际阈值，不能通过临时放宽阈值伪造通过。

## 6. 报告结构

```text
schemaVersion
run
workload
scenarios
  tableOpen
  orderSubmit
  kdsPrepareComplete
  serviceTaskFlow
    summary: 请求数、错误率、状态码、P50/P95/P99
    arrival: 目标/实际到达RPS、完成吞吐、调度延迟、并发峰值
    backlog: 初始、峰值、最终、斜率、排空时间
consistency
  kdsDuplicateClaims
  kdsInconsistentStates
  idempotencyConflicts
gate
  passed
  thresholds
  checks
  failures
```

报告不保存每个请求正文、授权头或客户信息。错误只保留短错误码，不保存完整响应体。

## 7. 结论限制

Mock通过只证明统计、分类和门禁逻辑可运行，不证明真实数据库、API或服务器达到性能目标。正式架构验收必须在全新规范化测试数据库、与目标部署同规格的服务实例上运行真实模式，并把JSON报告、提交SHA、镜像摘要和数据库迁移版本一起保存。

本工具观测的是客户端到达与完成积压。数据库锁等待、连接池等待、Outbox积压和SQL执行时间仍应由服务端指标补充；两类证据都通过后才能认定规范化架构达到商业发布标准。
