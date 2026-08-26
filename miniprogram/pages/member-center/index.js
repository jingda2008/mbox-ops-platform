const { getMiniBootstrap, claimAnnualDailySnack } = require('../../utils/api')
const { money, dateTime } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')
const { getRuntimeConfig } = require('../../config/index')

const LEVEL_NAMES = { member: '普卡会员', silver: '银卡会员', gold: '金卡会员' }
const LEVEL_ENGLISH = { member: 'M-BOX MEMBER', silver: 'SILVER MEMBER', gold: 'GOLD MEMBER' }
const CARD_LEVEL_NAMES = { member: '普卡', silver: '银卡', gold: '金卡' }
const MEMBER_CARD_PREVIEW_PROGRESS = {
  member: { rollingGrowth: 680, upgradeThreshold: 2000, upgradeRemaining: 1320, nextTier: 'silver' },
  silver: { rollingGrowth: 3680, upgradeThreshold: 5000, upgradeRemaining: 1320, nextTier: 'gold' },
  gold: { rollingGrowth: 5680, upgradeThreshold: null, upgradeRemaining: null, nextTier: null },
}
const BENEFIT_NAMES = {
  gift_product: '赠送好礼', discount: '折扣权益', credit: '金额权益', access: '专属资格', other: '会员权益',
}
const BENEFIT_STATUS_NAMES = { issued: '可使用', reserved: '已暂留', consumed: '已使用', fulfilled: '已使用', expired: '已失效', revoked: '已撤回' }
const ANNUAL_STATUS_NAMES = {
  pending: '待生效', available: '可使用', reserved: '已暂留', redeemed: '已核销',
  cancelled: '已取消', expired: '已过期', tier_invalid: '等级失效',
  confirming: '结果确认中', renewal_unlock: '续级后可解锁',
}
const CALENDAR_FILTERS = [
  { value: 'all', name: '全部状态' },
  { value: 'pending', name: '待生效' },
  { value: 'available', name: '可使用' },
  { value: 'reserved', name: '已暂留' },
  { value: 'redeemed', name: '已核销' },
  { value: 'cancelled', name: '已取消' },
  { value: 'expired', name: '已过期' },
  { value: 'tier_invalid', name: '等级失效' },
  { value: 'confirming', name: '结果确认中' },
  { value: 'renewal_unlock', name: '续级后可解锁' },
]

function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0 }

function memberCardPreviewLevel() {
  try {
    const options = wx.getEnterOptionsSync ? wx.getEnterOptionsSync() : wx.getLaunchOptionsSync()
    const level = options && options.query && options.query.memberCardPreview
    return getRuntimeConfig().isDevelopment && ['member', 'silver', 'gold'].includes(level) ? level : ''
  } catch (_error) {
    return ''
  }
}

function formatMemberNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''
}

function memberCardProgress(level, progress, previewLevel) {
  const source = previewLevel ? MEMBER_CARD_PREVIEW_PROGRESS[level] : progress
  const growth = source && Number.isFinite(Number(source.rollingGrowth)) ? Number(source.rollingGrowth) : null
  const threshold = source && Number.isFinite(Number(source.upgradeThreshold)) && Number(source.upgradeThreshold) > 0
    ? Number(source.upgradeThreshold) : null
  const nextTier = source && source.nextTier ? source.nextTier : null
  const upgradeRemaining = source && Number.isFinite(Number(source.upgradeRemaining))
    ? Math.max(0, Number(source.upgradeRemaining)) : null
  const hasProgress = growth !== null
  const progressPercent = !hasProgress ? 0 : threshold
    ? Math.max(0, Math.min(100, Math.round((growth / threshold) * 100))) : 100
  const nextTierName = nextTier ? (CARD_LEVEL_NAMES[nextTier] || '') : ''
  return {
    cardProgressAvailable: hasProgress,
    cardGrowthText: threshold
      ? `成长值 ${formatMemberNumber(growth)} / ${formatMemberNumber(threshold)}`
      : hasProgress ? `成长值 ${formatMemberNumber(growth)}` : '成长进度暂不可显示',
    cardDifferenceText: nextTier && upgradeRemaining !== null
      ? upgradeRemaining > 0
        ? `距${nextTierName}还差 ${formatMemberNumber(upgradeRemaining)}`
        : `${nextTierName}等级已达成`
      : level === 'gold' ? '金卡等级已达成' : '等级以已发布规则为准',
    cardProgressPercent: progressPercent,
    cardCurrentTierText: CARD_LEVEL_NAMES[level] || '普卡',
    cardNextTierText: nextTier ? (CARD_LEVEL_NAMES[nextTier] || '') : '',
    cardBenefitText: `查看${CARD_LEVEL_NAMES[nextTier || level] || '会员'}权益 ›`,
  }
}

