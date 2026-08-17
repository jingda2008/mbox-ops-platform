import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OfficialWechatMiniProgramCodeProvider,
  type WechatMiniProgramCodeInput,
} from './wechat-mini-program-code.js'

interface PrivateTableQrEntry {
  tableId: string
  tableCode: string
  tableDisplayName: string
  qrVersion: number
  tokenSha256: string
  url: string
}

export interface WechatTableMiniCodeProvider {
  render(input: Readonly<WechatMiniProgramCodeInput>): Promise<Buffer>
}

export interface RenderWechatTableMiniCodesInput {
  privateManifestPath: string
  outputDirectory: string
  provider: WechatTableMiniCodeProvider
  page: string
  environment: 'release' | 'trial' | 'develop'
  renderedAt?: Date
}

export interface RenderWechatTableMiniCodesResult {
  count: number
  auditManifestPath: string
}

export async function renderWechatTableMiniCodes(
  input: Readonly<RenderWechatTableMiniCodesInput>,
): Promise<RenderWechatTableMiniCodesResult> {
  const sourcePath = resolve(input.privateManifestPath)
  const sourceStat = await stat(sourcePath)
  if ((sourceStat.mode & 0o077) !== 0) throw new Error('桌码私密清单权限必须为0600')
  const manifest = privateManifest(JSON.parse(await readFile(sourcePath, 'utf8')))
  const outputDirectory = resolve(input.outputDirectory)
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 })
  await mkdir(outputDirectory, { mode: 0o700 })
  await chmod(outputDirectory, 0o700)
  const auditEntries: Array<Record<string, unknown>> = []
  for (const entry of manifest.entries) {
    const token = tableToken(entry.url)
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
      throw new Error(`${entry.tableCode}的桌码不是微信scene兼容的32字符凭证，必须明确轮换后再生成`)
    }
    const image = await input.provider.render({
      scene: token, page: input.page, environment: input.environment, width: 430,
    })
    const filename = `${safeTableCode(entry.tableCode)}.wechat-mini-code.png`
    const path = resolve(outputDirectory, filename)
    await writeFile(path, image, { mode: 0o600, flag: 'wx' })
    await chmod(path, 0o600)
    auditEntries.push({
      tableId: entry.tableId, tableCode: entry.tableCode,
      tableDisplayName: entry.tableDisplayName, qrVersion: entry.qrVersion,
      tokenSha256: entry.tokenSha256, filename,
      imageSha256: createHash('sha256').update(image).digest('hex'),
    })
  }
  const auditManifestPath = resolve(outputDirectory, 'wechat-mini-codes.audit.json')
  await writeFile(auditManifestPath, `${JSON.stringify({
    format: 'mbox.official-wechat-table-mini-codes.v1',
    renderedAt: (input.renderedAt ?? new Date()).toISOString(),
    sourceManifest: basename(sourcePath),
    page: input.page,
    environment: input.environment,
    entries: auditEntries,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await chmod(auditManifestPath, 0o600)
  return { count: auditEntries.length, auditManifestPath }
}

function privateManifest(value: unknown): { entries: PrivateTableQrEntry[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('桌码私密清单无效')
  const record = value as Record<string, unknown>
  if (record.format !== 'mbox.normalized-fixed-table-qr.v1' || !Array.isArray(record.entries)) {
    throw new Error('桌码私密清单版本无效')
  }
  const entries = record.entries.map((entry) => privateEntry(entry))
  if (entries.length < 1 || entries.length > 200) throw new Error('桌码私密清单数量无效')
  return { entries }
}

function privateEntry(value: unknown): PrivateTableQrEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('桌码私密清单条目无效')
  const entry = value as Record<string, unknown>
  const required = ['tableId', 'tableCode', 'tableDisplayName', 'tokenSha256', 'url'] as const
  if (!required.every((key) => typeof entry[key] === 'string') || !Number.isSafeInteger(entry.qrVersion)) {
    throw new Error('桌码私密清单条目无效')
  }
  return entry as unknown as PrivateTableQrEntry
}

function tableToken(value: string): string {
  const url = new URL(value)
  return new URLSearchParams(url.hash.slice(1)).get('token') ?? ''
}

function safeTableCode(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(normalized)) throw new Error('桌号格式无效')
  return normalized
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少${name}`)
  return value
}

async function main(): Promise<void> {
  if (process.env.MBOX_CONFIRM_WECHAT_MINI_CODE_RENDER !== 'RENDER') {
    throw new Error('渲染微信官方桌码必须设置MBOX_CONFIRM_WECHAT_MINI_CODE_RENDER=RENDER')
  }
  const environment = requiredEnvironment('MBOX_WECHAT_MINI_CODE_ENVIRONMENT')
  if (!['release', 'trial', 'develop'].includes(environment)) throw new Error('小程序码环境无效')
  if (process.env.NODE_ENV === 'production' && environment !== 'release') {
    throw new Error('生产桌码只能指向微信正式版小程序')
  }
  const result = await renderWechatTableMiniCodes({
    privateManifestPath: requiredEnvironment('MBOX_QR_PRIVATE_MANIFEST'),
    outputDirectory: requiredEnvironment('MBOX_WECHAT_MINI_CODE_OUTPUT_DIR'),
    page: process.env.MBOX_WECHAT_MINI_CODE_PAGE?.trim() || 'pages/order/index',
    environment: environment as 'release' | 'trial' | 'develop',
    provider: new OfficialWechatMiniProgramCodeProvider({
      appId: requiredEnvironment('MBOX_WECHAT_APP_ID'),
      appSecret: requiredEnvironment('MBOX_WECHAT_APP_SECRET'),
    }),
  })
  process.stdout.write(`rendered ${result.count} official WeChat table mini-program codes\n`)
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  void main().catch((error: unknown) => {
    const code = error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    process.stderr.write(`official WeChat table mini-program code rendering failed: ${code}\n`)
    process.exitCode = 1
  })
}
