import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { verifyBrowserPrerequisites } from './verify-release-browser-prerequisites.mjs'

test('fails closed on missing dependency or browser launch failure', async () => {
  for (const load of [async () => { throw new Error('ERR_MODULE_NOT_FOUND') },
    async () => ({ chromium: { launch: async () => { throw new Error('executable missing') } } })]) {
    await assert.rejects(verifyBrowserPrerequisites(load), /生产变更尚未开始/)
  }
})

test('closes a launched browser even when rendering fails', async () => {
  let closed = false
  await assert.rejects(verifyBrowserPrerequisites(async () => ({ chromium: { launch: async () => ({
    newPage: async () => { throw new Error('render failure') }, close: async () => { closed = true },
  }) } })), /预检失败/)
  assert.equal(closed, true)
})

test('the formal entrypoint fails before any remote command when the dependency is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mbox-preflight-'))
  try {
    await cp(new URL('../deploy', import.meta.url), join(root, 'deploy'), { recursive: true })
    await cp(new URL('./verify-release-browser-prerequisites.mjs', import.meta.url), join(root, 'scripts/verify-release-browser-prerequisites.mjs'), { recursive: true })
    await assert.rejects(promisify(execFile)('bash', [join(root, 'deploy/aliyun/deploy-release.sh')], {
      env: { ...process.env, MBOX_RELEASE_TAG: 'v1.0.0-rc.210', MBOX_SSH_KEY_PATH: '/must-not-be-read-before-preflight' },
    }), error => error.code === 1 && /ERR_MODULE_NOT_FOUND/.test(error.stderr) && /生产变更尚未开始/.test(error.stderr))
    const source = await readFile(new URL('../deploy/aliyun/deploy-release.sh', import.meta.url), 'utf8')
    assert.ok(source.indexOf('node scripts/verify-release-browser-prerequisites.mjs') < source.indexOf('mkdir -p'))
    assert.ok(source.indexOf('node scripts/verify-release-browser-prerequisites.mjs') < source.indexOf('ssh "'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
