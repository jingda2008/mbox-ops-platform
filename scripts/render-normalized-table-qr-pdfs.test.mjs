import assert from 'node:assert/strict'
import test from 'node:test'
import { createVerifiedQrDataUrl, renderCardsHtml, validatePrivateManifest } from './render-normalized-table-qr-pdfs.mjs'

const url = `https://139.224.254.60/guest?table=L01#token=${'a'.repeat(48)}`

test('validates fixed table QR manifests without accepting placeholder payloads', () => {
  const entries = validatePrivateManifest({
    format: 'mbox.normalized-fixed-table-qr.v1',
    sensitive: true,
    entries: [{ tableCode: 'L01', url }],
  })
  assert.equal(entries[0].url, url)
  assert.throws(() => validatePrivateManifest({
    format: 'mbox.normalized-fixed-table-qr.v1',
    sensitive: true,
    entries: [{ tableCode: 'L01', url: '-' }],
  }), /访问地址无效/)
})

test('generates a QR bitmap that decodes back to the exact guest URL', async () => {
  const dataUrl = await createVerifiedQrDataUrl(url)
  assert.match(dataUrl, /^data:image\/png;base64,/)
  const html = renderCardsHtml([{ tableCode: 'L01', qrDataUrl: dataUrl }])
  assert.match(html, /L01/)
  assert.doesNotMatch(html, /token=/)
})
