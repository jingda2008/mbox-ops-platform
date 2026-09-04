import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const wechatRoot = join(repoRoot, 'miniprogram')
const alipayRoot = join(repoRoot, 'alipay-miniprogram')

async function walk(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await walk(path))
    else output.push(path)
  }
  return output.sort()
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function tagSignature(source) {
  const normalized = source.replace(/<text\s+style="display:block"\s*><\/text>/g, '<br />')
  return [...normalized.matchAll(/<\s*(\/?)\s*([A-Za-z][\w-]*)/g)]
    .map((match) => `${match[1]}${match[2]}`)
    .join('|')
}

function cssSignature(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Alipay checkbox exposes public attributes such as color but does not
    // support WeChat's private internal checkbox selectors.
    .replace(/[^{}]*\.wx-checkbox-input[^{}]*\{[^{}]*\}/g, '')
    .replace(/\.wx-phone-button/g, '.alipay-phone-button')
    .replace(/\s+/g, ' ')
    .trim()
}

function syntaxCheckSource(source) {
  return source
    .replace(/^export\s+default\s+/gm, 'void ')
    .replace(/^export\s+\{\s*\n([\s\S]*?)^\}\s*$/gm, 'void ({\n$1\n})')
    .replace(/^export\s+\{([^\n}]*)\}\s*$/gm, 'void ({$1})')
}

function pageTitle(config) {
  return String(config.defaultTitle || config.navigationBarTitleText || '')
}

