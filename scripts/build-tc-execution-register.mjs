import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const baselinePath = resolve(root, 'docs/comprehensive-operating-test-cases.md')
const packageDocument = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const version = packageDocument.version
const versionSlug = version.replaceAll('/', '-')
const reportPath = resolve(root, `docs/tc-execution-report-${versionSlug}.md`)
const csvPath = resolve(root, `docs/tc-execution-register-${versionSlug}.csv`)
const blockersPath = resolve(root, `docs/tc-release-blockers-${versionSlug}.csv`)
const checkMode = process.argv.includes('--check')
const existingExecutionDate = existsSync(reportPath)
  ? readFileSync(reportPath, 'utf8').match(/^执行日期：`(\d{4}-\d{2}-\d{2})`$/m)?.[1]
  : undefined
const executionDate = process.env.MBOX_TC_EXECUTION_DATE?.trim()
  || existingExecutionDate
  || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())

const baseline = readFileSync(baselinePath, 'utf8')
const testCases = [...baseline.matchAll(/^\| ((?:PER|GST|SVC|ORD|PAY|MBR|SNG|INV|INC|SEC|PKC)-\d{3}) \| (P[0-3]) \| ([^|]+) \| ([^|]+) \|$/gm)]
  .map((match) => ({
    id: match[1],
    priority: match[2],
    scenario: match[3].trim(),
    expected: match[4].trim(),
  }))

if (testCases.length !== 213) throw new Error(`Expected 213 operating TCs, found ${testCases.length}`)

function ids(prefix, ranges) {
  return ranges.flatMap(([start, end = start]) =>
    Array.from({ length: end - start + 1 }, (_, index) => `${prefix}-${String(start + index).padStart(3, '0')}`),
  )
}

const passed = new Set([
  ...ids('PER', [[1, 4], [6], [20, 21], [24, 30]]),
  ...ids('GST', [[1, 17], [24, 40]]),
  ...ids('SVC', [[1, 18], [20]]),
  ...ids('ORD', [[1, 20]]),
  ...ids('PAY', [[13, 15], [19]]),
  ...ids('MBR', [[1, 12]]),
  ...ids('SNG', [[1, 7], [10, 11], [13, 14]]),
  ...ids('INV', [[1, 12]]),
  ...ids('SEC', [[1, 15]]),
  ...ids('PKC', [[1, 3], [5, 6], [8]]),
])

const blocked = new Set([
  ...ids('PAY', [[1, 4], [7, 12], [16, 18], [20]]),
  'INC-015',
  'PKC-004',
])

const ownersByDomain = {
  PER: '李艳、乌鸦',
  GST: '李艳、Tom、Jerry、Tyke',
  SVC: '李艳、Tom、Jerry、Tyke',
  ORD: '冷言志、申良良、Tom、Jerry、Tyke',
  PAY: '三沐、李艳、护古、陈方宇',
  MBR: '乌鸦、护古、李艳',
  SNG: '付淳羽、阿金、李艳',
  INV: '冷言志、申良良、李艳、护古',
  INC: '李艳、护古、陈方宇',
  SEC: '乌鸦、李艳',
  PKC: '乌鸦、李艳、护古',
}

const evidenceByDomain = {
  PER: 'authorization、pilot-auth、presence、multi-role及staff-access-matrix自动化回归',
  GST: 'reservation、table-access、table-operations、table-transfer、waitlist及proactive-service自动化回归',
  SVC: '服务任务、限流、SLA升级、通知失败保留与接单到完成闭环自动化回归',
  ORD: '订单、KDS、错品/缺货/重做、送达及库存消耗集成回归',
  PAY: '支付领域、退款、双人审批、幂等、拆单和服务商适配器工程回归',
  MBR: '权益发放、额度审批、匿名身份、同意状态、通知跳过和Outbox重试回归',
  SNG: '歌手资料、当日排班、倒计时、点歌状态机及可见性回归',
  INV: '收货、成本快照、盘点、存酒取用/转赠/作废、双人审批及幂等回归',
  INC: '系统兜底能力回归；事故动作本身仍由门店现场演练',
  SEC: '角色/API越权、签名固定桌码、离线隔离、通知降级、配置回滚及响应式页面回归',
  PKC: '300人/75桌/613请求压力回归、闭店阻断和PostgreSQL并发一致性回归',
}

