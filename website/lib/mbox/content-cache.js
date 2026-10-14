export function createReader(url,validate,ttl,send=fetch,now=Date.now){
 let value=null,until=0,pending=null;
 return async()=>{
  if(now()<until){if(!value)throw Error('Content unavailable');return value;}
  if(!pending)pending=Promise.resolve().then(async()=>{try{const r=await send(url,{headers:{accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(6000)});if(!r.ok)throw Error('Content unavailable');const next=validate(await r.json());value=next;until=now()+ttl;return next;}catch(error){value=null;until=now()+15000;throw error;}}).finally(()=>{pending=null});
  return pending;
 };
}
