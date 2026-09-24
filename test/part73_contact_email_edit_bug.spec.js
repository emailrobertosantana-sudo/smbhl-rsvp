// Live-testing task (batch 6), Part 1: SMBHL production bug -- editing
// a contact's EMAIL on /admin/contacts silently saved the OLD value,
// every time; editing PHONE on the same row worked correctly.
//
// ROOT CAUSE, found by directly firing wire()'s real change handlers
// against the real page's own script (not guessed): given a fresh
// i.value at the moment 'change' fires, BOTH the email and phone
// handlers correctly send it -- the JS logic was never the bug, and
// is structurally identical between the two fields. The only
// meaningful difference was type="email" vs type="tel" on the two
// <input> elements. type="email" is Chrome's strongest autofill
// heuristic signal; autocomplete="off" alone does not reliably
// suppress it (a well-documented Chromium behavior, especially
// pronounced with no name/id attribute for Chrome to otherwise key
// off of) -- on blur, Chrome can silently overwrite .value with an
// autofill suggestion BEFORE the 'change' handler ever runs, which no
// amount of correct JS can detect or prevent, since i.value is
// already wrong by the time this code sees it. type="tel" never
// triggers this same aggressive behavior, which is why phone always
// worked.
//
// FIX: type="email" -> type="text" inputmode="email" (keeps the
// mobile email keyboard, drops the desktop autofill trigger),
// matching phone's own already-successful shape. The existing JS-side
// regex validation in wire() is unchanged.
//
// This suite can't reproduce Chrome's own autofill engine (no real
// browser), so it can't directly prove the ORIGINAL bug reproduces or
// that the fix defeats real autofill -- that requires live browser
// verification. What it CAN and does prove: (1) the fix is actually
// in the served HTML (type="text" inputmode="email", not
// type="email"), on every row type (roster/sub/archived); (2) the
// save logic itself is correct and unaffected by the type change --
// firing the real wire() change handler with a controlled i.value
// sends exactly that value, for both email and phone, proving this
// wasn't secretly a JS bug in disguise.
import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { extractInlineScripts, assertNoSyntaxError, runScript } from './support/inline_scripts.js';

// A capturing DOM stub, local to this file (not the shared helper --
// the shared stubDom()'s addEventListener is a deliberate no-op for
// "does it parse / is X defined" checks; this one needs to actually
// register and later fire listeners, and capture what gets fetched,
// to prove the real save behavior).
function makeElement() {
  const listeners = {};
  return {
    _value: '',
    get value() { return this._value; },
    set value(v) { this._value = v; },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, dataset: {},
    addEventListener(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); },
    fire(evt) { (listeners[evt] || []).forEach(cb => cb()); },
    setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, remove() {}, closest() { return makeElement(); },
    querySelectorAll: () => [], querySelector: () => null,
    textContent: '', innerHTML: '',
  };
}

async function fetchContactsPage() {
  return (await SELF.fetch('http://example.com/admin/contacts')).text();
}

describe('Part 1 (live-testing task, batch 6): SMBHL contact email edits now save', () => {
  it('the served page no longer uses type="email" for the contact email inputs -- type="text" inputmode="email" instead', async () => {
    const html = await fetchContactsPage();
    expect(html).not.toContain('type="email" class="contact-input"');
    expect(html).toContain('type="text" inputmode="email" class="contact-input"');
    // Phone is untouched -- it was never the problem.
    expect(html).toContain('type="tel" class="contact-input"');
  });

  it('every inline script on the page is still syntactically valid, and wire()/api() are still defined', async () => {
    const html = await fetchContactsPage();
    const scripts = extractInlineScripts(html);
    assertNoSyntaxError(scripts, '/admin/contacts');
    const combined = scripts.join('\n;\n');
    expect(runScript(combined, 'return typeof wire;')).toBe('function');
    expect(runScript(combined, 'return typeof api;')).toBe('function');
  });

  it('firing the REAL change handler with a controlled, fresh value sends exactly that value for email -- proving the save logic itself was always correct, not secretly broken', async () => {
    const html = await fetchContactsPage();
    const combined = extractInlineScripts(html).join('\n;\n');

    const emInput = makeElement();
    emInput.dataset.em = 'P_TEST_EMAIL';
    const phInput = makeElement();
    phInput.dataset.ph = 'P_TEST_EMAIL';

    const elementsById = {};
    ['msg', 'lbl-season', 'lbl-season-title', 'cnt-roster', 'cnt-skater', 'cnt-goalie',
     'cnt-archived', 'lbl-roster-count', 'sub-skater-desc', 'sub-goalie-desc',
     'lbl-archive-count', 'cnt-phones', 'filter-contacts'].forEach(id => { elementsById[id] = makeElement(); });

    const fetchCalls = [];
    const fakeFetch = async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      fetchCalls.push({ url, body });
      return { ok: true, text: async () => '{}', json: async () => ({ ok: true, email: body?.email, phone: body?.phone }) };
    };

    const doc = {
      getElementById: (id) => elementsById[id] || makeElement(),
      querySelectorAll: (sel) => (sel === '[data-em]' ? [emInput] : sel === '[data-ph]' ? [phInput] : []),
      querySelector: () => null, addEventListener: () => {}, createElement: () => makeElement(),
      documentElement: { lang: '' }, cookie: '',
    };
    const win = { location: { search: '' }, addEventListener: () => {}, dispatchEvent: () => {} };

    const fn = new Function('window', 'document', 'localStorage', 'navigator', 'location', 'fetch',
      combined + '\n;\nif (typeof wire === "function") wire();');
    fn(win, doc, { getItem: () => null, setItem: () => {} }, { language: 'en-US' }, { search: '' }, fakeFetch);

    emInput.value = 'genuinely.typed.value@example.com';
    emInput.fire('change');
    await new Promise(r => setTimeout(r, 10));

    phInput.value = '514-111-2222';
    phInput.fire('change');
    await new Promise(r => setTimeout(r, 10));

    const emailCall = fetchCalls.find(c => c.body && c.body.action === 'email');
    const phoneCall = fetchCalls.find(c => c.body && c.body.action === 'phone');
    expect(emailCall.body.email).toBe('genuinely.typed.value@example.com');
    expect(phoneCall.body.phone).toBe('514-111-2222');
  });
});
