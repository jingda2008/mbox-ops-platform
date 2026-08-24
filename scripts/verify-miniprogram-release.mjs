import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { access, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_NOTIFICATION_TYPES = Object.freeze([
  'loyalty_points_credited',
  'loyalty_points_reversed',
  'loyalty_points_expiring',
  'reservation_performance_revised',
])

export async function verifyMiniProgramRelease(input) {
  const stage = releaseStage(input.stage)
  const evidencePath = resolve(input.evidencePath)
  const evidenceRoot = dirname(evidencePath)
  const evidenceBytes = await readFile(evidencePath)
  const evidence = object(JSON.parse(evidenceBytes.toString('utf8')), 'release evidence')
  const failures = []
  if (string(evidence.format) !== 'mbox.wechat-miniprogram-release-evidence.v1') failures.push('发布证据格式无效')

  const candidateRef = objectOrEmpty(evidence.candidate)
  const candidate = await readCandidate(
    evidenceRoot,
    candidateRef.manifestPath,
    candidateRef.manifestSha256,
    failures,
  )
  const appId = string(evidence.appId)
  if (!validAppId(appId)) failures.push('发布证据必须使用正式微信小程序AppID')
  if (candidate !== null && (candidate.manifest.appId !== appId || candidate.project.appid !== appId)) {
    failures.push('候选包、工程配置和发布证据AppID必须完全一致')
  }
  const sourceCommitSha = string(evidence.sourceCommitSha)
  if (!/^[0-9a-f]{40}$/.test(sourceCommitSha)) failures.push('发布证据必须绑定40位小写Git提交SHA')
  if (input.expectedCommitSha && sourceCommitSha !== input.expectedCommitSha.toLowerCase()) failures.push('发布证据提交与候选提交不一致')
  if (candidate !== null && candidate.manifest.sourceCommitSha !== sourceCommitSha) failures.push('候选包提交与发布证据提交不一致')

  const apiOrigin = httpsDomainOrigin(evidence.apiBaseUrl, '正式API', failures)
  if (candidate !== null && candidate.manifest.apiBaseUrl !== apiOrigin) failures.push('候选包API地址与发布证据不一致')
  let platformAttestation = null
  if (stage === 'upload' || stage === 'release') {
    await verifyEvidenceRef(evidenceRoot, evidence.appIdEvidenceRef, '正式AppID平台附件', failures)
    const domains = uniqueStringArray(evidence.requestDomains, 'request合法域名', failures)
    for (const domain of domains) httpsDomainOrigin(domain, 'request合法域名', failures)
    if (apiOrigin && !domains.includes(apiOrigin)) failures.push('微信request合法域名未包含正式API源地址')
    await verifyEvidenceRef(evidenceRoot, evidence.requestDomainsEvidenceRef, '微信合法域名平台附件', failures)

    const privacy = objectOrEmpty(evidence.privacy)
    for (const [field, label] of [
      ['operatorName', '运营主体名称'], ['contact', '隐私联系信息'],
      ['dataRetentionPolicyVersion', '数据保留策略版本'], ['thirdPartyRegisterVersion', '第三方清单版本'],
      ['policyVersion', '正式隐私政策版本'], ['approvedBy', '隐私政策批准人'],
    ]) if (!meaningful(privacy[field])) failures.push(`缺少有效${label}`)
    digest(privacy.contentSha256, '正式隐私政策内容摘要', failures)
    validPastIsoTime(privacy.approvedAt, '隐私政策批准时间', failures)
    validPastIsoTime(privacy.effectiveAt, '隐私政策生效时间', failures)
    validPastIsoTime(privacy.reviewedAt, '隐私复核时间', failures)
    await verifyEvidenceRef(evidenceRoot, privacy.evidenceRef, '隐私复核附件', failures)

    const devices = objectOrEmpty(evidence.deviceValidation)
    await verifyEvidenceRef(evidenceRoot, devices.wechatDeveloperToolEvidenceRef, '微信开发者工具验收附件', failures)
    await verifyEvidenceRef(evidenceRoot, devices.iosEvidenceRef, 'iOS真机验收附件', failures)
    await verifyEvidenceRef(evidenceRoot, devices.androidEvidenceRef, 'Android真机验收附件', failures)
    await verifyNotificationTemplates(evidenceRoot, evidence.subscriptionTemplates, failures)

    const upload = objectOrEmpty(evidence.upload)
    if (!meaningful(upload.version)) failures.push('缺少有效微信平台上传版本')
    if (!meaningful(upload.receiptId)) failures.push('缺少有效微信平台上传回执编号')
    validPastIsoTime(upload.uploadedAt, '微信平台上传时间', failures)
    await verifyEvidenceRef(evidenceRoot, upload.evidenceRef, '微信平台上传回执', failures)
  }
  if (stage === 'release') {
    const codes = objectOrEmpty(evidence.officialTableCodes)
    await verifyOfficialCodes(evidenceRoot, codes.auditManifestPath, codes.auditManifestSha256, failures)
    const review = objectOrEmpty(evidence.review)
    if (!meaningful(review.approvalId)) failures.push('缺少有效微信审核编号')
    validPastIsoTime(review.approvedAt, '微信审核通过时间', failures)
    await verifyEvidenceRef(evidenceRoot, review.evidenceRef, '微信审核回执', failures)
    const production = objectOrEmpty(evidence.productionRelease)
    if (!meaningful(production.releaseId)) failures.push('缺少有效微信正式发布编号')
    validPastIsoTime(production.releasedAt, '微信正式发布时间', failures)
    await verifyEvidenceRef(evidenceRoot, production.evidenceRef, '微信正式发布回执', failures)
  }
  const evidencePayloadSha256 = platformEvidencePayloadSha256(evidence, stage)
  if (stage === 'upload' || stage === 'release') {
    platformAttestation = await verifyPlatformAttestation({
      root: evidenceRoot,
      value: evidence.trust,
      stage,
      evidencePayloadSha256,
      sourceCommitSha,
      candidateManifestSha256: string(candidateRef.manifestSha256),
      appId,
      apiBaseUrl: apiOrigin,
      trustedKeyId: input.trustedKeyId,
      trustedPublicKey: input.trustedPublicKey,
      failures,
    })
  }
  return {
    format: 'mbox.wechat-miniprogram-release-verification.v1',
    status: failures.length === 0 ? 'ready' : 'blocked',
    stage,
    checkedAt: new Date().toISOString(),
    sourceCommitSha,
    appId,
    apiBaseUrl: apiOrigin,
    evidenceSha256: sha256(evidenceBytes),
    evidencePayloadSha256,
    candidateManifestSha256: string(candidateRef.manifestSha256),
    evidenceTrust: platformAttestation === null ? 'local_integrity_only' : 'trusted_external_attestation',
    attestationKeyId: platformAttestation?.keyId ?? '',
    attestationSha256: platformAttestation?.sha256 ?? '',
    attestationPayloadBase64: platformAttestation?.payloadBase64 ?? '',
    attestationSignature: platformAttestation?.signature ?? '',
    failures,
  }
}

export function platformEvidencePayloadSha256(evidence, stageValue) {
  const stage = releaseStage(stageValue)
  const payload = {
    format: string(evidence.format),
    stage,
    candidate: objectOrEmpty(evidence.candidate),
    appId: string(evidence.appId),
    sourceCommitSha: string(evidence.sourceCommitSha),
    apiBaseUrl: string(evidence.apiBaseUrl),
    requestDomains: stage === 'candidate' ? [] : evidence.requestDomains,
    appIdEvidenceRef: stage === 'candidate' ? null : evidence.appIdEvidenceRef,
    requestDomainsEvidenceRef: stage === 'candidate' ? null : evidence.requestDomainsEvidenceRef,
    privacy: stage === 'candidate' ? null : evidence.privacy,
    deviceValidation: stage === 'candidate' ? null : evidence.deviceValidation,
    subscriptionTemplates: stage === 'candidate' ? null : evidence.subscriptionTemplates,
    officialTableCodes: stage === 'release' ? evidence.officialTableCodes : null,
    upload: stage === 'candidate' ? null : evidence.upload,
    review: stage === 'release' ? evidence.review : null,
    productionRelease: stage === 'release' ? evidence.productionRelease : null,
  }
  return sha256(Buffer.from(canonicalJson(payload)))
}

async function verifyPlatformAttestation(input) {
  const trust = objectOrEmpty(input.value)
  if (trust.kind !== 'signed-platform-attestation') {
    input.failures.push(`${input.stage}阶段必须使用独立签名的微信平台验收证明`)
    return null
  }
  const trustedKeyId = string(input.trustedKeyId)
  const keyId = string(trust.keyId)
  if (!meaningful(trustedKeyId) || keyId !== trustedKeyId) input.failures.push('平台验收签名密钥身份不可信')
  const attestationPath = safeReferencePath(input.root, trust.attestationPath, '平台验收签名陈述', input.failures)
  const signaturePath = safeReferencePath(input.root, trust.signaturePath, '平台验收独立签名', input.failures)
  const expectedAttestationSha = digest(trust.attestationSha256, '平台验收签名陈述SHA256', input.failures)
  const expectedSignatureSha = digest(trust.signatureSha256, '平台验收独立签名SHA256', input.failures)
  if (!attestationPath || !signaturePath || !expectedAttestationSha || !expectedSignatureSha) return null
  try {
    const attestationBytes = await readFile(attestationPath)
    const signatureBytes = await readFile(signaturePath)
    if (sha256(attestationBytes) !== expectedAttestationSha) input.failures.push('平台验收签名陈述SHA256不匹配')
    if (sha256(signatureBytes) !== expectedSignatureSha) input.failures.push('平台验收独立签名SHA256不匹配')
    const attestation = object(JSON.parse(attestationBytes.toString('utf8')), 'platform attestation')
    if (attestation.format !== 'mbox.wechat-miniprogram-platform-attestation.v1') input.failures.push('平台验收签名陈述格式无效')
    if (attestation.stage !== input.stage) input.failures.push('平台验收签名阶段与当前门禁不一致')
    if (string(attestation.keyId) !== keyId) input.failures.push('平台验收签名陈述密钥身份不一致')
    if (string(attestation.evidencePayloadSha256) !== input.evidencePayloadSha256) input.failures.push('平台验收签名未绑定当前证据内容')
    if (string(attestation.candidateManifestSha256) !== input.candidateManifestSha256) input.failures.push('平台验收签名未绑定当前候选包')
    if (string(attestation.sourceCommitSha) !== input.sourceCommitSha) input.failures.push('平台验收签名未绑定当前提交')
    if (string(attestation.appId) !== input.appId || string(attestation.apiBaseUrl) !== input.apiBaseUrl) input.failures.push('平台验收签名未绑定当前AppID和API')
    if (!meaningful(attestation.issuer) || !meaningful(attestation.approvalTicket)) input.failures.push('平台验收签名缺少受控审批人或审批单号')
    validAttestationWindow(attestation.issuedAt, attestation.expiresAt, input.failures)
    const publicKeyPem = decodePublicKey(input.trustedPublicKey, input.failures)
    const signature = decodeSignature(signatureBytes, input.failures)
    if (publicKeyPem && signature) {
      const publicKey = createPublicKey(publicKeyPem)
      if (publicKey.asymmetricKeyType !== 'ed25519') input.failures.push('平台验收必须使用Ed25519独立签名密钥')
      else if (!verifySignature(null, attestationBytes, publicKey, signature)) input.failures.push('平台验收独立签名验证失败')
    }
    return {
      keyId,
      sha256: expectedAttestationSha,
      payloadBase64: attestationBytes.toString('base64'),
      signature: signatureBytes.toString('utf8').trim(),
    }
  } catch {
    input.failures.push('平台验收签名陈述或独立签名无法读取')
    return null
  }
}

function validAttestationWindow(issuedAtValue, expiresAtValue, failures) {
  const issuedAt = Date.parse(string(issuedAtValue))
  const expiresAt = Date.parse(string(expiresAtValue))
  validPastIsoTime(issuedAtValue, '平台验收签名签发时间', failures)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt <= issuedAt
    || expiresAt - issuedAt > 72 * 60 * 60 * 1000) failures.push('平台验收签名有效期无效或超过72小时')
}

