/**
 * A faithful TypeScript port of the harness's own routing rules, so the simulator shows what the real
 * controller does:
 *   - planEngineRouting  ← .harness/lib/governance.mjs
 *   - chooseModelTier    ← .harness/lib/common.mjs
 *   - model aliases      ← .harness/config.json  (profiles.<engine>.models)
 * If you change those rules in the harness, change them here too.
 */

export type Engine = 'claude' | 'antigravity' | 'codex' | 'gemini';
export type Tier = 'fast' | 'medium' | 'high';
export type Job = 'plan' | 'code' | 'qa';

export const ENGINES: { id: Engine; label: string; cli: string }[] = [
  { id: 'claude', label: 'Claude Code', cli: 'claude' },
  { id: 'antigravity', label: 'Antigravity', cli: 'agy' },
  { id: 'codex', label: 'Codex', cli: 'codex' },
  { id: 'gemini', label: 'Gemini', cli: 'gemini' },
];

export const TIERS: Tier[] = ['fast', 'medium', 'high'];

/** config.json → profiles.<engine>.models. Aliases only (never pinned versions); null = no --model, the CLI's newest default. */
export const MODEL_ALIASES: Record<Engine, Record<Tier, string | null>> = {
  claude: { fast: 'haiku', medium: 'sonnet', high: 'opus' },
  antigravity: { fast: null, medium: null, high: null },
  codex: { fast: null, medium: null, high: null },
  gemini: { fast: null, medium: null, high: null },
};

export interface Routing { plan: Engine; code: Engine; qa: Engine }

/** governance.mjs planEngineRouting(): 0 → null, 1 → everywhere, 2 → plan vs code+QA, 3+ → plan / code / QA. */
export function planEngineRouting(available: Engine[]): Routing | null {
  const have = [...new Set(available)];
  if (!have.length) return null;
  if (have.length === 1) return { plan: have[0], code: have[0], qa: have[0] };
  const first = (prefs: Engine[], pool: Engine[] = have): Engine => prefs.find((k) => pool.includes(k)) || pool[0];
  const plan = first(['antigravity', 'gemini', 'codex', 'claude']);
  const rest = have.filter((k) => k !== plan);
  const code = first(['claude', 'codex', 'gemini', 'antigravity'], rest);
  if (have.length === 2) return { plan, code, qa: code };
  const qa: Engine = have.includes('codex') && code !== 'codex' ? 'codex' : have.includes('claude') ? 'claude' : code;
  return { plan, code, qa };
}

export type Role = 'PO_ARCHITECT' | 'BA_ANALYST' | 'DEV_ENGINEER' | 'QA_AUDITOR';
export const ROLE_JOB: Record<Role, Job> = { PO_ARCHITECT: 'plan', BA_ANALYST: 'plan', DEV_ENGINEER: 'code', QA_AUDITOR: 'qa' };

const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

export interface TierInput { kind: 'plan' | 'work'; level?: 'orchestrator' | 'lead'; role: Role; targetFiles?: string[]; promptChars?: number; cycle?: number }

/** Why a tier was chosen, as a code (the UI translates it). */
export type Reason =
  | { code: 'planCross' | 'planQa' | 'planSlice' | 'arch' | 'smallEdit' }
  | { code: 'qaSmall' | 'qaLarge' | 'docsSmall' | 'docsLarge' | 'coding'; files: number }
  | { code: 'escalated'; from: Tier; to: Tier; retry: number };

/** common.mjs chooseModelTier(): the cheapest tier that fits the job; each failed cycle escalates one tier. */
export function chooseModelTier({ kind, level, role, targetFiles = [], promptChars = 0, cycle = 1 }: TierInput): { tier: Tier; reasons: Reason[] } {
  const files = targetFiles.length;
  let tier: Tier; let why: Reason;
  if (kind === 'plan') {
    if (level === 'orchestrator' || role === 'PO_ARCHITECT' || role === 'BA_ANALYST') { tier = 'high'; why = { code: 'planCross' }; }
    else if (role === 'QA_AUDITOR') { tier = 'fast'; why = { code: 'planQa' }; }
    else { tier = 'medium'; why = { code: 'planSlice' }; }
  } else if (role === 'PO_ARCHITECT') { tier = 'high'; why = { code: 'arch' }; }
  else if (role === 'QA_AUDITOR' || (files > 0 && targetFiles.every((f) => DOC_FILE.test(f)))) {
    const qa = role === 'QA_AUDITOR';
    if (files <= 2 && promptChars <= 2000) { tier = 'fast'; why = { code: qa ? 'qaSmall' : 'docsSmall', files }; }
    else { tier = 'medium'; why = { code: qa ? 'qaLarge' : 'docsLarge', files }; }
  } else if (files <= 1 && promptChars <= 600) { tier = 'fast'; why = { code: 'smallEdit' }; }
  else { tier = 'medium'; why = { code: 'coding', files }; }
  const reasons: Reason[] = [why];
  const bump = Math.max(0, cycle - 1);
  if (bump) {
    const from = tier;
    tier = TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(tier) + bump)];
    if (tier !== from) reasons.push({ code: 'escalated', from, to: tier, retry: bump });
  }
  return { tier, reasons };
}

export function modelFor(engine: Engine, tier: Tier): string | null {
  return MODEL_ALIASES[engine][tier];
}

export const engineCli = (e: Engine) => ENGINES.find((x) => x.id === e)!.cli;