const exactEvidence = {
  'PER-026': 'presence.test.ts：主责离线后任务重新打开并进入责任链，恢复登录不会自动夺回任务',
  'GST-024': 'proactive-service.test.ts：员工显式标记后按配置时间生成一次主动关怀任务，下单后自动关闭',
  'GST-025': 'proactive-service.test.ts：延后15/30/60分钟期间不生成任务，到期只恢复一次提醒并留审计',
  'SVC-018': 'sop-engine.test.ts：事件触发、多步骤计时、前一步完成依赖、停止条件、品类筛选、岗位派单、转桌跟随及幂等回归',
  'SVC-015': 'notification-runtime/dispatch测试：通知失败不删除核心任务，指数退避、失败监控和人工重试均留审计',
  'ORD-017': 'order-domain及kds-exception-api测试：错品关联原KDS生成唯一补做任务，原记录不删除',
  'ORD-018': 'order-domain及inventory-order-integration测试：质量退回后重做关联原品项并单独记录库存耗用',
  'MBR-006': 'benefit-domain/redemption测试：权限内发放、越权审批、客户权益可见及通知状态同步',
  'MBR-009': 'benefit-domain测试：未同意营销的会员权益到账但通知状态为skipped',
  'MBR-010': 'notification-dispatch/wechat-notification-adapter测试：限流重试有上限且不重复发权益',
  'INV-005': 'inventory-api及product-cost-policy测试：收货批次、单位、成本和历史成本快照不可追改',
  'INV-006': 'inventory-api/domain测试：盘盈盘亏进入待确认，额度与独立审批强校验',
  'INV-007': 'inventory-api/domain测试：存酒绑定客户、桌次、封签、位置、数量和到期时间',
  'INV-008': 'inventory-domain测试：存酒部分取用不超余量，幂等重试不重复扣减',
  'INV-009': 'inventory-api、inventory-domain及dual-approval测试：转赠总量守恒且发起人不能自批',
  'INV-010': 'inventory-api、inventory-domain及dual-approval测试：作废/过期保留原批次、原因和独立审批',
  'SEC-007': 'table-access及guest-api测试：固定桌码只交换绑定桌台当前桌次，无有效桌次或伪造桌号均拒绝',
  'SEC-012': 'notification-runtime/dispatch测试：通道失败时核心任务保留在员工/管理端队列并进入重试和人工接管',
  'SEC-014': 'Cloud SQL隔离PITR恢复演练：14个迁移、73张强制RLS表、状态校验和及版本日志一致，详见tc-restore-drill-1.0.0-rc.13.md',
  'PKC-008': 'business-day-api测试：开放桌、支付未知、退款失败、投诉和进行中点歌均阻止闭店并返回交接项',
}

function resultFor(testCase) {
  if (passed.has(testCase.id)) return '通过'
  if (blocked.has(testCase.id)) return '阻塞'
  return '未执行'
}

function executionMode(result) {
  if (result === '通过') return '自动化/云端证据'
  if (result === '阻塞') return '外部生产联调'
  return '门店现场执行'
}

function pendingReason(testCase, result) {
  if (result === '通过') return exactEvidence[testCase.id] ?? evidenceByDomain[testCase.id.slice(0, 3)]
  if (result === '阻塞') {
    if (testCase.id === 'INC-015') return '需真实微信、星驿和物理POS同时不可用的门店降级演练记录'
    if (testCase.id === 'PKC-004') return '需星驿/微信生产商户参数、真实小额流水及高峰回调/查单/退款记录'
    return '需星驿/微信生产商户参数、KYC、真实小额支付/退款及渠道流水号'
  }
  if (testCase.id.startsWith('INC-')) return '必须由门店按应急预案现场演练，上传脱敏照片、时间线、负责人和复盘记录'
  return '必须由对应真实岗位在门店设备和网络下执行，记录业务对象ID、审计事件和脱敏截图'
}

const rows = testCases.map((testCase) => {
  const result = resultFor(testCase)
  const domain = testCase.id.slice(0, 3)
  return {
    ...testCase,
    result,
    executionMode: executionMode(result),
    owners: ownersByDomain[domain],
    evidence: pendingReason(testCase, result),
  }
})

