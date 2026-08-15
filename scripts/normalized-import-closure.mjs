import { access, readFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'

const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs']

export async function scanImportClosure({ cwd, entries }) {
  const queue = entries.map((entry) => resolve(cwd, entry))
  const visited = new Set()
  const edges = []

  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || visited.has(file)) continue
    visited.add(file)
    const source = await readFile(file, 'utf8')
    for (const specifier of moduleSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue
      const target = await resolveSourceImport(dirname(file), specifier)
      if (target === null) continue
      edges.push({ from: projectPath(cwd, file), to: projectPath(cwd, target) })
      if (!visited.has(target)) queue.push(target)
    }
  }

  return {
    files: [...visited].map((file) => projectPath(cwd, file)).sort(),
    edges,
  }
}

function moduleSpecifiers(source) {
  const results = new Set()
  const staticImports = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g
  const dynamicImports = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const expression of [staticImports, dynamicImports]) {
    for (const match of source.matchAll(expression)) results.add(match[1])
  }
  return [...results]
}

async function resolveSourceImport(baseDirectory, specifier) {
  const target = resolve(baseDirectory, specifier)
  const candidates = extname(target) === ''
    ? [
        ...sourceExtensions.map((extension) => `${target}${extension}`),
        ...sourceExtensions.map((extension) => resolve(target, `index${extension}`)),
      ]
    : [target]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Continue through the supported source extensions.
    }
  }
  return null
}

function projectPath(cwd, file) {
  return relative(cwd, file).split('\\').join('/')
}
