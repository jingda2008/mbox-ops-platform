const sensitiveQueryKeys = new Set([
  'token',
  'tableToken',
  'sessionToken',
  'access_token',
  'refresh_token',
  'code',
  'state',
  'js_code',
  'customerAuthCode',
])

export function redactRequestUrl(value: string) {
  try {
    const url = new URL(value, 'http://mbox.local')
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveQueryKeys.has(key)) url.searchParams.set(key, 'REDACTED')
    }
    return `${url.pathname}${url.search}`
  } catch {
    return value.replace(/([?&](?:token|tableToken|sessionToken|access_token|refresh_token|code|state|js_code|customerAuthCode)=)[^&#\s]*/gi, '$1REDACTED')
  }
}

export function requestLogSerializer(request: {
  method?: string
  url?: string
  headers?: { host?: string }
  socket?: { remoteAddress?: string; remotePort?: number }
}) {
  return {
    method: request.method,
    url: redactRequestUrl(request.url ?? ''),
    host: request.headers?.host,
    remoteAddress: request.socket?.remoteAddress,
    remotePort: request.socket?.remotePort,
  }
}
