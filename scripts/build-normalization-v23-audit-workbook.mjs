import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool'
import { additionalRequirements, auditFor } from './normalization-v23-audit-data.mjs'

const root = resolve(process.env.MBOX_AUDIT_ROOT ?? resolve(import.meta.dirname, '..'))
const sourcePath = process.env.MBOX_AUDIT_SOURCE_CSV
if (!sourcePath) throw new Error('MBOX_AUDIT_SOURCE_CSV is required')
const outputDir = resolve(root, 'outputs/normalization-v23-audit')
const previewDir = resolve(outputDir, 'workbook-previews')
const csvOutput = resolve(outputDir, 'M-BOX规范化V2.3审计矩阵_2026-08-15.csv')
const xlsxOutput = resolve(outputDir, 'M-BOX规范化V2.3需求与审计工作簿_2026-08-15.xlsx')
await mkdir(previewDir, { recursive: true })

const sourceText = await readFile(sourcePath, 'utf8')
const parsed = parseCsv(sourceText)
const [sourceHeaders, ...sourceValues] = parsed
const sourceRows = sourceValues.filter((row) => row.some((cell) => cell !== '')).map((values) => Object.fromEntries(sourceHeaders.map((header, index) => [header, values[index] ?? ''])))
const rows = [...sourceRows, ...additionalRequirements]
const headers = [
  ...sourceHeaders,
  '合理性判断', '当前审计结论', '本地完成度%', '当前证据', '配置与权限边界', '风险或阻塞', '建议批次', '工期估算', '来源',
]
const enrichedValues = rows.map((row) => {
  const audit = auditFor(row)
  return [
    ...sourceHeaders.map((header) => row[header] ?? ''),
    audit.rationality, audit.currentConclusion, audit.completion, audit.evidence,
    audit.configuration, audit.risk, audit.batch, audit.estimate,
    additionalRequirements.some((requirement) => requirement.ID === row.ID)
      ? '2026-08-15用户新增要求与第二轮审计'
      : sourcePath,
  ]
})
const enrichedCsv = toCsv([headers, ...enrichedValues])
await writeFile(csvOutput, `${enrichedCsv}\n`, 'utf8')

const workbook = await Workbook.fromCSV(enrichedCsv, { sheetName: '需求矩阵' })
const summary = workbook.worksheets.add('审计总览')
const jsonSheet = workbook.worksheets.add('JSON清理')
const testSheet = workbook.worksheets.add('测试证据')
const gateSheet = workbook.worksheets.add('发布门禁')
const matrix = workbook.worksheets.getItem('需求矩阵')
const lastRow = rows.length + 1

buildSummary(summary, lastRow)
buildMatrix(matrix, lastRow)
buildJsonSheet(jsonSheet)
buildTestSheet(testSheet)
buildGateSheet(gateSheet)

const inspectSummary = await workbook.inspect({
  kind: 'region', sheetId: '审计总览', range: 'A1:H30', maxChars: 5000,
})
const formulaErrors = await workbook.inspect({
  kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 100 }, summary: 'final formula error scan', maxChars: 5000,
})

const renders = [
  ['审计总览', 'A1:H29', '01-审计总览.png'],
  ['需求矩阵', 'A1:K18', '02-需求矩阵-状态.png'],
  ['需求矩阵', 'L1:Q18', '02b-需求矩阵-证据.png'],
  ['JSON清理', 'A1:G13', '03-JSON清理.png'],
  ['测试证据', 'A1:H16', '04-测试证据.png'],
  ['发布门禁', 'A1:F18', '05-发布门禁.png'],
]
for (const [sheetName, range, filename] of renders) {
  const preview = await workbook.render({ sheetName, range, scale: 1, format: 'png' })
  await writeFile(resolve(previewDir, filename), new Uint8Array(await preview.arrayBuffer()))
}

const xlsx = await SpreadsheetFile.exportXlsx(workbook)
await xlsx.save(xlsxOutput)

