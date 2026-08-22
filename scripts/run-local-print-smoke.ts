import { randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { chromium } from '@playwright/test'
import { asPostgresPool } from '../server/postgres-repository.js'
import { appendOutboxMessage, type JsonObject } from '../server/normalized/command-executor.js'
import { HardwareRepository, type HardwareStation, type PrintJob } from '../server/normalized/hardware-repository.js'
import { PrintWorker, type PrintAdapterRequest } from '../server/normalized/print-worker.js'
import {
  createPrintTicketSnapshot,
  inferPrintTicketOutputProfile,
  normalizePrintTicketOutputProfile,
  parsePrintTicketSnapshot,
  printTicketPageHeightMm,
  renderPrintTicketHtml,
  ticketToJson,
  type PrintTicketOutputProfile,
  type PrintTicketKind,
  type PrintTicketSnapshot,
} from '../server/normalized/print-ticket-layout.js'
import { ScopedPostgresTransactionRunner, type StoreScope } from '../server/normalized/transaction-runner.js'

const execFile = promisify(execFileCallback)
const REQUIRED_CONFIRMATION = 'PRINT_MBOX_TEST_TICKETS'
const destination = argument('--printer')

if (process.env.MBOX_CONFIRM_LOCAL_PRINT !== REQUIRED_CONFIRMATION) {
  throw new Error(`拒绝发送实物测试票据。请设置 MBOX_CONFIRM_LOCAL_PRINT=${REQUIRED_CONFIRMATION}`)
}
if (!destination) throw new Error('缺少 --printer=<本机CUPS打印机名称>')
if (process.env.NODE_ENV === 'production' || process.env.MBOX_DEPLOYMENT_TIER === 'production') {
  throw new Error('本地打印测试脚本禁止连接生产环境')
}

const scope: StoreScope = {
  tenantId: required('MBOX_TENANT_ID'),
  storeId: required('MBOX_STORE_ID'),
}
const databaseUrl = required('DATABASE_URL')
assertLocalDatabase(databaseUrl)

const runId = `local-print-${randomUUID()}`
const pool = new Pool({ connectionString: databaseUrl, application_name: 'mbox-local-print-smoke' })
const transactions = new ScopedPostgresTransactionRunner(asPostgresPool(pool))

try {
  const outputProfile = await readOutputProfile(destination)
  const jobs = await createSystemTestJobs(transactions, scope, runId, destination, outputProfile)
  const result = await new PrintWorker(transactions).runBatch(
    scope,
    `local-cups:${process.pid}`,
    { print: (request) => renderAndPrint(destination, outputProfile, request) },
    { limit: jobs.length },
  )
  if (result.printed.length !== jobs.length || result.retrying.length > 0 || result.dead.length > 0 || result.lost.length > 0) {
    throw new Error(`打印队列未完整送达：成功${result.printed.length}/${jobs.length}，待重试${result.retrying.length}，终止${result.dead.length}，锁丢失${result.lost.length}`)
  }
  process.stdout.write(`${JSON.stringify({
    status: 'submitted_to_cups',
    runId,
    printer: destination,
    outputProfile,
    ticketKinds: jobs.map((job) => parsePrintTicketSnapshot(job.printSnapshot).kind),
    jobIds: result.printed,
  })}\n`)
} finally {
  await pool.end()
}

async function createSystemTestJobs(
  runner: ScopedPostgresTransactionRunner,
  printScope: Readonly<StoreScope>,
  testRunId: string,
  printerName: string,
  outputProfile: Readonly<PrintTicketOutputProfile>,
): Promise<PrintJob[]> {
  return runner.run(printScope, async (transaction) => {
    const hardware = new HardwareRepository(transaction)
    const device = await hardware.createDevice({
      code: `local-cups-${testRunId.slice(-12)}`,
      name: `本机测试打印机 · ${printerName}`,
      deviceType: 'printer',
      stationCode: 'cashier',
      capabilities: ['cups.local', 'print.test'],
      configSnapshot: { destination: printerName, localOnly: true, testRunId, outputProfile: { ...outputProfile } },
    })
    await hardware.recordConnectivity(device.id, 'online')

    for (const station of ['bar', 'kitchen', 'cashier'] as const) {
      await hardware.upsertPrinterRoute({
        code: `local-test-${station}-${testRunId.slice(-12)}`,
        name: `本机测试 · ${station}`,
        stationCode: station,
        printerDeviceId: device.id,
        copies: 1,
        priority: 1,
        status: 'active',
      })
    }

    const tickets = createTestTickets(testRunId)
    const jobs: PrintJob[] = []
    for (const ticket of tickets) {
      const eventKey = `print-test:${testRunId}:${ticket.snapshot.kind}`
      await appendOutboxMessage(transaction, {
        businessEventKey: eventKey,
        aggregateType: 'hardware_test',
        aggregateId: device.id,
        aggregateVersion: 1,
        eventType: 'hardware.print_test_requested.v1',
        payload: { runId: testRunId, ticket: ticketToJson(ticket.snapshot) },
      })
      const source = await transaction.query<{ id: string }>(`
        SELECT id FROM mbox.outbox_messages
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND message_key=$3
      `, [transaction.scope.tenantId, transaction.scope.storeId, eventKey])
      const sourceOutboxMessageId = source.rows[0]?.id
      if (!sourceOutboxMessageId) throw new Error('测试打印源事件未创建')
      jobs.push(...await hardware.materializeFromOutbox({
        sourceOutboxMessageId,
        stationCode: ticket.station,
        sourceType: ticket.station === 'cashier' ? 'cashier' : 'kds',
        sourceReference: ticket.snapshot.ticketReference,
        printSnapshot: ticketToJson(ticket.snapshot),
        containsPriorityNote: ticket.snapshot.note !== null,
        maxAttempts: 1,
      }))
    }
    return jobs
  })
}

function createTestTickets(testRunId: string): readonly { station: HardwareStation; snapshot: PrintTicketSnapshot }[] {
  const issuedAt = new Date().toISOString()
  const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  const create = (
    kind: PrintTicketKind,
    station: HardwareStation,
    subtitle: string,
    lines: PrintTicketSnapshot['lines'],
    totalAmountMinor: number | null,
    note: string | null,
  ) => ({ station, snapshot: createPrintTicketSnapshot({
    kind,
    subtitle,
    test: true,
    issuedAt,
    businessDate,
    ticketReference: `TEST-${testRunId.slice(-8).toUpperCase()}-${kind.slice(0, 3).toUpperCase()}`,
    tableCode: 'TEST-01',
    guestCount: 3,
    operatorLabel: 'M-BOX 系统测试',
    note,
    payment: kind === 'cashier_payment' ? { provider: 'wechat', method: 'jsapi' } : null,
    lines,
    totalAmountMinor,
    currency: 'CNY',
  }) })
  return [
    create('cashier_settlement', 'cashier', '桌台结账核对 · 非营业订单', [
      { name: '金汤力', quantity: 2, unitAmountMinor: 8800, totalAmountMinor: 17600 },
      { name: '松露薯条', quantity: 1, unitAmountMinor: 4800, totalAmountMinor: 4800 },
    ], 22400, '仅验证票据版式与分流，请勿收款。'),
    create('cashier_payment', 'cashier', '支付确认留档 · 非营业订单', [
      { name: '金汤力', quantity: 2, unitAmountMinor: 8800, totalAmountMinor: 17600 },
      { name: '松露薯条', quantity: 1, unitAmountMinor: 4800, totalAmountMinor: 4800 },
    ], 22400, '系统打印测试，未发起真实支付。'),
    create('bar_production', 'bar', '吧台制作分流 · 非营业订单', [
      { name: '金汤力', quantity: 2, note: '少冰，分两杯' },
    ], null, '优先核对杯型与出品备注。'),
    create('kitchen_production', 'kitchen', '后厨制作分流 · 非营业订单', [
      { name: '松露薯条', quantity: 1, note: '不要香菜，出品后通知服务员' },
    ], null, '优先核对过敏与备注。'),
  ]
}

async function renderAndPrint(
  printer: string,
  outputProfile: Readonly<PrintTicketOutputProfile>,
  request: Readonly<PrintAdapterRequest>,
): Promise<void> {
  const ticket = parsePrintTicketSnapshot(request.printSnapshot)
  const directory = await mkdtemp(join(tmpdir(), 'mbox-print-ticket-'))
  const pdfPath = join(directory, `${ticket.kind}.pdf`)
  try {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent(renderPrintTicketHtml(ticket, outputProfile), { waitUntil: 'load' })
      await page.pdf({
        path: pdfPath,
        ...(outputProfile.paper === 'a4'
          ? { format: 'A4' as const }
          : { width: outputProfile.paper, height: `${printTicketPageHeightMm(ticket, outputProfile)}mm` }),
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      })
    } finally {
      await browser.close()
    }
    const printerArguments = ['-d', printer, '-t', `M-BOX ${ticket.title} 测试`]
    if (outputProfile.paper === 'a4') printerArguments.push('-o', 'media=A4')
    printerArguments.push(pdfPath)
    await execFile('lp', printerArguments, { timeout: 30_000 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function readOutputProfile(printer: string): Promise<PrintTicketOutputProfile> {
  const { stdout: destinationOutput } = await execFile('lpstat', ['-v', printer], { timeout: 5_000 })
  if (!destinationOutput.includes(printer)) throw new Error('本机未识别指定打印机')
  const requestedPaper = argument('--paper')
  if (requestedPaper !== null && requestedPaper !== 'auto') {
    if (requestedPaper === '58') return normalizePrintTicketOutputProfile({ paper: '58mm', thermal: true })
    if (requestedPaper === '80') return normalizePrintTicketOutputProfile({ paper: '80mm', thermal: true })
    if (requestedPaper === 'a4') return normalizePrintTicketOutputProfile({ paper: 'a4', thermal: false })
    throw new Error('--paper仅支持auto、58、80或a4')
  }
  const { stdout: capabilityOutput } = await execFile('lpoptions', ['-p', printer, '-l'], { timeout: 5_000 })
  const inferred = inferPrintTicketOutputProfile(capabilityOutput)
  if (inferred === null) throw new Error('无法识别打印纸宽，请明确传入 --paper=58 或 --paper=80 或 --paper=a4')
  return inferred
}

function assertLocalDatabase(urlValue: string) {
  const parsed = new URL(urlValue)
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error('本地打印测试只允许连接本机数据库')
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少${name}`)
  return value
}

function argument(name: string): string | null {
  const value = process.argv.find((item) => item.startsWith(`${name}=`))
  return value ? value.slice(name.length + 1).trim() || null : null
}
