import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { buildMiniProgramReleaseCandidate } from './build-miniprogram-release-candidate.mjs'

const runtime = {
  mode: 'production', apiBaseUrl: 'https://api.shmbox.example', storeId: 'mbox-lujiazui',
  wechatIdentityEnabled: true, allowDevDataFallback: false,
  identityTenantId: '11111111-1111-4111-8111-111111111111',
  identityStoreId: '22222222-2222-4222-8222-222222222222',
  wechatAppId: 'wx1234567890abcdef', requestTimeoutMs: 10_000,
}

test('builds an isolated non-secret upload candidate with formal identity and URL checks enabled', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mbox-mini-candidate-'))
  const outputRoot = resolve(root, 'candidate')
  const result = await buildMiniProgramReleaseCandidate({
    sourceRoot: resolve('miniprogram'), outputRoot, runtime,
    sourceCommitSha: 'a'.repeat(40), createdAt: '2026-08-16T10:00:00.000Z',
  })
  const project = JSON.parse(await readFile(resolve(result.packageRoot, 'project.config.json'), 'utf8'))
  const generated = await readFile(resolve(result.packageRoot, 'config/release-config.generated.js'), 'utf8')
  assert.equal(project.appid, runtime.wechatAppId)
  assert.equal(project.setting.urlCheck, true)
  assert.match(generated, /https:\/\/api\.shmbox\.example/)
  assert.match(generated, /wechatIdentityEnabled": true/)
  assert.doesNotMatch(generated, /appSecret|tableToken.*[A-Za-z0-9_-]{32}/i)
  assert.ok(result.manifest.files.some((entry) => entry.path === 'app.json'))

  const releaseModule = { exports: {} }
  vm.runInNewContext(generated, { module: releaseModule, exports: releaseModule.exports })
  const configModule = { exports: {} }
  const configSource = await readFile(resolve(result.packageRoot, 'config/index.js'), 'utf8')
  vm.runInNewContext(configSource, {
    module: configModule, exports: configModule.exports,
    require: () => releaseModule.exports,
    wx: {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
      getExtConfigSync: () => ({ mbox: { apiBaseUrl: 'http://ext.invalid', storeId: 'wrong-ext' } }),
      getStorageSync: () => ({ apiBaseUrl: 'http://stored.invalid', storeId: 'wrong-stored' }),
    },
  })
  const resolved = configModule.exports.getRuntimeConfig()
  assert.equal(resolved.apiBaseUrl, runtime.apiBaseUrl)
  assert.equal(resolved.storeId, runtime.storeId)
  assert.equal(resolved.wechatAppId, runtime.wechatAppId)
  assert.equal(resolved.membershipInviteCooldownHours, 24)
})

test('rejects empty identity, IP origins, development fallback and output overwrite', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mbox-mini-candidate-invalid-'))
  await assert.rejects(buildMiniProgramReleaseCandidate({
    sourceRoot: resolve('miniprogram'), outputRoot: resolve(root, 'ip'),
    runtime: { ...runtime, apiBaseUrl: 'https://139.224.254.60' }, sourceCommitSha: 'b'.repeat(40),
  }), /HTTPS域名/)
  await assert.rejects(buildMiniProgramReleaseCandidate({
    sourceRoot: resolve('miniprogram'), outputRoot: resolve(root, 'empty'),
    runtime: { ...runtime, storeId: '' }, sourceCommitSha: 'b'.repeat(40),
  }), /storeId/)
  await assert.rejects(buildMiniProgramReleaseCandidate({
    sourceRoot: resolve('miniprogram'), outputRoot: resolve(root, 'empty-api'),
    runtime: { ...runtime, apiBaseUrl: '' }, sourceCommitSha: 'b'.repeat(40),
  }), /apiBaseUrl/)
  await assert.rejects(buildMiniProgramReleaseCandidate({
    sourceRoot: resolve('miniprogram'), outputRoot: resolve(root, 'empty-identity'),
    runtime: { ...runtime, identityTenantId: '' }, sourceCommitSha: 'b'.repeat(40),
  }), /identityTenantId/)
  await assert.rejects(buildMiniProgramReleaseCandidate({
    sourceRoot: resolve('miniprogram'), outputRoot: resolve(root, 'empty-appid'),
    runtime: { ...runtime, wechatAppId: '' }, sourceCommitSha: 'b'.repeat(40),
  }), /AppID/)
  await assert.rejects(buildMiniProgramReleaseCandidate({
    sourceRoot: resolve('miniprogram'), outputRoot: resolve(root, 'fallback'),
    runtime: { ...runtime, allowDevDataFallback: true }, sourceCommitSha: 'b'.repeat(40),
  }), /关闭开发数据兜底/)
  await assert.rejects(buildMiniProgramReleaseCandidate({
    sourceRoot: resolve('miniprogram'), outputRoot: root,
    runtime, sourceCommitSha: 'b'.repeat(40),
  }), /禁止覆盖/)
})

test('omits developer-private files from the upload package', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'mbox-mini-candidate-secret-'))
  const source = resolve(root, 'source')
  const outputRoot = resolve(root, 'output')
  await cp(resolve('miniprogram'), source, { recursive: true })
  await writeFile(resolve(source, 'project.private.config.json'), '{}')
  const result = await buildMiniProgramReleaseCandidate({
    sourceRoot: source, outputRoot, runtime, sourceCommitSha: 'b'.repeat(40),
  })
  assert.equal(result.manifest.files.some((entry) => entry.path === 'project.private.config.json'), false)
  await assert.rejects(readFile(resolve(result.packageRoot, 'project.private.config.json')), /ENOENT/)
})

test('rejects source project settings that would upload a different package', async (t) => {
  for (const [name, patch] of [
    ['outside root', { miniprogramRoot: '../unverified' }],
    ['plugin', { compileType: 'plugin' }],
    ['ignore runtime', { packOptions: { ignore: [{ type: 'file', value: 'config/release-config.generated.js' }], include: [] } }],
  ]) await t.test(name, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'mbox-mini-candidate-project-'))
    const sourceRoot = resolve(root, 'source'), outputRoot = resolve(root, 'candidate')
    await cp(resolve('miniprogram'), sourceRoot, { recursive: true })
    const path = resolve(sourceRoot, 'project.config.json')
    const project = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...project, ...patch }))
    await assert.rejects(buildMiniProgramReleaseCandidate({ sourceRoot, outputRoot, runtime,
      sourceCommitSha: 'a'.repeat(40) }), /工程根目录|编译类型|打包规则/)
    await assert.rejects(readFile(resolve(outputRoot, 'candidate-manifest.json')), /ENOENT/)
  })
})
