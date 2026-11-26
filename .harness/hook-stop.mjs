#!/usr/bin/env node
/**
 * .harness/hook-stop.mjs — Multi-editor Stop hook (Claude Code `.claude/settings.json` & Antigravity `.agents/hooks.json`).
 * Prevents an AI orchestrator from declaring work "done" while an active visible.mjs run is unverified,
 * or passed checks but still awaits a required reviewer judge or UI visual review.
 *
 *   node .harness/hook-stop.mjs          Claude Code Stop hook (reads JSON on stdin; exit 2 + stderr blocks stop)
 *   node .harness/hook-stop.mjs --agy    Antigravity Stop hook (reads JSON on stdin; stdout JSON `{ decision: "continue", reason }` or `{}`)
 *   node .harness/hook-stop.mjs --help   print this help and exit 0
 *
 * Silent for harness workers (`HARNESS_WORKER=1`), on loop-continuation re-entries (`stop_hook_active` / `continuationActive`),
 * on user cancel / error / budget termination, or when no run is waiting. Zero dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISIBLE_TERMINAL } from './lib/handoff.mjs';
import { judgeApproved, visualPending } from './lib/guard.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('hook-stop.mjs — Stop hook for Claude Code (.claude/settings.json) and Antigravity (.agents/hooks.json). Blocks premature completion when a visible.mjs run is still DELEGATED/FAILED/REVIEW_BLOCKED or awaits judge/visual review. Silent for workers and on re-entry.');
  process.exit(0);
}

const AGY_FLAG = process.argv.includes('--agy');

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function resolveRoot(call) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR || process.env.HARNESS_ROOT;
  if (fromEnv) return path.resolve(fromEnv);
  const fromCall = call?.cwd || (Array.isArray(call?.workspacePaths) && call.workspacePaths[0]);
  if (fromCall && typeof fromCall === 'string') return path.resolve(fromCall);
  const cwd = process.cwd();
  if (path.basename(cwd).toLowerCase() === '.agents' && fs.existsSync(path.join(cwd, '..', '.harness'))) {
    return path.resolve(cwd, '..');
  }
  return path.resolve(cwd);
}

function listVisibleRunsAt(root) {
  const dir = path.join(root, '.harness', 'visible');
  try {
    return fs.readdirSync(dir)
      .map((d) => readJsonSafe(path.join(dir, d, 'run.json'), null))
      .filter(Boolean)
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id || '').localeCompare(String(b.id || '')));
  } catch { return []; }
}

export function pendingStopReason(root) {
  const runs = listVisibleRunsAt(root);
  if (!runs.length) return '';
  // 1. Open run that was already delegated/failed/review-blocked and never verified to PASSED or rolled back
  const open = runs.filter((r) => !VISIBLE_TERMINAL.has(r.status) && ['DELEGATED', 'FAILED', 'REVIEW_BLOCKED'].includes(r.status));
  if (open.length) {
    const r = open[open.length - 1];
    return `Unfinished harness run ${r.id} ("${r.title}", status ${r.status}). Run \`node .harness/visible.mjs verify ${r.id}\` (or \`rollback ${r.id}\`) before finishing.`;
  }
  // 2. Passed run still awaiting mandatory judge or UI visual gate
  const awaiting = runs.filter((r) => r.status === 'PASSED' && ((r.reviewRequired && !judgeApproved(r)) || visualPending(r)));
  if (awaiting.length) {
    const r = awaiting[awaiting.length - 1];
    const parts = [];
    if (r.reviewRequired && !judgeApproved(r)) parts.push(`reviewer judge (\`node .harness/visible.mjs judge ${r.id} --agent reviewer --file <report>\`)`);
    if (visualPending(r)) parts.push(`visual review (\`node .harness/visible.mjs visual attach ${r.id} ...\` or human \`visual confirm ${r.id}\`)`);
    return `Run ${r.id} ("${r.title}") passed checks but is NOT DONE yet — still awaiting ${parts.join(' and ')}.`;
  }
  return '';
}

const normScript = (p) => {
  try { p = fs.realpathSync.native(p); } catch { p = path.resolve(p); }
  return process.platform === 'win32' ? p.toLowerCase() : p;
};
const isMain = Boolean(process.argv[1]) && normScript(process.argv[1]) === normScript(fileURLToPath(import.meta.url));
if (isMain) {
  const allowStop = (isAgy) => { if (isAgy) console.log('{}'); process.exit(0); };
  if (process.env.HARNESS_WORKER === '1') allowStop(AGY_FLAG);

  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { allowStop(AGY_FLAG); }
  let call = {};
  try { call = raw.trim() ? JSON.parse(raw) : {}; } catch { allowStop(AGY_FLAG); }

  const isAgy = AGY_FLAG || call?.hookEventName === 'Stop' || call?.continuationActive !== undefined || call?.terminationReason !== undefined;
  // Never loop infinitely or override cancel/error/budget exits
  if (call?.stop_hook_active === true || call?.continuationActive === true) allowStop(isAgy);
  if (isAgy && call?.terminationReason && call.terminationReason !== 'NO_TOOL_CALL') allowStop(true);

  const root = resolveRoot(call);
  const reason = pendingStopReason(root);
  if (!reason) allowStop(isAgy);

  if (isAgy) {
    console.log(JSON.stringify({ decision: 'continue', reason: `[harness stop gate] ${reason}` }));
    process.exit(0);
  }
  process.stderr.write(`[harness stop gate] ${reason}\n`);
  process.exit(2);
}
