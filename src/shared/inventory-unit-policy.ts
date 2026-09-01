export function isLiquidInventoryCategory(categoryCode: string): boolean {
  return categoryCode === 'spirits' || categoryCode.startsWith('spirits.')
    || categoryCode === 'wine' || categoryCode.startsWith('wine.')
    || categoryCode === 'mixer' || categoryCode.startsWith('mixer.')
    || categoryCode === 'beer' || categoryCode.startsWith('beer.')
    || categoryCode === 'bottled_spirits' || categoryCode.startsWith('bottled_spirits.')
    || categoryCode === 'alcohol' || categoryCode.startsWith('alcohol.')
}

export function requiresMillilitreInventoryMigration(categoryCode: string, baseUnit: string): boolean {
  return isLiquidInventoryCategory(categoryCode) && baseUnit.trim().toLowerCase() !== 'ml'
}

export function inventoryEmployeeUnit(categoryCode: string, baseUnit: string): string {
  return isLiquidInventoryCategory(categoryCode) ? 'ml' : baseUnit.trim().toLowerCase()
}

export function inventoryQuantityForEmployee(
  storedQuantity: string,
  categoryCode: string,
  baseUnit: string,
  packageVolumeMl: string | null,
): string | null {
  if (!requiresMillilitreInventoryMigration(categoryCode, baseUnit)) {
    return normalizeUnsignedDecimal(storedQuantity)
  }
  return multiplyUnsignedDecimals(storedQuantity, packageVolumeMl)
}

export function inventoryQuantityForStorage(
  employeeQuantity: string,
  categoryCode: string,
  baseUnit: string,
  packageVolumeMl: string | null,
): string | null {
  if (!requiresMillilitreInventoryMigration(categoryCode, baseUnit)) {
    return normalizeUnsignedDecimal(employeeQuantity)
  }
  return divideUnsignedDecimals(employeeQuantity, packageVolumeMl, 6)
}

function multiplyUnsignedDecimals(left: string, right: string | null, maximumScale = 6): string | null {
  const parsedLeft = parseUnsignedDecimal(left)
  const parsedRight = right === null ? null : parseUnsignedDecimal(right)
  if (parsedLeft === null || parsedRight === null || parsedRight.value === 0n) return null
  return formatRoundedDecimal(
    parsedLeft.value * parsedRight.value,
    parsedLeft.scale + parsedRight.scale,
    maximumScale,
  )
}

function divideUnsignedDecimals(dividend: string, divisor: string | null, outputScale: number): string | null {
  const parsedDividend = parseUnsignedDecimal(dividend)
  const parsedDivisor = divisor === null ? null : parseUnsignedDecimal(divisor)
  if (parsedDividend === null || parsedDivisor === null || parsedDivisor.value === 0n) return null
  const numerator = parsedDividend.value * powerOfTen(parsedDivisor.scale + outputScale)
  const denominator = parsedDivisor.value * powerOfTen(parsedDividend.scale)
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient
  return formatDecimal(rounded, outputScale)
}

function normalizeUnsignedDecimal(value: string): string | null {
  const parsed = parseUnsignedDecimal(value)
  return parsed === null ? null : formatDecimal(parsed.value, parsed.scale)
}

function parseUnsignedDecimal(value: string): { value: bigint; scale: number } | null {
  const normalized = value.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) return null
  const [whole = '0', fraction = ''] = normalized.split('.')
  return { value: BigInt(`${whole}${fraction}`), scale: fraction.length }
}

function formatRoundedDecimal(value: bigint, scale: number, maximumScale: number): string {
  if (scale <= maximumScale) return formatDecimal(value, scale)
  const divisor = powerOfTen(scale - maximumScale)
  const quotient = value / divisor
  const remainder = value % divisor
  return formatDecimal(remainder * 2n >= divisor ? quotient + 1n : quotient, maximumScale)
}

function formatDecimal(value: bigint, scale: number): string {
  if (scale === 0) return value.toString()
  const digits = value.toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, -scale)
  const fraction = digits.slice(-scale).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent)
}
