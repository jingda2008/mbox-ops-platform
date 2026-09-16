import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {readSheet as readXlsxFile} from 'read-excel-file/node'
import {custodyPrintHtml,custodyWorkbook} from './custody-document.js'
import type {CustodyOrder} from './bottle-custody-repository.js'
const order={id:'test',public_id:'20260916-123456-100001-1',member_no:'100001',category_name:'白兰地',item_name:'=HYPERLINK("https://invalid.example")',unit:'瓶',original_quantity:'2',remaining_quantity:'1',expires_at:'2026-10-06T08:00:00Z',stored_at:'2026-09-16T08:00:00Z',status:'stored',location:'<script>alert(1)</script>'} as unknown as CustodyOrder
it('produces an actual readable XLSX with literal customer text and preserves member numbers',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mbox-custody-xlsx-'));const path=join(directory,'export.xlsx');await writeFile(path,custodyWorkbook([order]));let rows;try{rows=await readXlsxFile(path)}finally{await rm(directory,{recursive:true,force:true})};expect(rows[0]![0]).toBe('存酒编号');expect(rows[1]![1]).toBe('100001');expect(rows[1]![3]).toBe(order.item_name);expect(rows[1]![12]).toBe('未登记')
})
it('escapes print content and distinguishes physical pickup from a printout',()=>{
 const html=custodyPrintHtml(order,'MBOX');expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');expect(html).toContain('不代替取走确认')
})
