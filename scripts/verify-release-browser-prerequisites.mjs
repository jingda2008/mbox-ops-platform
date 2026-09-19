import { pathToFileURL } from 'node:url'

// Run before downloading/copying a release or touching a production host.
// Launching is intentional: package and executable existence do not prove the
// local browser's dynamic libraries and sandbox are usable.
export async function verifyBrowserPrerequisites(load = () => import('@playwright/test')) {
  let browser
  try {
    const { chromium } = await load()
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.setContent('<main id="preflight">M-BOX 发布预检</main>')
    if (await page.locator('#preflight').textContent() !== 'M-BOX 发布预检') {
      throw new Error('browser cannot render the local probe')
    }
  } catch (cause) {
    throw new Error('发布机浏览器预检失败：请在发布工作树运行 npm ci 并安装 Playwright Chromium 及系统依赖，再重新执行正式发布入口。生产变更尚未开始。', { cause })
  } finally {
    await browser?.close()
  }
  return { verified: true, gate: 'local-browser-before-production-change' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await verifyBrowserPrerequisites())}\n`)
}
