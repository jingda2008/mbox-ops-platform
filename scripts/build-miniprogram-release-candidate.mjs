import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function buildMiniProgramReleaseCandidate(input) {
  const sourceRoot = resolve(input.sourceRoot)
  const outputRoot = resolve(input.outputRoot)
  await assertNewDirectory(outputRoot)
  const runtime = releaseRuntime(input.runtime)
  const sourceCommitSha = commitSha(input.sourceCommitSha)
  const createdAt = isoTime(input.createdAt ?? new Date().toISOString(), 'candidate createdAt')
  const packageRoot = resolve(outputRoot, 'miniprogram')
  await mkdir(outputRoot, { recursive: false, mode: 0o700 })
  const uploadExtensions = new Set(['.js', '.json', '.wxml', '.wxss', '.png', '.jpg', '.jpeg', '.svg', '.webp'])
  await cp(sourceRoot, packageRoot, {
    recursive: true, errorOnExist: true, force: false,
    filter: (source) => source === sourceRoot || extname(source) === '' || uploadExtensions.has(extname(source).toLowerCase()),
  })

  const sourceProject = object(JSON.parse(await readFile(resolve(sourceRoot, 'project.config.json'), 'utf8')), 'project config')
  const project = {
    ...sourceProject,
    appid: runtime.wechatAppId,
    setting: { ...objectOrEmpty(sourceProject.setting), urlCheck: true },
  }
  await writeFile(resolve(packageRoot, 'project.config.json'), `${JSON.stringify(project, null, 2)}\n`, { mode: 0o600 })
  const generatedConfig = `// Generated release artifact; contains no secret.\nmodule.exports = Object.freeze(${JSON.stringify(runtime, null, 2)})\n`
  await writeFile(resolve(packageRoot, 'config/release-config.generated.js'), generatedConfig, { mode: 0o600 })

  const files = await packageFiles(packageRoot)
  const manifest = {
    format: 'mbox.wechat-miniprogram-candidate.v1',
    createdAt,
    sourceCommitSha,
    appId: runtime.wechatAppId,
    apiBaseUrl: runtime.apiBaseUrl,
    storeId: runtime.storeId,
    identityTenantId: runtime.identityTenantId,
    identityStoreId: runtime.identityStoreId,
    runtime,
    packageRoot: 'miniprogram',
    projectConfigPath: 'miniprogram/project.config.json',
    runtimeConfigPath: 'miniprogram/config/release-config.generated.js',
    files,
  }
  const manifestPath = resolve(outputRoot, 'candidate-manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return { manifestPath, packageRoot, manifest }
}

function releaseRuntime(value) {
  const input = object(value, 'runtime config')
  const appId = formalAppId(input.wechatAppId)
  const apiBaseUrl = httpsOrigin(input.apiBaseUrl)
  const storeId = text(input.storeId)
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(storeId)) throw new Error('storeId无效')
  const identityTenantId = uuid(input.identityTenantId, 'identityTenantId')
  const identityStoreId = uuid(input.identityStoreId, 'identityStoreId')
  if (input.mode !== 'production' || input.wechatIdentityEnabled !== true || input.allowDevDataFallback !== false) {
    throw new Error('正式小程序必须启用微信身份并关闭开发数据兜底')
  }
  if (input.defaultTableCode || input.defaultTableToken || input.developmentActorId || input.developmentMemberId) {
    throw new Error('正式小程序包不得包含默认桌码或开发身份')
  }
  const requestTimeoutMs = Number(input.requestTimeoutMs ?? 10_000)
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 30_000) {
    throw new Error('requestTimeoutMs无效')
  }
  return Object.freeze({
    mode: 'production', apiBaseUrl, storeId,
    defaultTableCode: '', defaultTableToken: '', developmentActorId: '', developmentMemberId: '',
    allowDevDataFallback: false, requestTimeoutMs, wechatIdentityEnabled: true,
    membershipInviteCooldownHours: Number(input.membershipInviteCooldownHours ?? 720),
    identityTenantId, identityStoreId, wechatAppId: appId,
  })
}

async function packageFiles(root) {
  const paths = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('小程序候选包禁止符号链接')
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const name = entry.name.toLowerCase()
        if (name === 'project.private.config.json' || /\.(?:key|pem|p12|pfx|env)$/.test(name)) {
          throw new Error(`小程序候选包包含禁止文件：${entry.name}`)
        }
        const content = await readFile(path)
        if (/(?:app[_-]?secret|mbox_wechat_app_secret)["']?\s*[:=]|begin [a-z ]*private key/i.test(content.toString('utf8'))) {
          throw new Error(`小程序候选包包含疑似密钥：${entry.name}`)
        }
        paths.push(path)
      }
    }
  }
  await walk(root)
  return Promise.all(paths.toSorted().map(async (path) => ({
    path: relative(root, path).split(sep).join('/'),
    sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
  })))
}

async function assertNewDirectory(path) {
  try {
    await stat(path)
    throw new Error('候选输出目录已存在，禁止覆盖')
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
}

function httpsOrigin(value) {
  const raw = text(value)
  let url
  try { url = new URL(raw) } catch { throw new Error('apiBaseUrl无效') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/'
    || url.search || url.hash || isIP(url.hostname) || !url.hostname.includes('.')) {
    throw new Error('apiBaseUrl必须是无端口、无路径的HTTPS域名源地址')
  }
  return url.origin
}

function formalAppId(value) {
  const result = text(value)
  if (!/^wx[0-9a-f]{16}$/.test(result)) throw new Error('正式微信小程序AppID格式无效')
  return result
}
function uuid(value, label) {
  const result = text(value)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new Error(`${label}无效`)
  return result
}
function commitSha(value) {
  const result = text(value)
  if (!/^[0-9a-f]{40}$/i.test(result)) throw new Error('候选提交SHA无效')
  return result.toLowerCase()
}
function isoTime(value, label) {
  const result = text(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(`${label}无效`)
  return new Date(result).toISOString()
}
function text(value) { return typeof value === 'string' ? value.trim() : '' }
function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}无效`)
  return value
}
function objectOrEmpty(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {} }

async function main() {
  const runtimePath = process.env.MBOX_MINIPROGRAM_RUNTIME_CONFIG?.trim()
  const outputRoot = process.env.MBOX_MINIPROGRAM_CANDIDATE_OUTPUT?.trim()
  if (!runtimePath || !outputRoot) throw new Error('缺少MBOX_MINIPROGRAM_RUNTIME_CONFIG或MBOX_MINIPROGRAM_CANDIDATE_OUTPUT')
  const runtimeSource = JSON.parse(await readFile(resolve(runtimePath), 'utf8'))
  const result = await buildMiniProgramReleaseCandidate({
    sourceRoot: process.env.MBOX_MINIPROGRAM_SOURCE_ROOT?.trim() || 'miniprogram',
    outputRoot,
    sourceCommitSha: process.env.APP_COMMIT_SHA,
    runtime: runtimeSource.mbox ?? runtimeSource,
  })
  process.stdout.write(`mini-program candidate built: ${basename(result.manifestPath)}\n`)
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) await main()
