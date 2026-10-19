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
    .replace(/\.wxss/g, '.acss')
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
    assert(!/\bcatch\s*\{/.test(source), `支付宝编译器不支持省略 catch 参数: ${relative(alipayRoot, file)}`)
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
// The requested customer custody feature is WeChat-only. Keep all existing
// Alipay pages checked; only these exact new routes are outside parity scope.
const wechatOnlyPages = new Set(['pages/profile-bottles/index', 'pages/profile-bottle-detail/index'])
for (const page of wechatOnlyPages) {
  assert(wechatApp.pages.includes(page) && !alipayApp.pages.includes(page), `微信独有页面范围变化: ${page}`)
  for (const extension of ['.js', '.json', '.wxml', '.wxss']) await stat(join(wechatRoot, page + extension))
}
const sharedPages = wechatApp.pages.filter(page => !wechatOnlyPages.has(page))
assert(JSON.stringify(alipayApp.pages) === JSON.stringify(sharedPages), '支付宝 pages 顺序与共享微信页面不一致')

const wechatTabs = wechatApp.tabBar.list.map(({ pagePath, text }) => ({ pagePath, name: text }))
const alipayTabs = alipayApp.tabBar.items.map(({ pagePath, name }) => ({ pagePath, name }))
assert(JSON.stringify(alipayTabs) === JSON.stringify(wechatTabs), '支付宝 tabBar 页面或文案与微信不一致')

// The 2026-09-14 policy-readability fix is WeChat-only by explicit scope.
// Freeze both reviewed templates for these three divergences; any further change
// must be reviewed again. Alipay syntax, handlers, styles and package checks still run.
// User explicitly excluded Alipay from the v9 release on 2026-09-16.
// Bind the reviewed WeChat-only templates to exact hashes; do not skip syntax checks.
// Reviewed WeChat-only category expansion and 2026-09-20 community recovery;
// Alipay remains at its separately frozen template and is not part of this release.
// 2026-09-19: member QR preview is explicitly WeChat-only. Pin both reviewed
// templates and styles; all Alipay syntax, handler and package checks remain active.
// 2026-10-19: WeChat cards remove inline retry, show cumulative fallback and next-tier benefit previews.
// Alipay keeps its frozen retry and coupon navigation; both retain true-zero/unknown distinctions.
// Re-reviewed existing QR/policy differences; the changed progress blocks are tested on both platforms.
const wechatPolicyTemplateDivergences = {
  'pages/member-center/index': {"wechat": "7dbfe56ea18bae3db3cb72002ad0582690e646f6b5710c2693ef18412e61d8d4", "alipay": "b63676d88ddde7184c64edc094a21e584d6d2221f0b620a66a05a88efa66b2c7", "wechatStyle": "1805410a89f4ed7daf9f203b03ffce39e0520c943ef6fe0e06396de68b01b09b", "alipayStyle": "97bc2e2aacf0ace0629c8f2de495ba0426909ff3f717dda9a5b821b9f66010b8"},
  'pages/home/index': {"wechat": "acb7a4220bb51bdeaea146ef9680a9c585f30c8a9a2a15912d59fc787e1b6c3c", "alipay": "5d0b08ce22d6e10ef63e443e04f29c99c8027e59c833e645cb6fc64145a5f725"},
  // 2026-10-19: reviewed WeChat-only menu-entry invitation with explicit phone consent; Alipay stays frozen.
  // 2026-10-11: both docks retain the original checkout recovery action even for an empty/frozen cart.
  'pages/order/index': {"wechat": "af63894a866968982930ac9d6cb904b303c1f144911a9cd62a67195a5e128ec1", "alipay": "17199fca5c79d47ce1df251bdd571137689dd063359d130ca352bce7975d00d7"},
  'pages/profile/index': {"wechat": "c8741771e41f5e04e2d22b83d216c6b8098866353e590991ba5de7b634feee65", "alipay": "2208e9552cebbf408d7f15e1ccf97873e8dc799654c67b22e58fa38fb4e5fe10", "wechatStyle": "1fa5c72e694bc5efb80f28f0a50f92d69d60a552612309ac86206701e162c424", "alipayStyle": "0a138379f29010351fca2d688e41fbf3b8be6c7f0a9933de31c919dabf4f6e23"},
  'pages/community/index': {"wechat": "28632c76e3ffb25597311c97a90cccea5694f7536d0abb7e1d3ea03f6cfb8169", "alipay": "31652fbffa072e0ab56f52acd7fb99793ccab3066bdd39c045d2669ee25c8d2f"},
  'pages/reservations/index': {"wechat": "b2c4aaa0f832ac6cc3bd4ae3d85ad070f1404729af5e6ce44c687ce02f3c140c", "alipay": "20ea996ef29943ff51451163ce61a96ab42de0b022aa3e7cf6583a2ede3a0a9f"},
  'pages/profile-cards/index': {"wechat": "35bcb245d3e93abe560a9e770a2009bb6fd08a6deda4f740bb91d1b7ac08d43b", "alipay": "385a7e6a8cc313d852944e5a17bdde388f54b573122c019e0eb45ae20c789a07"},

  'pages/profile-preferences/index': { wechat: '821b839de36340872e068bcef174a1f58d63c285160f3e2fa048d7be69508276', alipay: 'a842657e97e011a6b76259dd9c9281e8878836d42e70d3ef32a5ae06b9ff9303' },
  'pages/membership-terms/index': { wechat: 'd06727683d41d9d85ff540ad3e0c8bfb04f59c5d2cb1e11a5265401b43189926', alipay: 'e283016560ab6f27f4ec8a46825fdc748874f54e9316384314b2bb18b3f48b81' },
  'pages/privacy/index': { wechat: '1930001a804ff2d1d259f17c5e95fabfd18698ba3390c34f7f5d7cfe57dc2c82', alipay: '5676e96092f9fb099021f9fc3fc1f726ccabae90ab849492ce507af6e6477b31', wechatStyle: '9b030ff109761feaef95c8acb23d6777562e19562c252436877afb94e84462c0', alipayStyle: '3df911f6d207652fe382af8abe70c740c7b775179a85ce080f8e4edf7c2273c0' },
}

for (const page of sharedPages) {
  const alipayBase = join(alipayRoot, page)
  for (const extension of ['.js', '.json', '.axml']) {
    await stat(`${alipayBase}${extension}`).catch(() => {
      throw new Error(`支付宝页面缺少 ${page}${extension}`)
    })
  }
  const wechatTemplate = await readFile(join(wechatRoot, `${page}.wxml`), 'utf8')
  const alipayTemplate = await readFile(`${alipayBase}.axml`, 'utf8')
  const alipayScript = await readFile(`${alipayBase}.js`, 'utf8')
  const divergence = wechatPolicyTemplateDivergences[page]
  const reviewedDivergence = Boolean(divergence && digest(wechatTemplate) === divergence.wechat && digest(alipayTemplate) === divergence.alipay)
  assert(reviewedDivergence || tagSignature(alipayTemplate) === tagSignature(wechatTemplate), `${page} 的标签布局与微信不一致`)

  const wechatHandlers = [...wechatTemplate.matchAll(/\b(?:bind|catch)[A-Za-z:]*="([A-Za-z_$][\w$]*)"/g)]
    .map((match) => match[1].replace(/Wechat/g, 'Alipay'))
  const alipayHandlers = [...alipayTemplate.matchAll(/\b(?:on|catch)[A-Z][A-Za-z]*="([A-Za-z_$][\w$]*)"/g)]
    .map((match) => match[1])
  assert(reviewedDivergence || JSON.stringify(alipayHandlers) === JSON.stringify(wechatHandlers), `${page} 的交互处理函数与微信不一致`)
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
  const reviewedStyleDivergence = (page === 'pages/community/index' && digest(wechatStyle) === 'c486eeedc11bb12747bef53bb0d3cb17ba8a06630e9c28a4534e343fae83a4ac' && digest(alipayStyle) === '8aed83c1c0b9df23001dd5119425e0ab777e5748795746c55269947d6fec7b63') || page === 'pages/order/index' && digest(wechatStyle) === '8a43c71c8f2632ad36f73857a780c924f86d3e288201b34441b9c17d32b6e7f5' && digest(alipayStyle) === '4225c235d5e13f4a6552f4273dae0758f511c9306b487e1d2b9ed2e7f32fb6a3'
  const reviewedMemberQrStyle = page === 'pages/member-center/index' && reviewedDivergence
    && digest(wechatStyle) === divergence.wechatStyle && digest(alipayStyle) === divergence.alipayStyle
  const reviewedPinnedStyle = Boolean(
    divergence
    && typeof divergence.wechatStyle === 'string'
    && typeof divergence.alipayStyle === 'string'
    && digest(wechatStyle) === divergence.wechatStyle
    && digest(alipayStyle) === divergence.alipayStyle
  )
  assert(reviewedMemberQrStyle || reviewedStyleDivergence || reviewedPinnedStyle || cssSignature(alipayStyle) === cssSignature(wechatStyle), `${page} 的布局样式与微信不一致`)

  const wechatConfig = JSON.parse(await readFile(join(wechatRoot, `${page}.json`), 'utf8').catch(() => '{}'))
  const alipayConfig = JSON.parse(await readFile(`${alipayBase}.json`, 'utf8'))
  assert(pageTitle(alipayConfig) === pageTitle(wechatConfig) || !pageTitle(wechatConfig), `${page} 的页面标题与微信不一致`)
  assert(Boolean(alipayConfig.pullRefresh) === Boolean(wechatConfig.enablePullDownRefresh), `${page} 的下拉刷新配置与微信不一致`)
}

const [wechatGlobalStyle, alipayGlobalStyle] = await Promise.all([
  readFile(join(wechatRoot, 'app.wxss'), 'utf8'),
  readFile(join(alipayRoot, 'app.acss'), 'utf8'),
])
// Reviewed WeChat-only bottom spacing for the native phone-capable custom tab bar.
const reviewedWechatTabSpacing = digest(wechatGlobalStyle) === 'ea93c65713e51421a17d560b484fc335fce9ce0a7f8856f415004ae8d173f591' && digest(alipayGlobalStyle) === 'b71b0e7cf3eed8a9b5cd5b1cb337a48a73f687724f5ae6964cf47e0ba81863da'
assert(reviewedWechatTabSpacing || cssSignature(alipayGlobalStyle) === cssSignature(wechatGlobalStyle), '全局布局样式与微信不一致')
const [wechatStateStyle, alipayStateStyle] = await Promise.all([
  readFile(join(wechatRoot, 'components/state-panel/index.wxss'), 'utf8'),
  readFile(join(alipayRoot, 'components/state-panel/index.acss'), 'utf8'),
])
assert(cssSignature(alipayStateStyle) === cssSignature(wechatStateStyle), '加载/空态/异常组件样式与微信不一致')
for (const file of await walk(join(wechatRoot,'styles'))) {
  if (!file.endsWith('.wxss')) continue
  const equivalent=join(alipayRoot,'styles',relative(join(wechatRoot,'styles'),file).replace(/\.wxss$/,'.acss'))
  assert(cssSignature(await readFile(file,'utf8'))===cssSignature(await readFile(equivalent,'utf8')),`共享样式不一致: ${relative(wechatRoot,file)}`)
}

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

const profilePhone = await readFile(join(alipayRoot, 'pages/profile/index.axml'), 'utf8')
assert(/open-type=["']getAuthorize["']/.test(profilePhone) && /scope=["']phoneNumber["']/.test(profilePhone), '会员入会必须使用官方 getAuthorize/phoneNumber')
assert(/function readAlipayPhoneAuthorization\(event\)/.test(await readFile(join(alipayRoot, 'utils/alipay-phone.js'), 'utf8')), '手机号授权必须读取授权回调，不得固定返回未接通')
assert(/my\.getPhoneNumber/.test(await readFile(join(alipayRoot, 'utils/alipay-phone.js'), 'utf8')), 'getAuthorize 成功后必须再取手机号密文')

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
