import { createHash } from 'node:crypto'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { TableQrProvisioner, type ProvisionedTableQr } from './table-qr-provisioner.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type StoreScope,
} from './transaction-runner.js'

export interface NormalizedTableQrEntry {
  tableId: string
  tableCode: string
  tableDisplayName: string
  qrVersion: number
  tokenSha256: string
  url: string
}

export interface NormalizedTableQrGenerationInput {
  provisioner: Pick<TableQrProvisioner, 'provision'>
  scope: Readonly<StoreScope>
  businessDate: string
  actorEmployeeId: string
  tableCodes: readonly string[]
  reason: string
  rotateExisting?: boolean
  guestBaseUrl: string
  outputDirectory: string
  generatedAt?: Date
}

export interface NormalizedTableQrGenerationResult {
  entries: readonly NormalizedTableQrEntry[]
  privateManifestPath: string
  auditManifestPath: string
}

interface AuditEntry {
  tableId: string
  tableCode: string
  tableDisplayName: string
  qrVersion: number
  tokenSha256: string
}

const PRIVATE_MANIFEST = 'table-qrs.private.json'
const AUDIT_MANIFEST = 'table-qrs.audit.json'

export function buildNormalizedTableQrEntries(
  provisioned: readonly ProvisionedTableQr[],
  guestBaseUrl: string,
): NormalizedTableQrEntry[] {
  const baseUrl = validateGuestBaseUrl(guestBaseUrl)
  return provisioned.map((record) => {
    const url = new URL(baseUrl)
    url.searchParams.set('table', record.tableCode)
    url.hash = new URLSearchParams({ token: record.tableQrToken }).toString()
    return Object.freeze({
      tableId: record.tableId,
      tableCode: record.tableCode,
      tableDisplayName: record.tableDisplayName,
      qrVersion: record.qrVersion,
      tokenSha256: createHash('sha256').update(record.tableQrToken).digest('hex'),
      url: url.toString(),
    })
  })
}

export async function generateNormalizedTableQrArtifacts(
  input: Readonly<NormalizedTableQrGenerationInput>,
): Promise<NormalizedTableQrGenerationResult> {
  validateGuestBaseUrl(input.guestBaseUrl)
  const outputDirectory = resolve(input.outputDirectory)
  await preparePrivateOutputDirectory(outputDirectory)
  let credentialsActivated = false

  try {
    const provisioned = await input.provisioner.provision({
      scope: input.scope,
      businessDate: input.businessDate,
      actorEmployeeId: input.actorEmployeeId,
      tableCodes: input.tableCodes,
      reason: input.reason,
      rotateExisting: input.rotateExisting,
    })
    credentialsActivated = true
    const entries = buildNormalizedTableQrEntries(provisioned, input.guestBaseUrl)
    const generatedAt = (input.generatedAt ?? new Date()).toISOString()
    const privateManifestPath = resolve(outputDirectory, PRIVATE_MANIFEST)
    const auditManifestPath = resolve(outputDirectory, AUDIT_MANIFEST)

    await writePrivateJson(privateManifestPath, {
      format: 'mbox.normalized-fixed-table-qr.v1',
      sensitive: true,
      generatedAt,
      legacyQrMigration: 'disabled',
      qrPayloadField: 'url',
      entries,
    })
    await writePrivateJson(auditManifestPath, {
      format: 'mbox.normalized-fixed-table-qr-audit.v1',
      sensitive: false,
      generatedAt,
      legacyQrMigration: 'disabled',
      entries: entries.map(toAuditEntry),
    })

    return Object.freeze({ entries, privateManifestPath, auditManifestPath })
  } catch (error) {
    // Preserve any private recovery manifest once credentials are active.
    if (!credentialsActivated) {
      await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  }
}

function toAuditEntry(entry: Readonly<NormalizedTableQrEntry>): AuditEntry {
  return {
    tableId: entry.tableId,
    tableCode: entry.tableCode,
    tableDisplayName: entry.tableDisplayName,
    qrVersion: entry.qrVersion,
    tokenSha256: entry.tokenSha256,
  }
}

function validateGuestBaseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('顾客桌码入口必须是有效URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('顾客桌码入口必须使用HTTP或HTTPS')
  }
  if (url.username || url.password) throw new Error('顾客桌码入口不能包含账号或密码')
  if (url.searchParams.has('token') || url.searchParams.has('tableQrToken')) {
    throw new Error('顾客桌码入口不能在查询参数中预设凭证')
  }
  if (url.hash) throw new Error('顾客桌码入口不能预设fragment')
  return url
}

