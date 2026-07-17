import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const baselinePath = resolve(root, 'docs/comprehensive-operating-test-cases.md')
const reportPath = resolve(root, 'docs/tc-execution-report-2026-07-17.md')
const csvPath = resolve(root, 'docs/tc-execution-register-2026-07-17.csv')
const checkMode = process.argv.includes('--check')

const baseline = readFileSync(baselinePath, 'utf8')
const testCases = [...baseline.matchAll(/^\| ((?:PER|GST|SVC|ORD|PAY|MBR|SNG|INV|INC|SEC|PKC)-\d{3}) \| (P[0-3]) \| ([^|]+) \| ([^|]+) \|$/gm)]
  .map((match) => ({
    id: match[1],
    priority: match[2],
    scenario: match[3].trim(),
    expected: match[4].trim(),
  }))

if (testCases.length !== 213) {
  throw new Error(`Expected 213 operating TCs, found ${testCases.length}`)
}

function ids(prefix, ranges) {
  return ranges.flatMap(([start, end = start]) =>
    Array.from({ length: end - start + 1 }, (_, index) => `${prefix}-${String(start + index).padStart(3, '0')}`),
  )
}

const passed = new Set([
  ...ids('PER', [[1, 4], [6], [20, 21], [24, 25], [27, 30]]),
  ...ids('GST', [[1, 17], [26, 40]]),
  ...ids('SVC', [[1, 14], [16, 18], [20]]),
  ...ids('ORD', [[1, 16], [19, 20]]),
  ...ids('PAY', [[13, 15], [19]]),
  ...ids('MBR', [[1, 5], [7, 8], [11, 12]]),
  ...ids('SNG', [[1, 7], [10, 11], [13, 14]]),
  ...ids('INV', [[1, 4], [11, 12]]),
  ...ids('SEC', [[1, 6], [8, 11], [13], [15]]),
  ...ids('PKC', [[1, 3], [5, 6]]),
])

const blocked = new Set([
  ...ids('PAY', [[1, 4], [7, 12], [16, 18], [20]]),
  ...ids('MBR', [[6], [9, 10]]),
  'INC-015',
  'PKC-004',
])

const evidenceByDomain = {
  PER: '569项自动化测试；13名真实员工云端登录与权限隔离检查',
  GST: 'reservation/table-access/table-transfer/waitlist测试；固定桌码签名交换',
  SVC: '服务任务、限流、升级链测试；云端L01接单→到桌→完成→客人确认闭环',
  ORD: '订单、KDS、履约、库存集成测试；移动端购物车视觉交互检查',
  PAY: '支付领域、退款、双人审批、幂等和服务商适配器模拟测试',
  MBR: '匿名身份、会员、权益发放/核销、活动审批和隐私边界测试',
  SNG: '歌手资料、当日排班、倒计时、点歌状态机测试',
  INV: '库存领域、并发预占、订单消耗和配置版本测试',
  INC: '仅完成系统兜底能力测试；必须由门店执行现场演练',
  SEC: '角色/API越权、签名桌码、离线幂等、配置回滚测试；390/1024/1200视觉检查',
  PKC: '300人/75桌/613请求合成峰值测试，0请求失败、0流程失败、0负库存',
}

function resultFor(testCase) {
  if (passed.has(testCase.id)) return '通过'
  if (blocked.has(testCase.id)) return '阻塞'
  return '未执行'
}

function noteFor(testCase, result) {
  if (result === '通过') return evidenceByDomain[testCase.id.slice(0, 3)]
  if (result === '阻塞') return '系统模拟链路已测；待真实微信/星驿支付、物理POS或第三方通知生产凭证'
  if (testCase.id.startsWith('INC-')) return '待李艳组织门店员工按应急预案现场演练并上传证据'
  return '系统准备项已回归；仍需对应岗位在真实设备/现场场景执行完整步骤'
}

const rows = testCases.map((testCase) => {
  const result = resultFor(testCase)
  return { ...testCase, result, evidence: noteFor(testCase, result) }
})

const counts = rows.reduce((summary, row) => {
  summary[row.result] = (summary[row.result] ?? 0) + 1
  return summary
}, {})
const releaseBlocking = rows.filter((row) => row.result !== '通过' && (row.priority === 'P0' || row.priority === 'P1'))

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

const csv = [
  ['TC编号', '优先级', '情况与关键步骤', '预期结果', '执行状态', '证据/待办'],
  ...rows.map((row) => [row.id, row.priority, row.scenario, row.expected, row.result, row.evidence]),
].map((row) => row.map(csvCell).join(',')).join('\n')

