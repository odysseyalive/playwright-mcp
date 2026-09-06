/**
 * suite.ts (tools) — the test-suite-builder trio. Everything an AI needs to
 * CREATE, EDIT, and AUDIT project e2e suites with this server, kept strictly
 * project-agnostic: templates + methodology ship here; fixtures, selectors,
 * credentials, and env commands stay in the target repo.
 *
 *   suite_scaffold    — write templates/suite/* (methodology pack + a
 *                       project-local .claude/skills/test-suite skill) into a
 *                       target project. Superset of session_scaffold_tests.
 *   suite_audit       — run a project's Playwright suite (or parse its last
 *                       JSON report) and return per-failure dossiers + the
 *                       TEST-DEFECT vs PRODUCT-BUG adjudication rubric. The
 *                       judgment stays with the calling model.
 *   suite_methodology — return the shipped playbook (single source: the same
 *                       reference files suite_scaffold writes).
 *
 * Spec: /session-method (Consumer 2 extension). DEC-2026-07-04-suite-builder-tools.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { wrapUntrusted } from '../exfil.js';
import { scaffold, SUITE_TEMPLATE_DIR } from '../scaffold.js';

const SKILL_REFS = path.join(SUITE_TEMPLATE_DIR, '.claude', 'skills', 'test-suite');

const ADJUDICATION_RUBRIC = `
ADJUDICATION RUBRIC (apply per failure, ONE at a time, evidence first):
- TEST-DEFECT — the software is right, the script is wrong: stale selector vs live DOM,
  wrong/stale fixture or test data, environment not established (login gate in the failure
  snapshot), session-shape violation (shared storageState on a session-mutating spec;
  "anonymous" test inheriting storageState), too-tight timing budget, mis-declared
  expectation. → FIX THE SCRIPT, re-run in isolation to green.
- PRODUCT-BUG — the app violates its own contract (error text rendered, wrong totals,
  missing records, 5xx) while the expectation matches intended behavior, reproduced under
  a correct freshly-verified setup. → Spec stays byte-for-byte untouched; report evidence +
  reproduction and hand off. NEVER relax an assertion or add a skip to go green.
- AMBIGUOUS — evidence supports both. → Present both readings to a human; never default
  toward the side you are allowed to edit.
Classify by EVIDENCE (attachments, server state, clean-condition repro), never by error
text alone — unrelated bugs can share one banner. Full workflow: suite_methodology
{ topic: "audit" }.`.trim();

/* ------------------------------------------------------------------ */
/* suite_scaffold                                                      */
/* ------------------------------------------------------------------ */

const scaffoldDefinition: Tool = {
  name: 'suite_scaffold',
  description:
    'Scaffold a full e2e TEST SUITE + methodology pack into a project: Playwright config ' +
    '(captured-session reuse, setup guard), environment guard (project-defined test-mode ' +
    'commands in e2e-suite.config.json), enforcing page-integrity gate, report-only error ' +
    'capture, session-isolation rules, AND a project-local .claude/skills/test-suite skill ' +
    'that teaches an AI to run/author/audit the suite. Use when a project needs an e2e ' +
    'suite built (superset of session_scaffold_tests). Writes only templates — no session ' +
    'data, no credentials; all project specifics stay in the target repo.',
  inputSchema: {
    type: 'object',
    properties: {
      outDir: {
        type: 'string',
        description:
          "Target project directory. Defaults to the server's working directory — pass " +
          'the project path explicitly to be sure.',
      },
      project: {
        type: 'string',
        description:
          'Project name baked into the generated skill/docs (letters, digits, . _ - only; ' +
          'default "app").',
      },
      session: {
        type: 'string',
        description: 'The session_login name the suite reuses (default "default").',
      },
      force: {
        type: 'boolean',
        description:
          'Overwrite existing files instead of refusing. WARNING: rewrites the whole template ' +
          'set, including files you have customized since scaffolding. Default false.',
      },
    },
  },
};

