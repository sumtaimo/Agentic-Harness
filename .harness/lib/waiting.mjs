/**
 * .harness/lib/waiting.mjs — one list of everything that waits for the owner, so nothing is scattered:
 * features to review, 🟡 decisions, bug hunts to review, held "needs your OK" items, BLOCKED items, failed jobs.
 * Read-only. Each entry: { kind, id, text, next } — `next` is the one command that moves it on.
 */
import fs from 'node:fs';
import { DIRS } from './common.mjs';
import { readBacklog } from './governance.mjs';

export function needsYou(b = readBacklog()) {
  const out = [];
  for (const f of Array.isArray(b.features) ? b.features : []) {
    if (f.status === 'DRAFT') {
      const open = (f.steps || []).filter((s) => s.needsDecision).length;
      out.push({ kind: 'feature', id: f.id, text: `feature "${f.goal}": ${f.steps.length} step(s) to keep or drop${open ? `, ${open} 🟡 decision(s)` : ''}`, next: `node .harness/feature.mjs show ${f.id}` });
    } else if (f.status === 'DRAFTING' && f.lastError) {
      out.push({ kind: 'feature', id: f.id, text: `feature "${f.goal}" could not be expanded: ${String(f.lastError).slice(0, 100)}`, next: `node .harness/feature.mjs expand ${f.id}` });
    }
  }
  for (const h of Array.isArray(b.hunts) ? b.hunts : []) {
    if (h.status === 'DRAFT') {
      const sure = (h.findings || []).filter((x) => x.confidence === 'confirmed').length;
      out.push({ kind: 'hunt', id: h.id, text: `bug hunt "${h.scope}": ${h.findings.length} finding(s) to keep or drop (${sure} confirmed)`, next: `node .harness/hunt.mjs show ${h.id}` });
    }
  }
  for (const t of b.tasks) {
    if (t.status !== 'BLOCKED') continue;
    const held = t.needsApproval;
    out.push({ kind: held ? 'ok' : 'blocked', id: t.id, text: `${t.title || t.goal}: ${String(t.blockedReason || (held ? 'needs your OK' : 'blocked')).slice(0, 120)}`,
      next: held ? `node .harness/backlog.mjs approve ${t.id}` : `node .harness/backlog.mjs ready ${t.id}  (after you decide)` });
  }
  // Failed jobs stay in .harness/failed/ for good; only recent ones (7 days) nag, so an old failure you dealt with does not
  // keep the list from ever being empty.
  let failed = 0;
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    failed = fs.readdirSync(DIRS.failed).filter((f) => f.endsWith('.json') && (() => { try { return fs.statSync(`${DIRS.failed}/${f}`).mtimeMs >= cutoff; } catch { return false; } })()).length;
  } catch { /* no folder */ }
  if (failed) out.push({ kind: 'failed', id: 'failed', text: `${failed} failed or halted job(s) in the last 7 days to look at`, next: 'see .harness/failed/*.trace.txt' });
  return out;
}

export function formatNeedsYou(list, { max = 8 } = {}) {
  if (!list.length) return ['Needs you: nothing — everything waiting on you is done.'];
  const icon = { feature: '🧩', hunt: '🐞', ok: '⏸', blocked: '✖', failed: '!' };
  return [`Needs you (${list.length}):`, ...list.slice(0, max).map((w) => `  ${icon[w.kind] || '-'} ${w.id}: ${w.text}\n      → ${w.next}`),
    ...(list.length > max ? [`  … ${list.length - max} more (node .harness/status.mjs --json)`] : [])];
}