process.stdout.write(JSON.stringify({
  sourceRows: sourceRows.length,
  addedRows: additionalRequirements.length,
  totalRows: rows.length,
  xlsxOutput,
  csvOutput,
  previews: renders.map((entry) => resolve(previewDir, entry[2])),
  summaryInspect: inspectSummary.ndjson,
  formulaErrorInspect: formulaErrors.ndjson,
}, null, 2))

function buildSummary(sheet, finalMatrixRow) {
  sheet.showGridLines = false
  sheet.getRange('A1:H1').merge()
  sheet.getRange('A1').values = [['M-BOX 规范化 V2.3 完整审计总览']]
  sheet.getRange('A2:H2').merge()
  sheet.getRange('A2').values = [['事实口径：rc.88隔离发布候选已完成本地回归，文档生成时未部署、未修改生产。自动完成度不能替代真实岗位、渠道、硬件和生产验收。']]
  sheet.getRange('A4:B9').values = [
    ['基线', 'rc.87 / d25b3a4（核对时与origin/main一致）'],
    ['隔离分支', 'agent/normalization-v23-upgrade-20260815'],
    ['隔离工作树', root],
    ['需求条目', null],
    ['当前结论', '本地候选已完成整理和测试；允许经独立PR和不可变CI发布validation，但264项商业门禁阻止production'],
    ['生成日期', '2026-08-15 CST'],
  ]
  sheet.getRange('B7').formulas = [[`=COUNTA('需求矩阵'!$A$2:$A$${finalMatrixRow})`]]

  sheet.getRange('A11:C17').values = [
    ['审计状态', '数量', '解释'],
    ['已完成（本地候选）', null, '代码和自动测试已完成；提交、部署与现场证据分开记录'],
    ['已通过本地回归', null, '基线能力保留且自动回归通过'],
    ['部分完成', null, '已有局部能力，跨域闭环或失败恢复仍缺'],
    ['未实现（后续版本）', null, '应进入独立版本，不应混入本轮架构清理'],
    ['外部条件阻塞', null, '需真实渠道、硬件、账号或现场条件'],
    ['总计', null, '应与需求矩阵条目数一致'],
  ]
  for (let row = 12; row <= 16; row += 1) {
    sheet.getRange(`B${row}`).formulas = [[`=COUNTIF('需求矩阵'!$J$2:$J$${finalMatrixRow},A${row})`]]
  }
  sheet.getRange('B17').formulas = [[`=SUM(B12:B16)`]]

  sheet.getRange('E4:H10').values = [
    ['关键指标', '结果', '状态', '边界'],
    ['候选旧JSON依赖', 0, '通过', '六类模式在规范化候选均为0'],
    ['全仓历史RuntimeState引用', 490, '历史债务', '不进入候选构建，但尚未物理删除'],
    ['本地数据库测试', '609/609', '通过', '98文件；一次性测试数据库；迁移001–048'],
    ['真实浏览器流程', '34/34', '通过', '本地fixture，不代表生产数据'],
    ['跨端预览', '22+2张', '通过', '22张浏览器页面；2张iOS模拟器；仍缺真机'],
    ['两项专项整改', '2/2', '本地通过', '真实支付、渠道退订和岗位现场尚未验收'],
  ]

  sheet.getRange('A19:H25').values = [
    ['建议批次', '主要范围', '团队工期估算', '前提', '', '', '', ''],
    ['V2.3收口', '审查意见、必要修正、提交、独立PR和门禁发布', '0.5–1工作日', '不包含真实支付/硬件/营业晚班验收', '', '', '', ''],
    ['V2.4交易与履约', '支付、退款、挂账、KDS异常、自动派送、预约到入座', '2–4周', '建议2名全栈+1名测试；渠道另计', '', '', '', ''],
    ['V2.5主数据与配置', '菜单版本、分类、库存、班次、工作站、通知', '2–4周', '可与V2.4部分并行', '', '', '', ''],
    ['V2.6会员经营与智能', '会员、权益、经营分析、SOP、AI/语音边界', '2–4周', 'AI仅建议，写操作人工确认', '', '', '', ''],
    ['外部联调', '微信/星驿、打印机、POS、门店网络', '条件到位后2–5工作日+3个营业晚班', '需真实账号、设备、人员和脱敏证据', '', '', '', ''],
    ['总历时判断', '内部功能可分三批；外部联调独立门禁', '2人开发+测试约6–10周；单人约10–16周', '这是范围估算，不是承诺日期', '', '', '', ''],
  ]
  for (let row = 19; row <= 25; row += 1) sheet.getRange(`D${row}:H${row}`).merge()

  styleTitle(sheet.getRange('A1:H1'))
  sheet.getRange('A2:H2').format = { fill: '#FFF8E3', font: { color: '#6B5310', italic: true }, wrapText: true }
  styleSection(sheet.getRange('A11:C11'))
  styleSection(sheet.getRange('E4:H4'))
  styleSection(sheet.getRange('A19:H19'))
  sheet.getRange('A4:A9').format = { fill: '#EAF4EF', font: { bold: true, color: '#174F3A' } }
  sheet.getRange('E5:E10').format = { fill: '#EAF4EF', font: { bold: true, color: '#174F3A' } }
  sheet.getRange('A1:H25').format.wrapText = true
  sheet.getRange('A1:H25').format.verticalAlignment = 'center'
  sheet.getRange('A1:H25').format.borders = { preset: 'all', style: 'thin', color: '#D8DED9' }
  sheet.getRange('A1:H25').format.rowHeight = 34
  sheet.getRange('A1:H2').format.rowHeight = 42
  setWidths(sheet, [22, 26, 30, 24, 30, 18, 18, 48])
  sheet.freezePanes.freezeRows(2)
}

