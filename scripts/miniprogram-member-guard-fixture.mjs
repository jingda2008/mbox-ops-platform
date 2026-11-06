import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Legacy presentation fixtures keep a fixed identity, but execute the actual
// lifecycle/pagination guards. Cross-identity tests use the full page fixture.
export function memberGuardFixture() {
  const modules = {}
  for (const name of ['member-page-action', 'member-pagination']) {
    const module = { exports: {} }
    vm.runInNewContext(readFileSync(new URL('../miniprogram/utils/' + name + '.js', import.meta.url), 'utf8'), {
      module,
      require: path => {
        if (path === './recoverable-command') return { commandIdentityScope: () => 'fixture-member' }
        if (path === './table-request-scope') return { tableRequestScope: () => 'fixture-table' }
        if (path === './session') return { getTableSession: () => ({}) }
        throw new Error('Unexpected guard dependency ' + path)
      },
    })
    modules[name] = module.exports
  }
  return modules
}
