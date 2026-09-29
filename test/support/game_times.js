// Every league game needs a start and an end time (nights, 2026-09-30:
// which games overlap is worked out from them). Tests written when both
// were optional create games through the routes with neither, or only a
// start; this fills what is missing -- 19:00, and an end an hour after the
// start -- and leaves given values alone.
export function withGameTimes(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  if (out.start_time === undefined || out.start_time === null) out.start_time = '19:00';
  if (out.end_time === undefined || out.end_time === null) out.end_time = hourAfter(out.start_time);
  return out;
}
export function hourAfter(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return '20:00';
  const t = (Number(m[1]) * 60 + Number(m[2]) + 60) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