function buildMatrix(sheet, finalRow) {
  sheet.showGridLines = false
  const used = sheet.getRange(`A1:Q${finalRow}`)
  used.format.wrapText = true
  used.format.verticalAlignment = 'top'
  used.format.borders = { preset: 'all', style: 'thin', color: '#D8DED9' }
  sheet.getRange('A1:Q1').format = { fill: '#123A2C', font: { bold: true, color: '#FFFFFF' }, wrapText: true, verticalAlignment: 'center' }
  sheet.getRange('A1:Q1').format.rowHeight = 42
  sheet.getRange(`A2:Q${finalRow}`).format.rowHeight = 66
  sheet.getRange(`K2:K${finalRow}`).format.numberFormat = '0"%"'
  sheet.getRange(`K2:K${finalRow}`).conditionalFormats.add('dataBar', { color: '#21815D', gradient: true })
  sheet.getRange(`J2:J${finalRow}`).conditionalFormats.add('containsText', { text: '已完成', format: { fill: '#DFF3E8', font: { color: '#12633F', bold: true } } })
  sheet.getRange(`J2:J${finalRow}`).conditionalFormats.add('containsText', { text: '已通过', format: { fill: '#E8F1FF', font: { color: '#184F8A', bold: true } } })
  sheet.getRange(`J2:J${finalRow}`).conditionalFormats.add('containsText', { text: '部分', format: { fill: '#FFF2CC', font: { color: '#7A5200', bold: true } } })
  sheet.getRange(`J2:J${finalRow}`).conditionalFormats.add('containsText', { text: '未实现', format: { fill: '#FDE2E2', font: { color: '#8B2727', bold: true } } })
  sheet.getRange(`J2:J${finalRow}`).conditionalFormats.add('containsText', { text: '阻塞', format: { fill: '#F4D6D6', font: { color: '#8B1E1E', bold: true } } })
  setWidths(sheet, [10, 10, 24, 18, 16, 10, 40, 28, 24, 20, 12, 52, 42, 42, 24, 34, 52])
  sheet.freezePanes.freezeRows(1)
  sheet.freezePanes.freezeColumns(3)
  const table = sheet.tables.add(`A1:Q${finalRow}`, true, 'RequirementAuditTable')
  table.style = 'TableStyleMedium4'
  table.showFilterButton = true
  table.showBandedRows = true
}

