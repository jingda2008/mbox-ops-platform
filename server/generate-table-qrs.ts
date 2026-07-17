import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  await Promise.all(entries.map((entry) => QRCode.toFile(resolve(outputDirectory, entry.pngFile), entry.url, {
    errorCorrectionLevel: 'H',
    margin: 4,
    width: 1024,
    color: { dark: '#111111', light: '#ffffff' },
  })))
  await writeFile(resolve(outputDirectory, 'manifest.private.json'), `${JSON.stringify(entries, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  const auditRows = ['table_code,display_name,token_version,token_sha256,png_file']
  for (const entry of entries) {
    auditRows.push([entry.tableCode, entry.displayName, String(entry.tokenVersion), entry.tokenSha256, entry.pngFile]
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
