import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { buildMiniProgramReleaseCandidate } from './build-miniprogram-release-candidate.mjs'
import { platformEvidencePayloadSha256, verifyMiniProgramRelease } from './verify-miniprogram-release.mjs'

const appId = 'wx1234567890abcdef'
const sourceCommitSha = 'a'.repeat(40)
const timestamp = new Date(Date.now() - 60_000).toISOString()

test('blocks source placeholders, fake AppIDs and absent candidate evidence', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mbox-mini-release-blocked-'))
  const evidence = resolve(root, 'evidence.json')
  await writeFile(evidence, JSON.stringify({
    format: 'mbox.wechat-miniprogram-release-evidence.v1',
    appId: 'wxMboxOfficial01', sourceCommitSha: '40-character-git-commit-sha',
    apiBaseUrl: 'https://139.224.254.60', requestDomains: ['https://139.224.254.60'],
    privacy: { operatorName: '待运营主体确认', contact: '待确认', reviewedAt: '待确认' },
    upload: { version: '待上传', uploadedAt: '待上传' },
    review: { approvalId: '待微信审核', approvedAt: '待微信审核' },
    productionRelease: { releaseId: '待正式发布', releasedAt: '待正式发布' },
  }))
  const report = await verifyMiniProgramRelease({ stage: 'release', evidencePath: evidence })
  assert.equal(report.status, 'blocked')
  assert.match(report.failures.join('\n'), /正式微信小程序AppID|候选包|有效运营主体|上传版本|审核编号|正式发布编号/)
})

test('keeps candidate, upload and release as separate trust claims', async () => {
  for (const stage of ['candidate', 'upload', 'release']) {
    const fixture = await readyFixture(stage)
    const report = await verifyMiniProgramRelease({
      stage, evidencePath: fixture.evidencePath, expectedCommitSha: sourceCommitSha,
      trustedKeyId: fixture.trustedKeyId,
      trustedPublicKey: fixture.trustedPublicKey,
    })
    assert.equal(report.status, 'ready', report.failures.join('\n'))
    assert.equal(report.stage, stage)
    assert.equal(report.sourceCommitSha, sourceCommitSha)
    assert.match(report.evidenceSha256, /^[0-9a-f]{64}$/)
    assert.equal(report.evidenceTrust, stage === 'candidate' ? 'local_integrity_only' : 'trusted_external_attestation')
  }
})

test('does not treat arbitrary local files plus SHA256 as platform authenticity evidence', async () => {
  const fixture = await readyFixture('candidate')
  const report = await verifyMiniProgramRelease({
    stage: 'release', evidencePath: fixture.evidencePath, expectedCommitSha: sourceCommitSha,
  })
  assert.equal(report.status, 'blocked')
  assert.equal(report.evidenceTrust, 'local_integrity_only')
  assert.match(report.failures.join('\n'), /独立签名的微信平台验收证明/)
})

test('rejects an upload attestation reused for release and a signature from another key', async () => {
  const uploadFixture = await readyFixture('upload')
  const reused = await verifyMiniProgramRelease({
    stage: 'release', evidencePath: uploadFixture.evidencePath,
    trustedKeyId: uploadFixture.trustedKeyId, trustedPublicKey: uploadFixture.trustedPublicKey,
  })
  assert.equal(reused.status, 'blocked')
  assert.match(reused.failures.join('\n'), /阶段与当前门禁不一致|未绑定当前证据内容/)

  const releaseFixture = await readyFixture('release')
  const unrelatedPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  const unrelated = Buffer.from(unrelatedPem).toString('base64')
  const wrongKey = await verifyMiniProgramRelease({
    stage: 'release', evidencePath: releaseFixture.evidencePath,
    trustedKeyId: releaseFixture.trustedKeyId, trustedPublicKey: unrelated,
  })
  assert.equal(wrongKey.status, 'blocked')
  assert.match(wrongKey.failures.join('\n'), /独立签名验证失败/)
})

test('rejects tampered candidate, unapproved domain and duplicate official table entry', async () => {
  const fixture = await readyFixture('release')
  const evidence = JSON.parse(await readFile(fixture.evidencePath, 'utf8'))
  evidence.apiBaseUrl = 'https://139.224.254.60'
  evidence.requestDomains = ['https://139.224.254.60']
  const audit = JSON.parse(await readFile(fixture.auditPath, 'utf8'))
  audit.entries.push(audit.entries[0])
  await writeFile(fixture.auditPath, JSON.stringify(audit), { mode: 0o600 })
  evidence.officialTableCodes.auditManifestSha256 = await fileDigest(fixture.auditPath)
  await writeFile(resolve(fixture.candidateRoot, 'miniprogram/app.json'), '{}')
  await writeFile(fixture.evidencePath, JSON.stringify(evidence))
  const report = await verifyMiniProgramRelease({
    stage: 'release', evidencePath: fixture.evidencePath,
    trustedKeyId: fixture.trustedKeyId, trustedPublicKey: fixture.trustedPublicKey,
  })
  assert.equal(report.status, 'blocked')
  assert.match(report.failures.join('\n'), /HTTPS域名/)
  assert.match(report.failures.join('\n'), /文件摘要不匹配/)
  assert.match(report.failures.join('\n'), /条目无效或重复/)
  assert.match(report.failures.join('\n'), /未绑定当前证据内容/)
})

