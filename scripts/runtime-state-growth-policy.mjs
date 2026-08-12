export function evaluateRuntimeStateGrowth({
  initialBytes,
  maxBytes,
  mutationSamples,
  absoluteLimitBytes,
  ratioWarningLimit,
  significantGrowthBytes,
  bytesPerMutationLimit,
}) {
  const growthBytes = Math.max(0, maxBytes - initialBytes)
  const growthRatio = initialBytes > 0 ? maxBytes / initialBytes : null
  const bytesPerMutation = mutationSamples > 0 ? growthBytes / mutationSamples : null
  const failures = []
  const warnings = []

  if (maxBytes > absoluteLimitBytes) {
    failures.push(`聚合状态最大 ${maxBytes}B > ${absoluteLimitBytes}B`)
  }

  if (
    growthBytes > significantGrowthBytes
    && bytesPerMutation !== null
    && bytesPerMutation > bytesPerMutationLimit
  ) {
    failures.push(`每次写入状态增量 ${bytesPerMutation.toFixed(1)}B > ${bytesPerMutationLimit}B`)
  }

  if (growthRatio !== null && growthRatio > ratioWarningLimit) {
    warnings.push(
      `聚合状态增长 ${growthRatio.toFixed(2)} 倍；倍率只用于趋势预警，需结合绝对体量和每次业务写入增量判断`,
    )
  }

  if (
    growthBytes <= significantGrowthBytes
    && bytesPerMutation !== null
    && bytesPerMutation > bytesPerMutationLimit
  ) {
    warnings.push(
      `低体量阶段每次写入状态增量 ${bytesPerMutation.toFixed(1)}B，记录为趋势但不作为容量阻断`,
    )
  }

  return {
    growthBytes,
    growthRatio,
    bytesPerMutation,
    failures,
    warnings,
    passed: failures.length === 0,
  }
}
