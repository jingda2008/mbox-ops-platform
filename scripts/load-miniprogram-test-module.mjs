import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// WeChat .js modules are CommonJS even though the repository uses ESM.
export function loadMiniModule(url) {
  const module = { exports: {} }
  vm.runInNewContext(readFileSync(url, 'utf8'), {
    module, exports: module.exports, Date,
    require: (path) => loadMiniModule(new URL(`${path}.js`, url)),
  }, { filename: url.pathname })
  return module.exports
}
