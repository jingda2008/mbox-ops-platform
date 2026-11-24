const { beijingDate, beijingDateTime } = require('../../utils/format')
const { getMiniBootstrap, getMiniLoyaltyLedger } = require('../../utils/api')
const { customerErrorMessage } = require('../../utils/customer-error')

const POINT_TYPE_NAMES = {
  earn: '消费积分到账',
  redeem: '积分兑换',
  expire: '积分到期',
  reverse: '退款积分冲回',
  supplement: '补发积分',
  adjust: '人工调整',
  restore: '积分返还',
}
const GROWTH_TYPE_NAMES = {
  earn: '消费成长值到账',
  reverse: '退款成长值冲回',
  supplement: '补发成长值',
  adjust: '人工调整成长值',
}

function shortDate(value) { return beijingDateTime(value, '') }

function signed(value) {
  const amount = Number(value || 0)
  return `${amount > 0 ? '+' : ''}${amount}`
}

function shortReference(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  return text.length <= 18 ? text : `…${text.slice(-12)}`
}

function ledgerMeta(item) {
  const parts = []
  const reference = shortReference(item.sourceReference)
  if (reference) parts.push(`关联单号 ${reference}`)
  if (Number.isInteger(item.policyVersion)) parts.push(`规则V${item.policyVersion}`)
  if (item.expiresAt) parts.push(`有效至 ${beijingDate(item.expiresAt)}`)
  return parts.join(' · ')
}

Page({
  data: {
    loading: true,
    error: '',
    earningPolicy: null, membership: null,
    tab: 'points',
    points: [],
    growth: [],
    processing: [],
  },

  onShow() { this.load() },
  onHide() { this.clearMemberRead() },
  onUnload() { this.clearMemberRead() },
  clearMemberRead() {
    this.readGeneration = (this.readGeneration || 0) + 1
    this.setData({ earningPolicy: null, membership: null, points: [], growth: [], processing: [], loading: false, error: '' })
  },

  async load() {
    const generation = this.readGeneration = (this.readGeneration || 0) + 1
    this.setData({ loading: true, error: '', earningPolicy: null, membership: null, points: [], growth: [], processing: [] })
    try {
      const [bootstrap, ledger] = await Promise.all([getMiniBootstrap(), getMiniLoyaltyLedger()])
      if (generation !== this.readGeneration) return
      const membership = bootstrap.membership || null
      this.setData({
        loading: false,
        earningPolicy: ledger.earningPolicy || null,
        membership: membership && {
          pointsBalance: membership.pointsBalance,
          growthValue: membership.growthValue,
          expiryText: membership.pointsExpiry && membership.pointsExpiry.expiringWithin30Days > 0
            ? `近30天有 ${membership.pointsExpiry.expiringWithin30Days} 积分将到期，最近到期日 ${beijingDate(membership.pointsExpiry.nextExpiryAt)}`
            : '近30天没有积分到期',
          debtText: Number(membership.pendingRecoveryPoints || 0) > 0
            ? `当前有 ${membership.pendingRecoveryPoints} 积分欠额；新到账积分会优先冲抵，期间暂不可兑换。`
            : '',
        },
        points: (ledger.points || []).map((item) => ({
          id: item.id,
          title: POINT_TYPE_NAMES[item.entryType] || '积分变动',
          description: item.description || '以门店记录为准',
          metaText: ledgerMeta(item),
          amountText: signed(item.pointsDelta),
          balanceText: `余额 ${item.balanceAfter}`,
          occurredAt: shortDate(item.occurredAt),
          positive: Number(item.pointsDelta || 0) > 0,
        })),
        growth: (ledger.growth || []).map((item) => ({
          id: item.id,
          title: GROWTH_TYPE_NAMES[item.entryType] || '成长值变动',
          description: item.description || '以门店记录为准',
          metaText: ledgerMeta(item),
          amountText: signed(item.growthDelta),
          balanceText: `成长值 ${item.balanceAfter}`,
          occurredAt: shortDate(item.occurredAt),
          positive: Number(item.growthDelta || 0) > 0,
        })),
        processing: (ledger.processing || []).slice(0, 5).map((item) => ({
          key: item.key,
          title: item.title || '积分确认进展',
          message: item.message || '门店正在确认本次记录。',
          referenceText: shortReference(item.sourceReference)
            ? `关联单号 ${shortReference(item.sourceReference)}`
            : '',
          updatedAt: shortDate(item.updatedAt),
          active: Boolean(item.active),
        })),
      })
    } catch (error) {
      if (generation !== this.readGeneration) return
      this.setData({ loading: false, error: customerErrorMessage(error, '积分明细暂时无法读取') })
    }
  },

  switchTab(event) {
    const tab = event.currentTarget.dataset.tab
    if (tab === 'points' || tab === 'growth') this.setData({ tab })
  },

  openMembership() { wx.switchTab({ url: '/pages/profile/index' }) },
})
