import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root=process.cwd(),out=path.resolve(process.env.STAFF_AUDIT_OUT??'artifacts/staff-every-control-20260920')
const source=JSON.parse(fs.readFileSync(path.join(out,'source-inventory.json'),'utf8'))
const findings=JSON.parse(fs.readFileSync('docs/staff-every-control-findings-20260920.json','utf8')).findings
if(source.baseline!==execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())throw Error('Audit baseline changed')
const evidence='docs/quality/evidence/staff-every-control-20260920'
fs.mkdirSync(evidence,{recursive:true})
const csv=(file,headers,rows)=>fs.writeFileSync(file,'\ufeff'+[headers,...rows].map(row=>row.map(cell=>'"'+String(cell??'').replaceAll('"','""')+'"').join(',')).join('\n')+'\n')
const issuesFor=file=>findings.filter(issue=>issue.files.includes(file.replace('src/normalized-ui/',''))||issue.files.includes(path.basename(file)))
const binding=c=>c.tag==='summary'?'浏览器原生展开/收起':c.tag==='a'?`链接：${c.href}`:c.externalForm?`关联表单：${c.externalForm}`:c.formSubmit?`所属表单：${c.formSubmit}`:Object.keys(c.events).length?'已定义交互事件':c.disabled==='true'?'固定不可操作的状态展示':'需组件/父级上下文判断'
csv('docs/staff-every-control-register-20260920.csv',['编号','源文件','行','组件/函数','控件','显示文字或动态表达式','点击/输入事件','表单提交','外部表单','禁用条件','显示条件','静态处理路径','所属文件问题（不代表此控件已复现）','证据边界'],source.controls.map(c=>[c.id,c.file,c.line,c.owner,c.tag,c.label.slice(0,700),JSON.stringify(c.events),c.formSubmit,c.externalForm,c.disabled,c.conditions,binding(c),issuesFor(c.file).map(f=>f.id).join('、'),'定义与绑定已登记；业务结果按闭环表核对，不能将源码登记或同名按钮可见计为逐实例通过']))
csv('docs/staff-function-register-20260920.csv',['源文件','行','函数','直接识别的API调用','状态/反馈调用','所属文件问题','证据边界'],source.functions.map(f=>[f.file,f.line,f.name,f.calls.join('\n'),f.states.join('\n'),issuesFor(f.file).map(f=>f.id).join('、'),'命名函数索引；共享包装器、内联回调和派生状态仍须结合源文件及所属流程，API数组为空不等于没有写操作']))
csv('docs/staff-display-source-register-20260920.csv',['源文件','行','组件/函数','来源','文字或字面量','候选系统词','证据边界'],source.copy.map(c=>[c.file,c.line,c.owner,c.kind,c.text,c.terms.join('、'),'完整候选索引；表达式内字面量可能是接口参数，是否实际展示以文案决策表与浏览器证据为准']))
const decisions=JSON.parse(fs.readFileSync('docs/staff-every-control-copy-decisions-20260920.json','utf8'))
csv('docs/staff-copy-review-20260920.csv',['编号','源文件','行','原文/定位片段','建议表达或交互','处理方式','必须保留的含义/要求'],decisions.map(([file,needle,after,decision,note],index)=>{
  const filePath='src/normalized-ui/'+file,content=fs.readFileSync(filePath,'utf8'),at=content.indexOf(needle)
  if(at<0)throw Error(`Missing copy anchor: ${file}:${needle}`)
  return [`COPY-${String(index+1).padStart(2,'0')}`,filePath,content.slice(0,at).split('\n').length,needle,after,decision,note]
}))
const runs=['default-390','default-1280','optin-320']
const summaries=runs.map(run=>JSON.parse(fs.readFileSync(path.join(out,run,'summary.json'),'utf8')))
const pages=runs.flatMap(run=>JSON.parse(fs.readFileSync(path.join(out,run,'pages.json'),'utf8')).map(page=>({...page,run})))
for(const run of runs)fs.copyFileSync(path.join(out,run,'summary.json'),path.join(evidence,`${run}.json`))
const routeRows=source.routes.map(route=>{
  const visits=pages.filter(page=>page.route===route),states=visits.flatMap(page=>page.states),related=findings.filter(issue=>issue.routes.includes(route))
  return [route,visits[0]?.states[0]?.headings.join(' / ')||'工作台',new Set(visits.map(page=>page.employee)).size,visits.length,states.length,[...new Set(states.flatMap(state=>state.name.startsWith('section:')?[state.name.slice(8)]:[]))].join('、'),visits.flatMap(page=>page.errors).join('；'),visits.flatMap(page=>page.badResponses.map(error=>`${page.employee}:${error.path}=${error.status}`)).join('；'),states.filter(state=>state.overflow>1).map(state=>state.overflow).join('；'),related.map(issue=>issue.id).join('、'),'已检查页面入口、只读展开和可见表达；交易/审批/设备结果须分别验证']
})
csv('docs/staff-page-audit-20260920.csv',['路由','页面标题','账号数','访问次数','记录状态数','实际切换分区','脚本错误','接口错误','横向溢出像素','发现问题','覆盖边界'],routeRows)
csv('docs/staff-rendered-controls-20260920.csv',['运行','账号','页面','展开状态','控件','名称','禁用','宽','高','缺少可计算名称','证据边界'],pages.flatMap(page=>page.states.flatMap(state=>state.controls.map(c=>[page.run,page.employee,page.route,state.name,c.tag,c.name,c.disabled,c.width,c.height,c.missingName,'渲染实例；只读展开不代表写操作已验收，同名控件不自动绑定源代码行']))))
const confirmed=new Map()
for(const file of fs.readdirSync(path.join(out,'closure-probes')).filter(file=>file.endsWith('.json'))){
  const records=JSON.parse(fs.readFileSync(path.join(out,'closure-probes',file),'utf8'))
  if(Array.isArray(records))for(const record of records)if(record.id&&record.result==='confirmed')confirmed.set(record.id,record)
}
fs.writeFileSync(path.join(evidence,'closure-findings.json'),JSON.stringify([...confirmed.values()],null,2)+'\n')
fs.copyFileSync(path.join(out,'closure-probes/waste-ledger-readback.json'),path.join(evidence,'waste-ledger-readback.json'))
const summary={baseline:source.baseline,generatedAt:new Date().toISOString(),routes:source.routes.length,sourceFiles:source.sourceFiles.length,controlSourceFiles:new Set(source.controls.map(c=>c.file)).size,controls:source.controls.length,buttons:source.controls.filter(c=>c.tag==='button').length,forms:source.controls.filter(c=>c.tag==='form').length,functions:source.functions.length,copyCandidates:source.copy.length,terminologyCandidates:source.copy.filter(c=>c.terms.length).length,copyDecisions:decisions.length,findings:findings.length,priorities:Object.fromEntries(['P1','P2','P3'].map(priority=>[priority,findings.filter(f=>f.priority===priority).length])),readOnlyVisits:pages.length,readOnlyStates:pages.reduce((n,page)=>n+page.states.length,0),confirmedProbes:confirmed.size,runs:summaries.map(({run,visits,states,employeeCount,width})=>({run,visits,states,employeeCount,width})),coverageCaveat:'Source definitions and read-only rendered states are distinct from end-to-end acceptance. Unobserved runtime variants and physical/provider outcomes are not passed.'}
fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify(summary,null,2)+'\n')
const hashes=source.sourceFiles.map(file=>({file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}))
fs.writeFileSync(path.join(evidence,'source-manifest.json'),JSON.stringify({baseline:source.baseline,files:hashes},null,2)+'\n')
console.log(JSON.stringify(summary,null,2))