function membershipView(item) {
  const previewLevel = memberCardPreviewLevel()
  const displayLevel = previewLevel || item.level
  const progress = item.tierProgress || null
  const qualificationGrowth = item.qualificationGrowth !== null && item.qualificationGrowth !== undefined
    && Number.isFinite(Number(item.qualificationGrowth))
    ? Number(item.qualificationGrowth) : progress ? number(progress.rollingGrowth) : null
  const nextLevel = progress && progress.nextTier ? LEVEL_NAMES[progress.nextTier] : ''
  const nextText = !progress || !nextLevel || progress.upgradeRemaining === null
    ? '当前等级权益以已发布规则为准'
    : progress.upgradeRemaining > 0
      ? `距离${nextLevel}还差 ${progress.upgradeRemaining} 成长值`
      : `已达到${nextLevel}成长值条件，等待系统按已发布规则确认`
  const periodAt = progress && (progress.periodStatus === 'grace' ? progress.graceEndsAt : progress.periodEndsAt)
  const threshold = progress && number(progress.upgradeThreshold)
  const progressPercent = threshold && qualificationGrowth !== null
    ? Math.max(0, Math.min(100, Math.round((qualificationGrowth / threshold) * 100))) : 0
  return Object.assign({
    memberNo: item.memberNo,
    memberCodeQrDataUrl: item.memberCodeQrDataUrl || '',
    level: displayLevel,
    levelText: LEVEL_NAMES[displayLevel] || 'M-BOX会员',
    levelEnglish: LEVEL_ENGLISH[displayLevel] || 'MEMBER',
    pointsBalance: number(item.pointsBalance),
    growthValue: number(item.growthValue),
    lifetimeGrowth: number(item.lifetimeGrowth === undefined ? item.growthValue : item.lifetimeGrowth),
    tierQualificationGrowth: item.tierQualificationGrowth === null || item.tierQualificationGrowth === undefined
      ? null : number(item.tierQualificationGrowth),
    qualificationGrowth,
    qualificationGrowthText: qualificationGrowth === null ? '待核验' : String(qualificationGrowth),
    qualificationText: progress
      ? `近${progress.evaluationWindowMonths}个月资格成长值 ${qualificationGrowth}`
      : '资格成长值以已发布规则和权威交易记录为准',
    qualificationProgressText: threshold && qualificationGrowth !== null
      ? `升级资格进度 ${qualificationGrowth} / ${threshold}` : '',
    progressPercent,
    periodText: periodAt ? `当前等级有效期至 ${String(periodAt).slice(0, 10)}` : '当前等级有效期以已发布规则为准',
    nextText,
    estimatedSpendText: item.estimatedSpendToNextTierMinor !== null
      && item.estimatedSpendToNextTierMinor !== undefined
      && Number.isFinite(Number(item.estimatedSpendToNextTierMinor))
      ? `按当前已发布规则估算还需消费合格商品 ${money(Number(item.estimatedSpendToNextTierMinor))}` : '',
    annualBenefitCounts: item.annualBenefitCounts || { preview: 0, granted: 0, available: 0 },
    updatedText: item.updatedAt ? `数据更新于 ${dateTime(item.updatedAt)}` : '',
  }, memberCardProgress(displayLevel, progress, previewLevel))
}

function benefitView(item) {
  const display = item.display || {}
  const quantity = number(item.remainingQuantity === undefined ? item.quantityAvailable : item.remainingQuantity)
  const starts = item.validFrom ? String(item.validFrom).slice(0, 10) : ''
  const ends = item.validUntil ? String(item.validUntil).slice(0, 10) : ''
  return {
    id: item.id,
    title: display.title || display.name || item.name || BENEFIT_NAMES[item.type] || '会员权益',
    description: display.description || display.summary || item.description || '使用条件以权益详情和现场确认为准',
    quantity,
    quantityText: `可用 ${quantity} 份`,
    validText: ends ? `有效至 ${ends}` : '有效期以权益详情为准',
    periodText: starts && ends ? `${starts} 至 ${ends}` : (starts ? `${starts} 起可使用` : '时间以权益详情为准'),
    valueText: number(item.valueAmountMinor) > 0 ? money(item.valueAmountMinor) : '',
    status: item.status || 'issued',
    statusText: BENEFIT_STATUS_NAMES[item.status] || '状态待确认',
  }
}

function ledgerView(item, kind) {
  const delta = number(kind === 'points' ? item.pointsDelta : item.growthDelta)
  return {
    id: item.id,
    title: item.description || '会员记录',
    timeText: dateTime(item.occurredAt || item.availableAt),
    amountText: `${delta >= 0 ? '+' : ''}${delta}${kind === 'points' ? ' 积分' : ' 成长值'}`,
    positive: delta >= 0,
  }
}

function calendarItems(items, index) {
  const filter = CALENDAR_FILTERS[index] || CALENDAR_FILTERS[0]
  return items.filter((item) => filter.value === 'all' || item.status === filter.value)
}

