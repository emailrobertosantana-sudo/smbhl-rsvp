// wrangler.jsonc: only the demo environment sends Notre Ligue mail through
// Cloudflare Email Sending (src/mail_provider.js). Production has neither
// MAIL_PROVIDER nor a send_email binding: everything there stays on
// Resend. (A Node test: the Workers pool cannot read the file.)
import { it, expect } from 'vitest';
import fs from 'node:fs';

it('production has no MAIL_PROVIDER and no send_email binding; demo has both', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  expect(cfg.vars.MAIL_PROVIDER).toBeUndefined();
  expect(cfg.send_email).toBeUndefined();
  expect(cfg.env.demo.vars.MAIL_PROVIDER).toBe('cloudflare');
  expect(cfg.env.demo.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
});
