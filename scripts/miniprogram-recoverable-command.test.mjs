import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('guest writes retain the same attempt after lost responses and reload, isolate table/member, and allow deliberate repeats', async () => {
  const source = await readFile(new URL('../miniprogram/utils/recoverable-command.js', import.meta.url), 'utf8')
  const storage = new Map()
  let sequence = 0
  let table = 'table-one'
  const load = () => {
    const context = { module: { exports: {} }, wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
    }, require: name => name === './id' ? { randomId: () => `attempt-${++sequence}` } : { getTableSession: () => ({ cartScope: table }) } }
    vm.runInNewContext(source, context)
    return context.module.exports.recoverableGuestCommand
  }
  const keys = []
  const lost = key => { keys.push(key); throw new Error('response lost after commit') }
  let send = load()
  await assert.rejects(send('service', { note: 'private customer request' }, lost))
  assert(!JSON.stringify([...storage]).includes('private customer request'))
  send = load()
  await assert.rejects(send('service', { note: 'private customer request' }, lost))
  assert.equal(keys[0], keys[1])
  await send('service', { note: 'private customer request' }, async key => { keys.push(key); return { id: 'original-task' } })
  await send('service', { note: 'private customer request' }, async key => { keys.push(key); return { id: 'new-task' } })
  assert.equal(keys[2], keys[0]); assert.notEqual(keys[3], keys[0])
  await assert.rejects(send('service', {}, lost))
  const firstTable = keys.at(-1)
  table = 'table-two'
  await assert.rejects(send('service', {}, lost))
  assert.notEqual(keys.at(-1), firstTable)
  const secondTable = keys.at(-1)
  storage.set('mbox.wechat.identity.principal.v1', { principalId: 'another-member' })
  await assert.rejects(send('service', {}, lost))
  assert.notEqual(keys.at(-1), secondTable)
  let resolve
  let calls = 0
  const pending = new Promise(done => { resolve = done })
  const first = send('benefit', { id: 'benefit-one' }, () => { calls++; return pending })
  const second = send('benefit', { id: 'benefit-one' }, () => { calls++; return pending })
  assert.equal(first, second)
  await Promise.resolve(); assert.equal(calls, 1)
  resolve({ id: 'one-reservation' }); await Promise.all([first, second])
})