function annualBenefitView(item) {
  const starts = item.windowStartsOn || item.date || ''
  const ends = item.windowEndsOn || starts
  return {
    id: item.id,
    title: item.title || '年度会员礼遇',
    periodText: starts && ends ? (starts === ends ? starts : `${starts} 至 ${ends}`) : '时间以门店已发布规则为准',
    status: item.status || 'pending',
    factState: item.factState || 'preview',
    statusText: ANNUAL_STATUS_NAMES[item.status] || '状态待确认',
    quantityText: annualBenefitStatusText(item),
    conditionsText: Array.isArray(item.conditions) ? item.conditions.join(' · ') : '',
    ruleText: [item.store && item.store.name, item.timezone, item.cycleKey ? `周期 ${item.cycleKey}` : '',
      item.applicableTier ? `${CARD_LEVEL_NAMES[item.applicableTier] || '会员'}适用` : ''].filter(Boolean).join(' · '),
    giftText: item.gift && item.gift.name ? `礼遇：${item.gift.name}` : '',
    substituteText: Array.isArray(item.substitutes) && item.substitutes.length
      ? `可替代：${item.substitutes.map((candidate) => candidate.name).join('、')}` : '',
    canApplyReason: item.canApplyReason || '',
    claimable: item.claimable === true,
  }
}

function annualBenefitStatusText(item) {
  if (item.claimable) return '入座后可申请，等待服务人员确认'
  if (item.factState === 'continuous_qualification') return '根据现场可用座位优先安排，不承诺固定桌位；无需一次性核销'
  if (item.kind === 'daily_snack' && item.factState === 'reserved') return '已暂留，等待服务人员确认'
  if (item.kind === 'daily_snack' && item.factState === 'awaiting_fulfillment') return '服务人员已确认，正在等待制作或送达'
  if (item.kind === 'daily_snack' && item.factState === 'fulfilled') return '已完成制作并送达'
  if (item.kind === 'daily_snack' && item.factState === 'cancelled') return '本次申请已取消，名额已释放'
  if (item.kind === 'daily_snack' && item.factState === 'expired') return '暂留超时已自动释放'
  return item.redeemable ? '可在到店后使用' : '尚未生成可使用权益'
}

Page({
  data: {
    loading: true, error: '', membership: null, benefits: [], points: [], growth: [], processing: [], annualCalendar: [],
    calendarFilters: CALENDAR_FILTERS, calendarFilterIndex: 0, calendarItems: [], dailySnackBusy: false,
    dailySnackClaim: null,
  },

  onShow() { this.load() },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const bootstrap = await getMiniBootstrap()
      const benefits = (bootstrap.benefits || []).map(benefitView)
      const annualCalendar = (bootstrap.annualBenefitCalendar || []).map(annualBenefitView)
      const membership = bootstrap && bootstrap.membership ? membershipView(bootstrap.membership) : null
      this.setData({
        loading: false,
        membership,
        benefits,
        points: (bootstrap.points || []).slice(0, 5).map((item) => ledgerView(item, 'points')),
        growth: (bootstrap.growth || []).slice(0, 5).map((item) => ledgerView(item, 'growth')),
        processing: (bootstrap.processing || []).slice(0, 5),
        annualCalendar,
        calendarFilterIndex: 0,
        calendarItems: calendarItems(annualCalendar, 0),
      })
    } catch (error) {
      this.setData({ loading: false, error: customerErrorMessage(error, '会员中心暂时无法读取') })
    }
  },

  onCalendarFilter(event) {
    const index = Math.max(0, Math.min(CALENDAR_FILTERS.length - 1, number(event.detail.value)))
    this.setData({ calendarFilterIndex: index, calendarItems: calendarItems(this.data.annualCalendar, index) })
  },

  async claimDailySnack() {
    if (this.data.dailySnackBusy) return
    this.setData({ dailySnackBusy: true, error: '' })
    try {
      const claim = await claimAnnualDailySnack()
      const expires = claim && claim.expiresAt ? String(claim.expiresAt).slice(11, 16) : '暂留期内'
      this.setData({ dailySnackClaim: {
        claimCode: claim.claimCode,
        claimCodeQrDataUrl: claim.claimCodeQrDataUrl || '',
        expiresText: expires,
      } })
      wx.showToast({ title: '已生成核销码', icon: 'success' })
    } catch (error) {
      this.setData({ error: customerErrorMessage(error, '每日点心暂时无法申请') })
    } finally { this.setData({ dailySnackBusy: false }) }
  },

  closeDailySnackClaim() { this.setData({ dailySnackClaim: null }) },

  openPoints() { wx.navigateTo({ url: '/pages/points/index' }) },
  openCoupons() { wx.navigateTo({ url: '/pages/profile-coupons/index' }) },
  backToProfile() { wx.switchTab({ url: '/pages/profile/index' }) },
})
