import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import jsQR from 'jsqr'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import QRCode from 'qrcode'

const OUTPUT_MODE = 0o700
const FILE_MODE = 0o600

export function validatePrivateManifest(value) {
  if (!value || value.format !== 'mbox.normalized-fixed-table-qr.v1' || value.sensitive !== true) {
    throw new Error('桌码私密清单格式无效')
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) throw new Error('桌码私密清单没有桌台')
  const codes = new Set()
  for (const entry of value.entries) {
    if (!entry || typeof entry.tableCode !== 'string' || !/^[A-Z0-9-]{1,24}$/.test(entry.tableCode)) {
      throw new Error('桌码清单包含无效桌号')
    }
    if (codes.has(entry.tableCode)) throw new Error(`桌码清单包含重复桌号：${entry.tableCode}`)
    codes.add(entry.tableCode)
    let url
    try {
      url = new URL(entry.url)
    } catch {
      throw new Error(`桌号 ${entry.tableCode} 的访问地址无效`)
    }
    if (url.protocol !== 'https:' || url.pathname !== '/guest' || url.searchParams.get('table') !== entry.tableCode) {
      throw new Error(`桌号 ${entry.tableCode} 的访问地址无效`)
    }
    const token = new URLSearchParams(url.hash.slice(1)).get('token') ?? ''
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error(`桌号 ${entry.tableCode} 的凭证无效`)
  }
  return value.entries
}

export async function createVerifiedQrDataUrl(url) {
  const buffer = await QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: 4,
    width: 900,
    color: { dark: '#101713', light: '#ffffff' },
  })
  const png = PNG.sync.read(buffer)
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, {
    inversionAttempts: 'dontInvert',
  })
  if (decoded?.data !== url) throw new Error('桌码成品解码校验失败')
  return `data:image/png;base64,${buffer.toString('base64')}`
}

export function renderCardsHtml(cards) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    @page { size: A5 portrait; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color: #101713; }
    .card { width: 148mm; height: 210mm; page-break-after: always; display: grid; grid-template-rows: 42mm 1fr 31mm; background: #fff; overflow: hidden; }
    .card:last-child { page-break-after: auto; }
    header { display: grid; place-items: center; align-content: center; gap: 2mm; color: #fff; background: #111713; border-bottom: 1.2mm solid #cba64d; }
    header strong { font-size: 10mm; font-weight: 650; letter-spacing: 0; }
    header span { font-size: 4.3mm; opacity: .82; }
    main { display: grid; justify-items: center; align-content: center; gap: 5mm; padding: 7mm; }
    h1 { margin: 0; font-size: 17mm; font-weight: 650; letter-spacing: 0; }
    img { width: 91mm; height: 91mm; image-rendering: pixelated; }
    footer { display: grid; justify-items: center; align-content: start; gap: 3mm; padding-top: 2mm; }
    footer strong { font-size: 6mm; }
    footer span { font-size: 4mm; color: #697169; }
    footer small { margin-top: 2mm; font-size: 3.4mm; color: #8a918b; }
  </style></head><body>${cards.map((card) => `<section class="card">
    <header><strong>M-BOX</strong><span>LIVEHOUSE · LUJIAZUI</span></header>
    <main><h1>${escapeHtml(card.tableCode)}</h1><img alt="${escapeHtml(card.tableCode)}桌码" src="${card.qrDataUrl}"></main>
    <footer><strong>扫码点单 · 呼叫服务</strong><span>未开台时请稍候，服务伙伴会为您安排</span><small>固定桌码 · ${escapeHtml(card.tableCode)}</small></footer>
  </section>`).join('')}</body></html>`
}

export async function renderNormalizedTableQrPdfs({ manifestPath, outputDirectory }) {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'))
  const entries = validatePrivateManifest(manifest)
  const output = resolve(outputDirectory)
  const perTable = join(output, 'per-table')
  await rm(output, { recursive: true, force: true })
  await mkdir(perTable, { recursive: true, mode: OUTPUT_MODE })
  await chmod(output, OUTPUT_MODE)
  await chmod(perTable, OUTPUT_MODE)

  const cards = []
  for (const entry of entries) {
    cards.push({ tableCode: entry.tableCode, qrDataUrl: await createVerifiedQrDataUrl(entry.url) })
  }

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const written = []
  try {
    const combinedName = `M-BOX固定桌码_${cards.length}桌_打印版.pdf`
    const combinedPath = join(output, combinedName)
    await page.setContent(renderCardsHtml(cards), { waitUntil: 'load' })
    await page.pdf({ path: combinedPath, format: 'A5', printBackground: true, preferCSSPageSize: true })
    written.push(combinedPath)

    for (const card of cards) {
      const path = join(perTable, `M-BOX固定桌码_${card.tableCode}.pdf`)
      await page.setContent(renderCardsHtml([card]), { waitUntil: 'load' })
      await page.pdf({ path, format: 'A5', printBackground: true, preferCSSPageSize: true })
      written.push(path)
    }
  } finally {
    await browser.close()
  }

  const sums = []
  for (const path of written) {
    await chmod(path, FILE_MODE)
    const digest = createHash('sha256').update(await readFile(path)).digest('hex')
    sums.push(`${digest}  ${path.startsWith(perTable) ? `per-table/${basename(path)}` : basename(path)}`)
  }
  const ledger = join(output, 'SHA256SUMS')
  await writeFile(ledger, `${sums.join('\n')}\n`, { mode: FILE_MODE })
  return { outputDirectory: output, count: cards.length, files: written.length, ledger }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifestPath = process.env.MBOX_QR_PRIVATE_MANIFEST?.trim()
  const outputDirectory = process.env.MBOX_QR_PDF_OUTPUT_DIR?.trim()
  if (!manifestPath || !outputDirectory) {
    throw new Error('必须设置 MBOX_QR_PRIVATE_MANIFEST 和 MBOX_QR_PDF_OUTPUT_DIR')
  }
  const result = await renderNormalizedTableQrPdfs({ manifestPath, outputDirectory })
  console.log(JSON.stringify({ outputDirectory: result.outputDirectory, tableCount: result.count, fileCount: result.files }))
}
