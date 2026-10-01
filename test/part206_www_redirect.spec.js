// www.notreligue.ca (a demo route) answers 301 to the same path and query on
// https://notreligue.ca; every other host is untouched.
import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('www.notreligue.ca', () => {
  it('redirects every path, with its query, to notreligue.ca', async () => {
    for (const [path, want] of [['/confidentialite', 'https://notreligue.ca/confidentialite'], ['/conditions', 'https://notreligue.ca/conditions'], ['/', 'https://notreligue.ca/'], ['/league/rsvp?e=1&p=2', 'https://notreligue.ca/league/rsvp?e=1&p=2']]) {
      const res = await SELF.fetch('https://www.notreligue.ca' + path, { redirect: 'manual' });
      expect(res.status, path).toBe(301);
      expect(res.headers.get('location'), path).toBe(want);
    }
  });
  it('other hosts are not redirected', async () => {
    const res = await SELF.fetch('https://example.com/confidentialite', { redirect: 'manual' });
    expect(res.status).not.toBe(301);
  });
});
