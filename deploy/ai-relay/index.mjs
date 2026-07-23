import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const port = Number(process.env.PORT ?? 8080)
const relayToken = process.env.MBOX_RELAY_TOKEN?.trim() ?? ''
const geminiApiKey = process.env.MBOX_GEMINI_API_KEY?.trim() ?? ''
const upstreamUrl = 'https://generativelanguage.googleapis.com/v1beta/interactions'
const maximumBodyBytes = 2 * 1024 * 1024

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid')
if (relayToken.length < 32) throw new Error('MBOX_RELAY_TOKEN must contain at least 32 characters')
if (geminiApiKey.length < 20) throw new Error('MBOX_GEMINI_API_KEY is invalid')

function sameSecret(left, right) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

async function readBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > maximumBodyBytes) throw new Error('BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    return sendJson(response, 200, { status: 'ok' })
  }
  if (request.method !== 'POST' || request.url !== '/v1beta/interactions') {
    return sendJson(response, 404, { error: { message: 'not found' } })
  }
  const presentedToken = String(request.headers['x-goog-api-key'] ?? '')
  if (!sameSecret(presentedToken, relayToken)) {
    return sendJson(response, 401, { error: { message: 'unauthorized' } })
  }

  try {
    const rawBody = await readBody(request)
    const parsed = JSON.parse(rawBody)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.model !== 'string') {
      return sendJson(response, 400, { error: { message: 'invalid request' } })
    }
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': geminiApiKey,
      },
      body: rawBody,
      signal: AbortSignal.timeout(30_000),
    })
    const result = await upstream.text()
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(result)
  } catch (error) {
    const bodyTooLarge = error instanceof Error && error.message === 'BODY_TOO_LARGE'
    sendJson(response, bodyTooLarge ? 413 : 502, {
      error: { message: bodyTooLarge ? 'request too large' : 'upstream unavailable' },
    })
  }
})

server.requestTimeout = 40_000
server.headersTimeout = 45_000
server.listen(port, '0.0.0.0')
