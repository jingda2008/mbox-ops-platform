import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { matchJob } from '../../../scripts/table-print-queue.mjs'
const now=Date.now()
const hash=name=>createHash('sha256').update(name).digest('hex')
const job={id:'f0000000-0000-4000-a000-000000000001',business_key:'print:test-route',copies:1,status:'printed',printed_at:new Date(now-30000).toISOString()}
const sample={checkedAt:new Date(now-3000).toISOString(),readable:true,printerStatus:'Normal',count:0,jobs:[],truncated:false}
test('refuses to infer that paper was printed from a missing, stale, incomplete or pre-submission snapshot',()=>{
  assert.equal(matchJob(job,null,now).state,'unknown')
  assert.equal(matchJob(job,{...sample,checkedAt:new Date(now-91000).toISOString()},now).state,'unknown')
  assert.equal(matchJob(job,{...sample,checkedAt:job.printed_at},now).state,'unknown')
  assert.equal(matchJob(job,{...sample,truncated:true},now).state,'unknown')
  assert.equal(matchJob(job,{...sample,count:1},now).state,'unknown')
  assert.equal(matchJob(job,{...sample,readable:false},now).state,'unknown')
  assert.equal(matchJob(job,sample,now).state,'not_in_windows_queue')
})
test('matches both generations, individual copies, paused and retained jobs',()=>{
  for(const [copies,document] of [[1,'MBOX-job-'+job.id],[2,'MBOX-job-'+job.id+'#2'],[1,'MBOX-'+job.business_key]]){
    const item={id:321,status:'Paused',submittedAt:job.printed_at,documentHash:hash(document)}
    const report={...sample,count:1,jobs:[item]}
    assert.equal(matchJob({...job,copies},report,now).state,'queue_reports_blocked')
    assert.equal(matchJob({...job,copies},{...report,jobs:[{...item,status:'Printing'}]},now).state,'in_windows_queue')
    assert.equal(matchJob({...job,copies},{...report,jobs:[{...item,status:'Printed, Retained'}]},now).state,'retained_after_spooling')
  }
})
