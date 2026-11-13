import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const source=await readFile(new URL('../public/booking.js',import.meta.url),'utf8');
const html=await readFile(new URL('../public/en/reserve/index.html',import.meta.url),'utf8');
const m=JSON.parse(html.match(/id="booking-messages" type="application\/json">(.*?)<\/script>/s)[1]);
async function start({returning=false,pending=false,offline=false,legacy=false}={}){
 const elements=new Map();
 const element=()=>({textContent:'',hidden:false,dataset:{},classList:{toggle(){}},addEventListener(){},setAttribute(){},querySelectorAll(){return []}});
 for(const [,id] of html.matchAll(/id="([^"]+)"/g))elements.set(id,element());
 elements.get('booking-messages').textContent=JSON.stringify(m);
 const form=elements.get('booking-form');form.elements={namedItem:()=>({})};
 elements.get('booking-recovery').hidden=true;
 const note=elements.get('booking-recovery-note');elements.get('booking-recovery').querySelector=()=>note;
 if(legacy)elements.delete('booking-recovery-note');
 const map=new Map(),identity={provider:'anonymous',providerAssertion:'anon-'+randomUUID(),deviceFingerprint:'web-'+randomUUID()},scope=JSON.stringify(['https://www.shmbox.com','a'.repeat(64)]);
 if(returning)map.set('mbox.site.reservation.identity.v1',JSON.stringify(identity));
 if(pending)map.set('mbox.web.reservation.submission.v1:'+scope,JSON.stringify({version:1,scope,key:randomUUID(),createdAt:Date.now(),payload:{publicId:'reservation-'+randomUUID(),mode:'direct',customerName:'Fixture',contact:'fixture@example.invalid',arrivalAt:'2026-11-13T13:00:00Z',guestCount:2,reservationPolicyVersion:1}}));
 const calls=[];
 vm.runInNewContext(source,{document:{getElementById:id=>elements.get(id),querySelectorAll:()=>[],querySelector:()=>null,documentElement:{lang:'en'}},location:{origin:'https://www.shmbox.com'},localStorage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)},crypto:{randomUUID},Date,Intl,Headers,AbortController,setTimeout,clearTimeout,fetch:async(url,options)=>{calls.push({url,method:options.method});if(offline)throw Error('offline');return Response.json({data:{recoveryScope:'a'.repeat(64)}})}});
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 return {elements,note,calls,form};
}
test('first visit shows no recovery warning and makes no session or reservation write',async()=>{
 const {elements,note,calls,form}=await start();assert.equal(note.textContent,'');assert.equal(elements.get('booking-recovery').hidden,true);assert.equal(form.hidden,false);assert.deepEqual(calls,[]);
});
test('pending submission restores warning dynamically and blocks new submission without recreating an order',async()=>{
 for(const legacy of [false,true]){const {elements,note,calls,form}=await start({returning:true,pending:true,legacy});assert.equal(note.textContent,m.uncertain);assert.equal(elements.get('booking-recovery').hidden,false);assert.equal(form.hidden,true);assert.deepEqual(calls,[{url:'/api/public/reservation/session',method:'POST'}]);}
});
test('reconnection failure explains connection issue instead of claiming a prior submission exists',async()=>{
 const {elements,note,calls,form}=await start({returning:true,offline:true});assert.equal(note.textContent,m.connectionError);assert.equal(elements.get('booking-recovery').hidden,false);assert.equal(form.hidden,true);assert.equal(calls.length,1);
});
