import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const VERSION = '1.0.0'
const execFileAsync = promisify(execFile)
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const dataDirectory = process.env.MBOX_PRINT_BRIDGE_DATA
  || join(process.env.ProgramData || 'C:\\ProgramData', 'MBOX', 'PrintBridge')
const configPath = join(dataDirectory, 'config.json')
const journalPath = join(dataDirectory, 'journal.json')
const printScriptPath = join(scriptDirectory, 'print-ticket.ps1')
const listScriptPath = join(scriptDirectory, 'list-printers.ps1')

await main(process.argv.slice(2))

async function main(args) {
  await mkdir(dataDirectory, { recursive: true })
  if (args[0] === 'pair') {
    const code = String(args[1] || '').trim()
    if (!code) throw new Error('请提供一次性配对码')
    const config = await readConfig(false)
    assertServerUrl(config.serverUrl)
    const response = await request(config.serverUrl, '/api/print-bridge/pair', {
      pairingCode: code,
      name: config.name || `M-BOX打印桥-${hostname()}`,
      hostname: hostname(),
      softwareVersion: VERSION,
    })
    config.publicId = requiredText(response.data?.publicId, 'publicId')
    config.credential = requiredText(response.data?.credential, 'credential')
    await atomicJson(configPath, config)
    process.stdout.write(`配对完成：${config.publicId}\n`)
    return
  }
  if (args[0] === 'once') {
    await runCycle(await readConfig(true))
    return
  }
  if (args.length !== 0 && args[0] !== 'run') throw new Error('仅支持 pair、once 或 run')
  await serviceLoop(await readConfig(true))
}

async function serviceLoop(config) {
  let lastHeartbeat = 0
  let failureDelayMs = 2_000
  for (;;) {
    try {
      if (Date.now() - lastHeartbeat >= 30_000) {
        await heartbeat(config)
        lastHeartbeat = Date.now()
      }
      await runCycle(config)
      failureDelayMs = 2_000
      await delay(2_000)
    } catch (error) {
      process.stderr.write(`${new Date().toISOString()} ${safeError(error)}\n`)
      await delay(failureDelayMs)
      failureDelayMs = Math.min(60_000, failureDelayMs * 2)
    }
  }
}

async function runCycle(config) {
  assertPaired(config)
  const claimed = await authenticatedRequest(config, '/api/print-bridge/work/claim', { limit: 10 })
  const jobs = Array.isArray(claimed.data?.jobs) ? claimed.data.jobs : []
  const commands = Array.isArray(claimed.data?.commands) ? claimed.data.commands : []
  for (const job of jobs) await processJob(config, job)
  for (const command of commands) await processCommand(config, command)
}

async function heartbeat(config) {
  assertPaired(config)
  const queues = await listQueues()
  await authenticatedRequest(config, '/api/print-bridge/heartbeat', {
    hostname: hostname(), softwareVersion: VERSION, queues,
  })
}

async function processJob(config, job) {
  const id = requiredUuid(job.id, 'job.id')
  const businessKey = requiredText(job.businessKey, 'job.businessKey')
  const journal = await readJournal()
  const previous = journal.entries[businessKey]
  if (previous?.state === 'printed') {
    await reportJob(config, id, 'printed')
    return
  }
  if (previous?.state === 'printing' || previous?.state === 'ambiguous') {
    journal.entries[businessKey] = { state: 'ambiguous', updatedAt: new Date().toISOString(), jobId: id }
    await saveJournal(journal)
    await reportJob(config, id, 'failed', 'ambiguous_previous_attempt')
    return
  }
  journal.entries[businessKey] = { state: 'printing', updatedAt: new Date().toISOString(), jobId: id }
  await saveJournal(journal)
  try {
    const content = renderTicket(job.printSnapshot)
    await printText({
      queue: requiredText(job.windowsQueueName, 'job.windowsQueueName'),
      documentName: `MBOX-${businessKey}`.slice(0, 120),
      profile: readProfile(job.printProfile),
      copies: readCopies(job.copies),
      content,
    })
    journal.entries[businessKey] = { state: 'printed', updatedAt: new Date().toISOString(), jobId: id }
    trimJournal(journal)
    await saveJournal(journal)
    await reportJob(config, id, 'printed')
  } catch (error) {
    const definitelyNotSubmitted = isDefinitelyNotSubmitted(error)
    if (definitelyNotSubmitted) delete journal.entries[businessKey]
    else journal.entries[businessKey] = {
      state: 'ambiguous', updatedAt: new Date().toISOString(), jobId: id,
    }
    await saveJournal(journal)
    await reportJob(
      config,
      id,
      'failed',
      definitelyNotSubmitted ? normalizeFailure(error) : 'ambiguous_print_result',
    )
  }
}

