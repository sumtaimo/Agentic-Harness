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

function exec(script, args, { cwd = ROOT, quiet = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
      cwd, env: { ...process.env, ...(quiet ? { HARNESS_SILENT: '1' } : {}) }
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

const csv = (v) => (Array.isArray(v) ? v.join(',') : v);

/**
 * Run one task. mode: 'normal' (1 worker, default) | 'parallel' (AI planner) | 'team' (hierarchy).
 * @param {{goal:string, files?:string[]|string, check?:string, mode?:string, engine?:string, maxCost?:number, branch?:string, wait?:boolean}} o
 */
export async function run(o = {}) {
  if (!o.goal || typeof o.goal !== 'string') throw new TypeError('run(): goal (string) is required');
  const mode = o.mode || 'normal';
  if (!['normal', 'parallel', 'team'].includes(mode)) throw new TypeError(`run(): unknown mode '${mode}'`);
  const args = ['--goal', o.goal, '--mode', mode];
  if (o.files) args.push('--files', csv(o.files));
  if (o.check) args.push('--check', o.check);
  if (o.engine) args.push('--engine', o.engine);
  if (o.maxCost !== undefined) args.push('--max-cost', String(o.maxCost));
  if (o.branch) args.push('--branch', o.branch);
  if (o.wait !== false) args.push('--wait');
  const r = await exec('dispatch.mjs', args, o);
  return { ...r, jobId: (r.stdout.match(/JOB_ID=(\S+)/) || [])[1] };
}

/** Add a backlog task (status READY by default) for autopilot. */
export async function addTask({ title, goal, files, role, check, status = 'READY' } = {}) {
  if (!title) throw new TypeError('addTask(): title is required');
  const args = ['add', title, '--status', status];
  if (goal) args.push('--goal', goal);
  if (files) args.push('--files', csv(files));
  if (role) args.push('--role', role);
  if (check) args.push('--check', check);
  return exec('backlog.mjs', args);
}

/** One autopilot step: run the next READY backlog task (inside charter.md). */
export const autopilotTick = () => exec('daemon.mjs', ['--tick']);
/** Current harness state (text). */
export const status = () => exec('status.mjs', []);
/** Setup check (ok=false when something must be fixed). */
export const doctor = () => exec('doctor.mjs', []);
