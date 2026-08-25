import type { JsonObject, JsonValue } from './command-executor.js'

export const PRINT_TICKET_SCHEMA_VERSION = 1

export type PrintTicketKind = 'cashier_settlement' | 'cashier_payment' | 'cashier_refund' | 'bar_production' | 'kitchen_production'
export type PrintTicketPaper = '58mm' | '80mm' | 'a4'

export interface PrintTicketOutputProfile {
  paper: PrintTicketPaper
  thermal: boolean
}

export const DEFAULT_PRINT_TICKET_OUTPUT_PROFILE: Readonly<PrintTicketOutputProfile> = Object.freeze({
  paper: '80mm',
  thermal: true,
})

export interface PrintTicketLine {
  name: string
  quantity: number
  note?: string | null
  unitAmountMinor?: number | null
  totalAmountMinor?: number | null
}

export interface PrintTicketPayment {
  provider: 'wechat' | 'postar' | 'cash' | 'physical_pos' | 'external_manual' | 'simulation'
  method: 'jsapi' | 'native_qr' | 'auth_code' | 'cash' | 'card' | 'manual'
}

export interface PrintTicketSnapshot {
  schemaVersion: typeof PRINT_TICKET_SCHEMA_VERSION
  kind: PrintTicketKind
  title: string
  subtitle: string
  test: boolean
  issuedAt: string
  businessDate: string
  ticketReference: string
  tableCode: string | null
  guestCount: number | null
  operatorLabel: string | null
  note: string | null
  payment: PrintTicketPayment | null
  lines: readonly PrintTicketLine[]
  totalAmountMinor: number | null
  currency: 'CNY'
}

const TICKET_TITLES: Record<PrintTicketKind, string> = {
  cashier_settlement: '结账单',
  cashier_payment: '支付凭条',
  cashier_refund: '退款凭条',
  bar_production: '吧台调酒制作单',
  kitchen_production: '后厨制作单',
}

export function createPrintTicketSnapshot(input: Readonly<Omit<PrintTicketSnapshot, 'schemaVersion' | 'title'>>): PrintTicketSnapshot {
  assertTicketKind(input.kind)
  assertShortText(input.subtitle, 'subtitle', 1, 80)
  assertShortText(input.ticketReference, 'ticketReference', 3, 120)
  assertDateTime(input.issuedAt, 'issuedAt')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) throw new TypeError('businessDate格式无效')
  if (input.tableCode !== null) assertShortText(input.tableCode, 'tableCode', 1, 32)
  if (input.guestCount !== null && (!Number.isSafeInteger(input.guestCount) || input.guestCount < 1 || input.guestCount > 200)) {
    throw new TypeError('guestCount无效')
  }
  if (input.operatorLabel !== null) assertShortText(input.operatorLabel, 'operatorLabel', 1, 80)
  if (input.note !== null) assertShortText(input.note, 'note', 1, 240)
  if (input.payment !== null) validatePayment(input.payment)
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 60) {
    throw new TypeError('lines必须包含1至60项')
  }
  const lines = input.lines.map((line) => normalizeLine(line))
  if (input.totalAmountMinor !== null && (!Number.isSafeInteger(input.totalAmountMinor) || input.totalAmountMinor < 0)) {
    throw new TypeError('totalAmountMinor无效')
  }
  return Object.freeze({
    schemaVersion: PRINT_TICKET_SCHEMA_VERSION,
    kind: input.kind,
    title: TICKET_TITLES[input.kind],
    subtitle: input.subtitle.trim(),
    test: input.test,
    issuedAt: input.issuedAt,
    businessDate: input.businessDate,
    ticketReference: input.ticketReference.trim(),
    tableCode: input.tableCode?.trim() ?? null,
    guestCount: input.guestCount,
    operatorLabel: input.operatorLabel?.trim() ?? null,
    note: input.note?.trim() ?? null,
    payment: input.payment === null ? null : Object.freeze({ ...input.payment }),
    lines,
    totalAmountMinor: input.totalAmountMinor,
    currency: 'CNY',
  })
}

export function isPrintTicketSnapshot(value: unknown): value is PrintTicketSnapshot {
  try {
    parsePrintTicketSnapshot(value)
    return true
  } catch {
    return false
  }
}

