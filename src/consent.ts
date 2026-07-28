/**
 * consent.ts: cookie-consent handling for the stealth fetch path.
 *
 * Two layers, cheapest first:
 *
 *   1. SEED. A domain registry of consent cookies pre-written into the context
 *      before the first navigation, so the banner never renders at all. Use this
 *      for sites whose accept-cookie is known and stable.
 *
 *   2. DISMISS. For everything else, click the banner's accept control after
 *      load and before extraction. The shared fetch context is a PERSISTENT
 *      profile, so whatever the site sets on accept is written to disk and every
 *      later fetch of that domain skips the banner permanently. One click per
 *      domain, ever.
 *
 * Why this matters beyond politeness: a consent banner is usually the only
 * substantial prose block on a link-dense index page, so Readability selects the
 * privacy notice AS the article and the real content is silently discarded. That
 * failure is invisible without this module (see CONSENT_TELL in extract.ts).
 *
 * Never throws into the caller. A banner that cannot be dismissed degrades to
 * the consent-wall status rather than an exception.
 *
 * IMPORTANT: never log to stdout (MCP stdio stream). Use stderr.
 */

import type { BrowserContext, Page } from 'playwright';

const log = (...args: unknown[]) => console.error('[playwright-mcp:consent]', ...args);

/** Cookies known to suppress a domain's consent UI outright. */
interface ConsentSeed {
  name: string;
  value: string;
  domain: string;
  path: string;
}

/**
 * Registry of pre-seedable consent cookies. Add a row when a domain's accept
 * cookie is known and stable; otherwise rely on the dismiss pass below.
 */
export const CONSENT_SEEDS: ConsentSeed[] = [
  // Google: suppresses the EU consent interstitial so the SERP renders.
  { name: 'SOCS', value: 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg', domain: '.google.com', path: '/' },
  { name: 'CONSENT', value: 'YES+cb', domain: '.google.com', path: '/' },
];

/** Pre-seed known consent cookies so those sites render content, not a wall. */
export async function seedConsent(context: BrowserContext): Promise<void> {
  try {
    await context.addCookies(CONSENT_SEEDS);
  } catch (err) {
    log('consent seed skipped:', err instanceof Error ? err.message : err);
  }
}

/**
 * Accept-control selectors for the common consent frameworks, plus per-site
 * entries for custom implementations. Ordered most-specific first.
 */
const ACCEPT_SELECTORS = [
  '#onetrust-accept-btn-handler', // OneTrust
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', // Cookiebot (granular)
  '#CybotCookiebotDialogBodyButtonAccept', // Cookiebot (simple)
  '.truste-button1', // TrustArc
  '#didomi-notice-agree-button', // Didomi
  'button[data-testid="uc-accept-all-button"]', // Usercentrics
  'button.lnc-accept', // jw.org / wol.jw.org
  '.lnc-button--primary', // jw.org fallback (Accept is the primary control)
];

/** Button text that means "accept", for the framework-agnostic fallback. */
const ACCEPT_TEXT = /^\s*(accept|accept all|agree|i agree|allow all|allow cookies|got it|ok)\s*$/i;

/**
 * Markup that indicates a consent UI is present. Cheap gate: when this does not
 * match, dismissal is skipped entirely and no selector work happens.
 */
const CONSENT_MARKUP =
  /privacy settings|cookie (consent|banner|notice|policy)|we use cookies|cookies and similar technologies|onetrust|cybotcookiebot|truste|didomi|usercentrics|lnc-accept/i;

/**
 * Dismiss a cookie-consent banner if one is present. Returns true when a control
 * was clicked. Safe to call on every fetch: it no-ops fast when the page has no
 * consent markup, and it never throws.
 *
 * The text fallback only considers controls sitting inside a consent-ish
 * container, so an ordinary "OK" button elsewhere on the page is never clicked.
 */
export async function dismissConsent(page: Page): Promise<boolean> {
  try {
    const html = await page.content();
    if (!CONSENT_MARKUP.test(html)) return false;

    for (const selector of ACCEPT_SELECTORS) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 400 })) {
          await el.click({ timeout: 1_500, noWaitAfter: true });
          await settle(page);
          log(`dismissed via ${selector} on ${hostOf(page)}`);
          return true;
        }
      } catch {
        /* selector absent or not clickable; try the next one */
      }
    }

    // Framework-agnostic fallback, scoped to a consent container.
    const clicked = await page
      .evaluate((pattern: string) => {
        const accept = new RegExp(pattern, 'i');
        const inConsentContainer = (el: Element): boolean => {
          let node: Element | null = el;
          for (let depth = 0; node && depth < 6; depth++) {
            const id = node.id || '';
            const cls = typeof node.className === 'string' ? node.className : '';
            if (/cookie|consent|privacy|gdpr|banner/i.test(`${id} ${cls}`)) return true;
            node = node.parentElement;
          }
          return false;
        };
        const controls = [...document.querySelectorAll('button, a[role="button"], input[type="button"]')];
        for (const control of controls) {
          const label = (control as HTMLElement).innerText || (control as HTMLInputElement).value || '';
          if (!accept.test(label)) continue;
          if (!inConsentContainer(control)) continue;
          (control as HTMLElement).click();
          return true;
        }
        return false;
      }, ACCEPT_TEXT.source)
      .catch(() => false);

    if (clicked) {
      await settle(page);
      log(`dismissed via text fallback on ${hostOf(page)}`);
    }
    return clicked;
  } catch (err) {
    log('dismiss skipped:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Let the banner tear down and any deferred content render. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => {});
  await page.waitForTimeout(200).catch(() => {});
}

function hostOf(page: Page): string {
  try {
    return new URL(page.url()).hostname;
  } catch {
    return page.url();
  }
}