function buildJsonSheet(sheet) {
  sheet.showGridLines = false
  sheet.getRange('A1:G1').merge()
  sheet.getRange('A1').values = [['旧 JSON 残留与候选闭包审计']]
  sheet.getRange('A2:G2').merge()
  sheet.getRange('A2').values = [['“候选为0”只代表默认规范化构建/CI/发布闭包不依赖旧路径；不等于全仓历史代码已经物理删除。']]
  sheet.getRange('A4:G11').values = [
    ['检查模式', '全仓历史计数', '规范化候选', '默认构建', '默认CI', '结论', '后续处置'],
    ['repository.mutate', 147, 0, '排除', '零残留门禁', '候选通过', '历史目录仅作不可执行参考，后续按可证明无引用批次删除'],
    ['runtime_states', 22, 0, '排除', '零残留门禁', '候选通过', '不得由新迁移、新接口或worker重新引用'],
    ['RuntimeState类型', 490, 0, '排除', '零残留门禁', '候选通过', '旧前端/测试分区隔离，不进入生产镜像'],
    ['旧运营投影入口', 6, 0, '排除', '零残留门禁', '候选通过', '只允许规范化读模型'],
    ['旧全局mutation尾部', 3, 0, '排除', '零残留门禁', '候选通过', '新代码检查阻断回流'],
    ['整店CAS写路径', 2, 0, '排除', '零残留门禁', '候选通过', '事务写入只走规范化仓储和命令执行器'],
    ['前端传递依赖闭包', '旧src/api.ts、src/offline.ts仍存', 0, '候选不可达', '63个前端文件扫描', '候选通过', '默认入口不得导入旧总API或离线RuntimeState'],
  ]
  sheet.getRange('A13:G13').merge()
  sheet.getRange('A13').values = [['判定：逻辑依赖已从候选闭包清除；全仓历史债务仍需保留棘轮并按独立删除批次处理，当前不可宣称“全仓零残留”。']]
  styleTitle(sheet.getRange('A1:G1'))
  sheet.getRange('A2:G2').format = { fill: '#FFF2CC', font: { color: '#6B5310', italic: true }, wrapText: true }
  styleSection(sheet.getRange('A4:G4'))
  sheet.getRange('A4:G11').format.borders = { preset: 'all', style: 'thin', color: '#D8DED9' }
  sheet.getRange('A1:G13').format.wrapText = true
  sheet.getRange('A1:G13').format.verticalAlignment = 'center'
  sheet.getRange('A1:G13').format.rowHeight = 48
  sheet.getRange('A13:G13').format = { fill: '#EAF4EF', font: { bold: true, color: '#174F3A' }, wrapText: true }
  setWidths(sheet, [26, 20, 18, 18, 22, 18, 52])
  sheet.freezePanes.freezeRows(4)
}

