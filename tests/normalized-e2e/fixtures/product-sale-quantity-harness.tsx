import {createRoot} from 'react-dom/client'
import {ProductSaleQuantityEditor} from '../../../src/normalized-ui/ProductSaleQuantityEditor'
import {NormalizedApiClient} from '../../../src/normalized-api'
const rows:Record<string,{remaining:number|null;version:string;reserved:number}>={one:{remaining:null,version:'0',reserved:0},two:{remaining:3,version:'0',reserved:0}}
const calls:Array<{body:unknown;key?:string}>=[],receipts=new Map<string,unknown>()
let drop=false,failRead=false
const api={
 async getEndpoint(endpoint:string){if(failRead)throw new Error('网络未连接');return {data:{...rows[endpoint.split('/').at(-2)!]}}},
 async postEndpoint(endpoint:string,body:{remaining:number|null;expectedVersion:string},options:{idempotencyKey:string}){
  calls.push({body,key:options.idempotencyKey})
  if(receipts.has(options.idempotencyKey))return receipts.get(options.idempotencyKey)
  const row=rows[endpoint.split('/').at(-2)!]!
  if(body.expectedVersion!==row.version)throw Object.assign(new Error('可售数量已变化，本次未保存'),{status:409})
  row.remaining=body.remaining;row.version=String(Number(row.version)+1)
  receipts.set(options.idempotencyKey,{...row})
  if(drop){drop=false;throw new Error('网络断开，结果尚未确认')}
  return {...row}
 },
} as unknown as NormalizedApiClient
const root=createRoot(document.getElementById('root')!)
function render(id='one'){root.render(<ProductSaleQuantityEditor key={id} api={api} productId={id} onSaved={async()=>{}}/>)}
Object.assign(window,{quantityHarness:{rows,calls,render,set:(state:{drop?:boolean;failRead?:boolean})=>{drop=state.drop??false;failRead=state.failRead??false}}})
render()
