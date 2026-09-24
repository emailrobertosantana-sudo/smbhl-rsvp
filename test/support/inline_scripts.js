// Live-testing task (batch 5), Part 8: this test suite can't execute a
// real browser, so every inline <script> block this app ships (the
// league-product pages are entirely server-rendered HTML with inline
// client-side JS, no separate bundle) went completely unexercised by
// tests -- three separate, previously-undiscovered bugs this session
// came from exactly that gap: backslash-escaping that silently killed
// an entire <script> block's worth of function definitions (roster
// page, "Ajouter" button did nothing -- see
// test/part37_roster_add_player_broken_regression.spec.js, which first
// built this exact technique), a missing esc() definition that would
// have thrown on any real Comms activity row, and a cadence value
// silently dropped by JSON.stringify (a function value where a string
// was expected -- JSON.stringify drops function-valued properties
// entirely, so the key just vanishes from the embedded dict with no
// error at all).
//
// This module generalizes that technique (previously copy-pasted
// across part37/part46/part47/part50) into one shared helper: extract
// every inline <script> block from a real server-rendered page,
// concatenate them in load order (matching how a browser would), and
// run the result against a minimal DOM stub via `new Function(...)`.
// This proves three separate things a plain HTML content check never
// would: (1) every script block is syntactically valid JS at all --
// the roster bug's exact failure mode, since a SyntaxError anywhere in
// a <script> tag prevents every function in it from being defined,
// not just the one containing the mistake; (2) a specific function
// name is actually DEFINED after the script runs, not silently
// missing; (3) a specific function, called with real arguments,
// produces the real, correct output -- not just "no crash".
//
// Deliberately NOT a jsdom dependency: `new Function` plus a handful of
// no-op stubs is enough for every page's own top-level script
// statements (which run immediately on load, not just inside a later
// event handler) to execute to completion. This won't catch a bug that
// only manifests on a real user interaction requiring genuine DOM
// behavior (click dispatch, real layout, etc) -- see this module's own
// README-style comment at the bottom of part72 for what's explicitly
// NOT covered by this technique and why.

import { expect } from 'vitest';

export function stubDom() {
  // A generic, always-safe stand-in for any DOM element -- deliberately
  // NEVER null. Real pages' top-level script statements (which run
  // immediately on load, not inside a later event handler) routinely
  // do things like document.getElementById('x').addEventListener(...)
  // unguarded, trusting the real template to have rendered that
  // element -- exactly true for a real browser, but not for a stub
  // returning null. A null-returning getElementById is only right for
  // testing a page's own explicit presence CHECK (e.g. `if
  // (document.getElementById('hardDeleteStatus')) ...`, used where one
  // shared script covers multiple page states) -- pass a real
  // `presentIds`/absence list via runScript's own DOM override for
  // that narrower case instead of changing this shared default.
  const el = () => ({
    value: '', checked: false, textContent: '', innerHTML: '', disabled: false,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    appendChild: () => {},
    remove: () => {},
    dataset: {},
    closest: () => el(),
  });
  return {
    window: { location: { search: '' }, addEventListener: () => {}, NotreLigue: {} },
    document: {
      getElementById: () => el(),
      querySelectorAll: () => [],
      querySelector: () => el(),
      addEventListener: () => {},
      createElement: () => el(),
      createRange: () => ({ selectNode: () => {} }),
      getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
      documentElement: { lang: '' },
      cookie: '',
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { language: 'en-US', clipboard: { writeText: async () => {} } },
    location: { search: '', href: '' },
  };
}

// Runs `combined` (the page's own concatenated inline scripts) followed
// by `tail` (a small snippet of test-only code, e.g. `return typeof
// submitContact;`) against the stub DOM above, returning whatever
// `tail` returns. Throws if `combined` itself has a syntax error --
// exactly the roster bug's own failure mode, at the exact moment it
// would have failed for a real browser.
export function runScript(combined, tail) {
  const stub = stubDom();
  const fn = new Function('window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location', combined + '\n' + (tail || ''));
  return fn(stub.window, stub.document, stub.localStorage, stub.sessionStorage, stub.navigator, stub.location);
}

export function extractInlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

export function assertNoSyntaxError(scripts, pageLabel) {
  for (const s of scripts) {
    expect(() => new Function(s), `${pageLabel}: inline script has a syntax error`).not.toThrow();
  }
}

// The cadAutoDrawHours bug class: a dict object embedded into the page
// via `var NAME = ${JSON.stringify(dict)};` silently drops any
// function-valued (or undefined-valued) property -- JSON.stringify
// just omits the key entirely, no error, no warning. Extracts that
// embedded object (by scanning the concatenated scripts for `var
// NAME = {...};`) and confirms every key this caller expects to exist
// really does, as a genuine string, in each language block. This is
// the generalized version of the specific bug: it would have caught
// cadAutoDrawHours going missing from I18N_COMMS regardless of why it
// went missing.
export function extractEmbeddedDict(combined, varName) {
  const re = new RegExp('var ' + varName + ' = (\\{[\\s\\S]*?\\});', 'm');
  const m = combined.match(re);
  if (!m) throw new Error(`embedded dict "${varName}" not found in script`);
  return JSON.parse(m[1]);
}

export function assertDictKeysPresent(dict, langs, expectedKeys) {
  for (const lang of langs) {
    const block = dict[lang];
    expect(block, `dict has no "${lang}" block`).toBeTruthy();
    for (const key of expectedKeys) {
      expect(typeof block[key], `dict.${lang}.${key} is missing or not a string (silently dropped by JSON.stringify?)`).toBe('string');
    }
  }
}
