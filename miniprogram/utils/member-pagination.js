const { commandIdentityScope } = require('./recoverable-command')

function beginMemberPage(page, lane, cursor) {
  const pages = page._memberPages || (page._memberPages = new Map())
  let state = pages.get(lane)
  const owner = commandIdentityScope()
  if (!cursor) {
    state = { owner, visited: new Set() }
    pages.set(lane, state)
  } else if (!state || state.owner !== owner) {
    const error = new Error('登录身份已变化，请刷新后重新读取')
    error.memberPageOwnerChanged = true
    throw error
  }
  return (nextCursor) => {
    if (commandIdentityScope() !== owner) {
      const error = new Error('登录身份已变化，请刷新后重新读取')
      error.memberPageOwnerChanged = true
      throw error
    }
    if (nextCursor && (nextCursor === cursor || state.visited.has(nextCursor))) {
      throw new Error('分页位置重复，请刷新后重试；已读取记录保留')
    }
    // Only commit a successfully checked position. Failed requests can retry it.
    if (cursor) state.visited.add(cursor)
  }
}

module.exports = { beginMemberPage }
