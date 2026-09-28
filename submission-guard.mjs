import {ORIGIN, parseBookingBody, checkPayload} from './core.mjs';

// Only an active bot run owns submission control. When idle, Chrome works normally.
export function createSubmissionGuard({getJob, hasAttempt, recordAttempt, log, origin = ORIGIN}) {
  return async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const job = getJob();
    try {
      if (new URL(route.request().url()).origin !== origin) throw Error('Unexpected reservation origin.');
      if (!job) {
        log('Manual submission allowed; the bot is idle.');
        return await route.continue();
      }
      if (!job.allowed || job.cancelled || job.sent || job.config.mode !== 'live') {
        throw Error('A bot run is active. Stop the run before submitting manually, or let a live run submit automatically.');
      }
      const body = parseBookingBody(route.request().postData() || '', route.request().headers()['content-type'] || '');
      checkPayload(body, job.config, job.selected);
      if (hasAttempt(job.config)) throw Error('An overlapping reservation was already attempted.');
      recordAttempt(job);
      job.sent = true;
      job.allowed = false;
      log('Sending one verified reservation request.');
      await route.continue();
    } catch (error) {
      if (job) job.guardError = error;
      log(error.message);
      await route.abort('blockedbyclient');
    }
  };
}
