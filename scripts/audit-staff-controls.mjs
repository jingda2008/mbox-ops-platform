import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const out = path.resolve(process.env.STAFF_AUDIT_OUT ?? 'artifacts/staff-every-control-20260920')
fs.mkdirSync(out, { recursive: true })
const relative = file => path.relative(root, file).split(path.sep).join('/')
const clean = value => value.replace(/\s+/g, ' ').trim()
const files = new Map()
const edges = []
const queue = ['src/normalized-ui/NormalizedStaffApp.tsx', 'src/normalized-ui/ConfirmationDialog.tsx', 'src/components/MenuOrderingWorkspace.tsx'].map(file => path.resolve(file))
while (queue.length) {
  const file = queue.shift()
  if (files.has(file)) continue
  const source = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  files.set(file, sf)
  const imports = []
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  for (const specifier of imports.filter(value => value.startsWith('.'))) {
    const target = ts.resolveModuleName(specifier, file, { moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, allowJs: true }, ts.sys).resolvedModule?.resolvedFileName
    if (!target || !target.startsWith(path.join(root, 'src/')) || !/\.[cm]?[jt]sx?$/.test(target)) continue
    edges.push({ from: relative(file), to: relative(target) })
    if (!files.has(target)) queue.push(target)
  }
}

const controls = [], copy = [], functions = [], expressions = []
const suspicious = /幂等|快照|\bDTO\b|\bJSON\b|UUID|outbox|normalized|normalize|规范化|服务端|后端|客户端|数据库|schema|租户|tenant|聚合|字段|版本校验|revision|versionId|publicId|employeeId|customerId|[A-Z]+_[A-Z_]+|原子|回放|回执|事实|证据链|权限码|适配器|SDK|runtime|provider|boolean|nullable|minor|CNY|ISO|强类型|状态机|静默|门禁|基点|万分比|终态|[\u4e00-\u9fff]ID\b/g
function owner(node, sf) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text
    if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText(sf)
    if (ts.isMethodDeclaration(parent)) return parent.name.getText(sf)
  }
  return '(module)'
}
function attrValue(attribute, sf) {
  if (!attribute.initializer) return 'true'
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text
  if (ts.isJsxExpression(attribute.initializer)) return attribute.initializer.expression?.getText(sf) ?? ''
  return attribute.initializer.getText(sf)
}
function labelText(node, sf) {
  if (ts.isJsxText(node)) return clean(node.text)
  if (ts.isJsxExpression(node)) return node.expression ? `{${clean(node.expression.getText(sf))}}` : ''
  if (ts.isJsxElement(node)) return node.children.map(child => labelText(child, sf)).filter(Boolean).join(' ')
  if (ts.isJsxFragment(node)) return node.children.map(child => labelText(child, sf)).filter(Boolean).join(' ')
  return ''
}
function containingLabel(node, sf) {
  for (let parent=node.parent;parent&&!ts.isFunctionLike(parent);parent=parent.parent) {
    if(ts.isJsxElement(parent)&&parent.openingElement.tagName.getText(sf)==='label') return parent.children.filter(child=>ts.isJsxText(child)||ts.isJsxExpression(child)).map(child=>labelText(child,sf)).filter(Boolean).join(' ')
  }
  return ''
}
function conditions(node, sf) {
  const values = []
  for (let p = node.parent; p && !ts.isFunctionLike(p); p = p.parent) {
    if (ts.isConditionalExpression(p)) values.push(clean(p.condition.getText(sf)))
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) values.push(clean(p.left.getText(sf)).slice(0, 220))
  }
  return values.reverse().join(' && ')
}
function copyRow(text, node, sf, kind) {
  const value = clean(text)
  if (!value || value.length < 2) return
  const terms = [...new Set(value.match(suspicious) ?? [])]
  copy.push({ file: relative(sf.fileName), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, owner: owner(node, sf), kind, text: value, terms, review: terms.length ? '需上下文判断' : '已登记，需结合页面判断' })
}
for (const [file, sf] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const visit = node => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node
      const tag = opening.tagName.getText(sf)
      const attrs = Object.fromEntries(opening.attributes.properties.filter(ts.isJsxAttribute).map(a => [a.name.getText(sf), attrValue(a, sf)]))
      const events = Object.fromEntries(Object.entries(attrs).filter(([key]) => /^on(?:Click|Change|Submit|KeyDown|KeyUp|Input|Blur|Focus|Toggle)$/.test(key)))
      if (['button', 'a', 'summary', 'input', 'select', 'textarea', 'form'].includes(tag) || Object.keys(events).length) {
        let form = node.parent
        while (form && !(ts.isJsxElement(form) && form.openingElement.tagName.getText(sf) === 'form')) form = form.parent
        const formAttrs = form ? Object.fromEntries(form.openingElement.attributes.properties.filter(ts.isJsxAttribute).map(a => [a.name.getText(sf), attrValue(a, sf)])) : {}
        const externalForm = attrs.form && [...sf.text.matchAll(/<form\b[^>]*id="([^"]+)"/g)].some(match=>match[1]===attrs.form) ? attrs.form : ''
        controls.push({ id: `CTRL-${String(controls.length + 1).padStart(4, '0')}`, file: relative(file), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, owner: owner(node, sf), tag, label: attrs['aria-label'] || labelText(node, sf) || containingLabel(node,sf), title: attrs.title ?? '', type: attrs.type ?? '', events, formSubmit: formAttrs.onSubmit ?? '', externalForm, href: attrs.href ?? '', disabled: attrs.disabled ?? '', conditions: conditions(node, sf), staticRegistration: '已登记', dynamicEvidence: '待映射', closure: '不可仅凭静态登记判为闭环' })
      }
      for (const attribute of opening.attributes.properties.filter(ts.isJsxAttribute)) {
        const name = attribute.name.getText(sf)
        if (['aria-label', 'title', 'placeholder', 'label'].includes(name) && attribute.initializer && ts.isStringLiteral(attribute.initializer)) copyRow(attribute.initializer.text, node, sf, `attribute:${name}`)
      }
    }
    if (ts.isJsxText(node)) copyRow(node.text, node, sf, 'jsx-text')
    if (ts.isJsxExpression(node) && node.expression) {
      const direct = !ts.isJsxAttribute(node.parent)
      if (direct && !ts.isJsxElement(node.expression)) expressions.push({ file:relative(file),line:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,owner:owner(node,sf),expression:clean(node.expression.getText(sf)).slice(0,600) })
      if (direct || ['aria-label','title','placeholder','label'].includes(node.parent.name?.getText(sf) ?? '')) {
        const collect = child => {
          if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) copyRow(child.text, child, sf, 'jsx-expression-literal')
          if (ts.isTemplateExpression(child)) for (const part of [child.head,...child.templateSpans.map(span=>span.literal)]) copyRow(part.text,part,sf,'jsx-template-text')
          if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child)) ts.forEachChild(child,collect)
        }
        collect(node.expression)
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent
      if (ts.isPropertyAssignment(parent) && /^(label|title|description|message|hint|summary|placeholder|emptyText|help)$/.test(parent.name.getText(sf))) copyRow(node.text, node, sf, 'display-definition')
      if (ts.isCallExpression(parent) && /set(?:Notice|Message|Error)|showNotice|notify|displayError|alert|confirm/.test(parent.expression.getText(sf))) copyRow(node.text, node, sf, 'feedback')
    }
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) {
      let name = node.name?.getText(sf)
      if (!name && ts.isVariableDeclaration(node.parent)) name = node.parent.name.getText(sf)
      if (name) {
        const calls = [], writes = [], states = []
        const walk = child => {
          if (child !== node.body && ts.isFunctionLike(child)) return
          if (ts.isCallExpression(child)) {
            const call = child.expression.getText(sf)
            if (/\bapi\.|^(?:request|fetch|getData|postData)$/.test(call)) calls.push(clean(child.getText(sf)).slice(0, 650))
            if (/^set[A-Z]|showNotice|notify/.test(call)) states.push(clean(child.getText(sf)).slice(0, 650))
            if (/create|save|submit|approve|reject|publish|record|refund|collect|transfer|close|open|delete|cancel|fulfill|deliver|complete|confirm|retry|reprint|update|postEndpoint|putEndpoint|patchEndpoint/i.test(call) && /api\.|fetch|postData|request/.test(call)) writes.push(clean(child.getText(sf)).slice(0, 650))
          }
          ts.forEachChild(child, walk)
        }
        walk(node.body)
        if (calls.length || states.length) functions.push({ file: relative(file), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, name, calls, writes, states, body: node.body.getText(sf) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
const routeSource = fs.readFileSync('src/normalized-ui/normalized-staff-routes.ts', 'utf8')
const routes = ['/', ...new Set([...routeSource.matchAll(/path === '([^']+)'/g)].map(m => m[1]))]
const data = { baseline: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), generatedAt: new Date().toISOString(), routes, sourceFiles: [...files.keys()].map(relative), importEdges: edges, controls, copy, expressions, functions }
fs.writeFileSync(path.join(out, 'source-inventory.json'), JSON.stringify(data, null, 2) + '\n')
const csv = rows => rows.map(row => row.map(cell => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n'
fs.writeFileSync(path.join(out, 'controls.csv'), '\ufeff' + csv([['编号', '文件', '行', '组件或函数', '控件', '显示文字或表达式', '类型', '事件', '表单提交', '禁用条件', '显示条件', '动态证据', '闭环结论'], ...controls.map(c => [c.id, c.file, c.line, c.owner, c.tag, c.label, c.type, JSON.stringify(c.events), c.formSubmit, c.disabled, c.conditions, c.dynamicEvidence, c.closure])]))
fs.writeFileSync(path.join(out, 'copy.csv'), '\ufeff' + csv([['文件', '行', '组件或函数', '来源', '文案', '候选系统词', '判定'], ...copy.map(c => [c.file, c.line, c.owner, c.kind, c.text, c.terms.join('、'), c.review])]))
const summary = { routes: routes.length, importedSourceFiles: files.size, controlDefinitions: controls.length, byTag: Object.fromEntries([...new Set(controls.map(c => c.tag))].map(tag => [tag, controls.filter(c => c.tag === tag).length])), copyEntries: copy.length, terminologyCandidates: copy.filter(c => c.terms.length).length, functionsWithEffects: functions.length }
fs.writeFileSync(path.join(out, 'inventory-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
