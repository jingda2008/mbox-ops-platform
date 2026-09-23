#!/usr/bin/env node
// Runs without database/provider credentials. Unacknowledged callbacks survive
// process death outside the application database; only the real API may ACK.
import {createServer, request as httpRequest} from 'node:http'
import {mkdirSync, openSync, closeSync, writeFileSync, readFileSync, readdirSync, renameSync, linkSync, unlinkSync, fsyncSync, existsSync, statSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto'
import {pathToFileURL} from 'node:url'

export function durableFile(path, value, exclusive = false) {
  const bytes = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`
  const next = `${path}.${randomUUID()}.next`
  let fd
  try { fd=openSync(next,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd) }
  finally { if (fd!==undefined) closeSync(fd) }
  if (exclusive) {
    // Never publish an empty/partial final receipt. A crash leaves an ignored
    // temporary file and no ACK; a retry can publish the original signed event.
    try { linkSync(next,path) }
    catch(error) { unlinkSync(next); if(error.code==='EEXIST') return false; throw error }
    unlinkSync(next)
  } else renameSync(next,path)
  const dir=openSync(resolve(path,'..'),'r');try{fsyncSync(dir)}finally{closeSync(dir)}
  return true
}

const callback = /^\/api\/(payments|refunds)\/providers\/(postar|wechat)\/callback$/
const hop = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'trailer', 'te'])
export function isNonFinancialRejection(result) {
  let body;try{body=JSON.parse(result.body)}catch{return false}
  const code=body?.error?.code??body?.code
  // These exact parser outcomes precede every provider/financial handler.
  // Keep original bytes and the rejection; never turn it into a provider ACK.
  const allowed={
    400:new Set(['REQUEST_JSON_INVALID','FST_ERR_CTP_INVALID_JSON_BODY','FST_ERR_CTP_EMPTY_JSON_BODY']),
    401:new Set(['PROVIDER_SIGNATURE_INVALID']),
    413:new Set(['FST_ERR_CTP_BODY_TOO_LARGE']),
    415:new Set(['FST_ERR_CTP_INVALID_MEDIA_TYPE']),
  }
  return allowed[result.status]?.has(code)??false
}
export function createMaintenanceIngress(directory) {
  mkdirSync(directory, {recursive:true, mode:0o700})
  mkdirSync(join(directory, 'callbacks'), {mode:0o700, recursive:true})
  const token = readFileSync(join(directory, 'control-token'), 'utf8').trim()
  if (token.length < 32) throw new Error('control token is missing')
  let target = null, active = 0, replaying = false
  const files = () => readdirSync(join(directory, 'callbacks')).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
  const read = name => JSON.parse(readFileSync(join(directory, 'callbacks', name), 'utf8'))
  const epoch = () => durableFile(join(directory, 'business-write-epoch.json'), {reason:'callback-observed', at:new Date().toISOString()}, true)
  const forward = envelope => new Promise((resolvePromise, reject) => {
    const headers = Object.fromEntries(Object.entries(envelope.headers).filter(([key]) => !hop.has(key.toLowerCase())))
    const body = Buffer.from(envelope.body, 'base64')
    const request = httpRequest(`${target}${envelope.path}`, {method:'POST', headers:{...headers, 'content-length':body.length}, timeout:15000}, response => {
      const chunks = []; let size = 0
      response.on('data', chunk => { size += chunk.length; if (size > 65536) { response.destroy(); reject(new Error('oversized API response')) } else chunks.push(chunk) })
      response.on('end', () => resolvePromise({status:response.statusCode, body:Buffer.concat(chunks).toString()}))
      response.on('error', reject)
    }); request.on('timeout', () => request.destroy(new Error('callback timeout'))); request.on('error', reject); request.end(body)
  })
  const apply = async (name, envelope) => {
    if (!target || envelope.status !== 'pending') return null
    const result = await forward(envelope)
    let ack = false; try { ack = result.status === 200 && JSON.parse(result.body).rspCod === '000000' } catch {}
    // A verified rejection is retained and is never turned into a provider ACK.
    const rejected=isNonFinancialRejection(result)
    if (ack || rejected) durableFile(join(directory, 'callbacks', name), {...envelope, status:ack?'acknowledged':'rejected', response:result, appliedAt:new Date().toISOString()})
    return result
  }
  const state = () => { const rows=files().map(read); return {status:'maintenance', reason:'planned_maintenance_upgrade', pending:rows.filter(x=>x.status==='pending').length, rejected:rows.filter(x=>x.status==='rejected').length, acknowledged:rows.filter(x=>x.status==='acknowledged').length, active, replaying, epoch:existsSync(join(directory,'business-write-epoch.json'))} }
  const server = createServer(async (req,res) => {
    const send = (code, body) => { res.writeHead(code, {'content-type':'application/json','cache-control':'no-store','retry-after':'10'}); res.end(typeof body==='string'?body:JSON.stringify(body)) }
    const path = req.url.split('?')[0]
    // Prove the exact public callback/ready route without transmitting the
    // control credential or requiring an additional public proxy path.
    if (req.method==='GET' && (callback.test(path) || path==='/api/ready')) {
      const challenge=new URL(req.url,'http://maintenance.invalid').searchParams.get('mboxMaintenanceChallenge')??''
      if (/^[a-f0-9]{64}$/.test(challenge)) return send(503,{status:'maintenance',reason:'planned_maintenance_upgrade',proof:createHmac('sha256',token).update(challenge).digest('hex')})
    }
    if (path.startsWith('/__maintenance/')) {
      const given=Buffer.from(String(req.headers['x-mbox-maintenance-token']??'')); const expected=Buffer.from(token)
      if (given.length!==expected.length || !timingSafeEqual(given,expected)) return send(404,{error:'not_found'})
      if (path==='/__maintenance/state' && req.method==='GET') return send(200,state())
      if (path==='/__maintenance/target' && req.method==='POST') {
        const address=String(req.headers['x-mbox-maintenance-target']??'')
        if (!/^http:\/\/\d{1,3}(?:\.\d{1,3}){3}:8787$/.test(address)) return send(400,{error:'invalid_target'})
        if (!existsSync(join(directory,'business-write-epoch.json'))) return send(409,{error:'epoch_required'})
        target=address; return send(200,state())
      }
      if (path==='/__maintenance/replay' && req.method==='POST') {
        if (!target || replaying) return send(409,{error:'replay_unavailable'})
        replaying=true
        try { for (const name of files()) await apply(name,read(name)); return send(200,state()) }
        catch { return send(503,{error:'callback_apply_failed',...state()}) }
        finally { replaying=false }
      }
      return send(404,{error:'not_found'})
    }
    if (req.method!=='POST' || !callback.test(path)) return send(503,{status:'maintenance',reason:'planned_maintenance_upgrade'})
    active++
    try {
      // Mark before reading the body: even an interrupted external notification
      // prevents a later operator from claiming that no external fact existed.
      epoch()
      let length=0; const chunks=[]
      for await (const chunk of req) { length+=chunk.length; if (length>2*1024*1024) return send(413,{error:'callback_too_large'}); chunks.push(chunk) }
      const body=Buffer.concat(chunks).toString('base64')
      const headers=Object.fromEntries(Object.entries(req.headers).filter(([key])=>!hop.has(key.toLowerCase())))
      const originalPath=req.url
      const id=createHash('sha256').update(JSON.stringify({path:originalPath,headers,body})).digest('hex'), name=`${id}.json`
      const file=join(directory,'callbacks',name)
      if (!existsSync(file)) {
        if (files().length>=20000) return send(503,{error:'callback_spool_capacity'})
        durableFile(file,{id,path:originalPath,headers,body,status:'pending',receivedAt:new Date().toISOString()},true)
      }
      const envelope=read(name)
      const result=envelope.response ?? await apply(name,envelope)
      return result ? send(result.status,result.body) : send(503,{status:'maintenance',reason:'callback_durably_pending'})
    } catch { return send(503,{error:'callback_not_acknowledged'}) }
    finally { active-- }
  })
  server.requestTimeout=30000; server.headersTimeout=10000
  return {server,state}
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  process.umask(0o077)
  const {server}=createMaintenanceIngress(resolve(process.argv[2])); server.listen(Number(process.argv[3]??8787),'0.0.0.0')
  process.on('SIGTERM',()=>server.close(()=>process.exit(0)))
}
