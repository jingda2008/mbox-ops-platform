import http from 'node:http';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import geoip from 'geoip-lite';
import {gateway} from './gateway.js';
import {createWebsiteContent} from './lib/mbox/website-content.js';
const base=resolve(fileURLToPath(new URL('./public/',import.meta.url)));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.xml':'application/xml; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.mp4':'video/mp4','.ico':'image/x-icon'};
export function createServer({origin='https://www.shmbox.com',send=fetch,lookup=geoip.lookup}={}) {
 const hostname=new URL(origin).host;
 const content=createWebsiteContent(send);
 return http.createServer(async(req,res)=>{
  const finish=(status,body='')=>{res.writeHead(status,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body)};
  try {
   if(req.headers.host!==hostname)return finish(421,'Unknown host');
   if(!req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))return finish(400);
   const url=new URL(req.url,origin);
   if(url.origin!==origin)return finish(400);
   if(url.pathname==='/healthz'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store','x-robots-tag':'noindex'});return res.end('{"service":"mbox-public-site","status":"ok"}')}
   const contentResponse=['GET','HEAD'].includes(req.method)?await content(new Request(url,{method:req.method,headers:req.headers}),true):null;
   if(contentResponse){
    res.writeHead(contentResponse.status,Object.fromEntries(contentResponse.headers));
    if(req.method==='HEAD'||!contentResponse.body)return res.end();
    Readable.fromWeb(contentResponse.body).on('error',()=>res.destroy()).pipe(res);return;
   }
   if(url.pathname.startsWith('/api/')){
    if(Number(req.headers['content-length'])>16384)return finish(413);
    const chunks=[];let bytes=0;
    for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return finish(413);chunks.push(chunk)}
    const body=Buffer.concat(chunks);
    const web=new Request(url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body}:{} )});
    // Caddy overwrites this dedicated header with the actual peer IP. No XFF trust.
    const ip=String(req.headers['x-mbox-client-ip']||req.socket.remoteAddress||'').replace(/^::ffff:/,'');
    web.cf={country:lookup(ip)?.country};
    const response=await gateway(web,send);
    if(!response)return finish(404);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if(req.method==='HEAD'||!response.body)return res.end();
    Readable.fromWeb(response.body).on('error',()=>res.destroy()).pipe(res);return;
   }
   if(!['GET','HEAD'].includes(req.method))return finish(405);
   let pathname;try{pathname=decodeURIComponent(url.pathname)}catch{return finish(400)}
   if(pathname.includes('\\')||pathname.split('/').some(part=>part.startsWith('.')))return finish(404);
   let path=resolve(base,'.'+pathname);if(!path.startsWith(base+sep)&&path!==base)return finish(404);
   let info;try{info=await stat(path)}catch{return finish(404,'Not found')}
   if(info.isDirectory()){
    if(!pathname.endsWith('/')){res.writeHead(308,{location:url.pathname+'/'+url.search});return res.end()}
    path=resolve(path,'index.html');try{info=await stat(path)}catch{return finish(404)}
   }
   if(!info.isFile())return finish(404);
   const etag='"'+info.size.toString(16)+'-'+Math.floor(info.mtimeMs).toString(16)+'"';
   const headers={'content-type':types[extname(path)]||'application/octet-stream','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','cache-control':pathname.startsWith('/assets/')?'public, max-age=86400':'public, max-age=0, must-revalidate','etag':etag,'accept-ranges':'bytes'};
   if(req.headers['if-none-match']===etag){res.writeHead(304,headers);return res.end()}
   let start=0,end=info.size-1,status=200;
   if(req.headers.range&&(!req.headers['if-range']||req.headers['if-range']===etag)){
    const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!m||(!m[1]&&!m[2])){res.writeHead(416,{'content-range':`bytes */${info.size}`});return res.end()}
    if(!m[1]){start=Math.max(0,info.size-Number(m[2]));}else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]))}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size){res.writeHead(416,{'content-range':`bytes */${info.size}`});return res.end()}
    status=206;headers['content-range']=`bytes ${start}-${end}/${info.size}`;
   }
   headers['content-length']=String(Math.max(0,end-start+1));res.writeHead(status,headers);
   if(req.method==='HEAD'||info.size===0)return res.end();
   createReadStream(path,{start,end}).on('error',()=>res.destroy()).pipe(res);
  }catch{if(!res.headersSent)finish(500,'Request failed');else res.destroy()}
 });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const server=createServer({origin:process.env.PUBLIC_ORIGIN||'https://www.shmbox.com'});
 server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=60;
 server.listen(Number(process.env.PORT||8080),process.env.BIND_ADDRESS||'0.0.0.0',()=>console.log('MBOX public site ready'));
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
