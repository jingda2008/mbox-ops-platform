const runtime = require('./platform')
const { getMiniBootstrap } = require('./api')

const LOGIN_REDIRECT_KEY = 'mbox.membership.login.redirect.v1'

async function hasActiveMembership() {
  try {
    const bootstrap = await getMiniBootstrap()
    return Boolean(bootstrap && bootstrap.membership)
  } catch (_error) {
    return false
  }
}

function redirectToMembershipLogin() {
  runtime.setStorageSync(LOGIN_REDIRECT_KEY, String(Date.now()))
  runtime.switchTab({ url: '/pages/profile/index' })
}

function consumeMembershipLoginRedirect() {
  const stored = runtime.getStorageSync(LOGIN_REDIRECT_KEY)
  if (!stored) return false
  runtime.removeStorageSync(LOGIN_REDIRECT_KEY)
  return true
}

function promptMembershipLogin(content) {
  return new Promise((resolve) => runtime.showModal({
    title: '请先登录会员',
    content: content || '登录会员后才能使用此功能',
    confirmText: '去登录',
    cancelText: '取消',
    success: (result) => {
      if (result.confirm) redirectToMembershipLogin()
      resolve(Boolean(result.confirm))
    },
    fail: () => resolve(false),
  }))
}

async function requireMembershipLogin(message) {
  if (await hasActiveMembership()) return true
  await promptMembershipLogin(message)
  return false
}

export {
  hasActiveMembership,
  redirectToMembershipLogin,
  consumeMembershipLoginRedirect,
  promptMembershipLogin,
  requireMembershipLogin,
}
