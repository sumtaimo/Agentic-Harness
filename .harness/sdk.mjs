/**
 * .harness/sdk.mjs — use the harness from your own JavaScript (scripts, CI), zero dependencies.
 *
 *   import { run, addTask, autopilotTick, status, doctor } from './.harness/sdk.mjs';
 *   const r = await run({ goal: 'Fix the login button', files: ['src/login.js'], check: 'npm test' });
 *   console.log(r.ok, r.jobId);
 *
 * Every function runs the same CLI scripts the humans use, so all rules (scopes, charter,
 * real check, rollback, budgets) apply exactly the same. Nothing here bypasses the controller.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

function exec(script, args, { cwd = ROOT, projectRoot = null, quiet = true } = {}) {
  const rootEnv = projectRoot && path.resolve(projectRoot) !== path.resolve(ROOT) ? { HARNESS_ROOT: path.resolve(projectRoot) } : {};
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
      cwd, env: { ...process.env, ...rootEnv, ...(quiet ? { HARNESS_SILENT: '1' } : {}) }
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

function parseJsonResult(r) {
  let data = null;
  try { data = JSON.parse(r.stdout); } catch { data = null; }
  return { ...r, data };
}

const csv = (v) => (Array.isArray(v) ? v.join(',') : v);

function formatWorkerArg(w) {
  if (typeof w === 'string') return w;
  if (w && typeof w === 'object') {
    const id = w.id || 'worker';
    const files = csv(w.files || w.targetFiles || []) || '';
    const prompt = w.prompt || w.goal || '';
    return `${id}:${files}:${prompt}`;
  }
  throw new TypeError('run(): each worker must be a "id:files:prompt" string or { id, files, prompt } object');
}

/**
 * Run one task. mode: 'normal' (1 worker, default) | 'parallel' (AI planner) | 'team' (hierarchy).
 * Also supports `resumeVisible` (boolean/runId), `cwd` (worktree path), `model`, `workers`, `title`, and `yes` (default true).
 * @param {{goal?:string, title?:string, files?:string[]|string, check?:string, mode?:string, engine?:string, model?:string, maxCost?:number, branch?:string, cwd?:string, resumeVisible?:boolean|string, workers?:Array<string|object>, yes?:boolean, wait?:boolean, projectRoot?:string, quiet?:boolean}} o
 */
export async function run(o = {}) {
  const hasWorkers = Array.isArray(o.workers) && o.workers.length > 0;
  if (!o.resumeVisible && !hasWorkers && (!o.goal || typeof o.goal !== 'string')) {
    throw new TypeError('run(): goal (string), workers, or resumeVisible is required');
  }
  const args = [];
  if (o.title) args.push('--title', String(o.title));
  if (o.goal) args.push('--goal', String(o.goal));
  if (o.mode !== undefined || !hasWorkers) {
    const mode = o.mode || 'normal';
    if (!['normal', 'parallel', 'team'].includes(mode)) throw new TypeError(`run(): unknown mode '${mode}'`);
    if (!(o.resumeVisible && o.mode === undefined)) args.push('--mode', mode);
  }
  if (o.files) args.push('--files', csv(o.files));
  if (o.check) args.push('--check', o.check);
  if (o.engine) args.push('--engine', o.engine);
  if (o.model) args.push('--model', String(o.model));
  if (o.maxCost !== undefined) args.push('--max-cost', String(o.maxCost));
  if (o.branch) args.push('--branch', o.branch);
  if (o.cwd) args.push('--cwd', String(o.cwd));
  if (o.resumeVisible) {
    if (typeof o.resumeVisible === 'string' && o.resumeVisible !== 'true') args.push('--resume-visible', o.resumeVisible);
    else args.push('--resume-visible');
  }
  if (hasWorkers) for (const w of o.workers) args.push('--worker', formatWorkerArg(w));
  if (o.yes !== false) args.push('--yes');
  if (o.wait !== false) args.push('--wait');
  const r = await exec('dispatch.mjs', args, { cwd: o.projectRoot || ROOT, quiet: o.quiet ?? true });
  return { ...r, jobId: (r.stdout.match(/JOB_ID=(\S+)/) || [])[1] };
}

