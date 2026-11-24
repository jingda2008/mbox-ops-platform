export type DeskPromise = { id:string; start:number; end:number; quantity:number; tableIds:readonly string[]|null; assignedIds:readonly string[] }
export type DeskBlock = { tableId:string; start:number; end:number; promiseId?:string }
export type ScopedDeskPlan = { feasible:true; assignments:Record<string,readonly string[]> } | { feasible:false; reason:'invalid'|'capacity'|'indeterminate' }
const validRange=(x:{start:number;end:number})=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.start<x.end
const overlaps=(x:{start:number;end:number},y:{start:number;end:number})=>x.start<y.end&&y.start<x.end
const unique=(x:readonly string[])=>x.every(s=>s.length>0)&&new Set(x).size===x.length
/** Pure feasibility check. Not authoritative without a scoped read under the database reservation lock. */
export function planScopedDeskPromises(desks:readonly string[],promises:readonly DeskPromise[],blocks:readonly DeskBlock[],maxNodes=20_000):ScopedDeskPlan {
  if(!Number.isSafeInteger(maxNodes)||maxNodes<0||maxNodes>250_000||!unique(desks)||!unique(promises.map(p=>p.id))||promises.some(p=>!validRange(p)||!Number.isSafeInteger(p.quantity)||p.quantity<1||!unique(p.assignedIds)||p.assignedIds.length>p.quantity||(p.tableIds!==null&&!unique(p.tableIds)))||blocks.some(b=>!b.tableId||!validRange(b))) return {feasible:false,reason:'invalid'}
  if(promises.some(p=>p.quantity>desks.length))return {feasible:false,reason:'capacity'}
  const sorted=[...promises].sort((a,b)=>a.start-b.start||a.end-b.end||a.id.localeCompare(b.id))
  const groups:DeskPromise[][]=[]
  let horizon=-Infinity
  for(const p of sorted){
    if(p.start>=horizon){groups.push([]);horizon=-Infinity}
    groups.at(-1)!.push(p);horizon=Math.max(horizon,p.end)
  }
  const assignments=new Map<string,string[]>()
  const inventory=[...desks].sort()
  let explored=0
  for(const group of groups){
    const occupied=new Map<string,DeskPromise[]>()
    const states=group.map(p=>{
      const allow=p.tableIds===null?null:new Set(p.tableIds)
      const blocked=new Set(blocks.filter(b=>overlaps(b,p)&&(b.promiseId!==p.id||!p.assignedIds.includes(b.tableId))).map(b=>b.tableId))
      return {p,choices:inventory.filter(id=>(allow===null||allow.has(id))&&!blocked.has(id)),allocated:[...p.assignedIds]}
    })
    const free=(id:string,p:DeskPromise)=>!(occupied.get(id)??[]).some(other=>overlaps(other,p))
    const occupy=(id:string,p:DeskPromise)=>{const active=occupied.get(id)??[];active.push(p);occupied.set(id,active)}
    for(const s of states){
      for(const id of s.p.assignedIds){if(!s.choices.includes(id)||!free(id,s.p))return {feasible:false,reason:'capacity'};occupy(id,s.p)}
      assignments.set(s.p.id,s.allocated)
    }
    // Bound recursion depth before doing potentially exponential interval list-coloring.
    if(states.reduce((n,s)=>n+s.p.quantity-s.allocated.length,0)>700)return {feasible:false,reason:'indeterminate'}
    function solve(): 'yes'|'no'|'limit' {
      let best:{state:typeof states[number];choices:string[];slack:number}|undefined
      for(const state of states){
        const remaining=state.p.quantity-state.allocated.length
        if(!remaining)continue
        const choices=state.choices.filter(id=>free(id,state.p))
        const slack=choices.length-remaining
        if(slack<0)return 'no'
        if(!best||slack<best.slack||(slack===best.slack&&choices.length<best.choices.length))best={state,choices,slack}
      }
      if(!best)return 'yes'
      if(explored>=maxNodes)return 'limit'
      explored++
      for(const id of best.choices){
        best.state.allocated.push(id);occupy(id,best.state.p)
        const result=solve()
        if(result==='yes')return result
        occupied.get(id)!.pop();best.state.allocated.pop()
        if(result==='limit')return result
      }
      return 'no'
    }
    const result=solve()
    if(result!=='yes')return {feasible:false,reason:result==='limit'?'indeterminate':'capacity'}
  }
  return {feasible:true,assignments:Object.fromEntries(assignments)}
}
