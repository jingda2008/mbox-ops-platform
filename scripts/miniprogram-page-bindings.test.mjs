import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
const read = name => readFile(new URL('../miniprogram/' + name, import.meta.url), 'utf8')
const config = JSON.parse(await read('app.json'))
for (const page of config.pages) {
  test(`${page}: every static template event has a page handler and navigator route exists`, async () => {
    const source = ts.createSourceFile(page + '.js', await read(page + '.js'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const methods = new Set()
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'Page' && ts.isObjectLiteralExpression(node.arguments[0])) {
        for (const property of node.arguments[0].properties) if (property.name) methods.add(property.name.getText(source).replace(/['"]/g, ''))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    const template = await read(page + '.wxml')
    const handlers = [...template.matchAll(/\b(?:bind|catch):?[\w-]+\s*=\s*"([^"]+)"/g)].map(match => match[1]).filter(name => !name.includes('{{'))
    for (const handler of handlers) assert.ok(methods.has(handler), `${page}: missing ${handler}`)
    for (const match of template.matchAll(/<navigator\b[^>]*\burl="([^"{]+)"/g)) {
      assert.ok(config.pages.includes(match[1].split('?')[0].replace(/^\//, '')), `${page}: invalid ${match[1]}`)
    }
  })
}