function decodePublicKey(value, failures) {
  const encoded = string(value)
  if (!encoded) { failures.push('缺少受保护的平台验收签名公钥'); return '' }
  try {
    const pem = Buffer.from(encoded, 'base64').toString('utf8')
    if (!pem.includes('BEGIN PUBLIC KEY')) throw new Error()
    return pem
  } catch { failures.push('平台验收签名公钥无效'); return '' }
}

function decodeSignature(value, failures) {
  try {
    const encoded = value.toString('utf8').trim()
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error()
    const signature = Buffer.from(encoded, 'base64')
    if (signature.length !== 64) throw new Error()
    return signature
  } catch { failures.push('平台验收独立签名编码无效'); return null }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

async function readCandidate(root, pathValue, digestValue, failures) {
  const path = safeReferencePath(root, pathValue, '候选包清单', failures)
  const expectedDigest = digest(digestValue, '候选包清单SHA256', failures)
  if (!path || !expectedDigest) return null
  try {
    const bytes = await readFile(path)
    if (sha256(bytes) !== expectedDigest) failures.push('候选包清单SHA256不匹配')
    const manifest = object(JSON.parse(bytes.toString('utf8')), 'candidate manifest')
    if (manifest.format !== 'mbox.wechat-miniprogram-candidate.v1') failures.push('候选包清单格式无效')
    if (!validAppId(manifest.appId)) failures.push('候选包AppID无效')
    if (!/^[0-9a-f]{40}$/.test(string(manifest.sourceCommitSha))) failures.push('候选包提交SHA无效')
    validPastIsoTime(manifest.createdAt, '候选包生成时间', failures)
    const runtime = strictRuntime(manifest.runtime, failures)
    if (runtime !== null && (
      runtime.wechatAppId !== manifest.appId || runtime.apiBaseUrl !== manifest.apiBaseUrl
      || runtime.storeId !== manifest.storeId || runtime.identityTenantId !== manifest.identityTenantId
      || runtime.identityStoreId !== manifest.identityStoreId
    )) failures.push('候选包运行配置投影不一致')
    const packageRoot = safeReferencePath(dirname(path), manifest.packageRoot, '候选包目录', failures)
    const projectPath = safeReferencePath(dirname(path), manifest.projectConfigPath, '候选工程配置', failures)
    const runtimePath = safeReferencePath(dirname(path), manifest.runtimeConfigPath, '候选运行配置', failures)
    if (!packageRoot || !projectPath || !runtimePath || runtime === null) return null
    const project = object(JSON.parse(await readFile(projectPath, 'utf8')), 'candidate project config')
    if (objectOrEmpty(project.setting).urlCheck !== true) failures.push('候选工程必须启用合法域名校验')
    const expectedRuntimeSource = `// Generated release artifact; contains no secret.\nmodule.exports = Object.freeze(${JSON.stringify(runtime, null, 2)})\n`
    if ((await readFile(runtimePath, 'utf8')) !== expectedRuntimeSource) failures.push('候选运行配置文件与清单不一致')
    await verifyPackageFiles(packageRoot, manifest.files, failures)
    return { manifest, project }
  } catch {
    failures.push('候选包清单或文件无法读取')
    return null
  }
}

function strictRuntime(value, failures) {
  const runtime = objectOrEmpty(value)
  const before = failures.length
  if (runtime.mode !== 'production' || runtime.wechatIdentityEnabled !== true || runtime.allowDevDataFallback !== false) failures.push('候选包必须启用正式微信身份并关闭开发兜底')
  const apiBaseUrl = httpsDomainOrigin(runtime.apiBaseUrl, '候选包API', failures)
  if (!validAppId(runtime.wechatAppId)) failures.push('候选包微信AppID无效')
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(string(runtime.storeId))) failures.push('候选包门店编号无效')
  for (const [field, label] of [['identityTenantId', '租户身份'], ['identityStoreId', '门店身份']]) {
    if (!validUuid(runtime[field])) failures.push(`候选包${label}无效`)
  }
  if (runtime.defaultTableCode || runtime.defaultTableToken || runtime.developmentActorId || runtime.developmentMemberId) failures.push('候选包包含开发身份或默认桌码')
  return failures.length === before ? { ...runtime, apiBaseUrl } : null
}