async function scaffoldHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const session = args.session ? String(args.session) : 'default';
  const project = args.project ? String(args.project) : 'app';
  const out = path.resolve(args.outDir ? String(args.outDir) : process.cwd());
  const force = Boolean(args.force);

  try {
    const written = scaffold({ session, project, out, force, templateDir: SUITE_TEMPLATE_DIR });
    const text =
      `Scaffolded the e2e suite + methodology pack into ${out}:\n` +
      written.map((rel) => `  ${rel}`).join('\n') +
      `\n\nNext steps:\n` +
      `  1. Fill e2e-suite.config.json (env.up/down = what "test mode" means for this app; may stay empty).\n` +
      `  2. Capture the login once: session_login({ name: "${session}", loginUrl: …, successSignal: …, headed: true }).\n` +
      `  3. npm i -D @playwright/test && npx playwright install chromium, then BASE_URL=… npx playwright test.\n` +
      `  4. The generated .claude/skills/test-suite/ skill documents the run/author/audit discipline —\n` +
      `     fill its "Project blanks" section with this project's fixtures and conventions.`;
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

/* ------------------------------------------------------------------ */
/* suite_audit                                                         */
/* ------------------------------------------------------------------ */

const auditDefinition: Tool = {
  name: 'suite_audit',
  description:
    "Audit a project's Playwright e2e suite: run it (run: true) or parse an existing JSON " +
    'report (reportPath), and get back per-failure dossiers (test, location, error, ' +
    'attachment paths) plus the TEST-DEFECT vs PRODUCT-BUG adjudication rubric. Use when ' +
    'tests fail and you must decide whether to fix the SCRIPT or report a real bug — the ' +
    'audit discipline fixes e2e scripts only and never papers over product bugs.',
  inputSchema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Project root containing the Playwright config (required).',
      },
      reportPath: {
        type: 'string',
        description:
          'Parse this existing Playwright JSON report (relative to cwd) instead of running. ' +
          'Suite-scaffolded projects write test-results/last-run.json on every run.',
      },
      run: {
        type: 'boolean',
        description:
          'Explicitly run `npx playwright test` in cwd (required when no reportPath — the ' +
          'tool never executes silently by default).',
      },
      specs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional spec files / filters passed to playwright test (run mode).',
      },
      timeoutMs: {
        type: 'number',
        description: 'Run-mode timeout in ms (default 600000, max 1800000).',
      },
    },
    required: ['cwd'],
  },
};

interface FailureDossier {
  test: string;
  location: string;
  project: string;
  status: string;
  retries: number;
  durationMs: number;
  error: string;
  attachments: { name: string; path: string }[];
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

/** Recursively collect failure dossiers + totals from a Playwright JSON report. */
function parseReport(report: unknown): { total: number; failures: FailureDossier[] } {
  let total = 0;
  const failures: FailureDossier[] = [];

  const walkSuites = (suites: any[]): void => {
    for (const suite of suites ?? []) {
      walkSuites(suite.suites);
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests ?? []) {
          total++;
          const last = t.results?.[t.results.length - 1];
          const ok = t.status === 'expected' || t.status === 'skipped' || last?.status === 'passed';
          if (ok || !last) continue;
          const err = last.errors?.[0] ?? last.error;
          failures.push({
            test: [suite.title, spec.title].filter(Boolean).join(' › ') || spec.title,
            location: `${spec.file}:${spec.line}:${spec.column}`,
            project: t.projectName ?? '',
            status: last.status ?? t.status,
            retries: (t.results?.length ?? 1) - 1,
            durationMs: last.duration ?? 0,
            error: stripAnsi(String(err?.message ?? err?.value ?? 'unknown error')).slice(0, 1200),
            attachments: (last.attachments ?? [])
              .filter((a: any) => a.path)
              .map((a: any) => ({ name: a.name, path: a.path })),
          });
        }
      }
    }
  };
  walkSuites((report as any)?.suites ?? []);
  return { total, failures };
}

function runPlaywright(
  cwd: string,
  specs: string[],
  reportFile: string,
  timeoutMs: number,
): Promise<{ stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'npx',
      ['playwright', 'test', ...specs, '--reporter=json'],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          // Both spellings: --reporter=json honors PLAYWRIGHT_JSON_OUTPUT_NAME;
          // suite-scaffolded configs also read PLAYWRIGHT_JSON_OUTPUT.
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
          PLAYWRIGHT_JSON_OUTPUT: reportFile,
        },
      },
      (err, _stdout, stderr) => {
        // Non-zero exit just means test failures — the report file is still the
        // source of truth. Only a missing report is a real execution error.
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('npx not found on PATH'));
          return;
        }
        if (err && String((err as Error & { killed?: boolean }).killed) === 'true') {
          reject(new Error(`playwright run timed out after ${timeoutMs}ms`));
          return;
        }
        resolve({ stderrTail: stripAnsi(stderr ?? '').slice(-2000) });
      },
    );
    void child;
  });
}

