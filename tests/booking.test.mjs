import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ORIGIN, BOOK_PATH, parseBookingBody, checkPayload} from '../core.mjs';
import {prepare,search,fillBooking,submitBooking} from '../booking.mjs';
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();});
const config={playDate:'2026-10-01',start:'18:00',end:'20:00',mode:'rehearsal'};
const fixture=`<!doctype html><html><body><div id="Step2"><form><select name="position"><option value="1">Main campus</option><option value="2">Nanda</option></select><select name="project_id"><option value="">Choose</option><option value="alumni">Main Campus — Alumni Hall Badminton Court</option><option value="tennis">Main Campus — Tennis</option></select><button type="submit">Search</button></form><div class="table-responsive"><table style="display:none"><thead><tr><th>Time</th><th>2026-09-30</th><th>2026-10-01</th></tr></thead><tbody></tbody></table></div><button class="flat-btn">Selected</button></div><script>
const selected=[];const table=document.querySelector('table');
document.querySelector('form').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;await fetch('/api/schedule/date',{method:'POST',body:'{}'});table.style.display='table';table.querySelector('tbody').innerHTML=[18,19].map((h,i)=>'<tr><td>'+h+':00:00 ~ '+(h+1)+':00:00</td><td></td><td>'+[1,2].map(c=>'<div class="zone-btn '+(i===1&&c===1?'danger':'success')+'" data-i="'+i+'" data-c="'+c+'"><input type="checkbox" '+(i===1&&c===1?'disabled':'')+'>No. '+c+' field (Available)</div>').join('')+'</td></tr>').join('');document.querySelectorAll('.zone-btn.success').forEach(b=>b.onclick=e=>{b.querySelector('input').checked=true;selected.push({i:+b.dataset.i,c:b.dataset.c});});e.submitter.disabled=false;};
document.querySelector('.flat-btn').onclick=()=>{const d=document.createElement('div');d.className='modal show';d.innerHTML='<table><tbody>'+selected.map(s=>'<tr><td>2026-10-01</td><td>'+(18+s.i)+':00:00 ~ '+(19+s.i)+':00:00</td><td>No. '+s.c+' field</td></tr>').join('')+'</tbody></table><div class="modal-footer"><button class="btn-primary">Confirm</button></div>';document.body.append(d);d.querySelector('button').onclick=()=>{document.querySelector('#Step2').remove();d.remove();const step=document.createElement('div');step.id='Step3';step.innerHTML='<form name="RentalRecord"><input name="project_name" disabled value="Main Campus Alumni Hall Badminton Court">'+selected.map(s=>'<input disabled value="2026-10-01 '+(18+s.i)+':00:00 ~ '+(19+s.i)+':00:00 No. '+s.c+' field">').join('')+'<label for="student-count">Student (NT$0)</label><input id="student-count" type="number" name="student" min="1" value="1"><label for="adult-count">Adult</label><input id="adult-count" type="number" name="adult" min="0" value="0"><button type="submit">Submit</button></form>';document.body.append(step);step.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=new FormData();f.append('project_id','alumni');f.append('details',JSON.stringify(selected.map(s=>({schedule_id:'s'+s.i,booking_date:'2026-10-01',zone:s.c}))));f.append('people',JSON.stringify([{identity_id:'student',quantity:Number(document.querySelector('[name=student]').value)}]));const r=await fetch('/api/personal/rentalRecord',{method:'POST',body:f});if(r.ok)location.href='/venue/personal/applied';};};};
</script></body></html>`;
async function setup({reject=false}={}){
  const context=await browser.newContext({serviceWorkers:'block'});let submissions=0;
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin!==ORIGIN)return route.abort();
    if(u.pathname===BOOK_PATH){submissions++;const body=parseBookingBody(route.request().postData(),route.request().headers()['content-type']);checkPayload(body,config,{projectId:'alumni',court:'2',studentId:'student',rows:[{},{}],scheduleIds:['s0','s1']});return route.fulfill({status:reject?500:200,contentType:'application/json',body:'{}'});}
    if(u.pathname==='/api/schedule/date')return route.fulfill({contentType:'application/json',body:JSON.stringify({schedule:[18,19].map((h,i)=>({id:'s'+i,schedule_date:'2026-10-01',start_time:h+':00:00',end_time:(h+1)+':00:00',zone:[1,2]}))})});
    return route.fulfill({contentType:'text/html',body:u.pathname.endsWith('/applied')?'<h1>Application received</h1>':fixture});
  });
  const page=await context.newPage();page.setDefaultTimeout(2000);return {context,page,count:()=>submissions};
}
test('Rehearsal selects one common court, fills eight students, sends no booking',async()=>{
  const {context,page,count}=await setup();try{const venue=await prepare(page);await search(page);const selected=await fillBooking(page,config,venue);assert.equal(selected.court,'2');assert.equal(await page.locator('[name=student]').inputValue(),'8');assert.equal(count(),0);}finally{await context.close();}
});
test('Live flow sends one verified request and requires success navigation',async()=>{
  const {context,page,count}=await setup();try{const venue=await prepare(page);await search(page);await fillBooking(page,config,venue);const result=await submitBooking(page,()=>{},3000);assert.equal(result.status,'submitted');assert.equal(count(),1);}finally{await context.close();}
});
test('Server failure is not retried',async()=>{
  const {context,page,count}=await setup({reject:true});try{const venue=await prepare(page);await search(page);await fillBooking(page,config,venue);await assert.rejects(()=>submitBooking(page,()=>{},3000),/500/);assert.equal(count(),1);}finally{await context.close();}
});
test('Cancellation before submission sends no request',async()=>{
  const {context,page,count}=await setup();try{const venue=await prepare(page);await search(page);await fillBooking(page,config,venue);await assert.rejects(()=>submitBooking(page,()=>{throw Error('stopped');}),/stopped/);assert.equal(count(),0);}finally{await context.close();}
});
