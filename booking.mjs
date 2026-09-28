import { ORIGIN, BOOK_PATH, chooseCourt, minutes, sleep } from './core.mjs';

const snapshots = new WeakMap();

export async function prepare(page) {
  await page.goto(ORIGIN + '/venue/personal/apply/2', {waitUntil:'domcontentloaded'});
  try { await page.locator('#Step2 select[name="project_id"]').waitFor({timeout:12000}); }
  catch { throw Error('Log in in the booking tab, solve the CAPTCHA, and dismiss any login notice. Then try again.'); }
  await page.locator('#Step2 select[name="position"]').selectOption('1');
  const options = await page.locator('#Step2 select[name="project_id"] option').evaluateAll(items => items.map(o => ({id:o.value, name:o.textContent.trim()})));
  const matches = options.filter(o => /(?:校友|alumni)/i.test(o.name) && /(?:羽球|badminton)/i.test(o.name));
  if (matches.length !== 1) throw Error(`Could not uniquely identify Alumni Hall Badminton Court. Available venues: ${options.filter(o=>o.id).map(o=>o.name).join('; ')}`);
  await page.locator('#Step2 select[name="project_id"]').selectOption(matches[0].id);
  return {projectId:matches[0].id, venue:matches[0].name};
}

export async function search(page) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/schedule/date' && r.request().method() === 'POST', {timeout:20000}).catch(()=>null);
  await page.locator('#Step2 form button[type="submit"]').click();
  const result = await response;
  if (!result) throw Error('Availability request timed out. Check login and the booking tab.');
  if (!result.ok()) throw Error(`Availability request failed (${result.status()}). Check login and the booking tab.`);
  const data = await result.json();
  if (!Array.isArray(data.schedule)) throw Error('The availability response format changed. Nothing was submitted.');
  snapshots.set(page,data.schedule);
  await page.locator('#Step2 > .table-responsive table tbody').waitFor({timeout:10000});
  await page.locator('#Step2 form button[type="submit"]').waitFor({state:'visible'});
  await page.waitForFunction(() => !document.querySelector('#Step2 form button[type="submit"]')?.disabled);
}

export async function readRows(page, date) {
  return page.locator('#Step2 > .table-responsive table').evaluate((table, target) => {
    const headers = [...table.querySelectorAll('thead tr th')];
    const column = headers.findIndex(h => h.textContent.includes(target));
    if (column < 1) return [];
    return [...table.querySelectorAll('tbody tr')].map((tr, tableIndex) => {
      const cells = [...tr.children];
      const times = cells[0]?.textContent.match(/(\d{2}:\d{2}(?::\d{2})?)\s*~\s*(\d{2}:\d{2}(?::\d{2})?)/);
      if (!times) throw Error('The site time-slot layout changed.');
      const buttons = [...(cells[column]?.querySelectorAll('.zone-btn.success') || [])];
      const courts = buttons.filter(b => !b.querySelector('input')?.disabled).map(b => b.textContent.match(/(?:第|No\.?)\s*(\d+)/i)?.[1]).filter(Boolean);
      return {start:times[1], end:times[2], courts, tableIndex, column};
    });
  }, date);
}