async function auditHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const cwd = path.resolve(String(args.cwd ?? ''));
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`cwd is not a directory: ${cwd}`);
    }

    let reportRaw: string;
    let ranNote = '';

    if (args.reportPath) {
      const p = path.resolve(cwd, String(args.reportPath));
      if (!fs.existsSync(p)) throw new Error(`report not found: ${p}`);
      reportRaw = fs.readFileSync(p, 'utf8');
      ranNote = `Parsed existing report: ${p}`;
    } else if (args.run === true) {
      const hasConfig = fs
        .readdirSync(cwd)
        .some((f) => /^playwright\.config\.(ts|js|mjs|cjs)$/.test(f));
      if (!hasConfig) throw new Error(`no playwright.config.* in ${cwd} — wrong project root?`);

      const specs = Array.isArray(args.specs) ? args.specs.map(String) : [];
      const timeoutMs = Math.min(Number(args.timeoutMs) || 600_000, 1_800_000);
      const reportFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'suite-audit-')),
        'report.json',
      );
      const { stderrTail } = await runPlaywright(cwd, specs, reportFile, timeoutMs);
      if (!fs.existsSync(reportFile)) {
        // Two provenances, two parts. The sentence is this server's; the tail is
        // a subprocess's stderr, which carries whatever a spec printed — page
        // text included — so it rides in a fence. Already truncated at the
        // resolve above: truncate first, wrap second, so no slice can cut a
        // delimiter in half.
        throw new Error(
          'playwright produced no JSON report. The stderr tail is quarantined below.\n' +
            wrapUntrusted(stderrTail, `playwright stderr (cwd ${cwd})`),
        );
      }
      reportRaw = fs.readFileSync(reportFile, 'utf8');
      ranNote = `Ran: npx playwright test ${specs.join(' ')} (cwd ${cwd})`;
    } else {
      throw new Error(
        'Pass reportPath (parse the last run) or run: true (execute the suite) — ' +
          'the tool never executes silently.',
      );
    }

    const { total, failures } = parseReport(JSON.parse(reportRaw));

    if (failures.length === 0) {
      return {
        content: [
          { type: 'text', text: `${ranNote}\n\nAUDIT CLEAN: ${total}/${total} tests passing. Nothing to adjudicate.` },
        ],
      };
    }

    const dossiers = failures
      .map(
        (f, i) =>
          `--- FAILURE ${i + 1}/${failures.length} ---\n` +
          `test:        ${f.test}\n` +
          `location:    ${f.location}\n` +
          `status:      ${f.status} (retries: ${f.retries}, ${Math.round(f.durationMs)}ms)\n` +
          `attachments: ${f.attachments.map((a) => `${a.name} → ${a.path}`).join('; ') || '(none)'}\n` +
          // The dossier headers above are this server's own words. `f.error` is
          // a Playwright failure message: page content, DOM fragments and
          // selectors that the site under test chose. It is quarantined because
          // ADJUDICATION_RUBRIC follows immediately below — server-authored
          // instructions telling the model to take action on what it just read.
          // Unfenced page text directly in front of those is the shape a
          // crafted failure message would exploit.
          //
          // Wrapped HERE and not at the `error:` assignment in parseReport: the
          // stripAnsi().slice() there must stay the outermost operation, so a
          // truncation can never cut a delimiter in half.
          `error:\n` +
          wrapUntrusted(f.error, `playwright failure: ${f.location}`),
      )
      .join('\n\n');

    const text =
      `${ranNote}\n\n${total - failures.length}/${total} passing, ${failures.length} failing.\n\n` +
      `${dossiers}\n\n${ADJUDICATION_RUBRIC}`;
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

/* ------------------------------------------------------------------ */
/* suite_methodology                                                   */
/* ------------------------------------------------------------------ */

const methodologyDefinition: Tool = {
  name: 'suite_methodology',
  description:
    'Return the e2e test-suite playbook this server ships (single source: the same files ' +
    'suite_scaffold installs). Topics: "overview" (the suite skill front page), ' +
    '"methodology" (the portable lessons), "authoring" (create/edit a spec), "audit" ' +
    '(classify failures, scripts-only fixes), "all". Use BEFORE creating, editing, or ' +
    'auditing e2e tests in any project.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        enum: ['overview', 'methodology', 'authoring', 'audit', 'all'],
        description: 'Which section to return (default "all").',
      },
    },
  },
};

const TOPIC_FILES: Record<string, string[]> = {
  overview: ['SKILL.md'],
  methodology: ['references/methodology.md'],
  authoring: ['references/authoring-workflow.md'],
  audit: ['references/audit-workflow.md'],
  all: [
    'SKILL.md',
    'references/methodology.md',
    'references/authoring-workflow.md',
    'references/audit-workflow.md',
  ],
};

async function methodologyHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const topic = String(args.topic ?? 'all');
    const files = TOPIC_FILES[topic];
    if (!files) throw new Error(`unknown topic: ${topic} (overview|methodology|authoring|audit|all)`);
    const text = files
      .map((rel) =>
        fs
          .readFileSync(path.join(SKILL_REFS, rel), 'utf8')
          .split('__PROJECT_NAME__')
          .join('<project>')
          .split('__SESSION_NAME__')
          .join('<session>'),
      )
      .join('\n\n---\n\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

export const suiteScaffoldTool = { definition: scaffoldDefinition, handler: scaffoldHandler };
export const suiteAuditTool = { definition: auditDefinition, handler: auditHandler };
export const suiteMethodologyTool = { definition: methodologyDefinition, handler: methodologyHandler };