async function verifyPackageFiles(packageRoot, value, failures) {
  if (!Array.isArray(value) || value.length < 5) { failures.push('候选包文件清单无效'); return }
  const declared = new Map()
  for (const entryValue of value) {
    const entry = objectOrEmpty(entryValue)
    const path = safeRelativePath(entry.path)
    const expected = /^[0-9a-f]{64}$/.test(string(entry.sha256)) ? string(entry.sha256) : ''
    if (!path || !expected || declared.has(path)) { failures.push('候选包文件条目无效或重复'); continue }
    declared.set(path, expected)
  }
  const actual = await listFiles(packageRoot)
  if (actual.length !== declared.size || actual.some((path) => !declared.has(path))) failures.push('候选包文件清单不完整')
  for (const path of actual) {
    const expected = declared.get(path)
    if (expected && sha256(await readFile(resolve(packageRoot, path))) !== expected) failures.push(`候选包文件摘要不匹配：${path}`)
  }
}

async function verifyNotificationTemplates(root, value, failures) {
  if (!Array.isArray(value)) { failures.push('缺少微信订阅消息模板审核清单'); return }
  const seen = new Set()
  for (const raw of value) {
    const entry = objectOrEmpty(raw)
    const type = string(entry.notificationType)
    if (!REQUIRED_NOTIFICATION_TYPES.includes(type) || seen.has(type)) { failures.push('订阅消息模板类型无效或重复'); continue }
    seen.add(type)
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(string(entry.templateId))) failures.push(`${type}模板ID无效`)
    validPastIsoTime(entry.approvedAt, `${type}模板审核时间`, failures)
    await verifyEvidenceRef(root, entry.evidenceRef, `${type}模板审核证据`, failures)
  }
  for (const type of REQUIRED_NOTIFICATION_TYPES) if (!seen.has(type)) failures.push(`缺少${type}审核模板`)
}