async function preparePrivateOutputDirectory(outputDirectory: string): Promise<void> {
  const parent = dirname(outputDirectory)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await mkdir(outputDirectory, { mode: 0o700 })
  await chmod(outputDirectory, 0o700)
  const probe = resolve(outputDirectory, '.write-probe')
  await writeFile(probe, 'ok\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rm(probe)
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  await chmod(path, 0o600)
}

async function listActiveTableCodes(
  transactions: ScopedPostgresTransactionRunner,
  scope: Readonly<StoreScope>,
): Promise<string[]> {
  return transactions.run(scope, async (transaction) => {
    const result = await transaction.query<{ code: string }>(`
      SELECT code
      FROM mbox.tables
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND status <> 'retired'
      ORDER BY code
    `, [scope.tenantId, scope.storeId])
    return result.rows.map((row) => row.code)
  }, { readOnly: true, isolation: 'repeatable-read' })
}

function parseRequestedTableCodes(value: string): string[] | 'ALL' {
  const normalized = value.trim()
  if (normalized.toUpperCase() === 'ALL') return 'ALL'
  const codes = [...new Set(normalized.split(',').map((code) => code.trim().toUpperCase()).filter(Boolean))]
  if (codes.length === 0) throw new Error('MBOX_QR_TABLE_CODES必须填写桌号或ALL')
  return codes
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少${name}`)
  return value
}

function defaultOutputDirectory(storeId: string): string {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return resolve('private/table-qrs/normalized', storeId, timestamp)
}

async function main(): Promise<void> {
  if (process.env.MBOX_CONFIRM_NORMALIZED_QR_GENERATION !== 'GENERATE') {
    throw new Error('生成规范化固定桌码必须设置MBOX_CONFIRM_NORMALIZED_QR_GENERATION=GENERATE')
  }

  const databaseUrl = requiredEnvironment('DATABASE_URL')
  const scope = Object.freeze({
    tenantId: requiredEnvironment('MBOX_TENANT_ID'),
    storeId: requiredEnvironment('MBOX_STORE_ID'),
  })
  const secret = requiredEnvironment('MBOX_NORMALIZED_SECRET')
  const guestBaseUrl = requiredEnvironment('MBOX_GUEST_BASE_URL')
  if (process.env.NODE_ENV === 'production' && !guestBaseUrl.startsWith('https://')) {
    throw new Error('生产固定桌码入口必须使用HTTPS')
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    application_name: 'mbox-normalized-table-qr-generator',
  }) as unknown as PostgresPool
  const transactions = new ScopedPostgresTransactionRunner(pool)

  try {
    const requested = parseRequestedTableCodes(requiredEnvironment('MBOX_QR_TABLE_CODES'))
    const tableCodes = requested === 'ALL' ? await listActiveTableCodes(transactions, scope) : requested
    if (tableCodes.length === 0) throw new Error('当前门店没有可签发固定桌码的桌台')
    const outputDirectory = resolve(
      process.env.MBOX_QR_OUTPUT_DIR?.trim() || defaultOutputDirectory(scope.storeId),
    )
    const result = await generateNormalizedTableQrArtifacts({
      provisioner: new TableQrProvisioner(transactions, secret),
      scope,
      businessDate: requiredEnvironment('MBOX_QR_BUSINESS_DATE'),
      actorEmployeeId: requiredEnvironment('MBOX_QR_ACTOR_EMPLOYEE_ID'),
      tableCodes,
      reason: requiredEnvironment('MBOX_QR_REASON'),
      rotateExisting: process.env.MBOX_QR_ROTATE_EXISTING === 'ROTATE',
      guestBaseUrl,
      outputDirectory,
    })
    process.stdout.write(
      `generated ${result.entries.length} normalized fixed table QR records; ${PRIVATE_MANIFEST} and ${AUDIT_MANIFEST} written; legacy migration disabled\n`,
    )
  } finally {
    await pool.end()
  }
}

const isDirectRun = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const code = error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    process.stderr.write(`normalized table QR generation failed: ${code}\n`)
    process.exitCode = 1
  })
}
