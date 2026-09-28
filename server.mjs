import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {ORIGIN, validateConfig, taipeiStamp, addDays, attemptKey, overlaps, sleep} from './core.mjs';
import {prepare, search, fillBooking, submitBooking} from './booking.mjs';
import {createSubmissionGuard} from './submission-guard.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.resolve(process.env.BADMINTON_RUNTIME || path.join(root, '.runtime'));
fs.mkdirSync(runtime, {recursive:true});
const lockFile = path.join(runtime, 'running.lock');
try { const lock = fs.openSync(lockFile, 'wx'); fs.writeFileSync(lock, String(process.pid)); fs.closeSync(lock); }
catch {
  const pid = Number(fs.readFileSync(lockFile, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) { console.error('The bot is already running. Use its open Chrome dashboard.'); process.exit(1); }
  fs.unlinkSync(lockFile);
  fs.writeFileSync(lockFile, String(process.pid), {flag:'wx'});
}
// Prevent idle sleep on macOS while the bot runs; caffeinate exits with this process.
if (process.platform === 'darwin') { try { spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], {stdio:'ignore'}).on('error', ()=>{}).unref(); } catch {} }
const save = (file, data) => { const p=path.join(runtime,file); fs.writeFileSync(p+'.tmp',JSON.stringify(data,null,2)); fs.renameSync(p+'.tmp',p); };
const load = (file, fallback) => fs.existsSync(path.join(runtime,file)) ? JSON.parse(fs.readFileSync(path.join(runtime,file),'utf8')) : fallback;
const ledger = load('attempts.json', {});
const token = crypto.randomBytes(24).toString('hex');
let context, bookingPage, dashboard, current = null, starting = false, preflight = false, stopping = false;
const state = {status:'idle', message:'Open the booking tab and log in before checking the connection.', logs:[], config:load('settings.json',null), selected:null};
function log(message) {
  const line = `${taipeiStamp().replace('T',' ')}  ${message}`;
  state.message = message; state.logs.push(line); if (state.logs.length>150) state.logs.shift();
  fs.appendFileSync(path.join(runtime,'bot.log'),line+'\n');
  console.log(line);
}
function checkpoint(job) { if (job.cancelled) throw Error('Run stopped.'); if (bookingPage.isClosed()) throw Error('The booking tab was closed.'); }
function blocked(config) { return Object.values(ledger).find(entry => overlaps(entry.config, config)); }

async function openBooking() {
  if (!bookingPage || bookingPage.isClosed()) {
    bookingPage = await context.newPage();
    bookingPage.setDefaultTimeout(10000);
    bookingPage.setDefaultNavigationTimeout(20000);
    await bookingPage.goto(ORIGIN + '/venue/personal/apply/2', {waitUntil:'domcontentloaded'});
  }
  await bookingPage.bringToFront();
}

async function waitUntil(job, target) {
  while (Date.now() < target) {
    checkpoint(job);
    await sleep(Math.min(500, Math.max(1,target-Date.now())));
  }
  checkpoint(job);
  if (Date.now() - target > 10000) throw Error('The computer missed the scheduled start by more than 10 seconds. Check sleep and clock settings, then set up a new run.');
}

