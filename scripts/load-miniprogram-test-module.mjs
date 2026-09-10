import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// WeChat uses CommonJS; Alipay 2.x modules use named/default ESM exports.
export function loadMiniModule(url) {
  const module = { exports: {} }
  const source=readFileSync(url,'utf8').replace(/^export\s+default\s+/gm,'module.exports = ')
    .replace(/^export\s+\{\s*\n([\s\S]*?)^\}\s*$/gm,'module.exports = {\n$1\n}')
    .replace(/^export\s+\{([^\n}]*)\}\s*$/gm,'module.exports = {$1}')
  vm.runInNewContext(source, {
    module, exports: module.exports, Date,
    require: (path) => loadMiniModule(new URL(`${path}.js`, url)),
  }, { filename: url.pathname })
  return module.exports
}
