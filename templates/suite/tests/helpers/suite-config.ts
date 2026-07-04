import fs from 'node:fs';
import path from 'node:path';

/**
 * Loader for e2e-suite.config.json — the ONE file that holds everything
 * project-specific about this suite (test-mode commands, allowlists). The
 * helpers stay project-agnostic by reading it instead of hardcoding.
 */

export interface SuiteConfig {
  project: string;
  session: string;
  env: { up: string; down: string; verifyUrl: string; verifyAbsent: string };
  integrity: { mode: 'enforce' | 'report' | 'off'; allow: string[] };
  errorCapture: { urlAllowlist: string[]; consoleAllowlist: string[]; fail4xx: boolean };
}

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'e2e-suite.config.json');

let cached: SuiteConfig | null = null;

export function suiteConfig(): SuiteConfig {
  if (cached) return cached;
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cached = {
    project: raw.project ?? 'app',
    session: raw.session ?? 'default',
    env: {
      up: raw.env?.up ?? '',
      down: raw.env?.down ?? '',
      verifyUrl: raw.env?.verifyUrl ?? '',
      verifyAbsent: raw.env?.verifyAbsent ?? '',
    },
    integrity: {
      mode: raw.integrity?.mode ?? 'enforce',
      allow: raw.integrity?.allow ?? [],
    },
    errorCapture: {
      urlAllowlist: raw.errorCapture?.urlAllowlist ?? [],
      consoleAllowlist: raw.errorCapture?.consoleAllowlist ?? [],
      fail4xx: Boolean(raw.errorCapture?.fail4xx),
    },
  };
  return cached;
}

export function toRegExps(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p));
}
