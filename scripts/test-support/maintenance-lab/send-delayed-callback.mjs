import {readFileSync,writeFileSync} from 'node:fs';import {createHash,privateEncrypt,constants} from 'node:crypto';
const fields={AGET_ID:'LOCAL-LAB-ONLY',CUST_ID:'LOCAL-LAB-ONLY',THREE_ORDER_NO:'lab-original-payment',ORDER_NO:'LAB-ORIGINAL-PROVIDER-TX',TXAMT:'100',ORDER_STATUS:'1',ORDER_TIME:'20260921084900',PAY_CHANNEL:'2'};
const canonical=Object.entries(fields).filter(([key,value])=>key!=='sign'&&value!==null&&value!==undefined&&value!=='').sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join('&');
const digest=createHash('sha256').update(canonical).digest('hex');const sign=privateEncrypt({key:readFileSync('/opt/mbox/secrets/synthetic-provider.pem'),padding:constants.RSA_PKCS1_PADDING},Buffer.from(digest)).toString('base64');
const body=JSON.stringify({...fields,sign});writeFileSync('/root/lab-callback-body.json',body,{mode:0o600});
const path='/opt/mbox/maintenance/local-entry-20260921-a/journal.jsonl';
for(let count=0;count<300;count++){
 let rows=[];try{rows=readFileSync(path,'utf8').trim().split('\n').map(JSON.parse)}catch{}
 if(rows.some(x=>x.event==='writers-drained')){
  const results=[];for(let i=0;i<2;i++){const r=await fetch('https://payments.localhost/api/payments/providers/postar/callback',{method:'POST',headers:{'content-type':'application/json'},body});results.push({status:r.status,body:await r.text()})}
  writeFileSync('/root/lab-delayed-callback-result.json',JSON.stringify({localOnly:true,syntheticSignedNotification:true,originalPublicId:'lab-original-payment',duplicateDuringMaintenance:results},null,2));process.exit(0)
 }
 await new Promise(r=>setTimeout(r,500));
}
throw new Error('writers-drained was not reached; no callback sent');
