/**
 * .harness/lib/governance.mjs
 * v2 governance layer: charter policy, role personas, skills, backlog store, release snapshots.
 * Zero dependencies — Node.js 18+ standard library only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, HARNESS_DIR, DIRS, FILES, atomicWriteJson, readJsonSafe, ensureDirs, LESSONS_HEADER, AUTO_LESSONS_HEADER, safeTarget } from './common.mjs';

export const GOV = {
  charter: path.join(HARNESS_DIR, 'charter.md'),
  backlog: path.join(HARNESS_DIR, 'backlog.json'),
  roles: path.join(HARNESS_DIR, 'roles'),
  skills: path.join(HARNESS_DIR, 'skills'),
  releases: DIRS.releases
};

// ───────────────────────────── glob matching ─────────────────────────────

/** Minimal glob → RegExp. `**` any depth, `*` within a segment, `?` one char. No "/" in pattern = match any basename. */
export function globToRegex(glob) {
  const g = String(glob).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return g.includes('/') ? new RegExp(`^${re}$`) : new RegExp(`(^|/)${re}$`);
}

/** Does path p (or, for a folder target "dir/", anything inside it) match any glob? */
export function matchesAny(p, globs = []) {
  const n = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const probes = n.endsWith('/') ? [n.slice(0, -1), `${n}x`] : [n];
  return globs.some((g) => probes.some((x) => globToRegex(g).test(x)));
}

/** For a folder target: is EVERYTHING inside it allowed? (needs a glob that covers dir/**) */
export function withinAll(p, globs = []) {
  const n = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!n.endsWith('/')) return matchesAny(n, globs);
  return globs.some((g) => globToRegex(g).test(`${n}x`) && globToRegex(g).test(`${n}a/b/c.x`));
}

// ───────────────────────────── charter ─────────────────────────────

const LIST = (v) => String(v || '').split(',').map((s) => s.trim().replace(/^`|`$/g, '')).filter(Boolean);

/**
 * Read the charter. Machine-readable keys are plain bullets anywhere in charter.md:
 *   - autonomous: on | off
 *   - maxAutoTasksPerRun: 3
 *   - allowedPaths: src/**, docs/**, tests/**
 *   - forbiddenPaths: .git/**, node_modules/**, .env*
 *   - forbiddenTools: Bash(git push:*), Bash(git remote:*)
 *   - requireRealCheck: yes
 * Everything else in the file is prose given to the PO_ARCHITECT as objectives/context.
 */
export function readCharter(file = GOV.charter) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* no charter */ }
  const get = (key) => {
    const m = text.match(new RegExp(`^\\s*[-*]\\s*\\**${key}\\**\\s*:\\s*(.+?)\\s*$`, 'mi'));
    return m ? m[1].replace(/^`|`$/g, '') : undefined;
  };
  const yes = (v, d) => (v === undefined ? d : /^(on|yes|true|enabled|1)$/i.test(v.trim()));
  return {
    exists: !!text,
    text,
    autonomous: yes(get('autonomous'), false),
    maxAutoTasksPerRun: Math.max(0, Number.parseInt(get('maxAutoTasksPerRun') ?? '3', 10) || 0),
    allowedPaths: LIST(get('allowedPaths')),
    forbiddenPaths: LIST(get('forbiddenPaths') ?? '.git/**, .harness/**, node_modules/**, .env*'),
    forbiddenTools: LIST(get('forbiddenTools')),
    requireRealCheck: yes(get('requireRealCheck'), true)
  };
}

// ───────────────────────────── roles ─────────────────────────────

