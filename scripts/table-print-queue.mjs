// Operations entry point. Run in the store's app container with a table code as argv[2].
// pg and the scoped DATABASE_URL are supplied by the deployed app. No writes.
import pg from 'pg'
import { pathToFileURL } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import { createHash, randomUUID } from 'node:crypto'

export function matchJob(job, sample, now) {
  if (!sample) return {state:'unknown', reason:'没有实时队列观测'}
  const age = now - Date.parse(sample.checkedAt)
  if (!Number.isFinite(age) || age < -10000 || age > 90000) return {state:'unknown',reason:'队列观测过期或时钟偏差'}
  if (!sample.readable) return {state:'unknown',reason:sample.error}
  const base = [`MBOX-job-${job.id}`, `MBOX-${job.business_key}`.slice(0,120)]
  const digests = new Set()
  const ambiguous = new Set()
  for (const name of base) {
    for (let copy=1;copy<=job.copies;copy++) {
      const title = job.copies===1 ? name : `${name}#${copy}`
      const hash = createHash('sha256').update(title).digest('hex')
      if(name===base[1] && job.business_key.length+5>120) ambiguous.add(hash)
      else digests.add(hash)
    }
  }
  const matched = sample.jobs.filter(item=>digests.has(item.documentHash))
  if (matched.length) {
    const faults=/paused|paperout|paperjam|blocked|offline|error|userintervention|dooropen|notavailable/i
    const completed=matched.every(j=>/printed|complete|retained/i.test(j.status))
    const blocked=matched.some(j=>faults.test(j.status))||faults.test(sample.printerStatus??'')
    const state=completed?'retained_after_spooling':blocked?'queue_reports_blocked':'in_windows_queue'
    return {state,jobs:matched.map(({id,status,submittedAt})=>({id,status,submittedAt})),printerStatus:sample.printerStatus}
  }
  if (sample.jobs.some(j=>ambiguous.has(j.documentHash))) return {state:'unknown',reason:'旧票名被截断，不能唯一确认'}
  if (job.status !== 'printed') return {state:'no_match',reason:'后台尚无 Windows 接收回执',backend:job.status}
  if (Date.parse(sample.checkedAt) < Date.parse(job.printed_at)+2000) return {state:'unknown',reason:'该次观测可能早于小票进队列'}
  if (sample.truncated || sample.count!==sample.jobs.length) return {state:'unknown',reason:'队列含无法完整识别的文档'}
  return {state:'not_in_windows_queue',reason:'当前队列未见本票，实体出纸未确认'}
}

// The HTTPS host is pinned so an operator's staff token cannot be sent to another host.
async function probeQueues(client, scope, devices, table, token) {
  const pending = new Map()
  const results = new Map()
  for (const device of devices) {
    const id = device.id
    const response = await fetch(`https://mbox.shmbox.com/api/hardware/devices/${id}/commands`, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(8000),
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':`queue-check-${randomUUID()}`},
      body:JSON.stringify({commandType:'ping',reason:`按桌核对打印队列 ${table}`}),
    })
    if (!response.ok) throw new Error(`请求打印队列检查失败 HTTP ${response.status}`)
    const {data}=await response.json()
    pending.set(data.id,id)
  }
  const deadline = Date.now()+45000
  while (pending.size && Date.now()<deadline) {
    // Use a new snapshot so committed command results become visible.
    await client.query('BEGIN READ ONLY')
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",scope)
    const {rows}=await client.query(`SELECT id,status,result_snapshot FROM mbox.hardware_commands
      WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])`,[...scope,[...pending.keys()]])
    await client.query('COMMIT')
    for(const row of rows){
      if(!['succeeded','failed','cancelled'].includes(row.status))continue
      results.set(pending.get(row.id),row.result_snapshot?.queueObservation)
      pending.delete(row.id)
    }
    if(pending.size)await wait(1200)
  }
  return results
}

