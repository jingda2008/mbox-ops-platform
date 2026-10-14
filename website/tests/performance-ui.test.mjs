import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as model from '../public/performance-model.js';
const source=readFileSync(new URL('../public/performance.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');
const snapshot=JSON.parse(readFileSync(new URL('../data/public-performance.json',import.meta.url)));
const messages={set:'Set {n}',nextDay:'next day',verified:'verified',snapshot:'dated reference',fresh:'fresh',failed:'failed',empty:'empty',loading:'loading',checked:'checked',reserve:'reserve',overnightNote:'prior evening',overnightFailed:'overnight unknown',ended:'ended',window:'window',upcoming:'upcoming'};
async function run(today,previous){
 const nodes=new Map();const el=()=>({textContent:'',className:'',dataset:{},children:[],hidden:false,disabled:false,append(...xs){this.children.push(...xs)},replaceChildren(){this.children=[]},setAttribute(){},addEventListener(){}});
 for(const id of ['live','performance-messages','performance-snapshot','schedule-date','schedule-list','schedule-status','schedule-label','schedule-checked','schedule-refresh','overnight-schedule','overnight-date','overnight-list','overnight-note'])nodes.set(id,el());
 nodes.get('performance-messages').textContent=JSON.stringify(messages);nodes.get('performance-snapshot').textContent=JSON.stringify(snapshot);
 const NativeDate=Date; class FixedDate extends NativeDate {constructor(...args){super(...(args.length?args:['2026-10-13T16:12:00Z']))}static now(){return NativeDate.parse('2026-10-13T16:12:00Z')}}
 const fixedModel={...model,shanghaiDate:(now=new FixedDate())=>model.shanghaiDate(now),phase:(s,now=FixedDate.now())=>model.phase(s,now)};
 const context={...fixedModel,Date:FixedDate,Intl,AbortSignal,setInterval(){},document:{getElementById:id=>nodes.get(id),createElement:el,documentElement:{lang:'en'},body:{dataset:{language:'en'}},addEventListener(){}},fetch:async url=>{const response=url.endsWith('2026-10-14')?today:previous;if(response instanceof Error)throw response;return {ok:true,json:async()=>response}}};
 vm.runInNewContext(source,context);await new Promise(resolve=>setImmediate(resolve));return nodes;
}
test('failed current-day lookup retains clearly dated reference and signals failure',async()=>{
 const n=await run(Error('offline'),Error('offline'));
 assert.equal(n.get('schedule-status').textContent,'failed');
 assert.equal(n.get('schedule-list').children.length,4);
 assert.match(n.get('schedule-date').textContent,/2026/);
 assert.equal(n.get('schedule-refresh').disabled,false);
 assert.equal(n.get('overnight-schedule').hidden,false);
 assert.equal(n.get('overnight-note').textContent,'overnight unknown');
});
test('empty current day clears rows; failed previous day stays explicitly unknown',async()=>{
 const n=await run({...snapshot,schedules:[]},Error('offline'));
 assert.equal(n.get('schedule-status').textContent,'empty');
 assert.equal(n.get('schedule-list').children.length,0);
 assert.equal(n.get('overnight-schedule').hidden,false);
});
test('cross-midnight previous-day set preserves its original number',async()=>{
 const raw={timezone:'Asia/Shanghai',localDate:'2026-10-13',schedules:[['张迪','20:30','21:15'],['包包','21:35','22:20'],['王旭靓','22:40','23:25'],['薛斌','23:45','00:30']].map(([performerStageName,start,end],i)=>({performerStageName,status:'scheduled',startsAt:'2026-10-13T'+start+':00+08:00',endsAt:(i===3?'2026-10-14':'2026-10-13')+'T'+end+':00+08:00'}))};
 const n=await run(snapshot,raw);
 assert.equal(n.get('overnight-list').children.length,1);
 assert.equal(n.get('overnight-list').children[0].children[0].textContent,'Set 4');
 assert.equal(n.get('overnight-list').children[0].children[1].textContent,'薛斌');
});
