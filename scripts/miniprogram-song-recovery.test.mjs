import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

test('song API replays the original command after a lost response/reload, isolates tables and permits a new confirmed request', async () => {
  const storage = new Map(), calls = []
  let table = 'table-one', sequence = 0, fail = true
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key,value) => storage.set(key,value), removeStorageSync: key => storage.delete(key) }
  const load = () => {
    const recovery = { exports: {} }, api = { exports: {} }
    vm.runInNewContext(readFileSync('miniprogram/utils/recoverable-command.js', 'utf8'), { module: recovery, wx, require: name => name === './id' ? { randomId: () => `song-command-${++sequence}` } : { getTableSession: () => ({ cartScope: table }) } })
    vm.runInNewContext(readFileSync('miniprogram/utils/api.js', 'utf8'), { module: api, wx, require: name => {
      if (name === './recoverable-command') return recovery.exports
      if (name === './request') return { request: async (path, options) => { calls.push({ path, options }); if (fail) throw Error('lost response after commit'); return { data: { id: 'song-request' } } } }
      return {}
    } })
    return api.exports
  }
  const input = { performanceScheduleId: 'show-one', songTitle: '测试歌曲', note: '私人备注' }
  await assert.rejects(load().submitSongRequest(input))
  const originalKey = calls[0].options.headers['idempotency-key']
  assert.doesNotMatch(JSON.stringify([...storage]), /测试歌曲|私人备注/)
  const api = load(); await assert.rejects(api.submitSongRequest(input))
  assert.equal(calls[1].options.headers['idempotency-key'], originalKey)
  fail = false; assert.equal((await api.submitSongRequest(input)).data.id, 'song-request')
  assert.equal(calls[2].options.headers['idempotency-key'], originalKey)
  await api.submitSongRequest(input); assert.notEqual(calls[3].options.headers['idempotency-key'], originalKey)
  fail = true; await assert.rejects(api.submitSongRequest(input)); const previous = calls.at(-1).options.headers['idempotency-key']
  table = 'table-two'; await assert.rejects(api.submitSongRequest(input)); assert.notEqual(calls.at(-1).options.headers['idempotency-key'], previous)
  assert.ok(calls.every(item => item.path === '/api/guest/song-requests'))
})
