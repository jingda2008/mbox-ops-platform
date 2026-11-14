// Isolated Windows service fixture. Binds loopback only; contains no production credentials.
import http from 'node:http'
import {readFile,appendFile} from 'node:fs/promises'
import {join} from 'node:path'
const directory=process.argv[2]
http.createServer(async(req,res)=>{
 let body='';for await(const c of req)body+=c
 const value=body?JSON.parse(body):{}
 await appendFile(join(directory,'requests.jsonl'),JSON.stringify({path:req.url,body:value,time:new Date().toISOString()})+'\n')
 let control={};try{control=JSON.parse(await readFile(join(directory,'control.json'),'utf8'))}catch{}
 if(req.url.endsWith('/heartbeat')&&control.rejectNewHeartbeat&&value.softwareVersion==='1.0.13'){res.writeHead(503);res.end('{}');return}
 res.setHeader('content-type','application/json')
 if(req.url.endsWith('/work/claim'))res.end(JSON.stringify({data:{jobs:[],commands:[]}}))
 else if(req.url.endsWith('/diagnostics'))res.end(JSON.stringify({data:{acceptedEventIds:(value.events||[]).map(e=>e.eventId)}}))
 else res.end(JSON.stringify({data:{}}))
}).listen(19130,'127.0.0.1')
