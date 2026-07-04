import { execSync } from 'node:child_process';
import { suiteConfig } from './helpers/suite-config';

/**
 * Environment guard (up) — puts the SITE into test mode on EVERY invocation,
 * including ad-hoc single-spec runs. The #1 source of "mysteriously broken
 * tests" is authoring/running specs against a site in the wrong mode; wiring
 * the mode switch into globalSetup makes every run identical.
 *
 * The command itself is project data (e2e-suite.config.json `env.up`) — e.g.
 * flip a flag file AND reload the app server. If your server caches config
 * per worker process, a flip WITHOUT a reload leaves warm workers serving the
 * old mode intermittently — the nastiest failure shape. Put the reload in the
 * command.
 *
 * Escape hatches: SKIP_ENV_GUARD=1 (touch nothing — something else manages the
 * mode), KEEP_ENV=1 (set up, but leave test mode up after the run — useful for
 * interactive browser-tool discovery between runs).
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.SKIP_ENV_GUARD) {
    console.log('[env-guard] SKIP_ENV_GUARD set — not touching site mode');
    return;
  }
  const { env } = suiteConfig();
  if (env.up) {
    console.log(`[env-guard] up: ${env.up}`);
    // execSync-with-shell is deliberate: env.up is a shell command line the
    // PROJECT OWNER wrote in their own e2e-suite.config.json (npm-scripts
    // trust model) — pipes/&& are the point. Never interpolate runtime data.
    execSync(env.up, { stdio: 'inherit' });
  }
  if (env.verifyUrl) {
    const res = await fetch(env.verifyUrl).catch(() => null);
    if (!res || !res.ok) {
      throw new Error(`[env-guard] verifyUrl unreachable after env.up: ${env.verifyUrl}`);
    }
    if (env.verifyAbsent) {
      const body = await res.text();
      if (body.includes(env.verifyAbsent)) {
        throw new Error(
          `[env-guard] test mode did not take effect: "${env.verifyAbsent}" still present at ${env.verifyUrl}. ` +
            `If the app caches config per worker, env.up must include a server reload.`,
        );
      }
    }
  }
}
