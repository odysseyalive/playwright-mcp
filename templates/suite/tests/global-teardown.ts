import { execSync } from 'node:child_process';
import { suiteConfig } from './helpers/suite-config';

/**
 * Environment guard (down) — restores normal site mode after the run.
 * See global-setup.ts for the full rationale and the escape hatches.
 */
export default async function globalTeardown(): Promise<void> {
  if (process.env.SKIP_ENV_GUARD) return;
  if (process.env.KEEP_ENV) {
    console.log('[env-guard] KEEP_ENV set — leaving test mode up');
    return;
  }
  const { env } = suiteConfig();
  if (env.down) {
    console.log(`[env-guard] down: ${env.down}`);
    // Same npm-scripts trust model as env.up — owner-authored shell line.
    execSync(env.down, { stdio: 'inherit' });
  }
}
