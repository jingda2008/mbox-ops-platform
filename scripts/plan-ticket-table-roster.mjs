import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

const tableCode=/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const uuid=/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
const scopeFields=['tenantId','storeId']
const order=(a,b)=>a<b?-1:a>b?1:0
function checkScope(row) {
  return row && scopeFields.every(field=>typeof row[field]==='string' && uuid.test(row[field]))
}
function fail(message) { throw new Error(message) }
function uniqueRows(rows,key,name){
  const result=new Map()
  for(const row of rows){
    if(result.has(row[key]))fail(`${name}重复：${row[key]}`)
    result.set(row[key],row)
  }
  return result
}
/**
 * Compares a signed-off operating list with a matching scoped table-master
 * snapshot, not the historical set of everything marked available. Returns a
 * review-only ticket whitelist diff. This never updates or deletes store tables.
 */
export function planTicketTableRoster({manifest,snapshot}){
  if(!checkScope(manifest)||!checkScope(snapshot)||scopeFields.some(k=>manifest[k]!==snapshot[k]))
    fail('名单与桌台快照必须来自同一门店作用域')
  if(manifest.complete!==true || typeof manifest.source!=='string' || !manifest.source.trim()
    || !/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(manifest.confirmedAt??'')
    || !Number.isFinite(Date.parse(manifest.confirmedAt)))
    fail('必须使用已确认的完整营业桌台名单并注明来源和时间')
  if(!Array.isArray(manifest.tables)||!manifest.tables.length||manifest.tables.length>2000
    || !Array.isArray(snapshot.tables)||!Array.isArray(snapshot.existingTicketTableIds))
    fail('营业桌台名单、现行档案或已有票务名单无效')
  for(const row of manifest.tables){
    if(typeof row?.code!=='string'||!tableCode.test(row.code)||typeof row.areaCode!=='string'||!row.areaCode.trim())
      fail('每桌须有准确的桌号和区域编码')
  }
  for(const row of snapshot.tables){
    if(typeof row?.id!=='string'||!uuid.test(row.id)||typeof row.code!=='string'||!tableCode.test(row.code)
      || typeof row.areaCode!=='string'||!['available','paused','retired'].includes(row.status)
      || !['active','paused','retired'].includes(row.areaStatus))
      fail('桌台档案快照不完整')
  }
  const byCode=uniqueRows(snapshot.tables,'code','桌台档案'), byId=uniqueRows(snapshot.tables,'id','桌台身份')
  const expected=uniqueRows(manifest.tables,'code','营业名单')
  const existingIds=new Set(snapshot.existingTicketTableIds)
  if(existingIds.size!==snapshot.existingTicketTableIds.length||[...existingIds].some(id=>!byId.has(id)))
    fail('已有票务桌台与同门店快照不一致')
  const matched=[]
  const blocked=[]
  for(const row of expected.values()){
    const table=byCode.get(row.code)
    if(!table)blocked.push({code:row.code,areaCode:row.areaCode,reason:'not_in_store_master'})
    else if(table.areaCode!==row.areaCode)blocked.push({code:row.code,areaCode:row.areaCode,reason:'area_mismatch'})
    else if(table.status!=='available'||table.areaStatus!=='active')
      blocked.push({code:row.code,areaCode:row.areaCode,reason:'not_operational_in_master'})
    else matched.push({tableId:table.id,code:table.code,areaCode:table.areaCode})
  }
  matched.sort((a,b)=>order(a.areaCode,b.areaCode)||order(a.code,b.code))
  const desired=new Set(matched.map(row=>row.tableId))
  const membershipDiff=blocked.length?null:{
    add:matched.filter(row=>!existingIds.has(row.tableId)),
    keep:matched.filter(row=>existingIds.has(row.tableId)),
    remove:[...existingIds].filter(id=>!desired.has(id)).map(id=>{
      const {code,areaCode}=byId.get(id)
      return {tableId:id,code,areaCode}
    }).sort((a,b)=>order(a.areaCode,b.areaCode)||order(a.code,b.code)),
  }
  return {
    mode:'review_only',source:manifest.source.trim(),confirmedAt:manifest.confirmedAt,
    scope:{tenantId:manifest.tenantId,storeId:manifest.storeId},
    blocked,ticketWhitelist:blocked.length?null:matched,membershipDiff,
    // No judgment is made about whether any unlisted available table is
    // occupied, historic, or an omission. It is only excluded from this plan.
    notSelectedAvailable:snapshot.tables.filter(row=>row.status==='available'&&!expected.has(row.code))
      .map(({code,areaCode})=>({code,areaCode})).sort((a,b)=>order(a.areaCode,b.areaCode)||order(a.code,b.code)),
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const argv=process.argv.slice(2)
  if(argv.length!==2||argv.some(x=>x.startsWith('-')))fail('Usage: node scripts/plan-ticket-table-roster.mjs confirmed-roster.json scoped-master-snapshot.json')
  const [manifest,snapshot]=await Promise.all(argv.map(async file=>JSON.parse(await readFile(file,'utf8'))))
  const plan=planTicketTableRoster({manifest,snapshot})
  console.log(JSON.stringify(plan,null,2))
  if(plan.blocked.length) process.exitCode=2
}
