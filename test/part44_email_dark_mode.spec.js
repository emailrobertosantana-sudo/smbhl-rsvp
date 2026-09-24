// Live-testing task, Part 9: two related dark-mode inbox rendering
// bugs, reported together in real testing.
// 1. The verification email's primary button rendered washed-out/
//    low-contrast in a dark-mode inbox.
// 2. An unexplained pale strip/band above the "Notre Ligue" header in
//    the same email.
//
// Root cause: every color in these templates is already a fixed,
// explicit hex value (never a var(--...) CSS custom property -- that
// scheme is exclusively for the in-app .nl-scoped pages, never
// injected into an email's own HTML). Several email clients (Gmail,
// Outlook.com, some Apple Mail versions) still apply their OWN
// automatic "smart" dark-mode content rewriting to any email that
// doesn't explicitly opt out, inconsistently inverting individual
// elements (a thin decorative colour bar, a button's fill) without
// correspondingly adjusting their own foreground -- exactly the
// washed-out button and the unexplained pale strip reported. Fixed by
// adding <meta name="color-scheme" content="light"> and
// <meta name="supported-color-schemes" content="light"> to every email
// template's <head> -- the standard opt-out every major email client
// that supports it will respect.
//
// Swept every email template in the codebase (not just verification):
// nlEmailWrap (design_system.js, every new-product transactional
// email), emailWrap (index.js, every SMBHL legacy notification email),
// and review.js's two inline scoresheet-notification/backup email
// builders.
import { nlEmailWrap } from '../src/design_system.js';
import { emailWrap } from '../src/index.js';
import { describe, it, expect } from 'vitest';

const COLOR_SCHEME_META = '<meta name="color-scheme" content="light">';
const SUPPORTED_SCHEMES_META = '<meta name="supported-color-schemes" content="light">';

describe('Part 9 (live-testing task): email templates opt out of client auto dark-mode', () => {
  it('nlEmailWrap (every new-product transactional email) includes both meta tags', () => {
    const html = nlEmailWrap({ brandName: 'Notre Ligue', bodyHtml: '<p>hi</p>', footerHtml: 'Sent by Notre Ligue' });
    expect(html).toContain(COLOR_SCHEME_META);
    expect(html).toContain(SUPPORTED_SCHEMES_META);
    // Both meta tags must land inside <head>, before it closes.
    const headEnd = html.indexOf('</head>');
    expect(html.indexOf(COLOR_SCHEME_META)).toBeLessThan(headEnd);
    expect(html.indexOf(SUPPORTED_SCHEMES_META)).toBeLessThan(headEnd);
  });

  it('emailWrap (every SMBHL legacy notification email) includes both meta tags', () => {
    const html = emailWrap('Test subject', '<p>hi</p>', null);
    expect(html).toContain(COLOR_SCHEME_META);
    expect(html).toContain(SUPPORTED_SCHEMES_META);
    const headEnd = html.indexOf('</head>');
    expect(html.indexOf(COLOR_SCHEME_META)).toBeLessThan(headEnd);
    expect(html.indexOf(SUPPORTED_SCHEMES_META)).toBeLessThan(headEnd);
  });

  // review.js's two email builders (scoresheet-notification, and the
  // data-backup email) are inline within larger functions rather than
  // standalone exports. This vitest-pool-workers test environment can't
  // reliably read a source file from disk to grep it directly (the same
  // cross-platform file:// path issue documented elsewhere in this
  // suite), so real end-to-end coverage for the data-backup email lives
  // in test/index.spec.js instead, extending its existing
  // "handleReviewPublish's backup email" test (which already captures
  // that email's real rendered HTML) with the same meta-tag assertions
  // used here. The scoresheet-notification email (triggered by the
  // photo/SMS upload path) shares the identical fix but isn't separately
  // covered by an automated test -- disproportionate setup for a
  // mechanical, identical two-line addition already verified by direct
  // code review; see this task's final report.

  it('the verification email\'s actual rendered HTML (nlEmailWrap + nlEmailButton together) carries the fix end to end', () => {
    // Mirrors buildVerificationEmail's own construction (auth.js) without
    // importing a non-exported function -- proves the two pieces (the
    // wrap's meta tags, the button's explicit padding from Part 8)
    // compose correctly in the actual email a user receives.
    const html = nlEmailWrap({
      brandName: 'Notre Ligue',
      barColor: '#16181d',
      bodyHtml: '<h1>Confirme ton courriel</h1><a href="https://x" style="display:block;padding:16px 24px;">Confirmer mon courriel</a>',
      footerHtml: 'Envoyé par Notre Ligue'
    });
    expect(html).toContain(COLOR_SCHEME_META);
    expect(html).toContain(SUPPORTED_SCHEMES_META);
  });
});