async function main() {
const table = process.argv[2]?.trim()
if (!table || table.length > 120) throw new Error('请提供桌号，可选第二个参数为营业日 YYYY-MM-DD')
const day=process.argv[3] || null
if(day && !/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('营业日格式不正确')
const client = new pg.Client({connectionString:process.env.DATABASE_URL, options:'-c default_transaction_read_only=on -c statement_timeout=8000 -c timezone=Asia/Shanghai'})
await client.connect()
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const scope=[process.env.MBOX_TENANT_ID,process.env.MBOX_STORE_ID]
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",scope)
  const {rows:[meta]}=await client.query(`SELECT now() as now,coalesce($3::date,mbox.current_operating_business_date($1,$2))::text as day,
    to_regclass('mbox.print_queue_observations') IS NOT NULL as passive`,[...scope,day])
  const args=[...scope,table,meta.day]
  const orders=(await client.query(`SELECT o.public_id,o.created_at,o.status,o.payment_status,o.settlement_mode,o.fulfillment_state,
    (SELECT jsonb_agg(jsonb_build_object('station',k.station_code,'state',k.status)) FROM mbox.order_items i JOIN mbox.kds_tasks k ON k.order_item_id=i.id WHERE i.order_id=o.id) preparation,
    (SELECT jsonb_agg(jsonb_build_object('kind',p.ticket_kind,'state',p.status,'error',p.last_error_code,'jobs',p.job_count)) FROM mbox.print_source_jobs p WHERE p.aggregate_id=o.id) print_sources
    FROM mbox.orders o JOIN mbox.table_sessions s ON s.id=o.table_session_id JOIN mbox.tables t ON t.id=s.table_id
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND upper(t.code)=upper($3) AND o.business_date=$4 ORDER BY o.created_at`,args)).rows
  const jobs=(await client.query(`SELECT j.id,j.business_key,j.printer_device_id,j.print_bridge_id,j.copies,j.status,j.printed_at,j.created_at,j.attempts,j.last_error_code,
    j.station_code,j.reprint_of_job_id,j.print_snapshot->>'ticketReference' reference,j.print_snapshot->'lines' items,d.windows_queue_name,
    b.hostname,b.software_version,b.last_seen_at,b.status AS bridge_status
    FROM mbox.print_jobs j JOIN mbox.devices d ON d.id=j.printer_device_id LEFT JOIN mbox.print_bridges b ON b.id=j.print_bridge_id
    WHERE j.tenant_id=$1 AND j.store_id=$2 AND upper(j.print_snapshot->>'tableCode')=upper($3)
      AND j.print_snapshot->>'businessDate'=$4 AND j.station_code IN ('bar','kitchen') ORDER BY j.created_at`,args)).rows
  const devices=(await client.query(`SELECT d.id,d.print_bridge_id,d.windows_queue_name,b.hostname,b.status AS bridge_status,b.software_version,b.last_seen_at
    FROM mbox.devices d JOIN mbox.print_bridges b ON b.id=d.print_bridge_id
    WHERE d.tenant_id=$1 AND d.store_id=$2 AND d.status='active' AND d.device_type='printer'`,scope)).rows
  const observations = []
  for (const d of devices) {
    let sample
    if (meta.passive) {
      sample=(await client.query(`SELECT observation FROM mbox.print_queue_observations WHERE tenant_id=$1 AND store_id=$2
        AND bridge_id=$3 AND queue_name=$4`,[...scope,d.print_bridge_id,d.windows_queue_name])).rows[0]?.observation
    }
    // Also supports a live ping issued by the existing authorized hardware command API.
    const ping=(await client.query(`SELECT result_snapshot->'queueObservation' AS report FROM mbox.hardware_commands
      WHERE tenant_id=$1 AND store_id=$2 AND device_id=$3 AND command_type='ping' AND completed_at>now()-interval '2 minutes'
      AND result_snapshot->'queueObservation'->>'queue'=$4 ORDER BY completed_at DESC LIMIT 1`,
      [...scope,d.id,d.windows_queue_name])).rows[0]?.report
    if(ping && (!sample || Date.parse(ping.checkedAt)>Date.parse(sample.checkedAt))) sample=ping
    if(d.bridge_status!=='active')sample=undefined
    observations.push({device:d,sample})
  }
  await client.query('COMMIT')
  if (process.env.MBOX_QUEUE_PROBE === '1') {
    const token=process.env.MBOX_QUEUE_OPERATOR_TOKEN
    if(!token)throw new Error('主动查询需要当前有打印管理权限的员工登录凭据')
    const liveDevices=devices.filter(d=>d.bridge_status==='active' && d.windows_queue_name)
    const reports=await probeQueues(client,scope,liveDevices,table,token)
    for(const entry of observations) entry.sample=reports.get(entry.device.id)
    meta.now=new Date()
  }
  const tickets=jobs.map(job=>{
    const sample=observations.find(({device:d})=>d.id===job.printer_device_id && d.print_bridge_id===job.print_bridge_id)?.sample
    const {business_key,...ticket}=job
    return {...ticket,checkedAt:sample?.checkedAt??null,windows:matchJob(job,sample,meta.now.getTime()),physicalPaper:'unconfirmed'}
  })
  const queues=observations.map(({device,sample})=>{const {jobs,...status}=sample??{};return {...device,...status}})
  console.log(JSON.stringify({table,businessDay:meta.day,asOf:meta.now,queues,orders,tickets},null,2))
} finally {await client.end()}
}

if (process.argv[1]==='-' || (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url)) await main()
