import { access, mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const projectRoot = join(repoRoot, 'alipay-miniprogram')
const relativeToolPath = '小程序开发者工具.app/Contents/Resources/app/kits/mini-pkg-builder'
const candidates = [join('/Applications', relativeToolPath)]

try {
  const volumes = await readdir('/Volumes')
  for (const volume of volumes.filter((name) => name.startsWith('MiniProgramStudio-'))) {
    candidates.push(join('/Volumes', volume, relativeToolPath))
  }
} catch (_error) {
  // The mounted-volume lookup is optional; the installed application remains preferred.
}

let compiler = ''
for (const candidate of candidates) {
  try {
    await access(candidate)
    compiler = candidate
    break
  } catch (_error) {
    // Continue to the next known official installation location.
  }
}

if (!compiler) {
  throw new Error('未找到支付宝小程序开发者工具；请先安装官方 MiniProgramStudio。')
}

const output = await mkdtemp('/private/tmp/mbox-alipay-compile-')
const result = spawnSync(compiler, [
  '--project', projectRoot,
  '--input', projectRoot,
  '--output', output,
  '--project-config-path', join(projectRoot, 'mini.project.json'),
  '--target', 'web',
  '--test',
  '--no-minify',
  '--no-vuerender',
  '--rmlrender',
  '--component', 'async',
  '--mode', 'concurrent',
], { encoding: 'utf8' })

if (result.stdout) process.stdout.write(result.stdout)
if (result.status !== 0) {
  if (result.stderr) process.stderr.write(result.stderr)
  throw new Error(`支付宝官方编译器退出码 ${result.status}`)
}

const appConfig = JSON.parse(await readFile(join(output, 'appConfig.json'), 'utf8'))
const workerPath = join(output, 'index.worker.js')
const workerSize = (await stat(workerPath)).size
if (!Array.isArray(appConfig.pages) || appConfig.pages.length !== 21 || workerSize <= 0) {
  if (result.stderr) process.stderr.write(result.stderr)
  throw new Error('支付宝编译产物不完整')
}

const workerSource = await readFile(workerPath, 'utf8')
const forbiddenRuntimePatterns = [
  [/\bwx\s*(?:\.|\[)/, '微信运行时调用'],
  [/typeof wx/, '微信运行时探测'],
  [/hideAlbum\s*:\s*(?:false|!1|0)\b/, '允许从相册重放桌码'],
  [/openCustomerServiceChat/, '支付宝端伪装企业微信原生客服'],
]
for (const [pattern, label] of forbiddenRuntimePatterns) {
  if (pattern.test(workerSource)) throw new Error(`支付宝编译产物仍包含${label}`)
}

const nonFatal = String(result.stderr || '').trim()
if (nonFatal && !/^EISDIR: illegal operation on a directory, open '/.test(nonFatal)) {
  process.stderr.write(result.stderr)
}
console.log(`Alipay official compiler passed (21 pages, worker ${workerSize} bytes, output ${output})`)
