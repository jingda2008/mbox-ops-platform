# 门票草稿：[经确认的营业桌台] 名单对照

此为开发用只读对照，不开售、不导入，不停用、删除、改名或迁移营业桌。当前用于营业的桌号为业务基准。曾在营业系统保留但不再排台的旧号，可能仍是“可用”；反过来，“营业中”列表受当班占用、待办及人员分配影响，不能替代门店完整名单。历史配置只用于发现差异，不自动加入。

## 取两份同范围资料

1. 由获准的门店负责人，从员工系统的完整桌台视图核对现行桌号与归属区域。完整桌台视图需要相应的全桌权限；可结合门店的区域图，逐项排除仅为旧桌次保留的行。不以单次已开桌筛选为名单。保存确认时间、来源、门店 ID，及完整的 `[{code,areaCode}]`。这里的区域编码是系统编码，不能用自由填写的显示名。
2. 同时取得同租户同门店的桌台档案快照，只需采集时间、稳定桌台 ID、桌号、区域编码、桌台状态、区域状态，以及现票务名单包含的桌台 ID。不要携带桌次、客户、订单、票号、二维码或营销数据。
3. 复核差异，不改业务档案；没拿到完整快照、桌号重复、区域不一致或桌台不可用均不执行导入。桌号精确匹配，不把 A01 自动合并成 A1。已确认稳定 ID 的桌台可填 `expectedTableId`，同号对应不同实体时不通过。

输入格式（虚拟桌号，仅示意）：

    confirmed-roster.json
    { "tenantId": "<UUID>", "storeId": "<UUID>", "complete": true,
      "source": "已核对的门店营业桌台档案", "confirmedAt": "2026-11-24T15:20:00+08:00",
      "tables": [{ "code": "A1", "areaCode": "indoor" }] }

    scoped-master-snapshot.json
    { "tenantId": "<同一租户UUID>", "storeId": "<同一门店UUID>",
      "capturedAt": "2026-11-24T15:21:00+08:00",
      "tables": [{ "id": "<稳定桌台UUID>", "code": "A1", "areaCode": "indoor",
                   "areaStatus": "active", "status": "available" }],
      "existingTicketTableIds": [] }

运行 `node scripts/plan-ticket-table-roster.mjs confirmed-roster.json scoped-master-snapshot.json`。只有完整、无冲突的名单才产生 `ticketWhitelist` 和增加/保留/移出名单差异；并不产生 SQL 或写入数据库。未选可用桌只是排除于本次方案，不能推断其已退休。阻断时输出冲突，且没有可应用的名单；不可从局部成功推导完整名单。保留采集时间和 `snapshotFingerprint`。它对同一范围内桌台身份、状态、桌区和已有票务名单签名，输入顺序不影响结果；只用于发现差异，不代表实际来源经验证。若将来获准导入，重新取同范围快照，比对指纹后才交给授权的导入流程。

## 候选验收与开售边界

- `node --test scripts/plan-ticket-table-roster.test.mjs` 运行合成数据对照。
- `MBOX_BROWSER_EXECUTABLE=/path/to/chromium node --test scripts/table-ticket-roster-draft-browser.test.mjs` 以真实页面组件、合成 API 测试桌区切换、草稿、名册变更、未选不保存、禁止上架。测试服务器仅监听回环地址，不访问门店系统。
- 找到真实名单后，名单导入仍需基于最新快照单独评审和授权。草稿可保存指定范围，不计为实时可售；购票、并发库存、订桌、开桌、排桌、改期、正式发布都不由这份工具执行。

## 名单核对后的隔离验收

1. 先按代码和区域把「配置且现行可排」「历史保留」「未能分类」分开。空台代表当前无正在使用的桌次，不代表该号码已退出营业名单。若尚有未能分类的桌台，不能把部分名单声明为完整；先测试最小合成名单，不为任何真实桌台写白名单。
2. 在隔离数据库用三个不同身份的桌台验证：现行新号、同区保留旧号、异区现行号。只有经过确认且同区在用的稳定 ID 出现在草稿选项。把原草稿中的一桌从隔离白名单移除，刷新需重新选桌，不能静默改成全区。
3. 导入前后只对比票务白名单；营业桌台表及行、区域映射、历史桌次、历史票档、已购票、现有预订和扫码关系应逐项一致。验证有权复核的账户和旧客户端、单笔与批量都不能发布指定桌台的候选。不要执行数据库首次迁移或演练于营业库。
4. 尚未实现限定桌位库存、门店预订和开桌互斥、原票排桌及改期，不以名单核对或草稿显示作为开售验收。

### 只读视图的分类候选（不能导入）

`scripts/build-ticket-table-roster-candidate.mjs` 可以把同一快照中的「配置并实际读回」「有日期的营业操作」「门店确认在用」「仅历史保留」分组做全覆盖、无重复核对，输出按桌区的独立候选。它不生成稳定 ID 或可导入清单。实际门店证据与候选应受控保管，不提交仓库。命令的两个参数为版本化配置和已分类的只读视图 JSON；视图输入须给出 `profileVersion`、`sources`（`liveView`、`ownerConfirmation`、`historicRetention`）、`liveRows`（`[{code,areaLabel}]`）、`datedOperations`、`ownerConfirmed`、`historicRetained`。单测：`node --test scripts/build-ticket-table-roster-candidate.test.mjs`。如果区域编码仅从同名配置映射，仍要用实际授权的同范围快照回查。
