import {defaultCustodyPolicy,type CustodyPolicy} from './bottle-custody-policy.js'
import type {CustodyOrder} from './bottle-custody-repository.js'
function xml(value:unknown){return Array.from(String(value??'')).filter(char=>char.charCodeAt(0)>=32||[9,10,13].includes(char.charCodeAt(0))).join('').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;')}
function decimalText(value:string){return value.includes('.')?value.replace(/\.?0+$/,'')||'0':value}
const labels:Record<string,string>={stored:'在存',collected:'已取走',archived:'已归档',voided:'已作废'}
export function custodyPrintHtml(order:CustodyOrder,title:string,settings:Pick<CustodyPolicy,'printFields'|'printFooter'>=defaultCustodyPolicy){
 const optionalRows=[['品类',order.category_name],['酒名',order.item_name],['原存数量',`${decimalText(order.original_quantity)} ${order.unit}`],['当前剩余',`${decimalText(order.remaining_quantity)} ${order.unit}`],['到期时间',new Date(order.expires_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})],['存放位置',order.location],['状态',labels[order.status]??order.status],['原购凭证',order.source_reference]]
 const keys=['category','item','quantity','remaining','expiry','location','status','source'];const rows=[['存酒编号',order.public_id],['会员号',order.member_no],...optionalRows.filter((_r,i)=>settings.printFields.includes(keys[i]! as CustodyPolicy['printFields'][number]))]
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${xml(title)}</title><style>@page{size:80mm auto;margin:4mm}body{font:14px/1.6 sans-serif;max-width:72mm;margin:12px auto;color:#000}h1{font-size:20px;text-align:center}p{margin:6px 0;overflow-wrap:anywhere}button{padding:10px}@media print{button{display:none}}</style><h1>${xml(title)}</h1>${rows.map(([key,value])=>`<p><strong>${xml(key)}：</strong>${xml(value)}</p>`).join('')}<p>${xml(settings.printFooter)}</p><button onclick="window.print()">打印 / 另存为 PDF</button></html>`
}
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return(crc^0xffffffff)>>>0}
/** A bounded ZIP STORE writer for generated OOXML. All cell values are inline
 * strings, so customer text can never become an Excel formula. */
function zip(entries:Record<string,string>):Buffer{
 const blocks:Buffer[]=[],directory:Buffer[]=[];let offset=0
 for(const [name,text] of Object.entries(entries)){
  const path=Buffer.from(name),data=Buffer.from(text),checksum=crc32(data),header=Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(checksum,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(path.length,26)
  blocks.push(header,path,data)
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(checksum,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(path.length,28);central.writeUInt32LE(offset,42);directory.push(central,path);offset+=header.length+path.length+data.length
 }
 const cd=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16)
 return Buffer.concat([...blocks,cd,end])
}
export function custodyWorkbook(orders:CustodyOrder[]):Buffer{
 const rows:unknown[][]=[['存酒编号','会员号','品类','酒名','原存数量','当前剩余','单位','状态','存入时间（北京时间）','到期时间（北京时间）','位置','原购凭证','存酒登记价值（元，非收入）','扩展字段'],...orders.map(o=>[o.public_id,o.member_no,o.category_name,o.item_name,o.original_quantity,o.remaining_quantity,o.unit,labels[o.status]??o.status,new Date(o.stored_at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),new Date(o.expires_at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),o.location,o.source_reference,o.declared_value_minor==null?'未登记':(Number(o.declared_value_minor)/100).toFixed(2),JSON.stringify(o.extra_fields??{})])]
 return tabularWorkbook(rows,'存酒明细')
}
export function tabularWorkbook(rows:unknown[][],name:string):Buffer{
 const sheet=`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${rows[0]?.length??1}" width="22" customWidth="1"/></cols><sheetData>${rows.map((row,i)=>`<row r="${i+1}">${row.map((value,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" t="inlineStr"><is><t xml:space="preserve">${xml(value).replaceAll('&quot;','"').replaceAll('&apos;',"'")}</t></is></c>`).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${String.fromCharCode(64+(rows[0]?.length??1))}${rows.length}"/></worksheet>`
 return zip({
 '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
 '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
 'xl/workbook.xml':`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
 'xl/_rels/workbook.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
 'xl/styles.xml':'<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
 'xl/worksheets/sheet1.xml':sheet,
 })
}