async function execute(job, firstVenue) {
  let config = {...job.config};
  try {
    for (let occurrence=1; occurrence<=job.config.count; occurrence++) {
      job.config=config; state.config=config; state.selected=null; job.selected=null; job.allowed=false; job.sent=false; job.guardError=null;
      if (config.mode === 'live' && blocked(config)) throw Error('An overlapping booking was already attempted. Check the website before another attempt.');
      let venue = occurrence===1 ? firstVenue : null;
      const warmup = config.target - 15000;
      if (Date.now() < warmup) { state.status='waiting'; log(`Run ${occurrence}/${job.config.count}: waiting until ${taipeiStamp(config.target).replace('T',' ')} Taiwan time.`); await waitUntil(job,warmup); }
      checkpoint(job);
      // Refresh authentication and form shortly before release, then keep it ready.
      if (config.target - Date.now() > 3000 || !venue) venue = await prepare(bookingPage);
      if (config.target > Date.now()) {state.status='waiting'; await waitUntil(job,config.target);}
      else if (config.runAt && Date.now()-config.target>10000) throw Error('The scheduled start was missed. Set up a new run.');
      state.status='booking';
      await bookingPage.bringToFront();
      log('Checking availability for the exact requested time.');
      const deadline=Date.now()+config.retrySeconds*1000;
      let selected;
      do {
        checkpoint(job);
        await search(bookingPage);
        checkpoint(job);
        selected=await fillBooking(bookingPage,config,venue,()=>checkpoint(job));
        if (selected || Date.now()>=deadline) break;
        await sleep(1000);
      } while (true);
      if (!selected) throw Error('No single court is available for that exact time, or the requested time does not match the site’s slots (maximum two slots).');
      job.selected=selected; state.selected={court:selected.court,venue:selected.venue,date:config.playDate,start:config.start,end:config.end,students:8};
      log(`Court ${selected.court}, ${config.playDate} ${config.start}–${config.end}, eight students: form verified.`);
      if (config.mode==='rehearsal') {
        state.status='rehearsal_complete'; log('Form filled only; no reservation was submitted. You can click Submit in the booking tab yourself. For automatic submission, choose Live mode.');
        await bookingPage.bringToFront();
        break;
      }
      checkpoint(job);
      job.allowed=true;
      try { await submitBooking(bookingPage,()=>checkpoint(job)); }
      catch (error) { throw job.guardError || error; }
      finally { job.allowed=false; }
      if (!job.sent) throw Error('The guarded submission was not observed. Inspect the booking tab.');
      ledger[attemptKey(config)].status='submitted'; save('attempts.json',ledger);
      state.status='submitted'; log('The website confirmed that the rental request was submitted. Check application status for final approval.');
      if (occurrence<job.config.count) {
        const days=config.repeat==='daily'?1:7;
        config={...config,playDate:addDays(config.playDate,days),target:config.target+days*86400000};
        config.runAt=taipeiStamp(config.target);
        log(`Next ${config.repeat} run: ${config.runAt.replace('T',' ')} Taiwan time. Keep the bot and Chrome open.`);
      }
    }
  } catch (error) {
    state.status=job.sent?'needs_review':job.cancelled?'stopped':'error';
    log(error.message);
    if (job.sent) log('A submission may have reached the server. Automatic submission retries are disabled. Check the application list.');
  } finally {
    job.allowed=false; current=null;
    state.busy=false;
  }
}

async function requestBody(req) {
  let text='';
  for await (const chunk of req) { text+=chunk; if (text.length>20000) throw Error('Request too large.'); }
  return text ? JSON.parse(text) : {};
}