function buildTestSheet(sheet) {
  sheet.showGridLines = false
  sheet.getRange('A1:H1').merge()
  sheet.getRange('A1').values = [['本地候选测试与预览证据']]
  sheet.getRange('A2:H2').merge()
  sheet.getRange('A2').values = [['所有结果来自隔离工作树和一次性测试数据库；没有写入生产数据库，没有真实支付、硬件或门店网络证据。']]
  sheet.getRange('A4:H14').values = [
    ['层级', '命令/范围', '通过', '失败', '跳过', '耗时/规模', '结论', '限制'],
    ['单元与无数据库回归', 'npm test', 492, 0, 195, '97通过文件；17跳过文件', '通过', '跳过项为环境/集成限定，不计作通过'],
    ['规范化数据库', 'test:normalized:postgres', 609, 0, 0, '98文件；迁移001–048', '通过', '一次性PostgreSQL测试库'],
    ['真实浏览器关键流程', 'test:e2e:normalized', 34, 0, 0, '约1.2分钟', '通过', '本地fixture；覆盖13名员工、顾客及手机适配'],
    ['持续负载', 'acceptance:normalized:load', 43, 0, 0, '4链路各300次场景；5 RPS；43项门禁', '通过', '本地mock负载模型，不代表生产峰值容量'],
    ['架构策略测试', 'architecture:normalized:test', 6, 0, 0, '闭包+策略', '通过', '候选六类旧依赖计数为0'],
    ['发布元数据', 'release:metadata', 1, 0, 0, 'rc.88；48迁移', '通过', '不可变身份须由合并提交、标签与镜像摘要形成'],
    ['CI分类器', 'ci:classifier:test', 7, 0, 0, '7项', '通过', '本地分类器测试，不是GitHub CI实跑'],
    ['类型、lint与构建', '双端类型+lint+build:normalized', 3, 0, 0, '规范化构建', '通过', '未构建/发布生产镜像'],
    ['跨端预览', 'Playwright页面+iOS模拟器截图', 24, 0, 0, '1440/1024/844横屏/390/320', '通过', '22张浏览器页面+2张iOS模拟器；真机待验'],
    ['差异洁净检查', 'git diff --check', 1, 0, 0, '工作树差异', '通过', '文档生成时工作树仍为未提交候选'],
  ]
  styleTitle(sheet.getRange('A1:H1'))
  sheet.getRange('A2:H2').format = { fill: '#FFF2CC', font: { color: '#6B5310', italic: true }, wrapText: true }
  styleSection(sheet.getRange('A4:H4'))
  sheet.getRange('A4:H14').format.borders = { preset: 'all', style: 'thin', color: '#D8DED9' }
  sheet.getRange('A1:H14').format.wrapText = true
  sheet.getRange('A1:H14').format.verticalAlignment = 'center'
  sheet.getRange('A1:H14').format.rowHeight = 48
  setWidths(sheet, [24, 34, 12, 12, 12, 20, 16, 50])
  sheet.freezePanes.freezeRows(4)
}

