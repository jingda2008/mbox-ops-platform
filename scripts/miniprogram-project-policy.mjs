// This release pipeline inventories the directory passed to the official CLI.
// Project redirection and selective packaging would invalidate that inventory.
export function miniProgramProjectFailures(project) {
  const failures = []
  if (!['.', './'].includes(project.miniprogramRoot)) failures.push('候选工程根目录必须是已核验包目录')
  if (project.compileType !== 'miniprogram') failures.push('候选工程编译类型必须是miniprogram')
  const packing = project.packOptions
  if (packing !== undefined) {
    if (!packing || typeof packing !== 'object' || Array.isArray(packing)) failures.push('候选工程打包规则无效')
    else for (const name of ['ignore', 'include']) {
      if (packing[name] !== undefined && (!Array.isArray(packing[name]) || packing[name].length !== 0)) {
        failures.push('候选工程打包规则不得增删已核验文件')
      }
    }
  }
  return failures
}
