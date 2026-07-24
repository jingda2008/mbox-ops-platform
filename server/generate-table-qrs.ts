import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import QRCode from 'qrcode'
import type { RuntimeState, Table } from '../src/shared/contracts.js'
import { validateProvisionState } from './provision-runtime.js'
import { signStaticTableQrToken } from './table-access.js'

export interface TableQrEntry {
  tableCode: string
  displayName: string
  tokenVersion: number
  tokenSha256: string
  url: string
  pngFile: string
}

const glyphs: Record<string, string[]> = {
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
}

const cardColors = {
  ink: [17, 17, 17, 255] as const,
  gold: [214, 180, 81, 255] as const,
  red: [217, 47, 58, 255] as const,
  white: [255, 255, 255, 255] as const,
}

function fillRect(image: PNG, x: number, y: number, width: number, height: number, color: readonly number[]) {
  for (let row = Math.max(0, y); row < Math.min(image.height, y + height); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(image.width, x + width); column += 1) {
      const offset = (row * image.width + column) * 4
      image.data[offset] = color[0]!
      image.data[offset + 1] = color[1]!
      image.data[offset + 2] = color[2]!
      image.data[offset + 3] = color[3]!
    }
  }
}

function textWidth(text: string, scale: number) {
  return [...text].reduce((total, character, index) => (
    total + (glyphs[character]?.[0]?.length ?? 5) * scale + (index === text.length - 1 ? 0 : scale)
  ), 0)
}

function drawText(image: PNG, text: string, y: number, scale: number, color: readonly number[]) {
  const normalized = text.toUpperCase()
  let x = Math.round((image.width - textWidth(normalized, scale)) / 2)
  for (const character of normalized) {
    const glyph = glyphs[character] ?? glyphs[' ']!
    glyph.forEach((row, rowIndex) => [...row].forEach((pixel, columnIndex) => {
      if (pixel === '1') fillRect(image, x + columnIndex * scale, y + rowIndex * scale, scale, scale, color)
    }))
    x += (glyph[0]!.length + 1) * scale
  }
}

export async function renderTableQrCard(entry: TableQrEntry) {
  const qrBuffer = await QRCode.toBuffer(entry.url, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: 4,
    width: 880,
    color: { dark: '#111111', light: '#ffffff' },
  })
  const qr = PNG.sync.read(qrBuffer)
  const card = new PNG({ width: 1024, height: 1240 })
  fillRect(card, 0, 0, card.width, card.height, cardColors.white)
  fillRect(card, 0, 0, card.width, 18, cardColors.gold)
  fillRect(card, 0, 18, 18, 190, cardColors.red)
  drawText(card, 'M-BOX TABLE', 46, 7, cardColors.ink)
  drawText(card, entry.tableCode, 118, 20, cardColors.ink)
  const qrX = Math.round((card.width - qr.width) / 2)
  const qrY = 310
  PNG.bitblt(qr, card, 0, 0, qr.width, qr.height, qrX, qrY)
  fillRect(card, 0, card.height - 18, card.width, 18, cardColors.gold)
  return PNG.sync.write(card)
}

function tokenVersion(table: Table) {
  const version = (table as Table & { qrTokenVersion?: number }).qrTokenVersion
  return Number.isSafeInteger(version) && Number(version) > 0 ? Number(version) : 1
}

export function buildTableQrEntries(state: RuntimeState, baseUrl: string, secret: string, issuedAt = Date.now()) {
  const parsedUrl = new URL(baseUrl)
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('顾客入口必须是HTTP或HTTPS URL')
  return state.tables.toSorted((left, right) => left.code.localeCompare(right.code)).map((table): TableQrEntry => {
    const version = tokenVersion(table)
    const token = signStaticTableQrToken({
      storeId: state.store.id,
      tableCode: table.code,
      tokenVersion: version,
      issuedAt,
    }, secret)
    const url = new URL(parsedUrl)
    url.searchParams.set('token', token)
    return {
      tableCode: table.code,
      displayName: table.displayName,
      tokenVersion: version,
      tokenSha256: createHash('sha256').update(token).digest('hex'),
      url: url.toString(),
      pngFile: `${table.code.replace(/[^A-Za-z0-9_-]/g, '_')}.png`,
    }
  })
}

export async function generateTableQrFiles(entries: TableQrEntry[], outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true })
  await Promise.all(entries.map(async (entry) => {
    await writeFile(resolve(outputDirectory, entry.pngFile), await renderTableQrCard(entry))
  }))
  await writeFile(resolve(outputDirectory, 'manifest.private.json'), `${JSON.stringify(entries, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  const auditRows = ['table_code,display_name,visible_label,token_version,token_sha256,png_file,card_format']
  for (const entry of entries) {
    auditRows.push([entry.tableCode, entry.displayName, entry.tableCode, String(entry.tokenVersion), entry.tokenSha256, entry.pngFile, 'labeled_png_v2']
      .map((value) => `"${value.replaceAll('"', '""')}"`).join(','))
  }
  await writeFile(resolve(outputDirectory, 'audit.csv'), `${auditRows.join('\n')}\n`, 'utf8')
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const required = (name: string) => {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`缺少${name}`)
    return value
  }
  if (process.env.MBOX_CONFIRM_QR_GENERATION !== 'GENERATE') {
    throw new Error('生成正式桌码必须设置MBOX_CONFIRM_QR_GENERATION=GENERATE')
  }
  const statePath = resolve(required('MBOX_INITIAL_STATE_PATH'))
  const storeCode = required('MBOX_STORE_CODE')
  const state = validateProvisionState(JSON.parse(await readFile(statePath, 'utf8')) as unknown, storeCode)
  const baseUrl = required('MBOX_GUEST_BASE_URL')
  if (process.env.MBOX_RUNTIME_MODE === 'production' && !baseUrl.startsWith('https://')) {
    throw new Error('生产桌码入口必须使用HTTPS')
  }
  const outputDirectory = resolve(process.env.MBOX_QR_OUTPUT_DIR?.trim() || `private/table-qrs/${storeCode}/permanent`)
  const entries = buildTableQrEntries(state, baseUrl, required('MBOX_QR_SECRET'))
  await generateTableQrFiles(entries, outputDirectory)
  process.stdout.write(`generated ${entries.length} permanent table QR files in ${basename(outputDirectory)}\n`)
}
