import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const statePath = resolve(root, '.runtime/state.json')
const basisPath = resolve(root, 'config/menu-cost-basis-2026-07-27.json')
const checkOnly = process.argv.includes('--check')
const workbookFlagIndex = process.argv.indexOf('--workbook')
const workbookPath = workbookFlagIndex >= 0 ? resolve(process.argv[workbookFlagIndex + 1]) : null

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const state = await readJson(statePath)
const basis = await readJson(basisPath)
const productsById = new Map(state.products.map((product) => [product.id, product]))
const productsBySku = new Map(state.products.map((product) => [product.sku, product]))
const errors = []
const warnings = []
const changes = []

for (const [sku, entry] of Object.entries(basis.products)) {
  const product = productsBySku.get(sku)
  if (!product) {
    errors.push(`成本基线中的商品不存在: ${sku}`)
    continue
  }
  if (product.productKind === 'bundle') {
    errors.push(`组合商品不能直接录入成本，必须由组件汇总: ${sku}`)
    continue
  }
  if (!Number.isInteger(entry.costAmount) || entry.costAmount <= 0) {
    errors.push(`商品成本必须为正整数分: ${sku}`)
    continue
  }
  if (entry.costAmount > product.listPriceAmount) {
    errors.push(`商品成本高于售价: ${sku}`)
    continue
  }
  if (product.costAmount !== entry.costAmount) {
    changes.push({
      productId: product.id,
      sku,
      name: product.name,
      beforeCostAmount: product.costAmount,
      afterCostAmount: entry.costAmount,
      source: entry.source,
      note: entry.note,
    })
    product.costAmount = entry.costAmount
    product.configVersion += 1
  }
}

for (const product of state.products.filter((item) => item.productKind === 'bundle' && /^V2-/.test(item.sku))) {
  let total = 0
  for (const component of product.bundleComponents ?? []) {
    const child = productsById.get(component.productId)
    if (!child) {
      errors.push(`组合 ${product.sku} 引用了不存在的商品 ${component.productId}`)
      continue
    }
    if (!Number.isInteger(component.quantity) || component.quantity <= 0) {
      errors.push(`组合 ${product.sku} 的组件 ${child.sku} 数量无效`)
      continue
    }
    if (!Number.isInteger(child.costAmount) || child.costAmount <= 0) {
      errors.push(`组合 ${product.sku} 的组件 ${child.sku} 尚未补齐成本`)
      continue
    }
    total += child.costAmount * component.quantity
  }
  if (total > product.listPriceAmount) {
    errors.push(`组合成本高于售价: ${product.sku}`)
  }
  if (product.costAmount !== total) {
    changes.push({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      beforeCostAmount: product.costAmount,
      afterCostAmount: total,
      source: 'component_rollup',
      note: '按当前组合组件数量与组件成本自动汇总',
    })
    product.costAmount = total
    product.configVersion += 1
  }
}

const scopedProducts = state.products.filter((product) => (
  product.enabled &&
  /^(V2|V3)-/.test(product.sku) &&
  product.productKind !== 'bundle'
))
for (const product of scopedProducts) {
  if (!Number.isInteger(product.costAmount) || product.costAmount <= 0) {
    errors.push(`启用商品仍缺成本: ${product.sku}`)
  }
}

for (const product of state.products.filter((item) => item.enabled && /^(V2|V3)-/.test(item.sku))) {
  const rate = product.listPriceAmount > 0 ? product.costAmount / product.listPriceAmount : 0
  if (product.productKind === 'bundle' && rate > 0.35) {
    warnings.push(`${product.sku} 成本率 ${(rate * 100).toFixed(2)}%，超过35%控制线`)
  }
  if (product.sku === 'V2-CHAMPAGNE-PERRIER' && rate > 0.3) {
    warnings.push(`${product.sku} 当前售价毛利率 ${((1 - rate) * 100).toFixed(2)}%，低于工作簿70%目标`)
  }
}

if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors, warnings }, null, 2))
  process.exit(1)
}

const workbook = workbookPath
  ? {
      fileName: basename(workbookPath),
      sha256: createHash('sha256').update(await readFile(workbookPath)).digest('hex'),
    }
  : null

const report = {
  ok: true,
  mode: checkOnly ? 'check' : 'apply',
  basisVersion: basis.version,
  changedProductCount: changes.length,
  directCostProductCount: Object.keys(basis.products).length,
  rolledUpBundleCount: state.products.filter((item) => item.productKind === 'bundle' && /^V2-/.test(item.sku)).length,
  warnings,
  changes,
  workbook,
}

if (!checkOnly && changes.length > 0) {
  const now = new Date()
  const timestamp = now.toISOString().replaceAll(':', '-')
  const backupDirectory = resolve(root, '.runtime/backups')
  await mkdir(backupDirectory, { recursive: true })
  const backupPath = resolve(backupDirectory, `state-before-menu-cost-${timestamp}.json`)
  await writeFile(backupPath, `${JSON.stringify(await readJson(statePath), null, 2)}\n`)

  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: 'emp-owner',
    action: 'product.cost_basis_imported.v1',
    objectType: 'productCatalog',
    objectId: basis.version,
    occurredAt: now.toISOString(),
    details: {
      basisVersion: basis.version,
      workbook,
      changedProductCount: changes.length,
      changes,
      backupFile: basename(backupPath),
    },
  })
  state.revision += 1

  const temporaryPath = `${statePath}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`)
  await rename(temporaryPath, statePath)

  const reportDirectory = resolve(root, '.runtime/reports')
  await mkdir(reportDirectory, { recursive: true })
  const reportPath = resolve(reportDirectory, `menu-cost-reconciliation-${basis.version}.json`)
  await writeFile(reportPath, `${JSON.stringify({ ...report, backupPath }, null, 2)}\n`)
  report.backupPath = backupPath
  report.reportPath = reportPath
}

if (!checkOnly && changes.length === 0) {
  report.message = '当前数据已与成本基线一致'
}

console.log(JSON.stringify(report, null, 2))
