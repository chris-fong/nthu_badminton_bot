import test from 'node:test';
import assert from 'node:assert/strict';
import {validateConfig, chooseCourt, parseBookingBody, checkPayload, overlaps, addDays, taipeiStamp} from '../core.mjs';

const now=Date.parse('2026-09-27T00:00:00+08:00');
const config={playDate:'2026-10-01',start:'18:00',end:'20:00',runAt:'2026-09-27T00:01:00',mode:'live',repeat:'none',retrySeconds:15};
test('Taiwan midnight and four-day window are independent of host timezone',()=>{
  const c=validateConfig(config,now);assert.equal(c.target,Date.parse('2026-09-26T16:01:00Z'));
  assert.equal(taipeiStamp(now),'2026-09-27T00:00:00');assert.equal(addDays('2026-12-31',1),'2027-01-01');
  assert.throws(()=>validateConfig({...config,playDate:'2026-10-02'},now),/four days/);
});
test('Reject malformed dates, reversed intervals, past times, bad repeats and excessive retries',()=>{
  for(const changes of [{playDate:'2026-02-30'},{end:'17:00'},{start:'24:00'},{runAt:'2026-09-26T00:01'},{runAt:'2026-09-27T25:00'},{mode:'maybe'},{repeat:'hourly'},{repeat:'daily',count:13},{retrySeconds:121}])assert.throws(()=>validateConfig({...config,...changes},now));
});
test('Find same available court across two exact slots, excluding lower unavailable courts',()=>{
  const r=chooseCourt([{start:'18:00:00',end:'19:00:00',courts:['1','2','10']},{start:'19:00:00',end:'20:00:00',courts:['2','10']}],'18:00','20:00');
  assert.equal(r.court,'2');assert.equal(r.rows.length,2);
});
test('Refuse gaps, switching courts, partial slots and more than two slots',()=>{
  assert.equal(chooseCourt([{start:'18:00',end:'19:00',courts:['1']},{start:'19:00',end:'20:00',courts:['2']}],'18:00','20:00'),null);
  assert.equal(chooseCourt([{start:'18:00',end:'19:00',courts:['1']},{start:'20:00',end:'21:00',courts:['1']}],'18:00','21:00'),null);
  assert.equal(chooseCourt([{start:'18:00',end:'20:00',courts:['1']}],'18:30','20:00'),null);
  assert.equal(chooseCourt([18,19,20].map(h=>({start:`${h}:00`,end:`${h+1}:00`,courts:['1']})),'18:00','21:00'),null);
});
const selected={projectId:'alumni',court:'2',studentId:'student',rows:[{},{}],scheduleIds:['s1','s2']};
const payload={project_id:'alumni',details:[{schedule_id:'s1',booking_date:'2026-10-01',zone:'2'},{schedule_id:'s2',booking_date:'2026-10-01',zone:'2'}],people:[{identity_id:'student',quantity:8}]};
test('Parse real multipart payload and validate the intended booking',()=>{
  const body=Object.entries(payload).map(([key,value])=>`--boundary\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${typeof value==='string'?value:JSON.stringify(value)}\r\n`).join('')+'--boundary--\r\n';
  assert.equal(checkPayload(parseBookingBody(body,'multipart/form-data; boundary=boundary'),config,selected),true);
});
test('Mutation guard rejects changed venue, date, court, duplicated slots, identity or participant totals',()=>{
  for(const mutation of [p=>p.project_id='other',p=>p.details[0].zone='3',p=>p.details[0].booking_date='2026-10-02',p=>p.details[1].schedule_id='s1',p=>p.details[1].schedule_id='different-time',p=>p.people[0].quantity=9,p=>p.people[0].identity_id='adult',p=>p.people.push({identity_id:'adult',quantity:1})]){
    const p=structuredClone(payload);mutation(p);assert.throws(()=>checkPayload(p,config,selected));
  }
});
test('Duplicate protection detects partially overlapping intervals on any court',()=>{
  assert.equal(overlaps(config,{...config,start:'19:00',end:'21:00'}),true);
  assert.equal(overlaps(config,{...config,start:'20:00',end:'21:00'}),false);
  assert.equal(overlaps(config,{...config,playDate:'2026-10-02'}),false);
});