async function processCommand(config, command) {
  const commandId = requiredUuid(command.id, 'command.id')
  try {
    const queue = requiredText(command.windowsQueueName, 'command.windowsQueueName')
    if (command.commandType === 'test_print') {
      await printText({
        queue,
        documentName: `MBOX-TEST-${command.publicId || commandId}`.slice(0, 120),
        profile: readProfile(command.printProfile), copies: 1,
        content: renderTestTicket(queue),
      })
    } else {
      const queues = await listQueues()
      if (!queues.includes(queue)) throw new Error('queue_not_found')
    }
    await authenticatedRequest(config, `/api/print-bridge/commands/${commandId}/result`, {
      outcome: 'succeeded', resultSnapshot: { checkedAt: new Date().toISOString() },
    })
  } catch (error) {
    await authenticatedRequest(config, `/api/print-bridge/commands/${commandId}/result`, {
      outcome: 'failed', failureCode: normalizeFailure(error),
      resultSnapshot: { checkedAt: new Date().toISOString() },
    })
  }
}

async function reportJob(config, jobId, outcome, failureCode) {
  await authenticatedRequest(config, `/api/print-bridge/jobs/${jobId}/result`, {
    outcome, ...(failureCode ? { failureCode } : {}),
  })
}

async function printText({ queue, documentName, profile, copies, content }) {
  const spoolDirectory = join(dataDirectory, 'spool')
  await mkdir(spoolDirectory, { recursive: true })
  const safeName = `ticket-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  const contentPath = join(spoolDirectory, safeName)
  await writeFile(contentPath, content, { encoding: 'utf8', flag: 'wx' })
  try {
    await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', printScriptPath,
      '-QueueName', queue,
      '-ContentPath', contentPath,
      '-DocumentName', documentName,
      '-Profile', profile,
      '-Copies', String(copies),
    ], { windowsHide: true, timeout: 45_000, maxBuffer: 1024 * 1024 })
  } finally {
    await import('node:fs/promises').then(({ unlink }) => unlink(contentPath).catch(() => undefined))
  }
}

async function listQueues() {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', listScriptPath,
  ], { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 })
  const parsed = JSON.parse(stdout.trim() || '[]')
  if (!Array.isArray(parsed)) throw new Error('printer_list_invalid')
  return parsed.filter((queue) => typeof queue === 'string' && queue.trim()).map((queue) => queue.trim()).slice(0, 64)
}

function renderTicket(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || !Array.isArray(value.lines)) {
    throw new Error('unsupported_ticket_snapshot')
  }
  const title = requiredText(value.title, 'ticket.title')
  const lines = [
    'M-BOX · SHANGHAI',
    value.test === true ? '【系统打印测试】' : '',
    center(title, 24),
    String(value.subtitle || ''),
    divider(),
    value.tableCode ? `桌台：${value.tableCode}${value.guestCount ? `  人数：${value.guestCount}` : ''}` : '',
    `单号：${requiredText(value.ticketReference, 'ticket.ticketReference')}`,
    `营业日：${requiredText(value.businessDate, 'ticket.businessDate')}`,
    divider(),
  ]
  for (const item of value.lines) {
    if (!item || typeof item !== 'object') throw new Error('invalid_ticket_line')
    lines.push(`${requiredText(item.name, 'line.name')}  ×${positiveInteger(item.quantity, 'line.quantity')}`)
    if (item.note) lines.push(`  备注：${String(item.note)}`)
    if (Number.isSafeInteger(item.totalAmountMinor)) lines.push(`  小计：${formatCny(item.totalAmountMinor)}`)
  }
  lines.push(divider())
  if (value.payment) lines.push(`支付方式：${paymentLabel(value.payment)}`)
  if (Number.isSafeInteger(value.totalAmountMinor)) lines.push(`合计：${formatCny(value.totalAmountMinor)}`)
  if (value.note) lines.push(`备注：${String(value.note)}`)
  lines.push('', '请按票据内容执行；异常请联系当班负责人。', '')
  return lines.filter((line, index) => line !== '' || index > lines.length - 4).join('\r\n')
}

function renderTestTicket(queue) {
  return ['M-BOX · SHANGHAI', '【系统打印测试】', divider(), `打印机：${queue}`, `电脑：${hostname()}`, `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`, divider(), '若文字、中文和切纸均正常，请在后台完成验收。', ''].join('\r\n')
}

function paymentLabel(payment) {
  const provider = String(payment?.provider || '')
  if (provider === 'cash') return '现金支付'
  if (provider === 'physical_pos') return 'POS刷卡支付'
  if (provider === 'wechat') return '微信支付'
  if (provider === 'postar') return '星驿支付'
  return '测试支付'
}

async function authenticatedRequest(config, path, body) {
  assertPaired(config)
  return request(config.serverUrl, path, body, {
    'x-mbox-print-bridge-id': config.publicId,
    authorization: `Bearer ${config.credential}`,
  })
}

async function request(serverUrl, path, body, headers = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(new URL(path, serverUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`http_${response.status}:${payload?.error?.code || 'request_failed'}`)
    return payload
  } finally {
    clearTimeout(timeout)
  }
}

async function readConfig(requireCredential) {
  const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''))
  assertServerUrl(config.serverUrl)
  if (requireCredential) assertPaired(config)
  return config
}

async function readJournal() {
  try {
    const value = JSON.parse(await readFile(journalPath, 'utf8'))
    return value && typeof value === 'object' && value.entries && typeof value.entries === 'object'
      ? value : { version: 1, entries: {} }
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, entries: {} }
    throw error
  }
}

function saveJournal(journal) { return atomicJson(journalPath, journal) }

async function atomicJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`
  const handle = await open(temporaryPath, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporaryPath, path)
}

