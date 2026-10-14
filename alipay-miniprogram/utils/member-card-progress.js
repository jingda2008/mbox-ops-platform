const LEVEL_NAMES = { member: '普卡', silver: '银卡', gold: '金卡' }

function progressNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  return Number.isFinite(Number(value)) ? Number(value) : null
}

function formatNumber(value) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function memberCardProgress(level, progress, status) {
  const growth = progressNumber(progress && progress.rollingGrowth)
  const threshold = progressNumber(progress && progress.upgradeThreshold)
  const nextTier = progress && progress.nextTier
  const hasTarget = threshold !== null && threshold > 0
    && ((level === 'member' && nextTier === 'silver') || (level === 'silver' && nextTier === 'gold'))
  const highestTier = level === 'gold' && progress
    && progress.nextTier === null && progress.upgradeThreshold === null
  const rulesUnavailable = status === 'rules_unavailable'
  const available = !rulesUnavailable && status !== 'unavailable'
    && growth !== null && Boolean(hasTarget || highestTier)
  const remaining = available && hasTarget ? Math.max(0, threshold - growth) : null
  return {
    cardProgressAvailable: available,
    cardProgressPercent: available
      ? hasTarget ? Math.max(0, Math.min(100, Math.round(growth / threshold * 100))) : 100
      : 0,
    cardGrowthText: available && hasTarget
      ? `成长值 ${formatNumber(growth)} / ${formatNumber(threshold)}`
      : growth !== null ? `成长值 ${formatNumber(growth)}`
        : rulesUnavailable ? '成长进度待公布' : '成长进度暂未读取',
    cardDifferenceText: rulesUnavailable ? '升级规则待公布'
      : !available ? '请重试读取成长进度'
        : highestTier ? '金卡等级已达成'
          : remaining > 0 ? `距${LEVEL_NAMES[nextTier]}还差 ${formatNumber(remaining)}`
            : `已达到${LEVEL_NAMES[nextTier]}成长值条件`,
    cardCurrentTierText: LEVEL_NAMES[level] || '会员',
    cardNextTierText: available && hasTarget ? LEVEL_NAMES[nextTier] : '',
    cardBenefitText: '查看我的优惠券 ›',
    cardProgressRetry: !available,
  }
}

export { memberCardProgress, progressNumber }