export async function fillBooking(page, config, venue, checkpoint = () => {}) {
  checkpoint();
  const rows = await readRows(page, config.playDate);
  const picked = chooseCourt(rows, config.start, config.end);
  if (!picked) return null;
  const selected = {...picked, ...venue};
  selected.scheduleIds = selected.rows.map(row => {
    const matches = (snapshots.get(page)||[]).filter(s => s.schedule_date === config.playDate && minutes(s.start_time) === minutes(row.start) && minutes(s.end_time) === minutes(row.end) && Array.isArray(s.zone) && s.zone.map(String).includes(selected.court));
    if (matches.length !== 1) throw Error('Could not verify the selected court against the latest schedule.');
    return String(matches[0].id);
  });
  for (const row of selected.rows) {
    checkpoint();
    const cell = page.locator('#Step2 > .table-responsive table tbody tr').nth(row.tableIndex).locator('td').nth(row.column);
    const button = cell.locator('.zone-btn.success').filter({hasText:new RegExp(`(?:第|No\\.?)\\s*${selected.court}\\s`)});
    if (await button.count() !== 1) throw Error('The selected court is no longer uniquely available.');
    await button.click();
    if (!(await button.locator('input').isChecked())) throw Error('The site did not select the requested slot.');
  }
  await page.locator('#Step2 button.flat-btn').click();
  const dialog = page.locator('.modal.show');
  await dialog.waitFor();
  const summary = await dialog.locator('tbody tr').allTextContents();
  if (summary.length !== selected.rows.length || summary.some((text, i) => !text.includes(config.playDate) || !text.includes(selected.rows[i].start) || !text.includes(selected.rows[i].end))) throw Error('The selection summary does not match the requested date and times.');
  checkpoint();
  await dialog.locator('.modal-footer button.btn-primary').click();
  const form = page.locator('#Step3 form[name="RentalRecord"]');
  await form.waitFor();
  await form.locator('input[type="number"]').first().waitFor();
  const fields = await form.locator('input[type="number"]').evaluateAll(inputs => inputs.map(e => ({name:e.name, label:document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent.trim() || '', min:Number(e.min)})));
  const students = fields.filter(f => /學生|student/i.test(f.label) && !/非學生|non.student|not.*student/i.test(f.label));
  if (students.length !== 1) throw Error('Could not uniquely identify the student category. Check the booking tab.');
  selected.studentId = students[0].name;
  if (fields.some(f => f.name !== selected.studentId && f.min > 0)) throw Error('This account requires a non-student participant. Log in with the intended student account.');
  for (const field of fields.filter(f => f.name !== selected.studentId)) await form.locator(`input[name="${field.name}"]`).fill('0');
  await form.locator(`input[name="${selected.studentId}"]`).fill('8');
  // React uses change events for its totals. Move focus and verify both DOM values and validity.
  await form.locator(`input[name="${selected.studentId}"]`).press('Tab');
  const check = await form.evaluate(f => ({valid:f.checkValidity(), values:[...f.querySelectorAll('input[type="number"]')].map(e=>[e.name,e.value]), error:f.querySelector('.text-danger')?.textContent.trim()}));
  if (!check.valid || check.error || check.values.some(([id, value]) => Number(value) !== (id === selected.studentId ? 8 : 0))) throw Error('The site rejected the eight-student participant count.');
  const venueText = await form.locator('input[name="project_name"]').inputValue();
  if (!/校友|alumni/i.test(venueText) || !/羽球|badminton/i.test(venueText)) throw Error('The final venue is not Alumni Hall Badminton Court.');
  const details = await form.locator('input:disabled:not([name="project_name"])').evaluateAll(inputs=>inputs.map(e=>e.value));
  if (details.length !== selected.rows.length || details.some((text,i) => !text.includes(config.playDate) || !text.includes(selected.rows[i].start) || !text.includes(selected.rows[i].end) || !new RegExp(`(?:第|No\\.?)\\s*${selected.court}\\s`).test(text))) throw Error('Final booking details changed. Nothing was submitted.');
  checkpoint();
  return selected;
}

export async function submitBooking(page, checkpoint = () => {}, timeout = 25000) {
  checkpoint();
  // Never retry a submit after any timeout or connection error.
  const responsePromise = page.waitForResponse(r => new URL(r.url()).pathname === BOOK_PATH && r.request().method() === 'POST', {timeout}).catch(() => null);
  await page.locator('#Step3 form[name="RentalRecord"] button[type="submit"]').click();
  const response = await responsePromise;
  if (!response) throw Error('No definite submission response. Check your application list before attempting another booking.');
  if (!response.ok()) throw Error(`The server returned ${response.status()}. Check your application list. The bot will not resubmit automatically.`);
  const deadline = Date.now() + Math.min(timeout, 10000);
  while (Date.now() < deadline) {
    if (new URL(page.url()).pathname === '/venue/personal/applied') return {status:'submitted'};
    const text = await page.locator('.swal2-popup:visible').textContent().catch(()=>null);
    if (text && /error|錯誤|错误/i.test(text)) throw Error('The site reported an error after submission. Check the booking tab and application list.');
    await sleep(100);
  }
  throw Error('The server responded, but the success page was not confirmed. Check your application list before trying again.');
}
