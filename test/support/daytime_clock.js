// drain() holds mail that comes due inside quiet hours (23:00-07:00
// Montreal by default) until they end (commit 66a858a). A test that drains
// without choosing quiet hours therefore passed by day and failed by night.
// useDaytimeClock() gives such a test a daytime clock: by day it does
// nothing; between 23:00 and 07:00 Montreal it moves Date forward to
// between 07:30 and 08:30 the next morning and lets it keep running. Call it in
// beforeEach and restore with vi.useRealTimers() in afterEach; a test that
// sets its own time (vi.setSystemTime) still wins.
import { vi } from 'vitest';

export function useDaytimeClock() {
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', hourCycle: 'h23' }).format(now));
  if (hour >= 7 && hour < 23) return false;
  const hoursAhead = hour >= 23 ? (24 - hour) + 7.5 : 7.5 - hour;
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(now.getTime() + hoursAhead * 3600000));
  return true;
}
