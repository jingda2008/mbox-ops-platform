const { getActivities, registerActivity, enrollMembership } = require('../../utils/api')
const { money } = require('../../utils/format')

Page({
  data: { loading: true, busyId: '', error: '', activities: [] },
  onShow() { this.load() },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()) },
  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const activities = (await getActivities()).map((item) => Object.assign({}, item, {
        partySize: 1,
        dateText: new Date(item.startsAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
        feeText: item.feeAmountMinor > 0 ? `${money(item.feeAmountMinor)}${item.feeBasis === 'per_person' ? '/人' : '/次'}` : '免费报名',
        paymentText: paymentText(item),
        refundText: item.refundPolicy && item.refundPolicy.summary
          ? item.refundPolicy.summary
          : '退款与取消规则以本场活动页面公示为准',
        availabilityText: item.remainingCapacity > 0 ? `剩余 ${item.remainingCapacity} 位` : '已满',
        actionText: registrationAction(item.registrationStatus, item.remainingCapacity),
      }))
      this.setData({ loading: false, activities })
    } catch (error) { this.setData({ loading: false, error: error.message || '活动暂时没有接上' }) }
  },
  changePartySize(event) {
    const id = event.currentTarget.dataset.id
    const delta = Number(event.currentTarget.dataset.delta)
    const activities = this.data.activities.map((item) => item.publicId === id
      ? Object.assign({}, item, { partySize: Math.max(1, Math.min(item.remainingCapacity || 1, item.partySize + delta)) })
      : item)
    this.setData({ activities })
  },
  async join(event) {
    const id = event.currentTarget.dataset.id
    const activity = this.data.activities.find((item) => item.publicId === id)
    if (!activity) return
    if (this.data.busyId) return
    this.setData({ busyId: id, error: '' })
    try {
      const paymentChoice = await choosePayment(activity)
      if (paymentChoice === null) return
      await enrollMembership()
      const result = await registerActivity(
        id,
        activity.partySize,
        { channel: 'miniprogram' },
        { acknowledged: true, acknowledgedAt: new Date().toISOString() },
        paymentChoice,
      )
      if (result.paymentRequired) {
        await showNotice(
          '名额已暂留，等待付款',
          `应付${money(result.amountDueMinor)}，请在${activity.paymentDeadlineMinutes}分钟内完成。支付通道未开通时，本记录不会被标记为已付款。`,
        )
      } else {
        wx.showToast({ title: result.status === 'waitlisted' ? '已进入候补' : '报名成功', icon: 'success' })
      }
      await this.load()
    } catch (error) { this.setData({ error: error.message || '报名没有完成' }) }
    finally { this.setData({ busyId: '' }) }
  },
})

function registrationAction(status, remainingCapacity) {
  if (status === 'payment_pending') return '待付款'
  if (status === 'confirmed' || status === 'checked_in') return '已经报名'
  if (status === 'waitlisted') return '候补中'
  return remainingCapacity < 1 ? '人数已满' : '加入这次活动'
}

function paymentText(item) {
  if (item.paymentMode === 'none') return item.feeAmountMinor > 0 ? `无需预付，${item.paymentRuleText}` : '无需付款，提交即确认'
  if (item.paymentMode === 'deposit_optional') return `可付${money(item.depositAmountMinor)}订金锁定，也可不付订金`
  if (item.paymentMode === 'deposit_required') return `需付${money(item.depositAmountMinor)}订金，${item.paymentDeadlineMinutes}分钟内完成`
  return `需全额预付，${item.paymentDeadlineMinutes}分钟内完成`
}

async function choosePayment(item) {
  const multiplier = item.feeBasis === 'per_person' ? item.partySize : 1
  const deposit = money(item.depositAmountMinor * multiplier)
  const full = money(item.feeAmountMinor * multiplier)
  if (item.paymentMode === 'deposit_optional') {
    const result = await actionSheet([`付订金 ${deposit}，锁定名额`, '不付订金，直接预约'])
    if (result === null) return null
    return result === 0 ? 'deposit' : 'none'
  }
  if (item.paymentMode === 'deposit_required') {
    const confirmed = await confirm('确认报名', `本次需先付订金${deposit}，剩余费用到店支付。${item.paymentRuleText}`)
    return confirmed ? 'deposit' : null
  }
  if (item.paymentMode === 'full_required') {
    const confirmed = await confirm('确认报名', `本次需全额预付${full}。${item.paymentRuleText}`)
    return confirmed ? 'full' : null
  }
  const confirmed = await confirm('确认报名', `${item.partySize}位，${item.paymentRuleText}`)
  return confirmed ? 'none' : null
}

function actionSheet(itemList) {
  return new Promise((resolve) => wx.showActionSheet({
    itemList,
    success: (result) => resolve(result.tapIndex),
    fail: () => resolve(null),
  }))
}

function confirm(title, content) {
  return new Promise((resolve) => wx.showModal({ title, content, confirmText: '确认', success: (result) => resolve(result.confirm), fail: () => resolve(false) }))
}

function showNotice(title, content) {
  return new Promise((resolve) => wx.showModal({ title, content, showCancel: false, success: resolve, fail: resolve }))
}
