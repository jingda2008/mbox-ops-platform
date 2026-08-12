const defaultSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))

function parsePayload(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function resetRuntimeMetricsWindow({
  baseUrls,
  token,
  phase,
  fetchImpl = fetch,
  sleep = defaultSleep,
  maxAttempts = 12,
  retryDelayMs = 25,
}) {
  if (!Array.isArray(baseUrls) || baseUrls.length < 1) throw new TypeError('baseUrls must not be empty')
  if (!token) throw new TypeError('metrics token must not be empty')
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer')

  const results = []
  for (const baseUrl of baseUrls) {
    let lastBusyPayload = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetchImpl(`${baseUrl}/api/metrics/reset`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-mbox-test-phase': phase,
          'x-mbox-test-stage': 'setup',
        },
      })
      const text = await response.text()
      const payload = parsePayload(text)
      if (response.ok) {
        results.push(payload)
        break
      }
      if (response.status !== 409 || payload?.code !== 'METRICS_RESET_BUSY') {
        throw new Error(`setup_reset_metrics ${response.status}: ${text.slice(0, 400)}`)
      }
      lastBusyPayload = payload
      if (attempt === maxAttempts) {
        throw new Error(`setup_reset_metrics remained busy after ${maxAttempts} attempts: ${JSON.stringify(lastBusyPayload)}`)
      }
      await sleep(Math.min(250, retryDelayMs * attempt))
    }
  }
  return results
}
