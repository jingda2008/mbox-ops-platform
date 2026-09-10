// Local native layout evidence only. No form submission or payment actions.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
const exec = promisify(execFile)
const [project, output, ...requested] = process.argv.slice(2)
if (!project?.startsWith('/private/tmp/mbox-native-audit-') || !output) throw new Error('Only an isolated native audit project is permitted')
await readFile(path.join(project, 'audit-guard.js'))
const config = JSON.parse(await readFile(path.join(project, 'app.json'), 'utf8'))
const pages = requested.length ? requested.map(name => 'pages/' + name + '/index') : config.pages
if (pages.some(page => !config.pages.includes(page))) throw new Error('Unknown page')
const cli = '/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide'
await mkdir(output, { recursive: true })
async function call(tool, args) {
  const { stdout } = await exec(cli, ['-c', 'Codex', tool, '--project', project, ...args], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 })
  const result = JSON.parse(stdout.slice(stdout.indexOf('{')))
  if (!result.ok || result.result?.success === false) throw new Error(JSON.stringify(result))
  return result
}
const results = []
for (const page of pages) {
  const name = page.split('/')[1]
  try {
    const tab = config.tabBar.list.some(item => item.pagePath === page)
    const current = await call('automation_runtime_info', ['--action', 'currentPage'])
    if (current.result.currentPage?.path !== page) await call('automation_navigate', ['--action', tab ? 'switchTab' : 'navigateTo', '--url', '/' + page])
    const state = await call('automation_runtime_info', ['--action', 'currentPage'])
    if (state.result.currentPage?.path !== page) throw new Error('Native route differs from requested page')
    const screenshot = await call('simulator_screenshot', ['--path', path.join(output, name + '-top.jpg'), '--wait', '1'])
    const record = { page, screenshot, layoutOnly: true }
    if (['reservations', 'profile-preferences', 'profile-cards', 'profile-marketing', 'profile', 'member-center', 'privacy', 'brand-story', 'service', 'complaint', 'points', 'profile-coupons', 'status', 'songs'].includes(name)) {
      await call('automation_viewport_action', ['--action', 'pageScrollTo', '--scroll-top', '100000'])
      record.bottom = await call('simulator_screenshot', ['--path', path.join(output, name + '-bottom.jpg')])
    }
    results.push(record)
    console.log('CAPTURED ' + page)
    await writeFile(path.join(output, 'capture-results.json'), JSON.stringify({ project, results }, null, 2))
    if (!tab) await call('automation_navigate', ['--action', 'navigateBack', '--delta', '1'])
  } catch (error) {
    results.push({ page, error: String(error) })
    await writeFile(path.join(output, 'capture-results.json'), JSON.stringify({ project, results }, null, 2))
    throw error // No automatic retries or silent missing-page success.
  }
}