async function verifyOfficialCodes(root, pathValue, digestValue, failures) {
  const path = safeReferencePath(root, pathValue, '微信官方桌码审计清单', failures)
  const expectedDigest = digest(digestValue, '微信官方桌码审计清单SHA256', failures)
  if (!path || !expectedDigest) return
  try {
    await access(path)
    const mode = (await stat(path)).mode & 0o777
    if ((mode & 0o077) !== 0) failures.push('微信官方桌码审计清单权限过宽')
    const bytes = await readFile(path)
    if (sha256(bytes) !== expectedDigest) failures.push('微信官方桌码审计清单SHA256不匹配')
    const audit = object(JSON.parse(bytes.toString('utf8')), 'mini code audit')
    if (audit.format !== 'mbox.official-wechat-table-mini-codes.v1' || audit.environment !== 'release') failures.push('桌码不是微信正式版官方小程序码')
    if (audit.page !== 'pages/order/index') failures.push('正式桌码未直接进入扫码点单门控页')
    validPastIsoTime(audit.renderedAt, '微信官方桌码生成时间', failures)
    if (!Array.isArray(audit.entries) || audit.entries.length < 1 || audit.entries.length > 200) { failures.push('微信官方桌码清单数量无效'); return }
    const ids = new Set(); const codes = new Set(); const files = new Set()
    for (const raw of audit.entries) {
      const entry = objectOrEmpty(raw)
      const filename = safeRelativePath(entry.filename)
      if (!validUuid(entry.tableId) || !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(string(entry.tableCode))
        || !meaningful(entry.tableDisplayName) || !Number.isSafeInteger(entry.qrVersion) || entry.qrVersion < 1
        || !/^[0-9a-f]{64}$/.test(string(entry.tokenSha256)) || !/^[0-9a-f]{64}$/.test(string(entry.imageSha256))
        || !filename || filename.includes('/') || !filename.endsWith('.wechat-mini-code.png')
        || ids.has(entry.tableId) || codes.has(entry.tableCode) || files.has(filename)) {
        failures.push('微信官方桌码条目无效或重复')
        continue
      }
      ids.add(entry.tableId); codes.add(entry.tableCode); files.add(filename)
      try {
        const image = await readFile(resolve(dirname(path), filename))
        if (sha256(image) !== entry.imageSha256) failures.push(`${entry.tableCode}官方桌码图片摘要不匹配`)
      } catch { failures.push(`${entry.tableCode}官方桌码图片无法读取`) }
    }
  } catch { failures.push('微信官方桌码审计清单无法读取或无效') }
}

