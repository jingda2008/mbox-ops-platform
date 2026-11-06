const { commandIdentityScope } = require('./recoverable-command')
const { tableRequestScope } = require('./table-request-scope')
const { getTableSession } = require('./session')

function identityOwner() {
  // Session-token renewal must not cancel an intent owned by the same member.
  return commandIdentityScope()
}

function beginMemberAction(page, lane, options) {
  if (page._pageHidden) return null
  const lanes = page._memberActions || (page._memberActions = new Map())
  if (lanes.has(lane)) return null
  let identity = identityOwner()
  let authenticating = Boolean(options && options.authentication)
  const table = tableRequestScope(getTableSession())
  const action = {
    owned: () => lanes.get(lane) === action,
    bindIdentity: () => { identity = identityOwner(); authenticating = false },
    sameIdentity: () => identityOwner() === identity,
    current: () => action.owned() && !page._pageHidden
      && (authenticating || action.sameIdentity())
      && (!(options && options.table) || tableRequestScope(getTableSession()) === table),
    finish: () => { if (action.owned()) lanes.delete(lane) },
  }
  lanes.set(lane, action)
  return action
}

function invalidateMemberActions(page) {
  if (page._memberActions) page._memberActions.clear()
}

module.exports = { beginMemberAction, invalidateMemberActions }
