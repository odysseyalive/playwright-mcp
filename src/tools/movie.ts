/**
 * movie.ts (tools) — record short captioned videos of a GUI, so a session can
 * explain a proposed interface change in motion: render a mock-up (or a live
 * local page), drive it with a saved step list, and hand back video files.
 *
 *   movie_script_save — save a named step list (the re-runnable core)
 *   movie_script_list — list saved step lists, or return one
 *   movie_record      — run a step list against one or more targets (url, file,
 *                       or HTML string) across viewports × light/dark, into one
 *                       per-job folder; optional before/after side-by-side
 *   movie_list        — what a job folder holds: paths, sizes, durations, posters
 *   movie_clean       — delete one job folder when the job is done
 *
 * The engine (paths, loopback server, overlay, recorder, ffmpeg) is src/movie.ts;
 * this file is the MCP surface only. Interactive recording on the shared
 * browser_* browser is deliberately NOT here — see the DEC
 * (DEC-2026-11-16-movie-tools-scripted-recorder) for why it was deferred.
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ToolContext } from '../tools.js';
import { wrapUntrusted } from '../exfil.js';
import {
  MAX_OUTPUT_BYTES,
  STEP_ACTIONS,
  VIEWPORT_PRESETS,
  checkSlug,
  describeJob,
  listJobs,
  listScripts,
  loadScript,
  moviesRoot,
  parseSchemes,
  parseSteps,
  parseTargets,
  parseViewports,
  recordMovie,
  removeJob,
  saveScript,
  type ClipRecord,
} from '../movie.js';
import { startHeartbeat } from './session.js';

const errorResult = (err: unknown): CallToolResult => ({
  content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

const MB = (MAX_OUTPUT_BYTES / 1024 / 1024).toFixed(0);

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...STEP_ACTIONS] },
    target: {
      type: 'string',
      description:
        'Playwright selector for the element the step acts on: CSS (`#swap`, `[data-space=W1]`), ' +
        '`text=Confirm`, or `role=button[name="Save"]`. The first match is used.',
    },
    url: { type: 'string', description: 'navigate: absolute http(s) URL, or a path resolved against the target ("/settings").' },
    text: { type: 'string', description: 'type: text typed key by key.' },
    key: { type: 'string', description: 'press: key name, e.g. Enter, Escape, Tab, ArrowDown.' },
    ms: { type: 'number', description: 'wait: milliseconds to pause (max 10000).' },
    dy: { type: 'number', description: 'scroll: pixels to wheel-scroll when there is no target.' },
    caption: { type: 'string', description: 'Caption burned into the video from this step on. "" clears it.' },
    highlight: {
      description: 'true draws a box around `target`; a selector string boxes that element instead.',
      anyOf: [{ type: 'boolean' }, { type: 'string' }],
    },
    highlightStyle: { type: 'string', enum: ['box', 'spotlight'], description: 'spotlight dims everything else.' },
    holdMs: { type: 'number', description: 'Pause after the step so a viewer can follow (default 900, max 5000).' },
    optional: {
      type: 'boolean',
      description: 'Skip this step, with a note, when its target is missing — for a "before" page that lacks the new control.',
    },
  },
  required: ['action'],
};

// ── movie_script_save ─────────────────────────────────────────────────────────

const scriptSaveDefinition: Tool = {
  name: 'movie_script_save',
  description:
    'Save a named step list for movie_record, so the same walk-through re-runs in one call after the ' +
    'mock-up changes. Steps use a closed vocabulary — navigate, click, type, hover, press, wait, scroll — ' +
    'each with an optional caption (burned into the video), highlight (box or spotlight) and holdMs. ' +
    'Saving under an existing name replaces it.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Script name: letters, digits, "_" and "-", up to 64 characters.' },
      description: { type: 'string', description: 'One line saying what the walk-through shows.' },
      steps: { type: 'array', items: STEP_SCHEMA, description: 'The steps, in order (at most 60).' },
    },
    required: ['name', 'steps'],
  },
};

async function scriptSaveHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const s = saveScript(checkSlug('name', args.name), args.steps, args.description);
    return json({ saved: s.name, steps: s.steps.length, note: `record it with movie_record({job, scriptName:"${s.name}", targets})` });
  } catch (err) {
    return errorResult(err);
  }
}

// ── movie_script_list ─────────────────────────────────────────────────────────

const scriptListDefinition: Tool = {
  name: 'movie_script_list',
  description: 'List saved movie scripts (name, description, step count). Pass `name` to get that script\'s full steps.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Return this one script in full.' } },
  },
};

async function scriptListHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    if (args.name !== undefined) return json(loadScript(checkSlug('name', args.name)));
    return json({ scripts: listScripts() });
  } catch (err) {
    return errorResult(err);
  }
}

// ── movie_record ──────────────────────────────────────────────────────────────

const recordDefinition: Tool = {
  name: 'movie_record',
  description:
    'Record a captioned demo video of a GUI: run a step list against each target and save one clip per ' +
    'target × viewport × color scheme into a per-job folder. Use it to SHOW a proposed GUI change — a ' +
    'mock-up from an HTML file or string, or a live local page — instead of describing it. Mock-ups are ' +
    'served from an internal loopback server confined to the mock-up\'s folder (no file://, no http.server) ' +
    'and run OFFLINE: nothing outside that folder loads, so vendor fonts/libraries into it. ' +
    'Each clip has a visible cursor, click ripples, the step captions, optional highlight boxes and a corner ' +
    'badge with the target label. Always writes .webm + a .png poster; adds .mp4 (and .gif on request) when a ' +
    'system ffmpeg with h264/gif is found, and says so when it is not. Two targets + sideBySide:true also ' +
    'makes a before/after composite (ffmpeg). Re-running the same script into the same job replaces those ' +
    `clips. Outputs over ${MB} MB are flagged. Long matrices take a while; movie_list shows what finished. ` +
    'Clean up with movie_clean when the job is complete.',
  inputSchema: {
    type: 'object',
    properties: {
      job: {
        type: 'string',
        description: 'Job id (letters, digits, "_" and "-", up to 64): the folder every output of this job lands in.',
      },
      scriptName: { type: 'string', description: 'A script saved with movie_script_save.' },
      script: { type: 'array', items: STEP_SCHEMA, description: 'Inline steps, instead of scriptName.' },
      targets: {
        type: 'array',
        description:
          'What to record, 1-4 entries, each with a label (shown as the corner badge and used in file names) ' +
          'and exactly one of: url (http(s), e.g. a local dev server), file (path to a local .html mock-up; its ' +
          'folder is served, dot-files never), html (an HTML string, saved into the job folder). For ' +
          'before/after, give two: [{label:"before", url:…}, {label:"after", file:…}].',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            url: { type: 'string' },
            file: { type: 'string' },
            html: { type: 'string' },
          },
          required: ['label'],
        },
      },
      viewports: {
        type: 'array',
        description:
          `Presets (${Object.values(VIEWPORT_PRESETS).map((v) => `${v.name} ${v.width}x${v.height}`).join(', ')}) ` +
          'or {name, width, height, mobile?}. Default ["desktop"].',
        items: {
          anyOf: [
            { type: 'string', enum: Object.keys(VIEWPORT_PRESETS) },
            {
              type: 'object',
              properties: { name: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' } },
              required: ['name', 'width', 'height'],
            },
          ],
        },
      },
      schemes: {
        type: 'array',
        items: { type: 'string', enum: ['light', 'dark'] },
        description: 'prefers-color-scheme to emulate. Default ["light"].',
      },
      session: {
        type: 'string',
        description:
          'A session_login capture to record a page behind a login. Applied to url targets only, and only on ' +
          'the domains the session was captured on; never to mock-ups.',
      },
      sideBySide: { type: 'boolean', description: 'With exactly two targets, also write a before|after composite per viewport/scheme.' },
      gif: { type: 'boolean', description: 'Also write a small looping .gif preview per clip (needs ffmpeg).' },
    },
    required: ['job', 'targets'],
  },
};

/** A clip's error is a Playwright error, which can quote the page's DOM: it is page-derived. */
function splitErrors(clips: ClipRecord[]) {
  const errors: string[] = [];
  const clean = clips.map(({ error, ...rest }) => {
    if (error) errors.push(`${rest.target}/${rest.viewport}/${rest.scheme}: ${error}`);
    return error ? { ...rest, failed: true } : rest;
  });
  return { clean, errors };
}