const alipayFiles = await walk(alipayRoot)
let packageBytes = 0
for (const file of alipayFiles) {
  const source = await readFile(file, 'utf8').catch(() => null)
  packageBytes += (await stat(file)).size
  const extension = extname(file)
  if (source !== null && extension === '.json') JSON.parse(source)
  if (source !== null && extension === '.js') {
    assert(!/^[\t ]*(?:module\.exports|exports\s*(?:\.|\[))/m.test(source), `支付宝 2.x 源码必须使用 ESM 导出: ${relative(alipayRoot, file)}`)
    new vm.Script(syntaxCheckSource(source), { filename: relative(alipayRoot, file) })
  }
  if (source !== null && /appsecret\s*[:=]/i.test(source)) {
    throw new Error(`支付宝包禁止出现 AppSecret 配置: ${relative(alipayRoot, file)}`)
  }
  if (source !== null && extension === '.js' && source.includes('/api/bootstrap')) {
    throw new Error(`顾客端禁止访问全店 bootstrap: ${relative(alipayRoot, file)}`)
  }
  if (source !== null && ['.js', '.axml', '.acss', '.json'].includes(extension)) {
    const forbidden = [
      [/\bwx\s*(?:\.|\[)/, 'wx.* 或 wx[...] 调用'],
      [/\bwx:/, 'wx: 模板指令'],
      [/\bbind(?:tap|input|change|blur|getphonenumber)=/i, '微信事件绑定'],
      [/\.wxml\b|\.wxss\b/, '微信文件扩展名'],
      [/\/api\/wechat(?:\/|\b)/, '微信专属后端接口'],
      [/open-type=["']getAuthorize["']/i, '未接通后端前禁止请求支付宝授权'],
      [/\.wx-checkbox-input\b/, '微信 checkbox 内部样式'],
    ]
    for (const [pattern, label] of forbidden) {
      if (pattern.test(source)) throw new Error(`${label}: ${relative(alipayRoot, file)}`)
    }
  }
}
assert(packageBytes <= 2 * 1024 * 1024, `支付宝小程序包超过保守 2MB 门禁: ${packageBytes} bytes`)

const wechatApp = JSON.parse(await readFile(join(wechatRoot, 'app.json'), 'utf8'))
const alipayApp = JSON.parse(await readFile(join(alipayRoot, 'app.json'), 'utf8'))
const project = JSON.parse(await readFile(join(alipayRoot, 'mini.project.json'), 'utf8'))
assert(project.format === 2, 'mini.project.json 必须使用 format 2')
assert(project.compileType === 'mini', 'mini.project.json format 2 的 compileType 必须为 mini')
assert(!Object.prototype.hasOwnProperty.call(project, 'enableAppxNg'), 'format 2 不得保留旧版 enableAppxNg 配置')
assert(!Object.prototype.hasOwnProperty.call(project, 'component2'), 'format 2 的 component2 必须迁移到 compileOptions')
assert(project.compileOptions && project.compileOptions.component2 === true, 'mini.project.json 必须显式启用 compileOptions.component2')
assert(JSON.stringify(alipayApp.pages) === JSON.stringify(wechatApp.pages), '支付宝 pages 顺序与微信不一致')

const wechatTabs = wechatApp.tabBar.list.map(({ pagePath, text }) => ({ pagePath, name: text }))
const alipayTabs = alipayApp.tabBar.items.map(({ pagePath, name }) => ({ pagePath, name }))
assert(JSON.stringify(alipayTabs) === JSON.stringify(wechatTabs), '支付宝 tabBar 页面或文案与微信不一致')

for (const page of wechatApp.pages) {
  const alipayBase = join(alipayRoot, page)
  for (const extension of ['.js', '.json', '.axml']) {
    await stat(`${alipayBase}${extension}`).catch(() => {
      throw new Error(`支付宝页面缺少 ${page}${extension}`)
    })
  }
  const wechatTemplate = await readFile(join(wechatRoot, `${page}.wxml`), 'utf8')
  const alipayTemplate = await readFile(`${alipayBase}.axml`, 'utf8')
  const alipayScript = await readFile(`${alipayBase}.js`, 'utf8')
  assert(tagSignature(alipayTemplate) === tagSignature(wechatTemplate), `${page} 的标签布局与微信不一致`)

  const wechatHandlers = [...wechatTemplate.matchAll(/\b(?:bind|catch)[A-Za-z:]*="([A-Za-z_$][\w$]*)"/g)]
    .map((match) => match[1].replace(/Wechat/g, 'Alipay'))
  const alipayHandlers = [...alipayTemplate.matchAll(/\b(?:on|catch)[A-Z][A-Za-z]*="([A-Za-z_$][\w$]*)"/g)]
    .map((match) => match[1])
  assert(JSON.stringify(alipayHandlers) === JSON.stringify(wechatHandlers), `${page} 的交互处理函数与微信不一致`)
  for (const handler of new Set(alipayHandlers)) {
    const escaped = handler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert(new RegExp(`\\b${escaped}\\s*\\(`).test(alipayScript), `${page} 缺少模板事件处理函数 ${handler}`)
  }

  const wechatStylePath = join(wechatRoot, `${page}.wxss`)
  const alipayStylePath = `${alipayBase}.acss`
  const [wechatStyle, alipayStyle] = await Promise.all([
    readFile(wechatStylePath, 'utf8').catch(() => ''),
    readFile(alipayStylePath, 'utf8').catch(() => ''),
  ])
  assert(cssSignature(alipayStyle) === cssSignature(wechatStyle), `${page} 的布局样式与微信不一致`)

  const wechatConfig = JSON.parse(await readFile(join(wechatRoot, `${page}.json`), 'utf8').catch(() => '{}'))
  const alipayConfig = JSON.parse(await readFile(`${alipayBase}.json`, 'utf8'))
  assert(pageTitle(alipayConfig) === pageTitle(wechatConfig) || !pageTitle(wechatConfig), `${page} 的页面标题与微信不一致`)
  assert(Boolean(alipayConfig.pullRefresh) === Boolean(wechatConfig.enablePullDownRefresh), `${page} 的下拉刷新配置与微信不一致`)
}

const [wechatGlobalStyle, alipayGlobalStyle] = await Promise.all([
  readFile(join(wechatRoot, 'app.wxss'), 'utf8'),
  readFile(join(alipayRoot, 'app.acss'), 'utf8'),
])
assert(cssSignature(alipayGlobalStyle) === cssSignature(wechatGlobalStyle), '全局布局样式与微信不一致')

const wechatAssets = (await walk(join(wechatRoot, 'assets'))).map((file) => relative(join(wechatRoot, 'assets'), file))
const alipayAssets = (await walk(join(alipayRoot, 'assets'))).map((file) => relative(join(alipayRoot, 'assets'), file))
assert(JSON.stringify(alipayAssets) === JSON.stringify(wechatAssets), '支付宝静态资源清单与微信不一致')
for (const asset of wechatAssets) {
  const [wechatValue, alipayValue] = await Promise.all([
    readFile(join(wechatRoot, 'assets', asset)),
    readFile(join(alipayRoot, 'assets', asset)),
  ])
  assert(digest(alipayValue) === digest(wechatValue), `静态资源内容不一致: ${asset}`)
}

const apiSource = await readFile(join(alipayRoot, 'utils/api.js'), 'utf8')
const wechatApiSource = await readFile(join(wechatRoot, 'utils/api.js'), 'utf8')
const apiPaths = [...apiSource.matchAll(/['`](\/api\/[A-Za-z0-9_?=&/${}.:-]+)/g)].map((match) => match[1])
for (const apiPath of apiPaths) {
  const stablePrefix = apiPath.split('?')[0].split('${')[0]
  assert(wechatApiSource.includes(stablePrefix), `支付宝前端出现微信端不存在的业务接口: ${stablePrefix}`)
}
const reservationNotificationRead = apiSource.match(/async function getReservationPerformanceNotificationAuthorizations\(\)\s*\{([\s\S]*?)\n\}/)
const reservationNotificationWrite = apiSource.match(/async function recordReservationPerformanceNotificationAuthorization\([^)]*\)\s*\{([\s\S]*?)\n\}/)
assert(reservationNotificationRead && !/publicRequest\(/.test(reservationNotificationRead[1]), '支付宝不得读取微信预约消息授权接口')
assert(reservationNotificationWrite && !/publicRequest\(/.test(reservationNotificationWrite[1]), '支付宝不得写入微信预约消息授权接口')

const runtimeConfig = await readFile(join(alipayRoot, 'config/index.js'), 'utf8')
assert(/alipayIdentityEnabled:\s*false/.test(runtimeConfig), '支付宝身份适配未完成前必须关闭身份能力')
assert(/alipayPaymentEnabled:\s*false/.test(runtimeConfig), '支付宝支付适配未完成前必须关闭支付能力')
for (const capability of ['alipayIdentityEnabled', 'alipayPaymentEnabled', 'alipayPhoneEnabled', 'alipayNotificationEnabled']) {
  assert(new RegExp(`merged\\.${capability}\\s*=\\s*false`).test(runtimeConfig), `${capability} 必须在配置合并后强制关闭`)
}
assert(/let envVersion\s*=\s*['"]release['"]/.test(runtimeConfig), '未知支付宝运行环境必须默认生产态')

const activitySource = await readFile(join(alipayRoot, 'pages/community-detail/index.js'), 'utf8')
const paidActivityGuard = activitySource.indexOf('pricing.requiresPaymentOnSubmit && getRuntimeConfig().alipayPaymentEnabled !== true')
const activityWrite = activitySource.indexOf('await registerActivity(')
assert(paidActivityGuard >= 0 && paidActivityGuard < activityWrite, '收费活动必须在创建报名之前拦截未接通的支付宝支付')

const reservationsSource = await readFile(join(alipayRoot, 'pages/reservations/index.js'), 'utf8')
const reservationsTemplate = await readFile(join(alipayRoot, 'pages/reservations/index.axml'), 'utf8')
const profileSource = await readFile(join(alipayRoot, 'pages/profile/index.js'), 'utf8')
const subscriptionSource = await readFile(join(alipayRoot, 'utils/alipay-subscription.js'), 'utf8')
assert(!/getMiniBootstrap|membershipRequired|redirectToMembershipLogin|goMembershipLogin/.test(reservationsSource), '支付宝预约页不得要求会员身份')
assert(!/membership-gate|请先登录会员|登录后才能预约/.test(reservationsTemplate), '支付宝预约页不得显示会员拦截')
assert(/openReservations\(\)\s*\{[\s\S]*?runtime\.switchTab\(\{ url: '\/pages\/reservations\/index' \}\)/.test(profileSource), '支付宝“我的预约”必须允许访客直接进入')
assert(!/getAlipayNotificationAuthorizations|getAlipayMemberServiceNotificationAuthorizations|getAlipayNotificationPrompt\('(activity_registration|order_checkout|member_card|coupon_open)'\)/.test(reservationsSource), '支付宝访客预约不得读取会员消息授权')
assert(/const RESERVATION_SUCCESS_SUBSCRIBE_TYPES = Object\.freeze\(\[\s*'reservation_performance_revised',?\s*\]\)/.test(subscriptionSource), '预约提交只能请求预约相关消息模板')
assert(/notificationsEnabled\s*\?\s*getReservationPerformanceNotificationAuthorizations\(\)\s*:\s*Promise\.resolve\(\{ authorizations: \[\] \}\)/.test(reservationsSource), '消息关闭时预约页不得读取平台消息授权')
assert(/if \(getRuntimeConfig\(\)\.alipayNotificationEnabled !== true\) \{[\s\S]*?不会申请授权/.test(reservationsSource), '预约提醒点击必须在消息未接通时明确失败关闭')

console.log(`Alipay Mini Program parity verification passed (${alipayApp.pages.length} pages, ${alipayTabs.length} tabs, ${packageBytes} bytes)`)
