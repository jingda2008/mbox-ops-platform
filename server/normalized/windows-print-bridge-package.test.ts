import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const directory = join(process.cwd(), 'deploy', 'windows-print-bridge')

describe('Windows print bridge package', () => {
  it('runs as an automatic system service without browser or employee credentials', async () => {
    const [bridge, service] = await Promise.all([
      readFile(join(directory, 'bridge.mjs'), 'utf8'),
      readFile(join(directory, 'MBoxPrintBridge.xml.template'), 'utf8'),
    ])
    expect(service).toContain('<startmode>Automatic</startmode>')
    expect(service).toContain('bridge.mjs&quot; run')
    expect(bridge).toContain("'/api/print-bridge/work/claim'")
    expect(bridge).toContain("'/api/print-bridge/heartbeat'")
    expect(bridge).not.toMatch(/employee|staff-session|document\.|window\.|puppeteer/i)
  })

  it('passes printer names as process arguments and fails closed on an ambiguous prior attempt', async () => {
    const bridge = await readFile(join(directory, 'bridge.mjs'), 'utf8')
    expect(bridge).toContain("execFileAsync('powershell.exe'")
    expect(bridge).not.toMatch(/\bexec\s*\(/)
    expect(bridge).toContain("state === 'ambiguous'")
    expect(bridge).toContain("'ambiguous_previous_attempt'")
    expect(bridge).toContain("'ambiguous_print_result'")
    expect(bridge).toContain('isDefinitelyNotSubmitted(error)')
    expect(bridge).toContain("journal.entries[businessKey] = { state: 'printing'")
    expect(bridge).toContain("journal.entries[businessKey] = { state: 'printed'")
  })

  it('requires HTTPS and supports source binary checksum verification during installation', async () => {
    const [bridge, installer] = await Promise.all([
      readFile(join(directory, 'bridge.mjs'), 'utf8'),
      readFile(join(directory, 'install.ps1'), 'utf8'),
    ])
    expect(bridge).toContain("url.protocol !== 'https:'")
    expect(installer).toContain('Get-FileHash')
    expect(installer).toContain('SHA256')
    expect(installer).not.toMatch(/Invoke-WebRequest|curl|Start-BitsTransfer/i)
  })
})