async function verifyEvidenceRef(root, value, label, failures) {
  const ref = objectOrEmpty(value)
  const path = safeReferencePath(root, ref.path, label, failures)
  const expected = digest(ref.sha256, `${label}SHA256`, failures)
  if (!path || !expected) return
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size < 1 || sha256(await readFile(path)) !== expected) failures.push(`${label}无效或摘要不匹配`)
  } catch { failures.push(`${label}无法读取`) }
}

function safeReferencePath(root, value, label, failures) {
  const path = safeRelativePath(value)
  if (!path) { failures.push(`缺少有效${label}路径`); return null }
  return resolve(root, path)
}
function safeRelativePath(value) {
  const path = string(value)
  if (!path || path.startsWith('/') || path.split(/[\\/]/).includes('..') || path.includes('\\')) return ''
  return path
}
async function listFiles(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('candidate package symlink is forbidden')
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
    }
  }
  await walk(root)
  return files.toSorted()
}
function releaseStage(value) {
  if (!['candidate', 'upload', 'release'].includes(value)) throw new Error('MBOX_MINIPROGRAM_RELEASE_STAGE无效')
  return value
}
function httpsDomainOrigin(value, label, failures) {
  try {
    const url = new URL(string(value))
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/'
      || url.search || url.hash || isIP(url.hostname) || !url.hostname.includes('.')) throw new Error()
    return url.origin
  } catch { failures.push(`${label}必须是无端口、无路径的HTTPS域名源地址`); return '' }
}
function uniqueStringArray(value, label, failures) {
  if (!Array.isArray(value)) { failures.push(`${label}清单无效`); return [] }
  const result = value.map(string).filter(Boolean)
  if (result.length < 1 || new Set(result).size !== result.length) failures.push(`${label}清单为空或重复`)
  return result
}
function validPastIsoTime(value, label, failures) {
  const raw = string(value); const time = Date.parse(raw)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw)
    || !Number.isFinite(time) || time > Date.now() + 300_000) failures.push(`${label}无效`)
}
function digest(value, label, failures) {
  const result = string(value)
  if (!/^[0-9a-f]{64}$/.test(result)) { failures.push(`${label}无效`); return '' }
  return result
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function validAppId(value) { return /^wx[0-9a-f]{16}$/.test(string(value)) }
function validUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(string(value)) }
function meaningful(value) {
  const result = string(value)
  return result.length >= 3 && !/(example|placeholder|pending|unknown|todo|tbd|n\/a|your-|待|未确认|未提供|占位|示例|测试)/i.test(result)
}
function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}无效`)
  return value
}
function objectOrEmpty(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {} }
function string(value) { return typeof value === 'string' ? value.trim() : '' }

async function main() {
  const evidencePath = process.env.MBOX_MINIPROGRAM_RELEASE_EVIDENCE?.trim()
  if (!evidencePath) throw new Error('缺少MBOX_MINIPROGRAM_RELEASE_EVIDENCE')
  const report = await verifyMiniProgramRelease({
    stage: process.env.MBOX_MINIPROGRAM_RELEASE_STAGE?.trim() || 'candidate',
    evidencePath,
    expectedCommitSha: process.env.APP_COMMIT_SHA?.trim(),
    trustedKeyId: process.env.MBOX_MINIPROGRAM_RELEASE_TRUSTED_KEY_ID?.trim(),
    trustedPublicKey: process.env.MBOX_MINIPROGRAM_RELEASE_TRUSTED_PUBLIC_KEY_BASE64?.trim(),
  })
  const reportPath = process.env.MBOX_MINIPROGRAM_RELEASE_REPORT?.trim()
  if (reportPath) await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.status !== 'ready') process.exitCode = 1
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) await main()