const p0p1Breakdown = releaseBlocking.reduce((summary, row) => {
  const key = `${row.priority}-${row.result}`
  summary[key] = (summary[key] ?? 0) + 1
  return summary
}, {})

const report = `# M-BOX 213条经营TC执行报告

执行日期：\`2026-07-17\`  
执行版本：\`1.0.0-rc.10\`  
时区：\`Asia/Shanghai\`  
原始基线：[comprehensive-operating-test-cases.md](comprehensive-operating-test-cases.md)  
逐条登记：[tc-execution-register-2026-07-17.csv](tc-execution-register-2026-07-17.csv)

## 结论

本轮确认基线共有 **213条**，没有增删或改变原始预期。执行结果为：

| 状态 | 数量 | 判定口径 |
|---|---:|---|
| 通过 | ${counts['通过'] ?? 0} | 有直接自动化、云端闭环、浏览器检查或压力测试证据 |
| 未执行 | ${counts['未执行'] ?? 0} | 必须由真实岗位、真实设备或门店现场完成，不能用单元测试冒充 |
| 阻塞 | ${counts['阻塞'] ?? 0} | 缺真实微信/星驿支付、物理POS或第三方生产通道凭证 |
| 失败 | ${counts['失败'] ?? 0} | 本轮未发现已执行项失败 |

**商业生产发布结论：不通过发布门禁。** 仍有 **${releaseBlocking.length}条 P0/P1** 未达到“通过”，其中 ${p0p1Breakdown['P0-阻塞'] ?? 0} 条P0阻塞、${p0p1Breakdown['P0-未执行'] ?? 0} 条P0未执行、${p0p1Breakdown['P1-阻塞'] ?? 0} 条P1阻塞、${p0p1Breakdown['P1-未执行'] ?? 0} 条P1未执行。当前版本只能作为门店验证候选版，不得改称商业生产版。

## 本轮证据

| 检查 | 结果 |
|---|---|
| 代码质量与构建 | lint通过；小程序静态检查56个文件；79个测试文件/569项测试通过；生产构建通过 |
| 依赖安全 | \`npm audit --omit=dev\`：0项已知漏洞 |
| 云端角色 | 13名真实员工全部可登录并获得各自职责；护古无\`identity.manage\` |
| 固定桌码 | 无签名桌号请求返回\`TABLE_ACCESS_INVALID\`；签名固定桌码可交换当前桌次会话 |
| 服务闭环 | L01创建个性化需求，由Tom接单、到桌、完成，客人确认后状态为\`confirmed\` |
| 客户视觉/交互 | 390、1024、1200宽度无横向溢出；按钮有反馈；心情选择高亮/灰化；购物车显示\`1件 · ¥88.00\`；控制台0错误 |
| 300人峰值 | 300人、75桌、613请求、并发40；请求失败0、流程失败0、负库存0；最慢业务p95为员工bootstrap 233.5ms |

## 仍需现场执行

1. 李艳作为总执行人，按CSV筛选“未执行”，组织12名员工在真实手机、平板、收银PC、KDS和门店网络逐条演练。
2. 陈方宇、护古、李艳共同完成所有P0资金、重大授权、应急和恢复项目；发起人与审批人必须分离。
3. 三沐完成微信/星驿、付款码、物理POS、现金、退款和日结真实小额流水；没有渠道流水号不得判定通过。
4. 阿金、申良良、冷言志、付淳羽完成断电、音响灯光、后厨/吧台缺岗、演出变更和现场履约项目。
5. 乌鸦收集脱敏截图、业务对象ID、审计事件和外部流水，逐条把状态改为通过/失败/阻塞；失败项修复后必须保留原记录并复测。

## 发布门禁

只有同时满足以下条件才允许商业生产发布：213条均为“通过”或经李艳与护古共同批准的“不适用”；所有P0/P1为通过；真实支付/退款/对账通过；现场应急与恢复演练通过；发布负责人签字并保留回退版本。验证环境可以继续用于完成待执行TC，但不得接真实顾客生产资金。
`

const generatedCsv = `\uFEFF${csv}\n`
if (checkMode) {
  if (readFileSync(csvPath, 'utf8') !== generatedCsv || readFileSync(reportPath, 'utf8') !== report) {
    throw new Error('TC execution artifacts are stale; run npm run tc:register')
  }
} else {
  writeFileSync(csvPath, generatedCsv)
  writeFileSync(reportPath, report)
}

console.log(JSON.stringify({
  mode: checkMode ? 'check' : 'write',
  total: rows.length,
  counts,
  releaseBlocking: releaseBlocking.length,
  reportPath,
  csvPath,
}, null, 2))
