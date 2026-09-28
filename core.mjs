export const ORIGIN = 'https://peo178.et.nthu.edu.tw';
export const BOOK_PATH = '/api/personal/rentalRecord';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const taipeiStamp = (ms = Date.now()) => new Date(ms + 8 * 3600000).toISOString().slice(0, 19);
export const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || addDays(value, 0) !== value) throw Error('Choose a valid playing date.');
  return value;
}
export function minutes(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value)) throw Error(`Invalid time: ${value}`);
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}
export function validateConfig(input, now = Date.now()) {
  const playDate = dateValue(input.playDate);
  const start = String(input.start || ''), end = String(input.end || '');
  if (minutes(start) >= minutes(end)) throw Error('End time must be after start time on the same day.');
  const runAt = input.runAt || '';
  if (runAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(runAt)) throw Error('Choose a valid booking start date and time.');
  if (runAt) { dateValue(runAt.slice(0, 10)); minutes(runAt.slice(11, 16)); if (runAt.length === 19 && Number(runAt.slice(17)) > 59) throw Error('Invalid seconds.'); }
  const target = runAt ? Date.parse(runAt + '+08:00') : now;
  if (!Number.isFinite(target) || target < now - 5000) throw Error('The booking start time is in the past.');
  if (Date.parse(`${playDate}T${start.slice(0,5)}:00+08:00`) <= target) throw Error('The playing time must be after the booking start time.');
  const daysAhead = (Date.parse(playDate) - Date.parse(taipeiStamp(target).slice(0, 10))) / 86400000;
  if (daysAhead < 0 || daysAhead > 4) throw Error('The site displays today through four days ahead. Adjust the booking start date or playing date.');
  if (!['rehearsal', 'live'].includes(input.mode)) throw Error('Choose rehearsal or live mode.');
  const repeat = input.repeat || 'none';
  if (!['none', 'daily', 'weekly'].includes(repeat)) throw Error('Invalid repeat schedule.');
  const count = repeat === 'none' ? 1 : Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > 12) throw Error('Choose 1–12 runs.');
  const retrySeconds = Number(input.retrySeconds ?? 15);
  if (!Number.isInteger(retrySeconds) || retrySeconds < 0 || retrySeconds > 120) throw Error('Availability retry window must be 0–120 seconds.');
  return {playDate, start: start.slice(0,5), end: end.slice(0,5), runAt, target, mode:input.mode, repeat, count, retrySeconds};
}

// Finds one court available across the exact requested interval. Never switches courts midway.
export function chooseCourt(rows, start, end) {
  const from = minutes(start), to = minutes(end);
  const eligible = rows.map((r, index) => ({...r, index, from: minutes(r.start), to: minutes(r.end)}))
    .filter(r => r.from >= from && r.to <= to).sort((a,b) => a.from - b.from);
  function visit(cursor, chosen, courts) {
    if (cursor === to && chosen.length) return {rows: chosen, court: courts[0]};
    if (chosen.length === 2) return null;
    for (const row of eligible.filter(r => r.from === cursor && r.to > cursor)) {
      const available = [...new Set(row.courts)].filter(c => courts === null || courts.includes(c)).sort((a,b) => Number(a) - Number(b));
      if (!available.length) continue;
      const result = visit(row.to, [...chosen, row], available);
      if (result) return result;
    }
    return null;
  }
  return visit(from, [], null);
}

export function attemptKey(config) { return `${config.playDate}|${config.start}|${config.end}`; }
export function overlaps(a, b) { return a.playDate === b.playDate && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end); }

export function parseBookingBody(body, contentType) {
  if (contentType.includes('application/json')) return JSON.parse(body);
  if (contentType.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(body));
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw Error('Unrecognized submission format; nothing was sent.');
  const fields = {};
  for (const part of body.split('--' + (match[1] || match[2]))) {
    const name = part.match(/Content-Disposition:[^\r\n]*\bname="([^"]+)"/i)?.[1];
    const split = part.indexOf('\r\n\r\n');
    if (name && split >= 0) fields[name] = part.slice(split + 4).replace(/\r\n$/, '');
  }
  return fields;
}
export function checkPayload(body, config, selected) {
  const details = typeof body.details === 'string' ? JSON.parse(body.details) : body.details;
  const people = typeof body.people === 'string' ? JSON.parse(body.people) : body.people;
  if (String(body.project_id) !== selected.projectId || !Array.isArray(details) || details.length !== selected.rows.length ||
      details.some(d => d.booking_date !== config.playDate || String(d.zone) !== selected.court || !d.schedule_id) ||
      new Set(details.map(d => String(d.schedule_id))).size !== details.length ||
      !Array.isArray(selected.scheduleIds) || selected.scheduleIds.length !== details.length || details.some(d => !selected.scheduleIds.includes(String(d.schedule_id)))) throw Error('Submission does not match the chosen venue, date, time, or court. Nothing was sent.');
  if (!Array.isArray(people) || people.some(p => !Number.isInteger(Number(p.quantity)) || Number(p.quantity) < 0)) throw Error('Invalid participant counts. Nothing was sent.');
  const nonzero = people.filter(p => Number(p.quantity) !== 0);
  if (nonzero.length !== 1 || String(nonzero[0].identity_id) !== selected.studentId || Number(nonzero[0].quantity) !== 8) throw Error('Submission must contain exactly eight students. Nothing was sent.');
  return true;
}