async function readyFixture(stage) {
  const root = await mkdtemp(resolve(tmpdir(), 'mbox-mini-release-ready-'))
  const candidateRoot = resolve(root, 'candidate')
  const candidate = await buildMiniProgramReleaseCandidate({
    sourceRoot: resolve('miniprogram'), outputRoot: candidateRoot,
    sourceCommitSha, createdAt: timestamp,
    runtime: {
      mode: 'production', apiBaseUrl: 'https://api.shmbox.example', storeId: 'mbox-lujiazui',
      wechatIdentityEnabled: true, allowDevDataFallback: false,
      identityTenantId: '11111111-1111-4111-8111-111111111111',
      identityStoreId: '22222222-2222-4222-8222-222222222222',
      wechatAppId: appId,
    },
  })
  const proofPath = resolve(root, 'platform-proof.txt')
  await writeFile(proofPath, 'platform receipt evidence\n')
  const proof = { path: 'platform-proof.txt', sha256: await fileDigest(proofPath) }
  const codes = resolve(root, 'codes')
  await mkdir(codes, { mode: 0o700 })
  const imagePath = resolve(codes, 'L01.wechat-mini-code.png')
  await writeFile(imagePath, Buffer.alloc(128, 7), { mode: 0o600 })
  const auditPath = resolve(codes, 'wechat-mini-codes.audit.json')
  await writeFile(auditPath, JSON.stringify({
    format: 'mbox.official-wechat-table-mini-codes.v1', renderedAt: timestamp,
    sourceManifest: 'table-qrs.private.json', page: 'pages/order/index', environment: 'release',
    entries: [{
      tableId: '33333333-3333-4333-8333-333333333333', tableCode: 'L01',
      tableDisplayName: '互动01', qrVersion: 2, tokenSha256: 'b'.repeat(64),
      filename: 'L01.wechat-mini-code.png', imageSha256: await fileDigest(imagePath),
    }],
  }), { mode: 0o600 })
  await chmod(auditPath, 0o600)
  const evidencePath = resolve(root, 'evidence.json')
  const templates = [
    'loyalty_points_credited', 'loyalty_points_reversed',
    'loyalty_points_expiring', 'reservation_performance_revised',
  ].map((notificationType, index) => ({
    notificationType, templateId: `wechat_template_${index + 1}`, approvedAt: timestamp, evidenceRef: proof,
  }))
  const evidence = {
    format: 'mbox.wechat-miniprogram-release-evidence.v1',
    candidate: {
      manifestPath: 'candidate/candidate-manifest.json',
      manifestSha256: await fileDigest(candidate.manifestPath),
    },
    appId, appIdEvidenceRef: proof, sourceCommitSha,
    apiBaseUrl: 'https://api.shmbox.example', requestDomains: ['https://api.shmbox.example'],
    requestDomainsEvidenceRef: proof,
    privacy: {
      operatorName: '上海某某文化公司', contact: 'privacy@shmbox.cn',
      dataRetentionPolicyVersion: 'retention-v1', thirdPartyRegisterVersion: 'vendors-v1',
      policyVersion: 'privacy-v1', contentSha256: 'c'.repeat(64), approvedBy: '法务复核人',
      approvedAt: timestamp, effectiveAt: timestamp,
      reviewedAt: timestamp, evidenceRef: proof,
    },
    deviceValidation: {
      wechatDeveloperToolEvidenceRef: proof, iosEvidenceRef: proof, androidEvidenceRef: proof,
    },
    subscriptionTemplates: templates,
    officialTableCodes: {
      auditManifestPath: 'codes/wechat-mini-codes.audit.json',
      auditManifestSha256: await fileDigest(auditPath),
    },
    upload: { version: '1.0.0', receiptId: 'UPLOAD-20260816-001', uploadedAt: timestamp, evidenceRef: proof },
    review: { approvalId: 'wechat-review-001', approvedAt: timestamp, evidenceRef: proof },
    productionRelease: { releaseId: 'wechat-release-001', releasedAt: timestamp, evidenceRef: proof },
  }
  const keys = generateKeyPairSync('ed25519')
  const trustedKeyId = 'wechat-platform-approval-2026-01'
  if (stage !== 'candidate') {
    const attestationPath = resolve(root, 'platform-attestation.json')
    const signaturePath = resolve(root, 'platform-attestation.sig')
    const issuedAt = new Date(Date.now() - 30_000).toISOString()
    const attestation = {
      format: 'mbox.wechat-miniprogram-platform-attestation.v1',
      stage,
      keyId: trustedKeyId,
      issuer: '微信发布复核岗',
      approvalTicket: 'CAB-20260816-001',
      issuedAt,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      evidencePayloadSha256: platformEvidencePayloadSha256(evidence, stage),
      candidateManifestSha256: evidence.candidate.manifestSha256,
      sourceCommitSha,
      appId,
      apiBaseUrl: evidence.apiBaseUrl,
    }
    const bytes = Buffer.from(JSON.stringify(attestation))
    const signature = sign(null, bytes, keys.privateKey).toString('base64')
    await writeFile(attestationPath, bytes, { mode: 0o600 })
    await writeFile(signaturePath, `${signature}\n`, { mode: 0o600 })
    evidence.trust = {
      kind: 'signed-platform-attestation', keyId: trustedKeyId,
      attestationPath: 'platform-attestation.json', attestationSha256: sha256(bytes),
      signaturePath: 'platform-attestation.sig', signatureSha256: await fileDigest(signaturePath),
    }
  }
  await writeFile(evidencePath, JSON.stringify(evidence))
  return {
    root, candidateRoot, evidencePath, auditPath, trustedKeyId,
    trustedPublicKey: Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
  }
}

async function fileDigest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