export function parsePrintTicketSnapshot(value: unknown): PrintTicketSnapshot {
  if (!isRecord(value)) throw new TypeError('打印票据快照必须是对象')
  if (value.schemaVersion !== PRINT_TICKET_SCHEMA_VERSION) throw new TypeError('不支持的打印票据版本')
  return createPrintTicketSnapshot({
    kind: readKind(value.kind),
    subtitle: readString(value.subtitle, 'subtitle'),
    test: value.test === true,
    issuedAt: readString(value.issuedAt, 'issuedAt'),
    businessDate: readString(value.businessDate, 'businessDate'),
    ticketReference: readString(value.ticketReference, 'ticketReference'),
    tableCode: nullableString(value.tableCode, 'tableCode'),
    guestCount: nullableGuestCount(value.guestCount),
    operatorLabel: nullableString(value.operatorLabel, 'operatorLabel'),
    note: nullableString(value.note, 'note'),
    payment: nullablePayment(value.payment),
    lines: readLines(value.lines),
    totalAmountMinor: nullableInteger(value.totalAmountMinor, 'totalAmountMinor'),
    currency: value.currency === 'CNY' ? 'CNY' : invalidCurrency(),
  })
}

export function ticketToJson(ticket: Readonly<PrintTicketSnapshot>): JsonObject {
  return {
    schemaVersion: ticket.schemaVersion,
    kind: ticket.kind,
    title: ticket.title,
    subtitle: ticket.subtitle,
    test: ticket.test,
    issuedAt: ticket.issuedAt,
    businessDate: ticket.businessDate,
    ticketReference: ticket.ticketReference,
    tableCode: ticket.tableCode,
    guestCount: ticket.guestCount,
    operatorLabel: ticket.operatorLabel,
    note: ticket.note,
    payment: ticket.payment === null ? null : { ...ticket.payment },
    lines: ticket.lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      note: line.note ?? null,
      unitAmountMinor: line.unitAmountMinor ?? null,
      totalAmountMinor: line.totalAmountMinor ?? null,
    })),
    totalAmountMinor: ticket.totalAmountMinor,
    currency: ticket.currency,
  }
}

