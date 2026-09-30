// Which service sends an email: Resend or Cloudflare Email Sending.
//
// MAIL_PROVIDER (a wrangler.jsonc var): 'resend' (the default, and what
// production uses) or 'cloudflare'. 'cloudflare' needs the send_email
// binding SEND_EMAIL in the same environment; only env.demo has both.
//
// Cloudflare Email Sending is set up for one domain, mail.notreligue.ca
// (DKIM selector cf-bounce, return path cf-bounce.mail.notreligue.ca). So
// only a message From that domain (Notre Ligue and its leagues) can go
// through it. Everything else goes through Resend whatever the variable
// says, and that is how SMBHL always stays on Resend: its From address is
// joueur@smbhl.com.
//
// There is no automatic fallback: with MAIL_PROVIDER 'cloudflare' and no
// binding, or when Cloudflare refuses a message, the send fails, the
// outbox retries it or marks it failed (src/mail_queue.js), and the health
// alerts report it. Resend's DNS records must stay while any mail goes
// through Resend (SMBHL, and any environment still on 'resend').
export const CLOUDFLARE_SENDING_DOMAIN = 'mail.notreligue.ca';

// "Name <addr@x>" or "addr@x" -> { email, name }.
export function parseAddress(addr) {
  const s = String(addr || '').trim();
  const m = s.match(/^(.*)<([^<>]+)>\s*$/);
  if (m) return { email: m[2].trim(), name: m[1].trim().replace(/^"|"$/g, '') };
  return { email: s, name: '' };
}

export function chooseMailProvider(env, fromAddr) {
  if (String((env && env.MAIL_PROVIDER) || 'resend').trim().toLowerCase() !== 'cloudflare') return 'resend';
  const domain = parseAddress(fromAddr).email.split('@')[1] || '';
  return domain.toLowerCase() === CLOUDFLARE_SENDING_DOMAIN ? 'cloudflare' : 'resend';
}