function buildGateSheet(sheet) {
  sheet.showGridLines = false
  sheet.getRange('A1:F1').merge()
  sheet.getRange('A1').values = [['审查、提交、发布与回滚门禁']]
  sheet.getRange('A2:F2').merge()
  sheet.getRange('A2').values = [['当前命令授权整理、测试与部署；但商业验收仍有264项阻塞，本轮只能经独立PR和不可变CI发布validation，真实支付保持关闭。']]
  sheet.getRange('A4:F14').values = [
    ['门禁', '当前状态', '事实证据', '仍需完成', '责任角色', '回滚/恢复'],
    ['基线', '通过', 'rc.87 / d25b3a4，核对时与origin/main一致', '提交前再fetch并比对主分支', '开发', '如主分支变化则rebase并重跑门禁'],
    ['隔离工作树', '通过', '独立分支与worktree，主工作树未修改', '持续保持隔离', '开发', '未提交前可按文件审查并放弃候选'],
    ['人工预览审查', '已生成', '22张真实浏览器页面和2张iOS模拟器预览已生成', '用户审查后仍需Android/iPhone真机与真实岗位复核', '用户/经营', '按审查意见进入后续受控版本'],
    ['提交与独立PR', '获授权；待执行', '文档生成时无候选提交SHA、无PR', '提交独立分支并等待全部CI', '开发', 'PR阶段可关闭；提交可revert'],
    ['合并主分支', '仅绿色PR后允许', '用户已要求部署，但不构成绕过保护规则的授权', '仅在全部不可变CI通过后合并', '用户/技术负责人', 'CI失败则保持隔离分支'],
    ['部署', '仅validation允许', '264项商业P0/P1验收阻塞production；真实支付配置仍关闭', '标签、不可变镜像、备份、迁移、候选验证后切换validation', '经营/运维', '保留rc.87应用回退；新增表列不做破坏性down'],
    ['数据库迁移', '本地通过', '042–048均为规范化迁移；测试库609/609', '生产前备份、容量和锁等待评估', 'DBA/开发', '迁移以加法为主；应用回退后保留兼容表/列，避免破坏性down'],
    ['远端支付', '入口已复核；渠道仍关闭', '支付域名、TLS、代理及伪造回调拒绝正常；活动运行时为validation且渠道配置未启用', '渠道资料到位后再脱敏核对收款、乱序回调、查单、退款、对账与关闭/恢复演练', '财务/渠道/开发', '本次不写入渠道密钥；保持真实支付关闭，未知支付不自动释放'],
    ['真实硬件', '阻塞', '只有软件队列和命令回归', '打印机、POS、KDS、网络实测', '门店/运维/开发', '故障时停用设备路由并人工交接'],
    ['岗位与现场', '阻塞', '自动浏览器覆盖13名员工', '真实设备、真实岗位、3个营业晚班', '李艳/各岗位', '发现失败即停止候选，回到已批准版本'],
  ]
  sheet.getRange('A16:F18').values = [
    ['未完成事项', '影响', '建议', '', '', ''],
    ['全仓历史JSON物理清理', '无候选运行影响，但维护成本仍高', '保持棘轮，按目录和引用证据分批删除，不与经营功能混成一次大提交', '', '', ''],
    ['矩阵其余交易/库存/会员/AI闭环', '部分P0会阻断生产', '按V2.4–V2.6独立版本执行，每批都有数据库、浏览器、权限、失败恢复和回滚门禁', '', '', ''],
  ]
  for (let row = 16; row <= 18; row += 1) sheet.getRange(`C${row}:F${row}`).merge()
  styleTitle(sheet.getRange('A1:F1'))
  sheet.getRange('A2:F2').format = { fill: '#FDE2E2', font: { color: '#8B2727', bold: true }, wrapText: true }
  styleSection(sheet.getRange('A4:F4'))
  styleSection(sheet.getRange('A16:F16'))
  sheet.getRange('A4:F14').format.borders = { preset: 'all', style: 'thin', color: '#D8DED9' }
  sheet.getRange('A16:F18').format.borders = { preset: 'all', style: 'thin', color: '#D8DED9' }
  sheet.getRange('A1:F18').format.wrapText = true
  sheet.getRange('A1:F18').format.verticalAlignment = 'center'
  sheet.getRange('A1:F18').format.rowHeight = 54
  setWidths(sheet, [24, 18, 48, 46, 24, 46])
  sheet.freezePanes.freezeRows(4)
}

function styleTitle(range) {
  range.format = { fill: '#0E2F24', font: { bold: true, color: '#FFFFFF', size: 18 }, horizontalAlignment: 'left', verticalAlignment: 'center' }
}

function styleSection(range) {
  range.format = { fill: '#D8B74C', font: { bold: true, color: '#15241E' }, wrapText: true, verticalAlignment: 'center' }
}

function setWidths(sheet, widths) {
  widths.forEach((width, index) => {
    sheet.getRangeByIndexes(0, index, 1000, 1).format.columnWidth = width
  })
}

function parseCsv(text) {
  const rows = []
  let row = []
  let value = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1 }
      else if (char === '"') quoted = false
      else value += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(value); value = '' }
    else if (char === '\n') { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = '' }
    else value += char
  }
  if (value !== '' || row.length > 0) { row.push(value.replace(/\r$/, '')); rows.push(row) }
  return rows
}

function toCsv(values) {
  return values.map((row) => row.map((value) => {
    const text = value == null ? '' : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }).join(',')).join('\n')
}