const server=http.createServer(async (req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try {
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return send(403,{error:'Invalid host.'});
    const url=new URL(req.url,`http://${req.headers.host}`);
    if (req.method==='GET' && url.pathname==='/') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'"});
      return res.end(fs.readFileSync(path.join(root,'dashboard.html'),'utf8'));
    }
    if (req.headers['x-bot-token']!==token) return send(403,{error:'Use the dashboard opened by the bot.'});
    if (req.method==='GET' && url.pathname==='/status') return send(200,{...state,busy:Boolean(current||starting||preflight),now:taipeiStamp(),attempts:Object.values(ledger).map(e=>({config:e.config,status:e.status}))});
    if (req.method!=='POST') return send(404,{error:'Not found.'});
    if (req.headers.origin!==`http://${req.headers.host}`) return send(403,{error:'Invalid origin.'});
    const data=await requestBody(req);
    if (url.pathname==='/stop') {
      if(current){current.cancelled=true;current.allowed=false;log(current.sent?'Stop requested. An in-flight submission may already be on the server.':'Stop requested.');}
      return send(200,{ok:true});
    }
    if (url.pathname==='/shutdown') {
      if(current) {current.cancelled=true;current.allowed=false;}
      send(200,{ok:true}); setTimeout(shutdown,300); return;
    }
    if (current||starting||preflight) throw Error('Stop the active operation before changing the setup.');
    if (url.pathname==='/login') {preflight=true;try{await openBooking();return send(200,{ok:true});}finally{preflight=false;}}
    if (url.pathname==='/check') {
      preflight=true;
      try {
        await openBooking(); const venue=await prepare(bookingPage); await search(bookingPage);
        const slots=await bookingPage.locator('#Step2 > .table-responsive table tbody tr td:first-child').allTextContents();
        state.venue=venue;state.slots=slots;state.status='ready'; log(`Connected to ${venue.venue}. Available time-slot labels loaded.`);
        await dashboard.bringToFront(); return send(200,{ok:true,venue,slots});
      }finally{preflight=false;}
    }
    if(url.pathname==='/start') {
      starting=true;
      try {
        const config=validateConfig(data);
        if(config.mode==='live'&&blocked(config)) throw Error('An overlapping booking was already attempted. Check the application list first.');
        const job={config,cancelled:false,allowed:false,sent:false,selected:null}; current=job;
        let venue;
        try { await openBooking(); checkpoint(job); venue=await prepare(bookingPage); checkpoint(job); }
        catch(error) { current=null;state.status=job.cancelled?'stopped':'error';log(error.message);throw error; }
        state.config=config;state.selected=null;state.status='armed';save('settings.json',config);
        log(`${config.mode==='live'?'LIVE':'REHEARSAL'} run armed for ${config.playDate} ${config.start}–${config.end}.`);
        await dashboard.bringToFront(); send(200,{ok:true}); void execute(job,venue);
      }finally{starting=false;}
      return;
    }
    send(404,{error:'Not found.'});
  }catch(error){log(error.message);send(400,{error:error.message});}
});

async function shutdown() {
  if(stopping)return;stopping=true;
  if(current){current.cancelled=true;current.allowed=false;}
  try {await context?.close();}catch{}
  server.close();
  try {fs.unlinkSync(lockFile);}catch{}
  process.exit(0);
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.on('SIGHUP',shutdown);
process.on('exit',()=>{try{fs.unlinkSync(lockFile);}catch{}});

// On macOS, Chrome keeps running after its last window closes, so treat "no tabs left" as closing the bot.
function watchPage(page) { page.on('close',()=>{ if(!stopping && context.pages().length===0) void shutdown(); }); }

try {
  try {
    context=await chromium.launchPersistentContext(path.join(runtime,'chrome-profile'),{channel:'chrome',headless:false,viewport:null,serviceWorkers:'block',timezoneId:'Asia/Taipei'});
  } catch (error) {
    throw Error(`Could not start Google Chrome. Install it in /Applications from https://www.google.com/chrome/ and quit any Chrome window using the bot profile.\n${error.message}`);
  }
  await context.route('**/api/personal/rentalRecord',createSubmissionGuard({
    getJob:()=>current, hasAttempt:blocked, log,
    recordAttempt:job=>{
      ledger[attemptKey(job.config)]={config:job.config,court:job.selected.court,status:'attempted',at:taipeiStamp()};
      save('attempts.json',ledger);
    }
  }));
  context.on('close',()=>{if(!stopping)void shutdown();});
  context.pages().forEach(watchPage); context.on('page',watchPage);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  dashboard=context.pages()[0]||await context.newPage();
  const address=`http://127.0.0.1:${server.address().port}/#${token}`;
  await dashboard.goto(address);
  // This local file is a convenience shortcut; it stays inside the private runtime directory.
  fs.writeFileSync(path.join(runtime,'dashboard.webloc'),`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>${address}</string></dict></plist>\n`);
  log('Dashboard ready. Click Open booking / log in to start.');
}catch(error){console.error(error.message);await shutdown();}
