import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

const validCode=/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const byText=(a,b)=>a.localeCompare(b,'en',{numeric:true})
function fail(message){throw Error(message)}
function sortedUnique(input,allowed,kind,source){
  if(!Array.isArray(input))fail(kind+'不是名单')
  const seen=new Set()
  return input.map(code=>{
    if(typeof code!=='string'||!validCode.test(code)||seen.has(code)||!allowed.has(code))fail(kind+'中桌号未能唯一核实：'+code)
    seen.add(code)
    return {code,...allowed.get(code),source}
  })
}
/** Derive an offline review candidate from a dated readback and explicit classes.
 * Never produces a production-import manifest or stable IDs. An unclassified row
 * rejects the whole result rather than silently disappearing.
 */
export function buildTicketTableRosterCandidate(profile,evidence){
  if(!profile.version||profile.version!==evidence.profileVersion||
    !evidence.sources?.liveView||!evidence.sources?.ownerConfirmation||!evidence.sources?.historicRetention)
    fail('须注明同一配置版本及只读、确认、历史来源')
  if(!Array.isArray(profile.tables)||!Array.isArray(profile.areas)||!Array.isArray(evidence.liveRows))
    fail('需要配置与完整营业桌台视图')
  const areaCodes=new Map(),usedAreaCodes=new Set()
  for(const {name,code} of profile.areas){
    if(!name||!code||areaCodes.has(name)||usedAreaCodes.has(code))fail('区域名称或编码不唯一：'+name)
    areaCodes.set(name,code);usedAreaCodes.add(code)
  }
  const live=new Map()
  for(const {code,areaLabel} of evidence.liveRows){
    const areaCode=areaCodes.get(areaLabel)
    if(typeof code!=='string'||!validCode.test(code)||live.has(code)||!areaCode)fail('桌台视图桌号或区域无效：'+code)
    live.set(code,{areaCode,areaLabel})
  }
  const baseCodes=new Set()
  for(const {code,areaCode} of profile.tables){
    if(baseCodes.has(code)||live.get(code)?.areaCode!==areaCode)fail('配置桌号不在同区现行视图：'+code)
    baseCodes.add(code)
  }
  const included=[
    ...sortedUnique([...baseCodes],live,'配置核对','配置与现行视图匹配'),
    ...sortedUnique(evidence.datedOperations,live,'营业操作核对','已核实有日期的营业操作'),
    ...sortedUnique(evidence.ownerConfirmed,live,'负责人确认','负责人确认在用'),
  ]
  const excluded=sortedUnique(evidence.historicRetained,live,'历史保留','历史保留证据；仅移出票务候选，不删桌台')
  const coverage=new Set()
  for(const {code} of [...included,...excluded]){
    if(coverage.has(code))fail('同一桌号不能同时归类：'+code)
    coverage.add(code)
  }
  if(coverage.size!==live.size)fail('视图有未归类桌台：'+[...live.keys()].filter(code=>!coverage.has(code)).join('、'))
  const byArea={}
  for(const {areaCode,areaLabel} of included){
    byArea[areaCode]??={label:areaLabel,count:0}
    byArea[areaCode].count++
  }
  const stableOrder=(a,b)=>byText(a.areaCode,b.areaCode)||byText(a.code,b.code)
  return {
    mode:'offline_review_candidate',productionReady:false,
    profileVersion:profile.version,sources:{...evidence.sources},
    liveCount:live.size,includedCount:included.length,excludedCount:excluded.length,byArea,
    tables:included.sort(stableOrder),excluded:excluded.sort(stableOrder),
    limits:['区域编码按配置的唯一同名区域映射，不是经读回的实时区域 ID。','未提供稳定桌台 ID、正式库存/状态或实时区域归属；不得直接导入或发布。','只影响票务候选范围，不停用、改名或删除任何营业桌台。'],
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const files=process.argv.slice(2)
  if(files.length!==2||files.some(x=>x.startsWith('-')))fail('Usage: node scripts/build-ticket-table-roster-candidate.mjs versioned-profile.json classified-live-readback.json')
  const [profile,evidence]=await Promise.all(files.map(async p=>JSON.parse(await readFile(p,'utf8'))))
  console.log(JSON.stringify(buildTicketTableRosterCandidate(profile,evidence),null,2))
}
