import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chromium} from 'playwright';
import {createSubmissionGuard} from '../submission-guard.mjs';

let browser,server,origin,received=0;
before(async()=>{
  server=http.createServer((req,res)=>{
    if(req.method==='POST')received++;
    res.writeHead(200,{'Content-Type':'text/html'});res.end('<title>Local reservation fixture</title>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
const payload={project_id:'alumni',details:[{schedule_id:'s1',booking_date:'2026-10-01',zone:'2'}],people:[{identity_id:'student',quantity:8}]};
function liveJob(){return {config:{playDate:'2026-10-01',start:'18:00',end:'19:00',mode:'live'},selected:{projectId:'alumni',court:'2',studentId:'student',scheduleIds:['s1'],rows:[{}]},allowed:true,sent:false,cancelled:false};}
async function setup(initialJob){
  let job=initialJob,attempts=0;
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.route('**/api/personal/rentalRecord',createSubmissionGuard({origin,getJob:()=>job,hasAttempt:()=>false,recordAttempt:()=>attempts++,log:()=>{}}));
  const page=await context.newPage();await page.goto(origin);
  return {context,setJob:j=>job=j,attempts:()=>attempts,send:body=>page.evaluate(async body=>{
    try{return (await fetch('/api/personal/rentalRecord',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status;}catch{return 'blocked';}
  },body)};
}
test('Idle browser lets a normal manual submission reach the server',async()=>{
  const s=await setup(null),before=received;
  try {assert.equal(await s.send(payload),200);assert.equal(received-before,1);assert.equal(s.attempts(),0);}finally{await s.context.close();}
});
test('Completing a rehearsal releases the browser for manual submission',async()=>{
  const s=await setup({...liveJob(),config:{...liveJob().config,mode:'rehearsal'},allowed:false}),before=received;
  try {assert.equal(await s.send(payload),'blocked');assert.equal(received,before);s.setJob(null);assert.equal(await s.send(payload),200);assert.equal(received-before,1);}finally{await s.context.close();}
});
test('Automatic booking sends once and blocks a duplicate while the run is active',async()=>{
  const job=liveJob(),s=await setup(job),before=received;
  try {assert.equal(await s.send(payload),200);assert.equal(await s.send(payload),'blocked');assert.equal(received-before,1);assert.equal(s.attempts(),1);assert.equal(job.sent,true);}finally{await s.context.close();}
});
test('Cancelled run and mismatched automated payload cannot reach the server',async()=>{
  const job=liveJob(),s=await setup(job),before=received;
  try {job.cancelled=true;assert.equal(await s.send(payload),'blocked');job.cancelled=false;assert.equal(await s.send({...payload,project_id:'wrong-venue'}),'blocked');assert.equal(received,before);assert.equal(s.attempts(),0);}finally{await s.context.close();}
});