function trimJournal(journal) {
  const entries = Object.entries(journal.entries)
  if (entries.length <= 10_000) return
  entries.sort((left, right) => Date.parse(left[1]?.updatedAt || '') - Date.parse(right[1]?.updatedAt || ''))
  for (const [key, value] of entries.slice(0, entries.length - 10_000)) {
    if (value?.state === 'printed') delete journal.entries[key]
  }
}

function assertServerUrl(value) {
  const url = new URL(requiredText(value, 'serverUrl'))
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('打印桥仅允许HTTPS服务地址')
}

function assertPaired(config) {
  requiredText(config.publicId, 'publicId')
  requiredText(config.credential, 'credential')
}

function readProfile(value) {
  if (!['escpos_58', 'escpos_80', 'windows_text'].includes(value)) throw new Error('unsupported_print_profile')
  return value
}

function readCopies(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) throw new Error('invalid_copies')
  return parsed
}

function positiveInteger(value, field) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${field}_invalid`)
  return parsed
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}_invalid`)
  return value.trim()
}

function requiredUuid(value, field) {
  const text = requiredText(value, field)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new Error(`${field}_invalid`)
  return text
}

function normalizeFailure(error) {
  const value = safeError(error).toLowerCase().replace(/[^a-z0-9_:-]/g, '_').slice(0, 90)
  if (value.includes('queue_not_found') || value.includes('invalidprinter')) return 'printer_queue_not_found'
  if (value.includes('timeout') || value.includes('aborted')) return 'bridge_print_timeout'
  return value || 'bridge_print_failed'
}

function isDefinitelyNotSubmitted(error) {
  const value = safeError(error).toLowerCase()
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code).toUpperCase() : ''
  return code === 'ENOENT'
    || value.includes('unsupported_ticket_snapshot')
    || value.includes('invalid_ticket_line')
    || value.includes('line.name_invalid')
    || value.includes('line.quantity_invalid')
    || value.includes('ticket.title_invalid')
    || value.includes('ticket.ticketreference_invalid')
    || value.includes('ticket.businessdate_invalid')
    || value.includes('unsupported_print_profile')
    || value.includes('invalid_copies')
    || value.includes('invalid_printer_queue')
    || value.includes('printer_unavailable')
}

function safeError(error) { return error instanceof Error ? error.message : String(error) }
function formatCny(value) { return `¥${(value / 100).toFixed(2)}` }
function divider() { return '--------------------------------' }
function center(value, width) { const pad = Math.max(0, Math.floor((width - value.length) / 2)); return `${' '.repeat(pad)}${value}` }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
