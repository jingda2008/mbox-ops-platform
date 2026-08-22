import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

import './miniprogram-request-credential-domain.test.mjs'

async function loadSessionModule() {
  const source = await readFile(new URL('../miniprogram/utils/session.js', import.meta.url), 'utf8')
  const storage = new Map()
  const app = { globalData: {} }
  const context = {
    module: { exports: {} },
    exports: {},
    getApp: () => app,
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
    },
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/session.js' })
  return { session: context.module.exports, storage }
}

const production = Object.freeze({
  isDevelopment: false, defaultTableCode: '', defaultTableToken: '',
})

test('reads the official mini-program code token from launchOptions.query.scene', async () => {
  const { session } = await loadSessionModule()
  const token = 'A'.repeat(32)
  const result = session.applyLaunchSession({ scene: 1047, query: { scene: token } }, production)
  assert.equal(result.tableToken, token)
  assert.equal(result.tableCode, '')
})

test('reads encoded scene parameters and accepts matching explicit aliases', async () => {
  const { session } = await loadSessionModule()
  const token = 'B'.repeat(32)
  const scene = encodeURIComponent(`token=${token}&table=L01`)
  const result = session.applyLaunchSession({ query: { scene, tableCode: 'L01', tableToken: token } }, production)
  assert.equal(result.tableToken, token)
  assert.equal(result.tableCode, 'L01')
})

test('rejects conflicting, malformed or unknown scene values instead of choosing one credential', async () => {
  const { session } = await loadSessionModule()
  const first = 'C'.repeat(32)
  const second = 'D'.repeat(32)
  assert.throws(() => session.applyLaunchSession({ query: { scene: first, token: second } }, production), /参数冲突/)
  assert.throws(() => session.applyLaunchSession({ query: { token: first, tableToken: second } }, production), /参数冲突/)
  assert.throws(() => session.applyLaunchSession({ query: { scene: 'redirect=https%3A%2F%2Fevil.invalid' } }, production), /scene无效/)
  assert.throws(() => session.applyLaunchSession({ query: { scene: '%E0%A4%A' } }, production), /scene无效/)
})

test('the in-mini-program scanner accepts official mini-program codes without allowing album replay', async () => {
  const source = await readFile(new URL('../miniprogram/pages/order/index.js', import.meta.url), 'utf8')
  assert.match(source, /onlyFromCamera:\s*true/)
  assert.match(source, /scanType:\s*\[\s*['"]qrCode['"]\s*,\s*['"]wxCode['"]\s*\]/)
  assert.match(source, /parseScanValue\(result\.path \|\| result\.result\)/)
})

test('published activity and home images resolve against the reviewed API host in the mini-program', async () => {
  const source = await readFile(new URL('../miniprogram/utils/media.js', import.meta.url), 'utf8')
  assert.match(source, /startsWith\('\/api\/public\/media-assets\/'\)/)
  assert.match(source, /getRuntimeConfig\(\)\.apiBaseUrl/)
  for (const page of ['home/index.js', 'community/index.js', 'community-detail/index.js', 'profile/index.js']) {
    const pageSource = await readFile(new URL(`../miniprogram/pages/${page}`, import.meta.url), 'utf8')
    assert.match(pageSource, /publicImageUrl/)
  }
})
