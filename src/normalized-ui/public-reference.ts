export function shortPublicReference(value: string, visibleCharacters = 8): string {
  const normalized = value.trim()
  if (normalized === '') return '待生成'
  if (normalized.length <= visibleCharacters + 4) return normalized
  return `…${normalized.slice(-visibleCharacters)}`
}