async function recordHandler(args: Record<string, unknown>, ctx?: ToolContext): Promise<CallToolResult> {
  let status = 'starting';
  const stop = startHeartbeat(ctx, 'movie_record', (what, ms) => `${what}: ${status} (${Math.round(ms / 1000)}s)`);
  try {
    const job = checkSlug('job', args.job);
    if ((args.script === undefined) === (args.scriptName === undefined))
      throw new Error('give exactly one of scriptName (saved with movie_script_save) or script (inline steps)');
    const named = args.scriptName !== undefined ? loadScript(checkSlug('scriptName', args.scriptName)) : undefined;
    const result = await recordMovie({
      job,
      scriptName: named?.name ?? 'inline',
      steps: named?.steps ?? parseSteps(args.script),
      targets: parseTargets(args.targets),
      viewports: parseViewports(args.viewports),
      schemes: parseSchemes(args.schemes),
      session: args.session !== undefined ? String(args.session) : undefined,
      sideBySide: args.sideBySide === true,
      gif: args.gif === true,
      signal: ctx?.signal,
      onStatus: (line) => (status = line),
    });
    const { clean, errors } = splitErrors(result.clips);
    const content: CallToolResult['content'] = [
      {
        type: 'text',
        text: JSON.stringify(
          {
            job: result.job,
            dir: result.dir,
            clips: clean,
            composites: result.composites,
            notes: result.notes.length ? result.notes : undefined,
            next: 'movie_list({job}) for sizes and durations; movie_clean({job}) when the job is complete.',
          },
          null,
          2,
        ),
      },
    ];
    if (errors.length)
      content.push(
        { type: 'text', text: `${errors.length} clip(s) stopped early; the recording up to that point was kept. Playwright said:` },
        { type: 'text', text: wrapUntrusted(errors.join('\n'), 'movie_record') },
      );
    return { content };
  } catch (err) {
    return errorResult(err);
  } finally {
    stop();
  }
}

