import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  storeConfigurationDigest,
  verifyStoreConfigurationVersion,
} from './store-configuration-version-ledger.mjs'

test('accepts the tracked configuration only at its immutable version checksum', async () => {
  const configBuffer = await readFile('deploy/normalized-store/mbox-lujiazui.store.json')
  const ledger = JSON.parse(await readFile(
    'deploy/normalized-store/store-configuration-versions.json',
    'utf8',
  ))
  assert.deepEqual(verifyStoreConfigurationVersion({ configBuffer, ledger }), [])
})

test('rejects changed content that reuses an existing configuration version', async () => {
  const configBuffer = await readFile('deploy/normalized-store/mbox-lujiazui.store.json')
  const ledger = JSON.parse(await readFile(
    'deploy/normalized-store/store-configuration-versions.json',
    'utf8',
  ))
  const changed = Buffer.from(configBuffer.toString('utf8').replace('M-BOX 陆家嘴', 'M-BOX 陆家嘴测试'))
  assert.match(
    verifyStoreConfigurationVersion({ configBuffer: changed, ledger }).join('\n'),
    /content changed without a new configuration version/,
  )
})

test('accepts changed content after allocating a new version and checksum', async () => {
  const source = JSON.parse(await readFile('deploy/normalized-store/mbox-lujiazui.store.json', 'utf8'))
  const ledger = JSON.parse(await readFile(
    'deploy/normalized-store/store-configuration-versions.json',
    'utf8',
  ))
  source.version = '2026.09.07-v21'
  source.store.name = 'M-BOX 陆家嘴测试'
  const changed = Buffer.from(`${JSON.stringify(source, null, 2)}\n`)
  ledger.versions.push({ version: source.version, sha256: storeConfigurationDigest(changed) })
  assert.deepEqual(verifyStoreConfigurationVersion({ configBuffer: changed, ledger }), [])
})
