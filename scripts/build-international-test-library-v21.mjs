import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index === -1 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return resolve(process.argv[index + 1])
}

const sourceDocumentPath = argument('--source-document')
const sourceRegisterPath = argument('--source-register')
const extensionPath = argument('--extension')
const outputDocumentPath = argument('--output-document')
const outputRegisterPath = argument('--output-register')

const source = readFileSync(sourceDocumentPath, 'utf8')
const extension = readFileSync(extensionPath, 'utf8')
const sourceRegister = readFileSync(sourceRegisterPath, 'utf8').replace(/^\uFEFF/, '')

const cases = [...extension.matchAll(/^\| ((?:GOP|BND)-\d{3}) \| (P[0-3]) \| ([^|]+) \| ([^|]+) \|$/gm)]
  .map((match) => ({
    id: match[1],
    priority: match[2],
    scenario: match[3].trim(),
    expected: match[4].trim(),
  }))

for (const prefix of ['GOP', 'BND']) {
  const ids = cases.filter((item) => item.id.startsWith(`${prefix}-`)).map((item) => item.id)
  const expected = Array.from({ length: 30 }, (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`)
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new Error(`${prefix} cases must contain exactly 001-030 in order`)
  }
}
if (cases.length !== 60) throw new Error(`Expected 60 extension cases, found ${cases.length}`)

function section(prefix, title) {
  const rows = extension.split('\n').filter((line) => line.startsWith(`| ${prefix}-`))
  return `## ${prefix === 'GOP' ? 17 : 18}. ${prefix}：${title}（30条）

| TC | 级别 | 情况与关键步骤 | 预期结果与必留证据 |
|---|---|---|---|
${rows.join('\n')}

---

`
}

let output = source
  .replace('# M-BOX 国际酒吧餐饮全场景测试用例库 V2.0', '# M-BOX 国际酒吧餐饮全场景测试用例库 V2.1')
  .replace('本文新增 **240 条国际经营场景用例**，编号为 `CHK/PRC/ALC/FUL/RSV/LVE/INVX/FIN/CHN/CRM/WRK/REL`，与现有 213 条不重复。',
    '本文新增 **300 条经营场景用例**，编号为 `CHK/PRC/ALC/FUL/RSV/LVE/INVX/FIN/CHN/CRM/WRK/REL/GOP/BND`，与现有 213 条不重复。V2.1新增的`GOP/BND`专门覆盖客户真实操作、点单异常以及无理、危险、违法要求。')
  .replace('**主用例总量：213 + 240 = 453 条。**', '**主用例总量：213 + 300 = 513 条。**')
  .replace('另有 24 条跨模块整晚组合场景，不计入 453 条主用例。', '另有 24 条跨模块整晚组合场景，不计入 513 条主用例。')
  .replace(/M-BOX国际酒吧餐饮全量477项测试执行登记表V2\.0\.csv/g, 'M-BOX国际酒吧餐饮全量537项测试执行登记表V2.1.csv')
  .replace('该表将213条现有基线、240条新增主用例和24条组合场景合并为477个可分派、可登记、可复测的执行项。',
    '该表将213条现有基线、300条新增主用例和24条组合场景合并为537个可分派、可登记、可复测的执行项。')
  .replace('| `REL` 集成、离线、观测与多店 | 20 | 接口、离线、配置、监控、安全 | 多门店、多时区、多币种 |\n| **新增合计** | **240** |  |  |',
    '| `REL` 集成、离线、观测与多店 | 20 | 接口、离线、配置、监控、安全 | 多门店、多时区、多币种 |\n| `GOP` 客户操作、点单与服务需求 | 30 | 扫码、搜索、推荐、购物车、备注、支付、服务 | 多设备、跨营业日 |\n| `BND` 无理、危险、违法与边界要求 | 30 | 免单索赔、隐私、酒类责任、骚扰、安全 | 急救、报警、线下处置 |\n| **新增合计** | **300** |  |  |')
  .replace('2. 新增240条中已启用功能的全部P0/P1。', '2. 新增300条中已启用功能的全部P0/P1。')
  .replace('这240条不是要求一天内全部开发。', '这300条不是要求一天内全部开发。')
  .replace('| 12个新增模块编号连续性 | 每个模块 `001-020`，无缺号 |', '| 14个新增模块编号连续性 | 12个模块为`001-020`，`GOP/BND`为`001-030`，无缺号 |')
  .replace('| 新增主用例唯一数 | 240 |', '| 新增主用例唯一数 | 300 |')
  .replace('| 合并执行登记唯一数 | 477 |', '| 合并执行登记唯一数 | 537 |')
  .replace('| Markdown主用例表格列数 | 240行全部正确 |', '| Markdown主用例表格列数 | 300行全部正确 |')
  .replace(
    '- 发布阻断：66条。',
    '- 发布阻断：66条。\n\nV2.1合并登记快照为：通过160条、未执行361条、阻塞16条；其中376条P0/P1尚未通过。该数字是执行管理基线，不代表商业经营验收已经完成。',
  )
  .replace(
    '这些状态只代表 `rc.48` 登记快照。新版本必须重新执行相应用例，不能把历史通过直接继承为当前通过。',
    '其中原213条状态只代表`rc.48`登记快照；V2.1新增自动化结果来自本次专项回归。候选发布仍必须重新执行适用用例，不能把历史通过直接继承为当前通过。',
  )

for (let sectionNumber = 25; sectionNumber >= 17; sectionNumber -= 1) {
  output = output.replaceAll(`## ${sectionNumber}.`, `## ${sectionNumber + 2}.`)
  output = output.replaceAll(`### ${sectionNumber}.`, `### ${sectionNumber + 2}.`)
}

output = output.replace(
  '## 19. 24条跨模块整晚组合场景',
  `${section('GOP', '客户操作、点单和服务需求')}${section('BND', '无理、危险、违法和边界要求')}## 19. 24条跨模块整晚组合场景`,
)

const automated = new Set([
  'GOP-002', 'GOP-003', 'GOP-013', 'GOP-017', 'GOP-018', 'GOP-019', 'GOP-022',
  'GOP-023', 'GOP-024', 'GOP-025', 'GOP-026', 'BND-001', 'BND-005',
])

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function registerRow(testCase) {
  const passed = automated.has(testCase.id)
  return [
    testCase.id,
    testCase.priority,
    testCase.scenario,
    testCase.expected,
    passed ? '通过' : '未执行',
    passed ? 'customer-test-v2.1' : 'V2.1',
    passed ? '服务端自动化' : '真实设备/岗位演练',
    testCase.id.startsWith('GOP') ? '客户、服务员、店长、研发测试' : '服务员、店长、运营负责人、安全责任人',
    passed
      ? 'guest-api.test.ts及client-responsibility-flow.test.ts专项回归'
      : '需记录执行人、北京时间、桌次/订单/任务ID、脱敏截图或录像及复盘结论',
  ].map(csvCell).join(',')
}

const sourceLines = sourceRegister.trimEnd().split('\n')
const xcmIndex = sourceLines.findIndex((line) => line.startsWith('"XCM-'))
if (xcmIndex === -1) throw new Error('Could not locate XCM rows in source register')
const registerLines = [
  ...sourceLines.slice(0, xcmIndex),
  ...cases.map(registerRow),
  ...sourceLines.slice(xcmIndex),
]
const registerIds = registerLines.slice(1).map((line) => line.match(/^"([^"]+)"/)?.[1]).filter(Boolean)
if (registerIds.length !== 537 || new Set(registerIds).size !== 537) {
  throw new Error(`Expected 537 unique register rows, found ${registerIds.length}/${new Set(registerIds).size}`)
}

writeFileSync(outputDocumentPath, output)
writeFileSync(outputRegisterPath, `\uFEFF${registerLines.join('\n')}\n`)

console.log(JSON.stringify({
  sourceDocument: basename(sourceDocumentPath),
  sourceRegister: basename(sourceRegisterPath),
  extension: basename(extensionPath),
  outputDirectory: dirname(outputDocumentPath),
  primaryCases: 513,
  combinationCases: 24,
  registerRows: registerIds.length,
  automatedPassed: automated.size,
}, null, 2))