// ── movie_list ────────────────────────────────────────────────────────────────

const listDefinition: Tool = {
  name: 'movie_list',
  description:
    'List movie jobs (no args) or one job\'s outputs ({job}): absolute paths, byte sizes, durations, posters, ' +
    `and which files are over the ${MB} MB embed limit. Use it to hand the files off, or to see what a ` +
    'cut-short movie_record call finished.',
  inputSchema: {
    type: 'object',
    properties: { job: { type: 'string', description: 'The job id to describe.' } },
  },
};

async function listHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    if (args.job === undefined) return json({ root: moviesRoot(), jobs: listJobs() });
    const job = checkSlug('job', args.job);
    let d;
    try {
      d = describeJob(job);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`no job "${job}"`);
      throw err;
    }
    const errors = d.clips.filter((c) => c.error).map((c) => `${c.target}/${c.viewport}/${c.scheme}: ${c.error}`);
    const clips = d.clips.map(({ error, ...rest }) => (error ? { ...rest, failed: true } : rest));
    const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify({ ...d, clips }, null, 2) }];
    if (errors.length) content.push({ type: 'text', text: wrapUntrusted(errors.join('\n'), 'movie_list') });
    return { content };
  } catch (err) {
    return errorResult(err);
  }
}

// ── movie_clean ───────────────────────────────────────────────────────────────

const cleanDefinition: Tool = {
  name: 'movie_clean',
  description:
    'Delete one movie job folder and everything in it, once the job is complete and the files are handed ' +
    'off. Only folders movie_record made are removed; saved scripts are kept.',
  inputSchema: {
    type: 'object',
    properties: { job: { type: 'string', description: 'The job id to delete.' } },
    required: ['job'],
  },
};

async function cleanHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const job = checkSlug('job', args.job);
    try {
      return json(removeJob(job));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`no job "${job}" (already cleaned?)`);
      throw err;
    }
  } catch (err) {
    return errorResult(err);
  }
}

export const movieScriptSaveTool = { definition: scriptSaveDefinition, handler: scriptSaveHandler };
export const movieScriptListTool = { definition: scriptListDefinition, handler: scriptListHandler };
export const movieRecordTool = { definition: recordDefinition, handler: recordHandler };
export const movieListTool = { definition: listDefinition, handler: listHandler };
export const movieCleanTool = { definition: cleanDefinition, handler: cleanHandler };
