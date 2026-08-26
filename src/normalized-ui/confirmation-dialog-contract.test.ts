import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../../', import.meta.url)
const sourceRoot = new URL('src/', root)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('centered confirmation dialog contract', () => {
  it('replaces browser-native confirmations and input prompts across the web client', () => {
    const sources = sourceFiles(sourceRoot.pathname).map((path) => readFileSync(path, 'utf8')).join('\n')
    expect(sources).not.toMatch(/window\.(?:alert|confirm|prompt)\s*\(/)
    expect(read('src/main.tsx')).toContain('<ConfirmationDialogProvider>')
    expect(read('src/legacy-e2e-main.tsx')).toContain('<ConfirmationDialogProvider>')
  })

  it('keeps confirmation and input actions in a fixed centered dialog with reachable controls', () => {
    const dialog = read('src/normalized-ui/ConfirmationDialog.tsx')
    const css = read('src/normalized-ui/confirmation-dialog.css')
    expect(dialog).toContain('confirmAction: (request: ConfirmationRequest) => Promise<boolean>')
    expect(dialog).toContain('promptAction: (request: InputPromptRequest) => Promise<string | null>')
    expect(dialog).toContain('role="alertdialog"')
    expect(dialog).toContain('role="dialog"')
    expect(css).toMatch(/\.normalized-confirmation-mask\s*\{[^}]*position:\s*fixed[^}]*place-items:\s*center/s)
    expect(css).toMatch(/\.normalized-confirmation-dialog button\s*\{[^}]*min-height:\s*44px/s)
    expect(css).toContain('.normalized-confirmation-dialog footer')
  })
})
