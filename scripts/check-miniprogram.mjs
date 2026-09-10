import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('../miniprogram/', import.meta.url))
const files = []

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else files.push(path)
  }
}

await walk(root)

const app = JSON.parse(await readFile(join(root, 'app.json'), 'utf8'))
if (!Array.isArray(app.pages) || new Set(app.pages).size !== app.pages.length) {
  throw new Error('小程序页面路由不能为空或重复')
}
for (const page of app.pages) {
  for (const extension of ['.js', '.wxml', '.wxss']) {
    if (!files.includes(join(root, page + extension))) throw new Error(`小程序页面缺失: ${page}${extension}`)
  }
}

for (const file of files) {
  const extension = extname(file)
  const source = await readFile(file, 'utf8')
  if (extension === '.json') JSON.parse(source)
  if (extension === '.js') new vm.Script(source, { filename: relative(root, file) })
  if (/appsecret\s*[:=]/i.test(source)) throw new Error(`小程序包禁止出现AppSecret配置: ${relative(root, file)}`)
  if (extension === '.js' && source.includes('/api/bootstrap')) {
    throw new Error(`顾客端禁止访问全店bootstrap: ${relative(root, file)}`)
  }
}

console.log(`mini-program static verification passed (${files.length} files)`)