const counts = rows.reduce((summary, row) => {
  summary[row.result] = (summary[row.result] ?? 0) + 1
  return summary
}, {})
const releaseBlocking = rows.filter((row) => row.result !== '通过' && (row.priority === 'P0' || row.priority === 'P1'))
const p0p1Breakdown = releaseBlocking.reduce((summary, row) => {
  const key = `${row.priority}-${row.result}`
  summary[key] = (summary[key] ?? 0) + 1
  return summary
}, {})

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function csvDocument(headings, bodyRows) {
  return `\uFEFF${[headings, ...bodyRows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

const csv = csvDocument(
  ['TC编号', '优先级', '情况与关键步骤', '预期结果', '执行状态', '执行版本', '执行方式', '责任人', '证据/待办'],
  rows.map((row) => [row.id, row.priority, row.scenario, row.expected, row.result, version, row.executionMode, row.owners, row.evidence]),
)

const blockersCsv = csvDocument(
  ['TC编号', '优先级', '状态', '责任人', '执行场景', '通过条件', '必须提交的证据'],
  releaseBlocking.map((row) => [
    row.id,
    row.priority,
    row.result,
    row.owners,
    row.scenario,
    row.expected,
    row.evidence,
  ]),
)

const report = `# M-BOX 213条经营TC执行报告

执行日期：\`${executionDate}\`
执行版本：\`${version}\`
时区：\`Asia/Shanghai\`
原始基线：[comprehensive-operating-test-cases.md](comprehensive-operating-test-cases.md)
逐条登记：[${`tc-execution-register-${versionSlug}.csv`}](${`tc-execution-register-${versionSlug}.csv`})
发布阻断：[${`tc-release-blockers-${versionSlug}.csv`}](${`tc-release-blockers-${versionSlug}.csv`})

## 结论

本轮基线共 **213条**，没有删除或放宽原始预期。\`${version}\`重新核对结果：

| 状态 | 数量 | 判定口径 |
|---|---:|---|
| 通过 | ${counts['通过'] ?? 0} | 有直接自动化、云端闭环、浏览器检查或压力测试证据 |
| 未执行 | ${counts['未执行'] ?? 0} | 必须由真实岗位、真实设备或门店现场完成，不能用单元测试冒充 |
| 阻塞 | ${counts['阻塞'] ?? 0} | 缺真实支付参数、外部流水或第三方生产通道 |
| 失败 | ${counts['失败'] ?? 0} | 已执行但结果不符合预期；本轮为0 |

**商业生产发布结论：不通过发布门禁。** 当前仍有 **${releaseBlocking.length}条 P0/P1** 未达到“通过”：${p0p1Breakdown['P0-阻塞'] ?? 0}条P0阻塞、${p0p1Breakdown['P0-未执行'] ?? 0}条P0未执行、${p0p1Breakdown['P1-阻塞'] ?? 0}条P1阻塞、${p0p1Breakdown['P1-未执行'] ?? 0}条P1未执行。

## rc.13重新验收

- TC版本和产物文件名由\`package.json\`自动生成，不再固定写死为rc.11。
- 每条记录增加执行版本、执行方式和责任人；发布阻断另生成独立CSV。
- 服务员开台、转桌、合台/加桌、结台翻台已纳入桌台权限和接口回归。
- 客人暂不点单新增15/30/60分钟延后提醒；延后期间不重复打扰，到期只恢复一次提醒。
- 错品/退回补做、权益同意与通知失败、收货盘点、存酒全链路、固定桌码安全、通知降级和闭店阻断改用现有直接证据重新判定。
- Cloud SQL已完成隔离时间点恢复演练并删除临时实例；恢复数据的迁移、RLS、校验和、版本日志和rc.13权限一致。
- 全量测试数量、提交、镜像、云端修订版和依赖审计以[自动发布证据](release-evidence.generated.md)为准，TC报告不再复制易过期的数字。

## 尚未完成的责任

1. 李艳组织真实岗位在手机、平板、收银PC、吧台/后厨KDS和门店网络执行所有“未执行”项。
2. 三沐、李艳、护古、陈方宇完成真实支付、退款、POS、现金、对账和日结，资金发起人与审批人必须分离。
3. 冷言志、申良良、付淳羽、阿金完成缺岗、出品、演出、灯光音响和应急场景。
4. 乌鸦逐条收集执行人、时间、业务对象ID、审计事件、外部流水和脱敏截图；没有证据不得改为通过。
5. 李艳与护古只能共同批准确实不适用的用例，不能用“不适用”隐藏未执行或失败。

## 发布门禁

只有同时满足以下条件才允许商业生产发布：所有P0/P1通过；真实支付/退款/对账通过；连续至少3个真实营业晚班达到SLA；现场应急与恢复演练通过；发布负责人签字并保留回退证据。验证环境可以继续执行TC，但不得接真实顾客生产资金。
`

function writeOrVerify(path, content) {
  if (checkMode) {
    if (readFileSync(path, 'utf8') !== content) throw new Error(`TC execution artifact is stale: ${path}`)
    return
  }
  writeFileSync(path, content)
}

writeOrVerify(csvPath, csv)
writeOrVerify(blockersPath, blockersCsv)
writeOrVerify(reportPath, report)

console.log(JSON.stringify({
  mode: checkMode ? 'check' : 'write',
  version,
  total: rows.length,
  counts,
  releaseBlocking: releaseBlocking.length,
  reportPath,
  csvPath,
  blockersPath,
}, null, 2))
