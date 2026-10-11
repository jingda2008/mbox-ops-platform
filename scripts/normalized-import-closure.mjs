import { access, readFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import ts from 'typescript'

/** Resolve the runtime source graph using the same TS module rules as the build. */
export async function scanImportClosure({ cwd, entries, configFile }) {
  cwd = resolve(cwd)
  const config = configFile ?? ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.normalized-web.json')
  let options = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true }
  if (config) {
    const parsed = ts.readConfigFile(resolve(cwd, config), ts.sys.readFile)
    if (parsed.error) throw new Error(`Cannot read import configuration: ${config}`)
    options = ts.parseJsonConfigFileContent(parsed.config, ts.sys, dirname(resolve(cwd, config))).options
  }
  const queue = entries.map(entry => resolve(cwd, entry))
  const visited = new Set(), edges = []
  while (queue.length) {
    const file = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const imports = new Set()
    function walk(node) {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
        const clause = node.importClause
        const bindings = clause?.namedBindings
        const onlyTypes = !clause?.name && bindings && ts.isNamedImports(bindings)
          && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly)
        if (!onlyTypes && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text)
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const onlyTypes = node.exportClause && ts.isNamedExports(node.exportClause)
          && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly)
        if (!onlyTypes) imports.add(node.moduleSpecifier.text)
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || node.expression.getText(source) === 'require') && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text)
      ts.forEachChild(node, walk)
    }
    walk(source)
    for (const specifier of imports) {
      const local = specifier.startsWith('.')
      if (local && /\.(css|svg|png|jpe?g|webp|json|woff2?)(\?.*)?$/.test(specifier)) {
        await access(resolve(dirname(file), specifier.split('?')[0]))
        continue
      }
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule
      const alias = Object.keys(options.paths ?? {}).some(pattern => {
        const [prefix, suffix = ''] = pattern.split('*')
        return pattern.includes('*') ? specifier.startsWith(prefix) && specifier.endsWith(suffix) : specifier === pattern
      })
      if (!resolved) {
        if (local || alias) throw new Error(`Unresolved runtime import: ${projectPath(cwd, file)} -> ${specifier}`)
        continue // External package or Node builtin; not repository code.
      }
      if (resolved.isExternalLibraryImport || resolved.resolvedFileName.endsWith('.d.ts')) continue
      const target = resolve(resolved.resolvedFileName)
      if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(extname(target))) continue
      edges.push({ from: projectPath(cwd, file), to: projectPath(cwd, target) })
      if (!visited.has(target)) queue.push(target)
    }
  }
  return { files: [...visited].map(file => projectPath(cwd, file)).sort(), edges }
}
function projectPath(cwd, file) { return relative(cwd, file).split('\\').join('/') }