export function renderPrintTicketHtml(
  ticket: Readonly<PrintTicketSnapshot>,
  requestedProfile: Readonly<PrintTicketOutputProfile> = DEFAULT_PRINT_TICKET_OUTPUT_PROFILE,
): string {
  const profile = normalizePrintTicketOutputProfile(requestedProfile)
  const production = ticket.kind === 'bar_production' || ticket.kind === 'kitchen_production'
  const amount = ticket.totalAmountMinor === null ? '' : `<section class="total"><span>合计</span><strong>${escapeHtml(formatCny(ticket.totalAmountMinor))}</strong></section>`
  const table = ticket.tableCode === null ? '' : `<section class="table-hero"><span>桌台</span><strong>${escapeHtml(ticket.tableCode)}</strong></section>`
  const guest = production || ticket.guestCount === null ? '' : `<p class="guest-count"><span>消费人数</span><strong>${ticket.guestCount} 位</strong></p>`
  const operator = ticket.operatorLabel === null ? '' : `<span>${escapeHtml(ticket.operatorLabel)}</span>`
  const payment = ticket.payment === null
    ? (ticket.kind === 'cashier_settlement' ? `<section class="payment"><span>支付方式</span><strong>待选择</strong></section>` : '')
    : `<section class="payment"><span>支付方式</span><strong>${escapeHtml(paymentLabel(ticket.payment))}</strong></section>`
  const venue = ticket.kind === 'cashier_settlement' ? '<p class="venue">陆家嘴中心 L+MALL</p>' : ''
  const note = ticket.note === null ? '' : `<section class="note"><b>备注</b>${escapeHtml(ticket.note)}</section>`
  const lines = ticket.lines.map((line) => `<li><div><b>${escapeHtml(line.name)}</b>${line.note ? `<small>${escapeHtml(line.note)}</small>` : ''}</div><strong>×${line.quantity}</strong>${line.totalAmountMinor === null || line.totalAmountMinor === undefined ? '' : `<em>${escapeHtml(formatCny(line.totalAmountMinor))}</em>`}</li>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    @page { size: ${profile.paper === 'a4' ? 'A4' : `${profile.paper} auto`}; margin: 0; }
    :root { --ticket-width: ${profile.paper === 'a4' ? '80mm' : profile.paper}; --ticket-padding-x: ${profile.paper === '58mm' ? '4.5mm' : '6mm'}; --ticket-padding-y: ${profile.paper === '58mm' ? '5.5mm' : '7mm'}; --brand: ${profile.thermal ? '#15291f' : '#176a4a'}; --brand-soft: ${profile.thermal ? '#f4f4f4' : '#eff7f2'}; --text: #18241e; }
    * { box-sizing: border-box; } body { margin: 0; color: var(--text); font-family: "PingFang SC", "Microsoft YaHei", sans-serif; background: ${profile.paper === 'a4' ? '#fff' : '#f4f7f3'}; }
    main { width: var(--ticket-width); min-height: 120mm; margin: ${profile.paper === 'a4' ? '0 auto' : '0'}; padding: var(--ticket-padding-y) var(--ticket-padding-x) 8mm; background: #fff; }
    .brand { color: var(--brand); font-size: 9pt; font-weight: 800; letter-spacing: .16em; text-align: center; }
    h1 { margin: 3mm 0 1mm; color: #102d20; font-size: 17pt; line-height: 1.2; text-align: center; }
    .test { display: inline-block; margin: 1mm auto 3mm; padding: 1mm 3mm; border-radius: 99px; color: #fff; background: var(--brand); font-size: 7.5pt; font-weight: 800; letter-spacing: .08em; }
    .center { text-align: center; } .venue { margin: 2mm 0 -1mm; color: var(--brand); font-size: 9pt; font-weight: 800; letter-spacing: .18em; text-align: center; } .subtitle { margin: 0 0 4mm; color: #668072; font-size: 8.5pt; text-align: center; }
    .table-hero { display:flex; align-items:baseline; justify-content:center; gap:2mm; margin:1mm 0 1.4mm; padding:2.6mm 3mm 2.8mm; border: .45mm solid var(--brand); border-radius:2mm; color:var(--brand); background:var(--brand-soft); } .table-hero span { font-size:8pt; font-weight:700; letter-spacing:.1em; } .table-hero strong { font-size:24pt; line-height:1; letter-spacing:.02em; } .guest-count { display:flex; justify-content:center; gap:2mm; margin:0 0 3.2mm; color:#5b7465; font-size:8pt; letter-spacing:.05em; } .guest-count strong { color:var(--brand); font-size:10pt; }
    .meta { display: grid; gap: 1.4mm; padding: 3mm 0; border-top: .35mm solid #d9e6df; border-bottom: .35mm solid #d9e6df; color: #3f584b; font-size: 8pt; }
    .meta-line { display:flex; justify-content:space-between; gap: 3mm; } ul { margin: 3mm 0; padding: 0; list-style: none; } li { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap: 2mm; align-items:start; padding: 2.2mm 0; border-bottom: .2mm solid #edf1ee; font-size: 10pt; } li b { display:block; } li small { display:block; margin-top: .8mm; color:#6a7b71; font-size:7.5pt; line-height:1.4; } li strong { color:#176a4a; } li em { min-width:15mm; color:#304438; font-style:normal; text-align:right; }
    .payment { display:flex; align-items:center; justify-content:space-between; margin:3mm 0 0; padding:2.5mm 3mm; border:.3mm solid #bfdbcf; border-radius:1.8mm; background:var(--brand-soft); color:#3e5e4d; font-size:8pt; } .payment strong { color:var(--brand); font-size:11pt; }
    .note { margin-top: 3mm; padding: 2.5mm 3mm; border-left: 1.2mm solid #d8a846; background:#fffaf0; color:#66512a; font-size:8pt; line-height:1.5; } .note b { display:block; margin-bottom:.5mm; }
    .total { display:flex; align-items:end; justify-content:space-between; margin-top:4mm; padding-top:3mm; border-top:.6mm solid var(--brand); color:#244936; } .total strong { color:var(--brand); font-size:18pt; line-height:1; }
    footer { margin-top:5mm; color:#829287; font-size:7pt; line-height:1.5; text-align:center; } .dash { margin:4mm 0 0; border-top:.35mm dashed #8da99a; }
    main.production .table-hero { margin-top:0; border-width:.65mm; background:#eaf5ef; } main.production .table-hero strong { font-size:30pt; } main.production ul { margin-top:4mm; } main.production li { padding:3.5mm 0; font-size:12pt; } main.production li b { font-size:16pt; line-height:1.25; } main.production li small { font-size:9pt; } main.production li strong { font-size:14pt; }
    main.paper-58 .brand { font-size:7.5pt; } main.paper-58 h1 { font-size:15pt; } main.paper-58 .subtitle { font-size:7.5pt; } main.paper-58 .table-hero strong { font-size:20pt; } main.paper-58 .meta, main.paper-58 .payment, main.paper-58 .note { font-size:7pt; } main.paper-58 li { grid-template-columns:minmax(0,1fr) auto; font-size:9pt; } main.paper-58 li em { grid-column:2; min-width:0; } main.paper-58 li b { font-size:10pt; } main.paper-58 .total strong { font-size:16pt; } main.paper-58.production .table-hero strong { font-size:25pt; } main.paper-58.production li b { font-size:13pt; } main.paper-58.production li { font-size:10pt; }
  </style></head><body><main class="${production ? 'production' : 'cashier'} paper-${profile.paper.replace('mm', '')}"><div class="brand">M-BOX · SHANGHAI</div><div class="center">${ticket.test ? '<span class="test">系统打印测试</span>' : ''}</div>${venue}<h1>${escapeHtml(ticket.title)}</h1><p class="subtitle">${escapeHtml(ticket.subtitle)}</p>${table}${guest}<section class="meta"><div class="meta-line"><span>${escapeHtml(ticket.ticketReference)}</span><span>${escapeHtml(ticket.businessDate)} ${escapeHtml(formatTime(ticket.issuedAt))}</span></div><div class="meta-line">${operator}</div></section><ul>${lines}</ul>${payment}${note}${amount}<div class="dash"></div><footer>请按票据内容执行；如有异常请联系当班负责人。<br>此票据为${ticket.test ? '测试' : '系统'}留痕，不替代支付凭证。</footer></main></body></html>`
}

export function normalizePrintTicketOutputProfile(value: Readonly<PrintTicketOutputProfile>): PrintTicketOutputProfile {
  if (value.paper !== '58mm' && value.paper !== '80mm' && value.paper !== 'a4') throw new TypeError('打印纸张规格无效')
  if (typeof value.thermal !== 'boolean') throw new TypeError('打印方式无效')
  if (value.paper === 'a4' && value.thermal) throw new TypeError('A4不能标记为热敏打印')
  if ((value.paper === '58mm' || value.paper === '80mm') && !value.thermal) throw new TypeError('小票纸必须标记为热敏打印')
  return Object.freeze({ paper: value.paper, thermal: value.thermal })
}

export function inferPrintTicketOutputProfile(cupsCapabilities: string): PrintTicketOutputProfile | null {
  const normalized = cupsCapabilities.toLowerCase()
  const selected = normalized.match(/pagesize\/[^:\n]*:[^\n]*\*([^\s]+)/)?.[1] ?? null
  const selectedProfile = selected === null ? null : profileForCupsMediaName(selected)
  if (selectedProfile !== null) return selectedProfile
  const candidates = new Set<PrintTicketPaper>()
  if (/(^|[^0-9])58(?:\.0)?mm|58x|2\.25/.test(normalized)) candidates.add('58mm')
  if (/(^|[^0-9])80(?:\.0)?mm|80x|3\.15/.test(normalized)) candidates.add('80mm')
  if (/\ba4\b|210x297/.test(normalized)) candidates.add('a4')
  if (candidates.size === 1) return profileForPaper([...candidates][0]!)
  return null
}

function profileForCupsMediaName(value: string): PrintTicketOutputProfile | null {
  if (/(^|[^0-9])58(?:\.0)?mm|58x|2\.25/.test(value)) return profileForPaper('58mm')
  if (/(^|[^0-9])80(?:\.0)?mm|80x|3\.15/.test(value)) return profileForPaper('80mm')
  if (/\ba4\b|210x297/.test(value)) return profileForPaper('a4')
  return null
}

function profileForPaper(paper: PrintTicketPaper): PrintTicketOutputProfile {
  return normalizePrintTicketOutputProfile({ paper, thermal: paper !== 'a4' })
}

export function printTicketPageHeightMm(ticket: Readonly<PrintTicketSnapshot>, profile: Readonly<PrintTicketOutputProfile>): number {
  const normalized = normalizePrintTicketOutputProfile(profile)
  if (normalized.paper === 'a4') return 297
  const fixed = ticket.kind === 'bar_production' || ticket.kind === 'kitchen_production' ? 70 : 92
  const perLine = normalized.paper === '58mm' ? 13 : 11
  const extra = (ticket.note === null ? 0 : 14) + (ticket.payment === null ? 0 : 11) + (ticket.totalAmountMinor === null ? 0 : 16)
  return Math.min(260, Math.max(90, fixed + ticket.lines.length * perLine + extra))
}

function normalizeLine(input: Readonly<PrintTicketLine>): PrintTicketLine {
  assertShortText(input.name, 'line.name', 1, 120)
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 999) throw new TypeError('line.quantity无效')
  if (input.note !== undefined && input.note !== null) assertShortText(input.note, 'line.note', 1, 240)
  for (const [key, value] of [['unitAmountMinor', input.unitAmountMinor], ['totalAmountMinor', input.totalAmountMinor]] as const) {
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`line.${key}无效`)
  }
  return Object.freeze({ name: input.name.trim(), quantity: input.quantity, note: input.note?.trim() ?? null, unitAmountMinor: input.unitAmountMinor ?? null, totalAmountMinor: input.totalAmountMinor ?? null })
}

