# 门店资料导入模板

先填写`go-live-input-checklist.md`汇总门店、支付、微信、云环境和验收责任；结构化且通过双签的数据再转换为`store-import-template.json`导入包。

正式资料尚未齐备时，按`../docs/pilot-validation-plan.md`执行门店验证，并使用`pilot-night-record.md`记录每晚指标、异常、责任人和结论。

`store-import-template.json` 是结构模板，不是 M-Box 陆家嘴正式门店资料。模板故意使用 `sandbox`、`draft`、示例 ID 和缺失声明，不能直接用于生产。

## 使用顺序

1. 从已签字的门店资料工作簿生成一个新导入包，不直接改正式运行态 JSON。
2. 替换所有 `example-*`、`replace-with-*` 和“必须替换”内容。
3. 先调用 `preflightStoreImportPackage(state, package)`，逐项处理带分区、行号和字段的错误/警告。
4. 展示 `preview` 中的新增、修改、删除和未变化记录，取得审批后再应用。
5. 在 RuntimeState repository 的单次事务内调用 `applyStoreImportPackage`，提交其返回的新状态。

## 完整度和覆盖策略

- `production` 要求所有分区均为 `complete`，且 `declaredMissingData` 为空。
- `partial`/`draft` 只能作为明确标记的沙盒资料；不完整分区禁止 `replace`。
- `replace` 会以导入包为该分区的完整真相，包外记录进入删除差异；`upsert` 保留包外记录。
- 不得把 `/Users/jingda/mbox/数据分析/座位数据_当前版.json` 转为正式导入包。该文件明确标记“部分完成”，只列出 A1-A10，缺少 A/C/K/W 区完整桌台、容量和责任链。

## 必填数据约束

- 所有对象为严格契约，未知字段和缺失字段都会报错，不补默认值。
- 金额单位是整数分。成本不得高于标价；是否允许零价由 `allowZeroListPrice` 明确决定。
- 时间必须是带时区偏移的 ISO 8601；班次结束时间晚于开始时间，员工未取消班次不得重叠。
- 桌台必须显式提供状态、客人数和开台时间。`occupied` 需要正客人数与开台时间，其他状态要求客人数为 0 且开台时间为 `null`。
- 每桌需要有效主责和至少一个候补。每个区域在导入营业日需要主责、候补、领班、经理四级班次覆盖。
- 停用员工必须 `online: false`、`paused: true`，且不能承担未取消班次或新责任。
- 商品 `stationId`、服务动作/话术/SLA、派单岗位和主动关怀服务类型均不可缺失。
- `authorizationAuthorities[].allowedSkuIds` 沿用现有运行态字段名，值实际是商品 `id`，不是可见 SKU 文本。
- 每项折扣/赠送权限需要不同的经营与财务审批人、审批时间和原因。当前 RuntimeState 只支持 `discount`/`gift`；退款权限模型尚未接入时，应在 `declaredMissingData` 明确记录，不能伪装为已导入。
- 本契约只覆盖当前 RuntimeState 已承载的门店主数据。支付商户、物理 POS 终端和渠道密钥仍需由支付/设备模块建模并单独联调；未接入时应明确记录为部署缺口。

## 应用保护

预检还会阻止删除或破坏进行中任务、主动点单关怀、开放桌台会话、未履约订单、会员销售归属和权益商品引用。配置变更必须使用高于当前历史最大值的 `config.version`；应用会追加配置版本记录和一条整店导入审计，`revision` 只增加一次，输入状态不会被修改。
