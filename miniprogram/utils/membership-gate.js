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
  wx.setStorageSync(LOGIN_REDIRECT_KEY, String(Date.now()))
  wx.switchTab({ url: '/pages/profile/index' })
}

function consumeMembershipLoginRedirect() {
  const stored = wx.getStorageSync(LOGIN_REDIRECT_KEY)
  if (!stored) return false
  wx.removeStorageSync(LOGIN_REDIRECT_KEY)
  return true
}

function promptMembershipLogin(content) {
  return new Promise((resolve) => wx.showModal({
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

module.exports = {
  hasActiveMembership,
  redirectToMembershipLogin,
  consumeMembershipLoginRedirect,
  promptMembershipLogin,
  requireMembershipLogin,
}
