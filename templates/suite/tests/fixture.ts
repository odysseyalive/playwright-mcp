import { test as base, expect } from '@playwright/test';

import { attachErrorCapture, formatCapturedErrors } from './helpers/error-capture';
import type { ErrorCaptureHandle } from './helpers/error-capture';
import { attachPageIntegrity, scanPageIntegrity, formatFindings } from './helpers/page-integrity';
import type { IntegrityHandle, IntegrityMode } from './helpers/page-integrity';
import { suiteConfig } from './helpers/suite-config';

/**
 * Suite fixture — import { test, expect } from '../fixture' (never from
 * '@playwright/test' directly) so every spec gets, automatically:
 *
 *   errorCapture   report-only console/network/exception capture, attached to
 *                  the report as page-errors.txt (never fails a test)
 *   integrity      the page-integrity gate: scans every page load + a final
 *                  post-interaction pass; artifact-class findings FAIL the
 *                  test under 'enforce' (project default in
 *                  e2e-suite.config.json; per-spec override:
 *                  test.use({ pageIntegrity: 'report' | 'off' }))
 */

type TestOptions = {
  pageIntegrity: IntegrityMode | undefined;
};

type TestFixtures = {
  errorCapture: ErrorCaptureHandle;
  integrity: IntegrityHandle;
  _suiteAuto: void;
};

export const test = base.extend<TestFixtures & TestOptions>({
  pageIntegrity: [undefined, { option: true }],

  errorCapture: async ({ page }, use, testInfo) => {
    const handle = attachErrorCapture(page);
    await use(handle);
    if (handle.errors.length > 0) {
      await testInfo.attach('page-errors.txt', {
        body: formatCapturedErrors(handle),
        contentType: 'text/plain',
      });
    }
  },

  integrity: async ({ page, pageIntegrity }, use, testInfo) => {
    const mode = pageIntegrity ?? suiteConfig().integrity.mode;
    if (mode === 'off') {
      await use({ findings: [], allow: [] });
      return;
    }
    const handle = attachPageIntegrity(page);
    await use(handle);
    await scanPageIntegrity(page, handle);

    if (handle.findings.length > 0) {
      await testInfo.attach('page-integrity.txt', {
        body: formatFindings(handle.findings),
        contentType: 'text/plain',
      });
    }
    const fails = handle.findings.filter((f) => f.severity === 'fail');
    if (mode === 'enforce' && fails.length > 0) {
      throw new Error(
        `Page integrity violations (${fails.length}) — broken HTML / rendered artifacts:\n` +
          formatFindings(fails),
      );
    }
  },

  _suiteAuto: [
    async ({ errorCapture, integrity }, use) => {
      void errorCapture;
      void integrity;
      await use();
    },
    { auto: true },
  ],
});

export { expect };