function readLines(value: unknown): PrintTicketLine[] {
  if (!Array.isArray(value)) throw new TypeError('lines必须是数组')
  return value.map((line) => {
    if (!isRecord(line)) throw new TypeError('line无效')
    return { name: readString(line.name, 'line.name'), quantity: readInteger(line.quantity, 'line.quantity'), note: nullableString(line.note, 'line.note'), unitAmountMinor: nullableInteger(line.unitAmountMinor, 'line.unitAmountMinor'), totalAmountMinor: nullableInteger(line.totalAmountMinor, 'line.totalAmountMinor') }
  })
}

function validatePayment(value: Readonly<PrintTicketPayment>) {
  if (!['wechat', 'postar', 'cash', 'physical_pos', 'external_manual', 'simulation'].includes(value.provider)) throw new TypeError('payment.provider无效')
  if (!['jsapi', 'native_qr', 'auth_code', 'cash', 'card', 'manual'].includes(value.method)) throw new TypeError('payment.method无效')
}

function nullablePayment(value: unknown): PrintTicketPayment | null {
  if (value === null) return null
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.method !== 'string') throw new TypeError('payment无效')
  const payment: PrintTicketPayment = { provider: value.provider as PrintTicketPayment['provider'], method: value.method as PrintTicketPayment['method'] }
  validatePayment(payment)
  return payment
}