/** Load .harness/roles/*.json keyed by role name (e.g. DEV_ENGINEER). */
export function loadRoles() {
  const roles = {};
  try {
    for (const f of fs.readdirSync(GOV.roles).filter((x) => x.endsWith('.json'))) {
      const r = readJsonSafe(path.join(GOV.roles, f), null);
      if (r?.name) roles[String(r.name).toUpperCase()] = { ...r, file: f };
    }
  } catch { /* no roles dir */ }
  return roles;
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const baseTool = (rule) => String(rule).split('(')[0].trim();

/** Turn "dir/" into "dir/**" for permission rules. */
const toRulePath = (t) => (t.endsWith('/') ? `${t}**` : t);

/** The skill's tool list that applies to this role (its own override, else the default list). */
export const skillToolsFor = (skill, roleName) => skill.toolsByRole?.[String(roleName).toUpperCase()] ?? skill.allowedTools ?? [];

/** Does a role rule cover a skill rule? Same tool, and equal or a ":*" prefix match (Bash(npm:*) covers Bash(npm test:*)). */
function covers(roleRule, skillRule) {
  if (roleRule === skillRule) return true;
  const [rt, ri] = [baseTool(roleRule), (roleRule.match(/\((.*)\)$/) || [])[1]];
  const [st, si] = [baseTool(skillRule), (skillRule.match(/\((.*)\)$/) || [])[1]];
  if (rt !== st || ri === undefined || si === undefined) return false;
  if (!ri.endsWith(':*')) return false;
  const prefix = ri.slice(0, -2);
  return si === prefix || si.startsWith(`${prefix} `) || si.startsWith(`${prefix}:`);
}

/**
 * Compute the engine tool list for a worker:
 *  1. start from the role's allowedTools ("{targetFiles}" expands to one rule per target path;
 *     with no targets it expands to the role's writablePaths),
 *  2. a skill can only NARROW it. Per tool the skill lists either
 *       - a bare name ("Edit")        → keep the role's rules for that tool unchanged, or
 *       - exact rules ("Bash(npm test:*)") → replace the role's rules for that tool by those skill
 *         rules that the role already covers (a skill can never grant a command the role lacks).
 *     Tools the skill does not mention are dropped (read-only tools are always kept).
 *  Returns the rules; use explainSkillNarrowing() for what a skill asked for but did not get.
 */
export function computeAllowedTools(role, skills, targetFiles) {
  const targets = (targetFiles || []).length ? targetFiles.map(toRulePath) : (role.writablePaths || []);
  let rules = [];
  for (const rule of role.allowedTools || []) {
    if (rule.includes('{targetFiles}')) targets.forEach((t) => rules.push(rule.replace('{targetFiles}', t)));
    else rules.push(rule);
  }
  for (const s of skills) {
    const list = skillToolsFor(s, role.name);
    if (!Array.isArray(list) || list.length === 0) continue;
    const bare = new Set(list.filter((r) => !r.includes('(')).map(baseTool));
    const exact = new Map();
    for (const r of list.filter((x) => x.includes('('))) exact.set(baseTool(r), [...(exact.get(baseTool(r)) || []), r]);
    const before = rules;
    const out = [];
    for (const r of before) {
      const t = baseTool(r);
      if (READ_ONLY_TOOLS.has(t) || bare.has(t)) out.push(r);
    }
    for (const [t, skillRules] of exact) {
      if (bare.has(t)) continue; // a bare name already keeps the role's rules
      for (const sr of skillRules) if (before.some((r) => covers(r, sr))) out.push(sr);
    }
    rules = out;
  }
  return [...new Set(rules)];
}

/** Skill rules the role does NOT cover (asked for, not granted) — for logs and Doctor. */
export function skillRulesNotGranted(role, skills) {
  const roleRules = role.allowedTools || [];
  const missing = [];
  for (const s of skills) for (const r of skillToolsFor(s, role.name)) {
    if (r.includes('(') && !roleRules.some((rr) => covers(rr, r))) missing.push(`${s.name}: ${r}`);
  }
  return missing;
}

/** Charter forbidden paths + tools → engine deny rules (Claude: --disallowedTools). */
export function computeDisallowedTools(charter) {
  const rules = [];
  for (const p of charter.forbiddenPaths || []) { rules.push(`Edit(${p})`, `Write(${p})`); }
  return [...new Set([...rules, ...(charter.forbiddenTools || [])])];
}

// ───────────────────────────── skills ─────────────────────────────

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w.-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) {
      try { v = JSON.parse(v); } catch { v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean); }
    } else if (/^(true|false)$/i.test(v)) v = /^true$/i.test(v);
    else v = v.replace(/^["']|["']$/g, '');
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

/** Load .harness/skills/<name>/SKILL.md → { name: {name, description, roles[], allowedTools[], keywords[], autoApply, body, raw} } */
export function loadSkills() {
  const skills = {};
  try {
    for (const dir of fs.readdirSync(GOV.skills, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const file = path.join(GOV.skills, dir.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const name = String(meta.name || dir.name);
      skills[name] = {
        name,
        description: String(meta.description || ''),
        roles: (Array.isArray(meta.roles) ? meta.roles : []).map((r) => String(r).toUpperCase()),
        allowedTools: Array.isArray(meta.allowedTools) ? meta.allowedTools : [],
        // optional per-role override: "allowedTools.DEV_ENGINEER: [...]" replaces the default list for that role only
        toolsByRole: Object.fromEntries(Object.entries(meta).filter(([k, v]) => /^allowedTools\./.test(k) && Array.isArray(v)).map(([k, v]) => [k.slice('allowedTools.'.length).toUpperCase(), v])),
        keywords: Array.isArray(meta.keywords) ? meta.keywords.map(String) : [],
        autoApply: meta.autoApply === true,
        body: body.trim(),
        raw,
        dir: dir.name
      };
    }
  } catch { /* no skills dir */ }
  return skills;
}

/**
 * Pick skills for a worker. Explicit `skills` win; otherwise skills whose roles include the
 * worker's role AND (autoApply OR a keyword appears in the prompt). A skill whose `roles` list
 * excludes the role is never injected (reported as a mismatch).
 */
export function matchSkills(sub, roleName, allSkills) {
  const chosen = []; const mismatched = []; const unknown = [];
  const fits = (s) => s.roles.length === 0 || s.roles.includes(roleName);
  if (Array.isArray(sub.skills) && sub.skills.length) {
    for (const n of sub.skills) {
      const s = allSkills[n];
      if (!s) unknown.push(n);
      else if (!fits(s)) mismatched.push(n);
      else chosen.push(s);
    }
  } else {
    const text = String(sub.prompt || '').toLowerCase();
    for (const s of Object.values(allSkills)) {
      if (!fits(s) || s.roles.length === 0) continue;
      if (s.autoApply || s.keywords.some((k) => text.includes(k.toLowerCase()))) chosen.push(s);
    }
  }
  return { chosen, mismatched, unknown };
}

// ───────────────────────────── team hierarchy (orchestrator → leads → workers) ─────────────────────────────

export const TEAM_FILE = path.join(HARNESS_DIR, 'team.json');
export const loadTeam = (file = TEAM_FILE) => readJsonSafe(file, null);

/** Concrete sample paths for a glob (used to compare two globs without a full glob algebra). */
function globProbes(glob) {
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  return [...new Set([
    g.replace(/\*\*\//g, 'a/b/').replace(/\*\*/g, 'a/b/c').replace(/\*/g, 'x'),
    g.replace(/\*\*\//g, '').replace(/\*\*/g, 'c').replace(/\*/g, 'y')
  ])];
}
/** Is everything the child glob can match also matched by the parent globs? (probe-based, conservative) */
export const globWithin = (child, parentGlobs) => globProbes(child).every((p) => matchesAny(p, parentGlobs));
/** Can two globs match the same file? (probe-based) */
export const globsOverlap = (a, b) => globProbes(a).some((p) => matchesAny(p, [b])) || globProbes(b).some((p) => matchesAny(p, [a]));

/**
 * The deterministic guardrails of the hierarchy. Returns { errors[], warnings[] }; errors must stop the run.
 *  - exactly one orchestrator (level "orchestrator", reports to nobody), and it is READ-ONLY (its role owns no files)
 *  - every lead reports to the orchestrator, has a known role that may write, and a non-empty scope
 *  - a lead's scope can only NARROW its role's writable paths, and never reach charter-forbidden paths
 *  - lead scopes are pairwise disjoint, so teams can never collide on a file
 *  - budgets only shrink downwards (sum of lead cost caps <= orchestrator cap; lead minutes <= orchestrator minutes)
 */
export function validateTeam(team, { roles = {}, charter = null, plannerMaxWorkers = 4, engines = null } = {}) {
  const errors = []; const warnings = [];
  if (!team || !Array.isArray(team.members)) return { errors: ['team.json must be an object with a "members" list'], warnings };
  const ids = new Set();
  for (const m of team.members) {
    if (!m || typeof m.id !== 'string' || !m.id) { errors.push('every member needs an "id"'); continue; }
    if (ids.has(m.id)) errors.push(`duplicate member id "${m.id}"`);
    ids.add(m.id);
    if (m.model !== undefined && (typeof m.model !== 'string' || !/^[\w.:@/-]+$/.test(m.model))) errors.push(`member "${m.id}": model must be a tier (fast | medium | high) or a model alias such as "opus"`);
    if (m.engine !== undefined && (typeof m.engine !== 'string' || (engines && !engines.includes(m.engine)))) errors.push(`member "${m.id}": engine "${m.engine}" is not an engine in config.json profiles${engines ? ` (${engines.join(', ')})` : ''}`);
    if (!['orchestrator', 'lead'].includes(m.level)) errors.push(`member "${m.id}": level must be "orchestrator" or "lead" (workers are created by leads at run time)`);
  }
  const orchs = team.members.filter((m) => m.level === 'orchestrator');
  const leads = team.members.filter((m) => m.level === 'lead');
  if (orchs.length !== 1) errors.push(`exactly one orchestrator is required (found ${orchs.length})`);
  if (!leads.length) errors.push('at least one lead is required');
  const orch = orchs[0];
  if (orch) {
    if (orch.reports_to) errors.push(`orchestrator "${orch.id}" must not report to anyone`);
    const r = roles[String(orch.role).toUpperCase()];
    if (!r) errors.push(`orchestrator "${orch.id}": unknown role "${orch.role}"`);
    else if ((r.writablePaths || []).length) errors.push(`orchestrator "${orch.id}": role ${r.name} may write files (${r.writablePaths.join(', ')}); the orchestrator must be read-only`);
    for (const c of orch.canDelegateTo || []) if (!leads.some((l) => l.id === c)) errors.push(`orchestrator canDelegateTo lists "${c}", which is not a lead`);
  }
  for (const l of leads) {
    if (orch && l.reports_to !== orch.id) errors.push(`lead "${l.id}" must report to the orchestrator "${orch.id}" (reports_to is "${l.reports_to}")`);
    const r = roles[String(l.role).toUpperCase()];
    if (!r) { errors.push(`lead "${l.id}": unknown role "${l.role}"`); continue; }
    if (!(r.writablePaths || []).length) errors.push(`lead "${l.id}": role ${r.name} is read-only, so its workers could not do any work`);
    if (!Array.isArray(l.scope) || !l.scope.length) { errors.push(`lead "${l.id}": needs a non-empty "scope" (paths its team may own)`); continue; }
    for (const g of l.scope) {
      if (!globWithin(g, r.writablePaths || [])) errors.push(`lead "${l.id}": scope "${g}" is wider than what role ${r.name} may write (${(r.writablePaths || []).join(', ')})`);
      if (charter && globProbes(g).some((p) => matchesAny(p, charter.forbiddenPaths))) errors.push(`lead "${l.id}": scope "${g}" reaches a path the charter forbids (${charter.forbiddenPaths.join(', ')})`);
      if (charter && charter.allowedPaths.length && !globWithin(g, charter.allowedPaths)) warnings.push(`lead "${l.id}": scope "${g}" is wider than the charter allowedPaths; autonomous runs will reject files outside them`);
    }
    const mw = l.maxWorkers ?? 3;
    if (!Number.isInteger(mw) || mw < 1 || mw > plannerMaxWorkers) errors.push(`lead "${l.id}": maxWorkers must be a whole number from 1 to ${plannerMaxWorkers}`);
  }
  for (let i = 0; i < leads.length; i++) for (let j = i + 1; j < leads.length; j++) {
    for (const a of leads[i].scope || []) for (const b of leads[j].scope || []) {
      if (globsOverlap(a, b)) errors.push(`leads "${leads[i].id}" and "${leads[j].id}" have overlapping scopes ("${a}" / "${b}"); two teams could collide on a file`);
    }
  }
  const num = (v) => (typeof v === 'number' && v >= 0 ? v : null);
  if (orch) {
    const sumCost = leads.reduce((t, l) => t + (num(l.budget?.maxCostUsd) ?? 0), 0);
    const oc = num(orch.budget?.maxCostUsd);
    if (oc !== null && sumCost > oc + 1e-9) errors.push(`budgets must shrink downwards: leads' cost caps add up to $${sumCost} but the orchestrator's cap is $${oc}`);
    const om = num(orch.budget?.maxMinutes);
    for (const l of leads) { const lm = num(l.budget?.maxMinutes); if (om !== null && lm !== null && lm > om) errors.push(`lead "${l.id}": maxMinutes (${lm}) exceeds the orchestrator's (${om})`); }
  }
  return { errors, warnings };
}

/** The effective set-up of one member (for `team.mjs show` and Doctor). */
export function describeMember(m, roles) {
  const r = roles[String(m.role).toUpperCase()] || {};
  return {
    id: m.id, level: m.level, role: m.role, reportsTo: m.reports_to || null,
    scope: m.scope || [], maxWorkers: m.level === 'lead' ? (m.maxWorkers ?? 3) : null,
    tools: r.allowedTools || [], budget: m.budget || {}, mission: r.mission || r.description || '',
    engine: m.engine || null
  };
}

// ───────────────────────────── engine routing (team.mjs auto-assign) ─────────────────────────────

/** Which job each role does, for engine routing. Roles not listed here count as coding. */
export const ROLE_JOB = { PO_ARCHITECT: 'plan', BA_ANALYST: 'plan', DEV_ENGINEER: 'code', QA_AUDITOR: 'qa' };

/**
 * Pick an engine for each job from the engines that are actually usable. Pure: no probing, no files.
 *   3+ engines: planning/research → agy (antigravity) or gemini, coding → claude, QA/review → codex (else claude)
 *   2 engines:  planning/research on one, coding AND QA on the other
 *   1 engine:   that engine everywhere
 *   0 engines:  null (nothing to assign; the harness falls back to "auto" at run time)
 * Returns { plan, code, qa } (profile names) or null.
 */
export function planEngineRouting(available) {
  const have = [...new Set((available || []).map((s) => String(s).toLowerCase()))];
  if (!have.length) return null;
  if (have.length === 1) return { plan: have[0], code: have[0], qa: have[0] };
  const first = (prefs, pool = have) => prefs.find((k) => pool.includes(k)) || pool[0];
  // Planning prefers a research engine; without one, give planning to the non-claude engine so claude can code.
  const plan = first(['antigravity', 'gemini', 'codex', 'claude']);
  const rest = have.filter((k) => k !== plan);
  const code = first(['claude', 'codex', 'gemini', 'antigravity'], rest);
  if (have.length === 2) return { plan, code, qa: code };
  const qa = have.includes('codex') && code !== 'codex' ? 'codex' : have.includes('claude') ? 'claude' : code;
  return { plan, code, qa };
}

/** Write routing.plan/code/qa onto the team members by role (returns a NEW team object; input untouched). */
export function applyEngineRouting(team, routing) {
  if (!routing) return team;
  return { ...team, members: team.members.map((m) => ({ ...m, engine: routing[ROLE_JOB[String(m.role).toUpperCase()] || 'code'] })) };
}

/**
 * Level-1 guardrail, shared by the headless controller and the editor workflow: is the orchestrator's
 * delegation allowed? Throws an Error with a plain message on the first broken rule.
 *  - each assignment goes to a lead the orchestrator may delegate to, each lead at most once
 *  - every file is a safe relative path inside that lead's scope (and inside what the user allowed)
 *  - no two leads are given overlapping files
 */
export function validateDelegation(plan, { leads, delegable, userAllowed = [] }) {
  if (!plan || !Array.isArray(plan.assignments) || !plan.assignments.length) throw new Error('JSON has no "assignments" list.');
  const strip = (f) => String(f).replace(/\/$/, '');
  const inside = (file, targets) => targets.some((t) => { const n = strip(String(t).replace(/\\/g, '/').replace(/^\.\//, '')); return file === n || file.startsWith(`${n}/`); });
  const seenLeads = new Set(); const claimed = [];
  for (const a of plan.assignments) {
    const lead = leads.find((l) => l.id === a.lead);
    if (!lead || !delegable.has(lead.id)) throw new Error(`assignment to "${a.lead}": that is not a lead you may delegate to (${[...delegable].join(', ')}).`);
    if (seenLeads.has(lead.id)) throw new Error(`lead "${lead.id}" is assigned twice; use each lead at most once.`);
    seenLeads.add(lead.id);
    if (typeof a.goal !== 'string' || !a.goal.trim()) throw new Error(`assignment to "${lead.id}" has no goal.`);
    if (!Array.isArray(a.files) || !a.files.length) throw new Error(`assignment to "${lead.id}" has no files.`);
    a.files = a.files.map((f) => { const s = safeTarget(f); if (!s) throw new Error(`assignment to "${lead.id}" has an unsafe path "${f}".`); const base = s.replace(/\/+$/, ''); return String(f).endsWith('/') ? `${base}/` : base; });
    for (const f of a.files) {
      if (!withinAll(f, lead.scope)) throw new Error(`file "${f}" is outside lead "${lead.id}"'s scope (${lead.scope.join(', ')}).`);
      if (userAllowed.length && !inside(strip(f), userAllowed)) throw new Error(`file "${f}" is outside the files the user allowed (${userAllowed.join(', ')}).`);
      for (const [other, by] of claimed) {
        if (by !== lead.id && (strip(f) === strip(other) || strip(f).startsWith(`${strip(other)}/`) || strip(other).startsWith(`${strip(f)}/`))) throw new Error(`Swarm Lock Collision: "${f}" (${lead.id}) overlaps "${other}" (${by}).`);
      }
      claimed.push([f, lead.id]);
    }
  }
  return plan;
}

// ───────────────────────────── native editor agents generated from team.json ─────────────────────────────
// In the editor (Claude Code) every lead is also a NAMED sub-agent the orchestrator can delegate to, so you see
// "lead-dev" etc. working in the session. The files in .claude/agents/ are generated from team.json + roles, so
// team.json stays the single source of truth for each member's set-up.

export const AGENTS_DIR = path.join(ROOT, '.claude', 'agents');
const hasRule = (role, re) => (role.allowedTools || []).some((r) => re.test(r));

/** The native tool list for a lead: read tools always; write tools if the role owns files; Bash only if the role runs tests/node. */
export function agentToolsFor(role) {
  const tools = ['Read', 'Glob', 'Grep'];
  if ((role.writablePaths || []).length) tools.push('Edit', 'Write');
  if (hasRule(role, /^Bash\((npm|node)/)) tools.push('Bash');
  return tools;
}

export function renderAgentFile(lead, role, team) {
  const orch = (team.members || []).find((m) => m.level === 'orchestrator');
  const tools = agentToolsFor(role);
  const mission = role.mission || role.description || lead.role;
  const desc = `${lead.id} (${role.name}), a lead on the agent team. The orchestrator delegates ${lead.scope.join(', ')} work to it; it changes only the files it is assigned.`.replace(/\s+/g, ' ');
  return [
    '---',
    `name: ${lead.id}`,
    `description: ${desc}`,
    `tools: ${tools.join(', ')}`,
    '---',
    `<!-- Generated from .harness/team.json and .harness/roles by "node .harness/team.mjs sync-agents". Edit those, not this file. -->`,
    `You are **${lead.id}**, a team lead (level 2) in an agent team${orch ? ` reporting to the orchestrator \`${orch.id}\`` : ''}. Your role: ${role.name}.`,
    '',
    mission,
    '',
    `Your team may own: ${lead.scope.join(', ')}. The orchestrator's message tells you exactly which files you may create or change in this run.`,
    '',
    '## How you work',
    '- Change ONLY the files you were assigned. The controller compares every changed file against the assignments after you finish: anything outside your files is reverted and the run fails.',
    '- Follow the shared interface contract and acceptance criteria in your assignment exactly; other leads are building against them in parallel.',
    '- Never touch `.harness/`, `.claude/`, `.git/`, secrets or `.env*`. Never run git commands that change history or remotes, and never push.',
    ...(tools.includes('Bash') ? ['- You may check your work with `npm test` or `node --test`. Do not run other commands.'] : ['- You have no shell. Work with the file tools only.']),
    '- Finish with a short report (at most 5 lines): files changed, what you did, what you checked, anything unresolved. Do not claim you tested something you did not run.',
    ''
  ].join('\n');
}

/** { 'lead-dev.md': content, … } for every lead whose role is known. */
export function expectedAgentFiles(team, roles) {
  const out = {};
  for (const l of (team?.members || []).filter((m) => m.level === 'lead')) {
    const role = roles[String(l.role).toUpperCase()];
    if (role) out[`${l.id}.md`] = renderAgentFile(l, role, team);
  }
  return out;
}

/** Write (or check) .claude/agents/*.md. Returns { written[], unchanged[], stale[] }; with check:true nothing is written. */
export function syncAgents(team, roles, { dir = AGENTS_DIR, check = false } = {}) {
  const want = expectedAgentFiles(team, roles);
  const res = { written: [], unchanged: [], stale: [] };
  if (!check) fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(want)) {
    const p = path.join(dir, f);
    let cur = null; try { cur = fs.readFileSync(p, 'utf8'); } catch { /* missing */ }
    if (cur === content) res.unchanged.push(f);
    else if (check) res.stale.push(f);
    else { fs.writeFileSync(p, content); res.written.push(f); }
  }
  return res;
}

// ───────────────────────────── backlog store ─────────────────────────────

export const STATUSES = ['BACKLOG', 'READY', 'IN_PROGRESS', 'DONE', 'BLOCKED'];

export function readBacklog() {
  const b = readJsonSafe(GOV.backlog, null);
  if (!b) return { version: '2.0.0', project: '', tasks: [] };
  if (Array.isArray(b)) return { version: '2.0.0', project: '', tasks: b };
  return { ...b, tasks: Array.isArray(b.tasks) ? b.tasks : [] };
}

export function writeBacklog(b) { atomicWriteJson(GOV.backlog, b); }

/** Read-modify-write one item by id. Returns the updated item (or null). */
export function updateBacklogItem(id, patch) {
  if (!id) return null;
  const b = readBacklog();
  const item = b.tasks.find((t) => t.id === id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  writeBacklog(b);
  return item;
}

/** Validate a backlog object (for import). Throws with a readable message. */
export function validateBacklog(b) {
  const tasks = Array.isArray(b) ? b : b?.tasks;
  if (!Array.isArray(tasks)) throw new Error('Backlog must be a JSON object with a "tasks" list (or a bare list).');
  const ids = new Set();
  tasks.forEach((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`Task #${i + 1} is not an object.`);
    if (!t.id) throw new Error(`Task #${i + 1} has no "id".`);
    if (ids.has(t.id)) throw new Error(`Duplicate task id "${t.id}".`);
    ids.add(t.id);
    if (!t.title && !t.goal) throw new Error(`Task "${t.id}" needs a "title" or "goal".`);
    if (t.status && !STATUSES.includes(t.status)) throw new Error(`Task "${t.id}" has unknown status "${t.status}" (use ${STATUSES.join(', ')}).`);
  });
  return Array.isArray(b) ? { version: '2.0.0', project: '', tasks } : b;
}

/** Highest priority READY item: lowest "priority" number first, then oldest. */
export function nextReady(b = readBacklog()) {
  return b.tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.status === 'READY')
    .sort((a, z) => (a.t.priority ?? 99) - (z.t.priority ?? 99) || a.i - z.i)[0]?.t || null;
}

export function backlogCounts(b = readBacklog()) {
  const c = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const t of b.tasks) c[t.status || 'BACKLOG'] = (c[t.status || 'BACKLOG'] || 0) + 1;
  return c;
}

/** Turn a backlog item into an inbox job (the item stays the source of truth for status). */
export function itemToJob(item, { autonomous = false } = {}) {
  const job = {
    id: `${item.id}-run${Date.now().toString(36)}`,
    backlogId: item.id,
    title: item.title || item.goal,
    autonomous,
    createdAt: new Date().toISOString()
  };
  for (const k of ['engine', 'verifyCmd', 'acceptanceCriteria', 'interfaceContract', 'source']) if (item[k] !== undefined) job[k] = item[k];
  if (item.hierarchy) job.hierarchy = true;
  if (item.maxCostUsd !== undefined) job.maxCostUsd = item.maxCostUsd;
  if (Array.isArray(item.subtasks) && item.subtasks.length) job.subtasks = item.subtasks;
  else if (item.hierarchy) Object.assign(job, { goal: item.goal || item.title, targetFiles: item.targetFiles || [] });
  else if (item.autoPlan) Object.assign(job, { autoPlan: true, goal: item.goal || item.title, targetFiles: item.targetFiles || [] });
  else job.subtasks = [{ id: 'worker-main', role: item.role, skills: item.skills, targetFiles: item.targetFiles || [], prompt: item.goal || item.title }];
  return job;
}

// ───────────────────────────── release snapshots ─────────────────────────────

/**
 * Snapshot the current charter + backlog (+ optional skills / memory) into
 * .harness/releases/release-<timestamp>/ and MOVE unstarted inbox jobs into it.
 * `busyFile` (the job the daemon is running right now) is never moved.
 */
export function snapshotRelease({ reason = 'import', includeSkills = false, includeMemory = false, busyFile = null } = {}) {
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let dir = path.join(GOV.releases, `release-${stamp}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(GOV.releases, `release-${stamp}-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const [src, name] of [[GOV.charter, 'charter.md'], [GOV.backlog, 'backlog.json']]) {
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, name)); saved.push(name); }
  }
  if (includeSkills && fs.existsSync(GOV.skills)) { fs.cpSync(GOV.skills, path.join(dir, 'skills'), { recursive: true }); saved.push('skills/'); }
  if (includeMemory) {
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    for (const f of [FILES.lessons, FILES.autoLessons, FILES.profile]) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, 'memory', path.basename(f)));
    saved.push('memory/');
  }

  // Unstarted inbox jobs belong to the old upload: park them in the release.
  const moved = [];
  for (const f of fs.readdirSync(DIRS.inbox).filter((x) => x.endsWith('.json'))) {
    const full = path.join(DIRS.inbox, f);
    if (busyFile && path.resolve(busyFile) === path.resolve(full)) continue;
    fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
    fs.renameSync(full, path.join(dir, 'inbox', f));
    moved.push(f);
  }

  // Human-readable summary of what the old upload achieved.
  const b = readBacklog();
  const done = b.tasks.filter((t) => t.status === 'DONE');
  const completedJobs = fs.readdirSync(DIRS.completed).filter((f) => f.endsWith('.json'));
  const lines = [
    `# Release snapshot — ${stamp}`, '',
    `Reason: ${reason}`, `Saved: ${saved.join(', ') || '(nothing)'}`,
    `Unstarted inbox jobs moved here: ${moved.length ? moved.join(', ') : 'none'}`, '',
    '## Backlog status at snapshot', ...STATUSES.map((s) => `- ${s}: ${b.tasks.filter((t) => (t.status || 'BACKLOG') === s).length}`), '',
    '## Done items', ...(done.length ? done.map((t) => `- ${t.id}: ${t.title || t.goal}${t.completedAt ? ` (${t.completedAt})` : ''}`) : ['- none']), '',
    '## Blocked items', ...(b.tasks.filter((t) => t.status === 'BLOCKED').map((t) => `- ${t.id}: ${t.title || t.goal} — ${t.blockedReason || ''}`)), '',
    `## Completed job files (${completedJobs.length}) in .harness/completed/`, ...completedJobs.slice(-50).map((f) => `- ${f}`)
  ];
  fs.writeFileSync(path.join(dir, 'completed-summary.md'), lines.join('\n') + '\n');
  return { dir, stamp, saved, moved };
}

export function resetMemory() {
  fs.writeFileSync(FILES.lessons, LESSONS_HEADER);
  fs.writeFileSync(FILES.autoLessons, AUTO_LESSONS_HEADER);
}

export function listReleases() {
  try {
    return fs.readdirSync(GOV.releases).filter((d) => d.startsWith('release-')).sort();
  } catch { return []; }
}

export { ROOT };
