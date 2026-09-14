import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const directory = join(process.cwd(), 'deploy', 'windows-print-bridge')

describe('Windows print bridge package', () => {
  it('prints unit price, Chinese payment label and issued time without inventing prices', async () => {
    const source = await readFile(join(directory,'bridge.mjs'),'utf8')
    const render = vm.runInNewContext(`${source.slice(source.indexOf('function renderTicket(value)'),source.indexOf('async function authenticatedRequest'))}; renderTicket`, {
      requiredText:(value:string)=>value,positiveInteger:(value:number)=>value,
      divider:()=> '---',center:(value:string)=>value,formatCny:(value:number)=>`¥${(value/100).toFixed(2)}`,
    })
    const text = render({schemaVersion:1,title:'结账单',ticketReference:'order-test',businessDate:'2026-09-10',
      tableCode:'B05',guestCount:2,issuedAt:'2026-09-10T12:00:00Z',operatorLabel:'收银员',payment:{provider:'external_manual'},
      lines:[{name:'啤酒',quantity:4,unitAmountMinor:4000,totalAmountMinor:12000}]})
    expect(text).toContain('桌台：B05\r\n人数：2')
    expect(text).toContain('单价：¥40.00')
    expect(text).toContain('小计：¥120.00')
    expect(text).toContain('其他线下收款')
    expect(text).toContain('时间：')
    expect(text).toContain('经办：收银员')
    expect(text).not.toContain('测试支付')
  })
  it('changes only numbered table settlements and keeps the entire trace after amounts and reprint notes', async () => {
    const source=await readFile(join(directory,'bridge.mjs'),'utf8')
    const render=vm.runInNewContext(`${source.slice(source.indexOf('function renderTicket(value)'),source.indexOf('async function authenticatedRequest'))}; renderTicket`, {
      requiredText:(value:string)=>value,positiveInteger:(value:number)=>value,
      divider:()=> '---',center:(value:string)=>value,formatCny:(value:number)=>`¥${(value/100).toFixed(2)}`,
    })
    const ticket={schemaVersion:1,kind:'table_settlement',title:'整桌结账归档单',ticketReference:'session-original-full-trace',
      displayNumber:'20260914-213508-004271',businessDate:'2026-09-14',note:'补打：原票遗失',totalAmountMinor:100,
      lines:[{name:'啤酒',quantity:1,totalAmountMinor:100}]}
    const text=render(ticket)
    expect(text.split('\r\n')).toContain('单号：20260914-213508-004271')
    expect(text).toContain('原始追溯码：session-original-full-trace')
    expect(text.indexOf('原始追溯码：')).toBeGreaterThan(text.indexOf('备注：补打'))
    for(const kind of ['cashier_settlement','cashier_payment','cashier_refund','bar_production','kitchen_production','order_summary','delivery','daily_settlement','production_notice']) {
      const other=render({...ticket,kind})
      expect(other).toContain('单号：session-original-full-trace')
      expect(other).not.toContain('004271')
      expect(other).not.toContain('原始追溯码：')
    }
    expect(render({...ticket,displayNumber:undefined})).toContain('单号：session-original-full-trace')
  })
  it('retains venue RAW transport, GBK and cutting instead of Windows font rendering', async () => {
    const source = await readFile(join(directory, 'print-ticket.ps1'), 'utf8')
    expect(source).toContain('di.pDatatype = "RAW"')
    expect(source).toContain('GetEncoding(936)')
    expect(source).toContain('0x1D, 0x56, 0x01')
    expect(source).toContain('GetTextElementEnumerator')
    expect(source).not.toMatch(/DrawString|PrintDocument|MeasureString/)
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

  it('provides a one-click guarded upgrade without changing printer configuration', async () => {
    const [launcher, upgrade] = await Promise.all([
      readFile(join(directory, 'MBOX-OneClick-Upgrade.cmd'), 'utf8'),
      readFile(join(directory, 'upgrade.ps1'), 'utf8'),
    ])
    expect(launcher).toContain('upgrade.ps1')
    expect(upgrade).toContain('-Verb RunAs')
    expect(upgrade).toContain('-PassThru')
    expect(upgrade).toContain('exit $elevated.ExitCode')
    expect(upgrade).toContain("Document -like 'MBOX-*'")
    expect(upgrade).toContain("state -eq 'printing'")
    expect(upgrade).toContain('Global\\MBOX-PrintBridge-Upgrade')
    expect(upgrade).toContain("$files = @('bridge.mjs','print-ticket.ps1','list-printers.ps1')")
    expect(upgrade).not.toMatch(/Set-Printer|Remove-PrintJob|Add-Printer|printer_routes|pairing/i)
    expect(upgrade).not.toContain('SilentlyContinue')
  })
})
