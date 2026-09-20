/** Keep actionable business Chinese; raw implementation details stay in server diagnostics. */
export function staffErrorMessage(value: unknown, fallback: string, status: number): string {
  if (status >= 500 || typeof value !== 'string') return fallback
  const message = value.trim()
  if (!message || !/[\u3400-\u9fff]/.test(message)
    || /SQLSTATE|PostgreSQL|\b(?:SELECT|INSERT|UPDATE|DELETE)\s|\b(?:TypeError|ReferenceError)\b|\bat\s+\S+\.(?:ts|js):\d+/i.test(message)) return fallback
  return message
}

export function staffUnavailableMessage(method: string): string {
  return ['GET', 'HEAD'].includes(method.toUpperCase())
    ? '读取失败，请刷新重试'
    : '本次操作结果尚未确认，请核对原操作后重试'
}
