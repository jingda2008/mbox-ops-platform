import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const directory = join(process.cwd(), 'deploy', 'windows-print-bridge')

describe('Windows print bridge package', () => {
  it('measures remaining text and paginates long tickets instead of truncating them', async () => {
    const source = await readFile(join(directory, 'print-ticket.ps1'), 'utf8')
    expect(source).toContain('MeasureString($pageState.Remaining')
    expect(source).toContain('[ref]$charactersOnPage')
    expect(source).toContain('Remaining.Substring($charactersOnPage)')
    expect(source).toContain('$eventArgs.HasMorePages = $pageState.Remaining.Length -gt 0')
    expect(source).toContain("throw 'invalid_print_page_bounds'")
    expect(source).not.toContain('$eventArgs.HasMorePages = $false')
  })
  it('classifies process failures without exposing command arguments and inspects untruncated diagnostics',async()=>{
    const source=await readFile(join(directory,'bridge.mjs'),'utf8')
    const start=source.indexOf('function normalizeFailure(error)'),end=source.indexOf('\nfunction isDefinitelyNotSubmitted',start)
    const normalize=vm.runInNewContext(`${source.slice(start,end)}; normalizeFailure`,{safeError:(e:Error)=>e.message})
    expect(normalize({message:'Command failed: '+ 'private-path '.repeat(50),stderr:'invalid_printer_queue'})).toBe('printer_queue_not_found')
    expect(normalize({message:'Command failed: private credentials',killed:true})).toBe('bridge_print_timeout')
    expect(normalize({message:'secret=do-not-log',code:'ENOENT'})).toBe('powershell_not_found')
    expect(normalize({message:'unclassified private details'})).toBe('bridge_print_failed')
    expect(source).toContain("'/api/print-bridge/work/claim', { limit: 1 }")
  })
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