export function paymentLabel(payment: Readonly<PrintTicketPayment>): string {
  validatePayment(payment)
  if (payment.provider === 'wechat') return payment.method === 'jsapi' ? '微信支付' : '微信扫码支付'
  if (payment.provider === 'postar') return payment.method === 'card' ? '银行卡支付' : '星驿支付'
  if (payment.provider === 'cash') return '现金支付'
  if (payment.provider === 'physical_pos') return 'POS刷卡支付'
  if (payment.provider === 'external_manual') return '其他线下收款'
  return '模拟支付（测试）'
}

function assertTicketKind(value: unknown): asserts value is PrintTicketKind {
  if (value !== 'cashier_settlement' && value !== 'cashier_payment' && value !== 'cashier_refund' && value !== 'bar_production' && value !== 'kitchen_production') throw new TypeError('打印票据类型无效')
}

function readKind(value: unknown): PrintTicketKind { assertTicketKind(value); return value }
function readString(value: unknown, field: string): string { if (typeof value !== 'string') throw new TypeError(`${field}必须是文本`); return value }
function nullableString(value: unknown, field: string): string | null { if (value === null) return null; return readString(value, field) }
function readInteger(value: unknown, field: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${field}必须是整数`); return value }
function nullableInteger(value: unknown, field: string): number | null { if (value === null) return null; return readInteger(value, field) }
function nullableGuestCount(value: unknown): number | null {
  const guestCount = nullableInteger(value, 'guestCount')
  if (guestCount !== null && (guestCount < 1 || guestCount > 200)) throw new TypeError('guestCount无效')
  return guestCount
}
function invalidCurrency(): never { throw new TypeError('currency必须为CNY') }
function assertShortText(value: unknown, field: string, min: number, max: number): asserts value is string { if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw new TypeError(`${field}长度无效`) }
function assertDateTime(value: unknown, field: string): asserts value is string { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${field}必须为有效时间`) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function formatCny(value: number): string { return `¥${(value / 100).toFixed(2)}` }
function formatTime(value: string): string { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date(value)) }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!) }

export function jsonTicketSnapshot(ticket: Readonly<PrintTicketSnapshot>): JsonObject { return ticketToJson(ticket) }
export function ticketJsonValue(ticket: Readonly<PrintTicketSnapshot>): JsonValue { return ticketToJson(ticket) }