/** Add a backlog task (status READY by default) for autopilot. */
export async function addTask({ title, goal, files, role, check, priority, skills, status = 'READY' } = {}) {
  if (!title) throw new TypeError('addTask(): title is required');
  const args = ['add', title, '--status', status];
  if (goal) args.push('--goal', goal);
  if (files) args.push('--files', csv(files));
  if (role) args.push('--role', role);
  if (check) args.push('--check', check);
  if (priority !== undefined) args.push('--priority', String(priority));
  if (skills) args.push('--skills', csv(skills));
  return exec('backlog.mjs', args);
}

/** One autopilot step: run the next READY backlog task (inside charter.md). */
export const autopilotTick = ({ force = false } = {}) => exec('daemon.mjs', force ? ['--tick', '--force'] : ['--tick']);
/** Current harness state (text). Optionally pass `{ log: N }` for telemetry lines. */
export const status = ({ log } = {}) => exec('status.mjs', log !== undefined ? ['--log', String(log)] : []);
/** Collected workspace/menu overview status as structured JSON (via start.mjs --json). */
export const statusJson = async () => parseJsonResult(await exec('start.mjs', ['--json']));
/** Compact 4-8 line editor summary (via hook-session.mjs --brief). */
export const statusBrief = ({ noFetch = false } = {}) => exec('hook-session.mjs', noFetch ? ['--brief', '--no-fetch'] : ['--brief']);
/** Alias for compact workspace overview summary (start.mjs --summary). */
export const statusSummary = () => exec('start.mjs', ['--summary']);
/** AI quota/token usage report (parsed JSON by default). */
export const usage = async ({ days, json = true } = {}) => {
  const args = [];
  if (days !== undefined) args.push('--days', String(days));
  if (json !== false) args.push('--json');
  const r = await exec('usage.mjs', args);
  return json !== false ? parseJsonResult(r) : r;
};
/** List editor-workflow runs (visible.mjs status). */
export const visibleStatus = () => exec('visible.mjs', ['status']);
/** Inspect / generate handoff prompt for an unfinished editor run. */
export const visibleHandoff = async ({ runId, json = true, prompt = false } = {}) => {
  const args = ['handoff', ...(runId ? [String(runId)] : [])];
  if (prompt) args.push('--prompt');
  else if (json !== false) args.push('--json');
  const r = await exec('visible.mjs', args);
  return !prompt && json !== false ? parseJsonResult(r) : r;
};
/** Inspect session board (child tasks & risk). */
export const sessionsBoard = async ({ json = true } = {}) => {
  const r = await exec('sessions.mjs', json !== false ? ['board', '--json'] : ['board']);
  return json !== false ? parseJsonResult(r) : r;
};
/** Retrieve task-ranked harness memory context (permanent rules + relevant auto-lessons). */
export const memoryContext = ({ goal, query, files, projectRoot } = {}) => {
  const args = ['context'];
  if (goal) args.push('--goal', String(goal));
  if (query) args.push('--query', String(query));
  if (files) args.push('--files', csv(files));
  return exec('memory.mjs', args, { cwd: projectRoot || ROOT, projectRoot });
};
/** Inspect configured agent team, scopes, models, and budgets. */
export const teamShow = () => exec('team.mjs', ['show']);
/** Preview or apply adaptive scope updates from project layout (team.mjs adapt-scopes). */
export const teamAdaptScopes = ({ apply = false, projectRoot } = {}) => exec('team.mjs', apply ? ['adapt-scopes', '--apply'] : ['adapt-scopes'], { cwd: projectRoot || ROOT, projectRoot });
/** Setup check (ok=false when something must be fixed). */
export const doctor = ({ deep = false } = {}) => exec('doctor.mjs', deep ? ['--deep'] : []);
