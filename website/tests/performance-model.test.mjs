import test from 'node:test';
import assert from 'node:assert/strict';
import {shanghaiDate,previousDate,normalize,phase} from '../public/performance-model.js';
const set={performerStageName:'薛斌',startsAt:'2026-10-13 23:45:00+08',endsAt:'2026-10-14 00:30:00+08',status:'scheduled'};
const payload=schedules=>({data:{timezone:'Asia/Shanghai',localDate:'2026-10-13',schedules}});
test('Shanghai date rolls over at 16:00 UTC, including year boundary',()=>{
 assert.equal(shanghaiDate(new Date('2026-10-13T15:59:59Z')),'2026-10-13');
 assert.equal(shanghaiDate(new Date('2026-10-13T16:00:00Z')),'2026-10-14');
 assert.equal(previousDate('2027-01-01'),'2026-12-31');
});
test('previous evening final set remains in scheduled window after midnight',()=>{
 const s=normalize(payload([set]),'2026-10-13').schedules[0];
 assert.equal(phase(s,Date.parse('2026-10-13T15:44:59Z')),'upcoming');
 assert.equal(phase(s,Date.parse('2026-10-13T16:12:00Z')),'window');
 assert.equal(phase(s,Date.parse('2026-10-13T16:30:00Z')),'ended');
 assert.equal(shanghaiDate(new Date(s.endsAt)),'2026-10-14');
});
test('empty and all-cancelled schedules are valid and never reuse cancelled sets',()=>{
 assert.equal(normalize(payload([]),'2026-10-13').schedules.length,0);
 assert.equal(normalize(payload([{...set,status:'cancelled'}]),'2026-10-13').schedules.length,0);
});
test('wrong date, malformed times and wrong timezone are rejected',()=>{
 assert.throws(()=>normalize(payload([set]),'2026-10-14'));
 assert.throws(()=>normalize(payload([{...set,endsAt:'bad'}]),'2026-10-13'));
 assert.throws(()=>normalize(payload([{...set,endsAt:set.startsAt}]),'2026-10-13'));
 assert.throws(()=>normalize({timezone:'UTC',localDate:'2026-10-13',schedules:[]},'2026-10-13'));
 assert.throws(()=>normalize(payload([{...set,performerStageName:''}]),'2026-10-13'));
});
