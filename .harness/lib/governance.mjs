/**
 * .harness/lib/governance.mjs
 * v2 governance layer: charter policy, role personas, skills, backlog store, release snapshots.
 * Zero dependencies — Node.js 18+ standard library only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, HARNESS_DIR, DIRS, FILES, atomicWriteJson, readJsonSafe, ensureDirs, LESSONS_HEADER, AUTO_LESSONS_HEADER, normalizeTarget, loadConfig, memberModels, workerName } from './common.mjs';

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

/**
 * A FILE-TYPE scope ends in a file-name pattern (e.g. "src/**\/*.test.*"); a FOLDER scope ends in "**" or "*" (e.g. "src/**").
 * When a file matches a folder scope of one lead and a file-type scope of another, the file-type scope wins: so
 * src/button.test.tsx belongs to the QA lead, src/button.tsx to the dev lead, and every file still has ONE owner.
 */
export function isFileTypeGlob(g) {
  const s = String(g).trim().replace(/\\/g, '/');
  if (!s || s.endsWith('/')) return false;
  const last = s.split('/').pop();
  return Boolean(last) && last !== '**' && last !== '*' && (last.includes('*') || last.includes('.'));
}

/** Does this lead own file f, given all leads (file-type scopes of other leads take precedence over folder scopes)? */
export function leadOwns(lead, f, leads = [lead]) {
  if (!withinAll(f, lead.scope || [])) return false;
  if ((lead.scope || []).filter(isFileTypeGlob).some((g) => matchesAny(f, [g]))) return true;
  return !leads.some((o) => o.id !== lead.id && (o.scope || []).filter(isFileTypeGlob).some((g) => matchesAny(f, [g])));
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

/**
 * Capability flag read by other tools (e.g. Skill Foundry's doctor) instead of a version number: a lead's explicit skills
 * are ADDED to autoApply skills (matchSkills), and several skills' tool lists compose by UNION (computeAllowedTools).
 */
export const SKILL_COMPOSITION = 'additive-union';
/**
 * Capability flag: keywords inject a skill even for a member with an explicit `skills` list (matchSkills), so a tool
 * such as Skill Foundry may write pointers with `autoApply: false` and rely on keywords. Read the flag, never a version.
 */
export const SKILL_MATCH = 'keywords-with-explicit';
/**
 * Capability flag: a keyword matches as a WHOLE word or phrase (case-insensitive), also with a plural "s"/"es" — so
 * "token" matches "tokens" but not "tokenizer", "api" not "rapid", "auth" not "author", "rest" not "restore".
 * Multi-word keywords ("access token") and keywords with punctuation ("install.mjs", "--reset") match as written.
 * Up to v1.0.30 this was 'substring' (anywhere in the text), which injected unrelated skills.
 */
export const SKILL_KEYWORD_MATCH = 'word';

/** Does this skill keyword appear in the text as a whole word or phrase (plural allowed)? See SKILL_KEYWORD_MATCH. */
export function keywordMatches(text, keyword) {
  const k = String(keyword || '').trim().toLowerCase();
  if (!k) return false;
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![a-z0-9])${esc}(?:s|es)?(?![a-z0-9])`, 'i').test(String(text || ''));
}
/** Highest SKILL.md `schema_version` (format of the skill pointer) this harness understands; a missing value means 1. */
export const SKILL_SCHEMA_MAX = 1;
const unsupportedSkills = new Map();
/** Pointers skipped by loadSkills because their schema_version is newer than SKILL_SCHEMA_MAX: [{ name, schemaVersion }]. */
export const unsupportedSkillPointers = () => [...unsupportedSkills].map(([name, schemaVersion]) => ({ name, schemaVersion }));

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
const toRulePath = (t) => {
  const n = String(t).replace(/\\/g, '/');
  return n.endsWith('/') ? `${n}**` : n;
};

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
 *  3. several skills compose by UNION of what each one keeps (never more than the role allows); see below.
 *  4. with `explicit`, only skills named there narrow; keyword/autoApply skills never take a rule away.
 *  Returns the rules; use explainSkillNarrowing() for what a skill asked for but did not get.
 */
export function computeAllowedTools(role, skills, targetFiles, { explicit = null } = {}) {
  const targets = (targetFiles || []).length ? targetFiles.map(toRulePath) : (role.writablePaths || []);
  let rules = [];
  for (const rule of role.allowedTools || []) {
    if (rule.includes('{targetFiles}')) targets.forEach((t) => rules.push(rule.replace('{targetFiles}', t)));
    else rules.push(rule);
  }
  // Each skill narrows the role's rules on its own; with several skills the result is the UNION of those views, so a
  // skill that needs a tool (e.g. a bare "Bash" for its engine scripts) is never starved by a stricter sibling skill
  // (code-craft's "npm test only"). It can never exceed what the role itself allows. A skill with no tool list has no
  // opinion and is skipped; if no skill lists tools the role's rules stay as they are.
  // `explicit` (names from the member's or plan's own `skills` list): only those skills may NARROW. A skill that came in by
  // keyword or autoApply only joins the union, so it can give back a rule the role already has, never take one away.
  // Without `explicit` every skill counts as explicit (callers that do not pass it keep the old behaviour).
  const isExplicit = (s) => !explicit || explicit.includes(s.name);
  const lists = skills.map((s) => [isExplicit(s), skillToolsFor(s, role.name)]).filter(([, l]) => Array.isArray(l) && l.length > 0);
  const narrowers = lists.some(([e]) => e) ? lists.map(([, l]) => l) : [];
  if (narrowers.length) {
    const base = rules;
    const out = [];
    for (const list of narrowers) {
      const bare = new Set(list.filter((r) => !r.includes('(')).map(baseTool));
      const exact = new Map();
      for (const r of list.filter((x) => x.includes('('))) exact.set(baseTool(r), [...(exact.get(baseTool(r)) || []), r]);
      for (const r of base) {
        const t = baseTool(r);
        if (READ_ONLY_TOOLS.has(t) || bare.has(t)) out.push(r);
      }
      for (const [t, skillRules] of exact) {
        if (bare.has(t)) continue; // a bare name already keeps the role's rules
        for (const sr of skillRules) if (base.some((r) => covers(r, sr))) out.push(sr);
      }
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
      const sv = meta.schema_version === undefined ? 1 : Number(meta.schema_version);
      if (Number.isFinite(sv) && sv > SKILL_SCHEMA_MAX) {
        if (!unsupportedSkills.has(name)) process.stderr.write(`SKILL_SCHEMA_UNSUPPORTED ${name} (schema_version ${sv} > ${SKILL_SCHEMA_MAX}; update the harness)\n`);
        unsupportedSkills.set(name, sv);
        continue;
      }
      unsupportedSkills.delete(name);
      skills[name] = {
        name,
        schemaVersion: Number.isFinite(sv) ? sv : 1,
        description: String(meta.description || ''),
        roles: (Array.isArray(meta.roles) ? meta.roles : []).map((r) => String(r).toUpperCase()),
        allowedTools: Array.isArray(meta.allowedTools) ? meta.allowedTools : [],
        // optional per-role override: "allowedTools.DEV_ENGINEER: [...]" replaces the default list for that role only
        toolsByRole: Object.fromEntries(Object.entries(meta).filter(([k, v]) => /^allowedTools\./.test(k) && Array.isArray(v)).map(([k, v]) => [k.slice('allowedTools.'.length).toUpperCase(), v])),
        keywords: Array.isArray(meta.keywords) ? meta.keywords.map(String) : [],
        autoApply: meta.autoApply === true,
        installedBy: meta['installed-by'] ? String(meta['installed-by']) : '',
        // how much the skill needs its engine/ scripts: 'required', 'optional' (it has a documented fallback without them) or '' (not declared)
        engine: ['required', 'optional'].includes(String(meta.engine)) ? String(meta.engine) : '',
        starterStub: meta['starter-stub'] ? String(meta['starter-stub']) : '',
        body: body.trim(),
        raw,
        dir: dir.name
      };
    }
  } catch { /* no skills dir */ }
  return skills;
}

/**
 * Pick skills for a worker. A skill is chosen when its roles include the worker's role (always required) AND any of:
 * it is in the explicit `skills` list (a lead's list, a plan's list); it has `autoApply: true`; or one of its keywords
 * appears in the task prompt (case-insensitive), whether or not there is an explicit list. See SKILL_MATCH. A skill whose `roles` list
 * excludes the role is never injected (reported as a mismatch).
 */
export function matchSkills(sub, roleName, allSkills) {
  const chosen = []; const mismatched = []; const unknown = [];
  const fits = (s) => s.roles.length === 0 || s.roles.includes(roleName);
  const explicit = Array.isArray(sub.skills) && sub.skills.length > 0;
  if (explicit) {
    for (const n of sub.skills) {
      const s = allSkills[n];
      if (!s) unknown.push(n);
      else if (!fits(s)) mismatched.push(n);
      else if (!chosen.includes(s)) chosen.push(s);
    }
  }
  const text = String(sub.prompt || '').toLowerCase();
  const scored = [];
  for (const s of Object.values(allSkills)) {
    if (chosen.includes(s) || !fits(s) || s.roles.length === 0) continue;
    // added to the explicit list: autoApply skills, and skills whose keyword appears in the task (with or without a list)
    const hit = s.keywords.filter((k) => keywordMatches(text, k));
    if (s.autoApply || hit.length) scored.push({ s, hits: hit.length, longest: Math.max(0, ...hit.map((k) => String(k).length)), keyword: hit.sort((a, b) => b.length - a.length)[0] || null });
  }
  // Ranking: the explicit list first (in its order), then most keyword hits, then the longest matched phrase.
  scored.sort((a, b) => b.hits - a.hits || b.longest - a.longest || a.s.name.localeCompare(b.s.name));
  const why = new Map(scored.map((x) => [x.s.name, x.keyword]));
  const ranked = [...chosen, ...scored.map((x) => x.s)];
  // At most SKILL_LIMIT_PER_WORKER skills reach one worker (owner's decision: one by one, never many at once, so the
  // context stays small); the rest are named, not loaded.
  return { chosen: ranked.slice(0, SKILL_LIMIT_PER_WORKER), notLoaded: ranked.slice(SKILL_LIMIT_PER_WORKER).map((s) => s.name), why, mismatched, unknown };
}

/** Capability flag: the most skills one worker gets (explicit list first, then best keyword match); the rest are named, not loaded. */
export const SKILL_LIMIT_PER_WORKER = 2;

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
/**
 * team.json is the AI agent team only. People (names, e-mails, hats po/ba/ux/dev/qa) live in each person's git-ignored
 * .harness/memory/me.md, so a human "hat" can never be read as an AI role or widen a scope. Returns warnings.
 */
const HUMAN_TEAM_KEYS = ['hats', 'hat', 'human', 'humans', 'people', 'person', 'persons', 'owner', 'owners', 'name', 'email', 'assignee', 'assignees', 'user', 'users', 'members_human'];
const HUMAN_HATS = ['po', 'ba', 'ux', 'dev', 'qa'];
export function humanFieldsInTeam(team) {
  const out = [];
  const fix = 'team.json is the AI agent team; put people and their hats in their own .harness/memory/me.md (node .harness/memory.mjs me set --hats …)';
  for (const k of Object.keys(team || {})) if (HUMAN_TEAM_KEYS.includes(k.toLowerCase())) out.push(`team.json has a "${k}" field: ${fix}`);
  for (const m of Array.isArray(team?.members) ? team.members : []) {
    if (!m || typeof m !== 'object') continue;
    const id = m.id || '?';
    for (const k of Object.keys(m)) if (HUMAN_TEAM_KEYS.includes(k.toLowerCase())) out.push(`member "${id}" has a "${k}" field: ${fix}`);
    if (typeof m.id === 'string' && m.id.includes('@')) out.push(`member "${id}" looks like an e-mail address: ${fix}`);
    if (typeof m.role === 'string' && HUMAN_HATS.includes(m.role.toLowerCase()) && m.role === m.role.toLowerCase()) out.push(`member "${id}" has role "${m.role}", which is a human hat, not an AI role (use a role from .harness/roles/, e.g. QA_AUDITOR): ${fix}`);
  }
  return out;
}

export function validateTeam(team, { roles = {}, charter = null, plannerMaxWorkers = 4, engines = null } = {}) {
  const errors = []; const warnings = [];
  if (!team || !Array.isArray(team.members)) return { errors: ['team.json must be an object with a "members" list'], warnings };
  for (const w of humanFieldsInTeam(team)) warnings.push(w);
  const ids = new Set();
  for (const m of team.members) {
    if (!m || typeof m.id !== 'string' || !m.id) { errors.push('every member needs an "id"'); continue; }
    if (ids.has(m.id)) errors.push(`duplicate member id "${m.id}"`);
    ids.add(m.id);
    if (m.model !== undefined && (typeof m.model !== 'string' || !/^[\w.:@/-]+$/.test(m.model))) errors.push(`member "${m.id}": model must be a tier (fast | medium | high) or a model alias from config.json`);
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
    // A lead the orchestrator may not delegate to can never receive work: add it to canDelegateTo (or remove the list).
    if (Array.isArray(orch.canDelegateTo) && orch.canDelegateTo.length) for (const l of leads) if (!orch.canDelegateTo.includes(l.id)) warnings.push(`lead "${l.id}" is not in the orchestrator's canDelegateTo, so it can never receive work`);
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
      if (isFileTypeGlob(a) !== isFileTypeGlob(b)) continue; // a file-type scope takes its files out of a folder scope: one owner
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
export const ROLE_JOB = { PO_ARCHITECT: 'plan', COORDINATOR: 'plan', BA_ANALYST: 'plan', DEV_ENGINEER: 'code', UX_DESIGNER: 'code', QA_AUDITOR: 'qa', REVIEWER: 'qa', SECURITY: 'qa' };

/**
 * Pick an engine for each job from the engines that are actually usable. Pure: no probing, no files.
 *   3+ engines: planning/research → agy (antigravity), coding → claude, QA/review → codex (else claude)
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
  const plan = first(['antigravity', 'codex', 'claude']);
  const rest = have.filter((k) => k !== plan);
  const code = first(['claude', 'codex', 'antigravity'], rest);
  if (have.length === 2) return { plan, code, qa: code };
  const qa = have.includes('codex') && code !== 'codex' ? 'codex' : have.includes('claude') ? 'claude' : code;
  return { plan, code, qa };
}

/** Write routing.plan/code/qa onto the team members by role (returns a NEW team object; input untouched). */
export function applyEngineRouting(team, routing) {
  if (!routing) return team;
  return { ...team, members: team.members.map((m) => ({ ...m, engine: routing[ROLE_JOB[String(m.role).toUpperCase()] || 'code'] })) };
}

const TEST_FILE_RE = /(^|\/)(tests?|__tests__|e2e)(\/|$)|\.(test|spec)\.[a-z0-9*?]+$|(^|\/)(test_[^/]+\.py|[^/]+_test\.(py|go))$/i;
/** True when `p` matches a test directory or test file convention (JS/TS/Python/Go). */
export function isTestFilePath(p) {
  const n = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return TEST_FILE_RE.test(n);
}

/**
 * Level-1 guardrail, shared by the headless controller and the editor workflow: is the orchestrator's
 * delegation allowed? Throws an Error with a plain message on the first broken rule.
 *  - each assignment goes to a lead the orchestrator may delegate to, each lead at most once
 *  - every file is a safe relative path inside that lead's scope (and inside what the user allowed)
 *  - when a QA_AUDITOR lead exists on the team, only QA_AUDITOR leads may own test files
 *  - no two leads are given overlapping files
 */
export function validateDelegation(plan, { leads, delegable, userAllowed = [] }) {
  if (!plan || !Array.isArray(plan.assignments) || !plan.assignments.length) throw new Error('JSON has no "assignments" list.');
  const strip = (f) => String(f).replace(/\/$/, '').replace(/\/\*\*$/, '');
  const inside = (file, targets) => targets.some((t) => {
    const raw = String(t).replace(/\\/g, '/').replace(/^\.\//, '');
    const n = strip(raw);
    return file === n || file.startsWith(`${n}/`) || (/[*?]/.test(raw) && matchesAny(file, [raw]));
  });
  const hasQaLead = leads.some((l) => String(l.role).toUpperCase() === 'QA_AUDITOR');
  const seenLeads = new Set(); const claimed = [];
  for (const a of plan.assignments) {
    const lead = leads.find((l) => l.id === a.lead);
    if (!lead || !delegable.has(lead.id)) throw new Error(`assignment to "${a.lead}": that is not a lead you may delegate to (${[...delegable].join(', ')}).`);
    if (seenLeads.has(lead.id)) throw new Error(`lead "${lead.id}" is assigned twice; use each lead at most once.`);
    seenLeads.add(lead.id);
    if (typeof a.goal !== 'string' || !a.goal.trim()) throw new Error(`assignment to "${lead.id}" has no goal.`);
    if (!Array.isArray(a.files) || !a.files.length) throw new Error(`assignment to "${lead.id}" has no files.`);
    a.files = a.files.map((f) => { const s = normalizeTarget(f); if (!s) throw new Error(`assignment to "${lead.id}" has an unsafe path "${f}".`); return s; });
    for (const f of a.files) {
      if (hasQaLead && String(lead.role).toUpperCase() !== 'QA_AUDITOR' && isTestFilePath(f)) {
        throw new Error(`lead "${a.lead}" (${lead.role}) may not own test file "${f}" — only lead-qa owns test files.`);
      }
      if (!leadOwns(lead, f, leads)) throw new Error(`file "${f}" is outside lead "${lead.id}"'s scope (${lead.scope.join(', ')})${withinAll(f, lead.scope) ? '; a more specific scope of another lead owns it (e.g. test files belong to the QA lead)' : ''}.`);
      if (userAllowed.length && !inside(strip(f), userAllowed)) throw new Error(`file "${f}" is outside the files the user allowed (${userAllowed.join(', ')}).`);
      for (const [other, by] of claimed) {
        const fDir = f.endsWith('/') || f.endsWith('/**');
        const otherDir = other.endsWith('/') || other.endsWith('/**');
        // Without case: src/b.js and src/B.js are one file on Windows and macOS.
        const lf = strip(f).toLowerCase(); const lo = strip(other).toLowerCase();
        const overlaps = lf === lo || lf.startsWith(`${lo}/`) || lo.startsWith(`${lf}/`) || ((/[*?]/.test(f) || /[*?]/.test(other)) && globsOverlap(f.toLowerCase(), other.toLowerCase()));
        if (by !== lead.id && overlaps) {
          if (fDir !== otherDir) {
            const file = fDir ? other : f;
            const dirLead = leads.find((l) => l.id === (fDir ? lead.id : by));
            if (dirLead && !leadOwns(dirLead, file, leads)) continue;
          }
          throw new Error(`Swarm Lock Collision: "${f}" (${lead.id}) overlaps "${other}" (${by}).`);
        }
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

/**
 * The Claude Code model for a named lead: picked by job from the claude profile's tiers (BA and QA → fast, coding → medium),
 * so a lead never silently inherits the session's (often most expensive) model. A member "model" alias overrides it.
 */
export function editorModelFor(lead, config) {
  if (!config?.profiles?.claude) return null;
  return memberModels(config, { ...lead, engine: 'claude', level: 'worker' }).work.model;
}

/** Can this role run node (so a skill's engine/ scripts)? */
export const runsNode = (role) => (role.allowedTools || []).some((r) => covers(r, 'Bash(node:*)') || r === 'Bash');
export const ENGINE_SCRIPTS = "a skill's own script (`node .claude/skills/<skill>/engine/…`) when an injected skill tells you to run it";

export function renderAgentFile(lead, role, team, config = (() => { try { return loadConfig(); } catch { return null; } })()) {
  const orch = (team.members || []).find((m) => m.level === 'orchestrator');
  const tools = agentToolsFor(role);
  const model = editorModelFor(lead, config);
  const mission = role.mission || role.description || lead.role;
  const desc = `${lead.id} (${role.name}), a lead on the agent team. The orchestrator delegates ${lead.scope.join(', ')} work to it; it changes only the files it is assigned.`.replace(/\s+/g, ' ');
  return [
    '---',
    `name: ${lead.id}`,
    `description: ${desc}`,
    `tools: ${tools.join(', ')}`,
    ...(model ? [`model: ${model}`] : []),
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
    ...(tools.includes('Bash') ? [`- You may check your work with \`npm test\`${runsNode(role) ? " or `node --test`, and run " + ENGINE_SCRIPTS : ''}. Do not run other commands.`] : ['- You have no shell. Work with the file tools only.']),
    '- Finish with a short report (at most 5 lines): files changed, what you did, what you checked, anything unresolved. Do not claim you tested something you did not run.',
    ''
  ].join('\n');
}

/** { 'lead-dev.md': content, … } for every lead whose role is known. */
export function expectedAgentFiles(team, roles, config = undefined) {
  const out = {};
  for (const l of (team?.members || []).filter((m) => m.level === 'lead')) {
    const role = roles[String(l.role).toUpperCase()];
    if (role) out[`${l.id}.md`] = renderAgentFile(l, role, team, config);
  }
  return out;
}

/** Write (or check) .claude/agents/*.md. Returns { written[], unchanged[], stale[] }; with check:true nothing is written. */
export function syncAgents(team, roles, { dir = AGENTS_DIR, check = false, config = undefined } = {}) {
  const want = expectedAgentFiles(team, roles, config);
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
  if (item.costApproved === true) job.costApproved = true; // the person approved this big run (backlog.mjs approve)
  if (item.model) job.model = item.model;
  if (Array.isArray(item.subtasks) && item.subtasks.length) job.subtasks = item.subtasks;
  else if (item.hierarchy) Object.assign(job, { goal: item.goal || item.title, targetFiles: item.targetFiles || [] });
  else if (item.autoPlan) Object.assign(job, { autoPlan: true, goal: item.goal || item.title, targetFiles: item.targetFiles || [] });
  else job.subtasks = [{ id: workerName({ role: item.role, goal: item.goal || item.title, files: item.targetFiles }), role: item.role, skills: item.skills, targetFiles: item.targetFiles || [], prompt: item.goal || item.title }];
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

// ───────────────────────────── anti-cheat & root-cause patch audit ─────────────────────────────

const MAX_AUDIT_BYTES = 256 * 1024;
const NON_CODE_FILE_RE = /\.(md|mdx|txt|json|css|scss|less|svg|png|jpg|jpeg|gif|webp|ico|yml|yaml|toml|lock)$/i;
const TEST_BYPASS_RE = /(?:\.skip\s*\(|\.only\s*\(|\bx(?:it|test)\s*\(|\b(?:describe|it|test)\.(?:skip|todo)\b|\.todo\s*\()/;
const EMPTY_CATCH_RE = /(?<![.\w$])catch\s*(?:\([^)]*\))?\s*\{\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*\}/;
const EMPTY_PROMISE_CATCH_RE = /\.catch\s*\(\s*(?:(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*\}|null\b|undefined\b)|function\s*(?:[A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*\})\s*\)/;
const ROOT_CAUSE_RE = /root.?cause|symptom|because|caused by|blast radius/i;
const NON_DEV_REPORT_KEY_RE = /^(?:lead-)?(?:qa|ba)(?:[-.]|$)/i;
const isHashOrFlag = (v) => typeof v !== 'string' || /^[0-9a-f]{40}$/i.test(v) || v === 'HEAD';

function parseUnifiedDiffAddedHunks(diffText) {
  const hunks = [];
  let cur = null;
  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      if (cur && cur.length) hunks.push(cur);
      cur = [];
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+')) cur.push(line.slice(1));
  }
  if (cur && cur.length) hunks.push(cur);
  return hunks;
}

function diffAddedHunks(oldText, newText) {
  const a = String(oldText || '').split(/\r?\n/);
  const b = String(newText || '').split(/\r?\n/);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const aMid = a.slice(pre, a.length - suf);
  const bMid = b.slice(pre, b.length - suf);
  if (!bMid.length) return [];
  if (!aMid.length) return [bMid];
  if (aMid.length * bMid.length <= 250000) {
    const m = aMid.length; const n = bMid.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = aMid[i] === bMid[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const hunks = []; let cur = [];
    let i = 0; let j = 0;
    while (i < m && j < n) {
      if (aMid[i] === bMid[j]) { if (cur.length) { hunks.push(cur); cur = []; } i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else cur.push(bMid[j++]);
    }
    while (j < n) cur.push(bMid[j++]);
    if (cur.length) hunks.push(cur);
    return hunks;
  }
  const counts = new Map();
  for (const l of aMid) counts.set(l, (counts.get(l) || 0) + 1);
  const added = [];
  for (const l of bMid) {
    const c = counts.get(l) || 0;
    if (c > 0) counts.set(l, c - 1);
    else added.push(l);
  }
  return added.length ? [added] : [];
}

function insideDir(baseDir, targetPath) {
  const b = path.resolve(baseDir);
  const r = path.relative(b, targetPath);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

function extractAddedHunks({ rel, root, baseVal, curVal, baselineDir, baseRef, hasGitHead }) {
  const abs = path.resolve(root, rel);
  if (!insideDir(root, abs)) return [];
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (st && st.isFile()) {
    if (st.size > MAX_AUDIT_BYTES) return [];
    let buf;
    try { buf = fs.readFileSync(abs); } catch { return []; }
    if (buf.includes(0)) return [];
    const diskText = buf.toString('utf8');
    if (baselineDir && baseVal !== 'HEAD') {
      const baseAbs = path.resolve(baselineDir, rel);
      if (insideDir(baselineDir, baseAbs)) {
        try {
          const bst = fs.statSync(baseAbs);
          if (bst.isFile() && bst.size <= MAX_AUDIT_BYTES) {
            const oldBuf = fs.readFileSync(baseAbs);
            if (!oldBuf.includes(0)) return diffAddedHunks(oldBuf.toString('utf8'), diskText);
          }
        } catch {
          // Only fall through to git HEAD if inside a git repo; otherwise treat as a new file below.
        }
      }
    }
    if (hasGitHead()) {
      const ref = baseRef || 'HEAD';
      if (ref === 'HEAD') {
        const stOut = spawnSync('git', ['status', '--porcelain', '--', rel], { cwd: root, encoding: 'utf8', timeout: 5000 });
        if (stOut.status === 0 && /^\?\?/.test(stOut.stdout || '')) {
          return [diskText.split(/\r?\n/)];
        }
      }
      const inBase = spawnSync('git', ['cat-file', '-e', `${ref}:${rel}`], { cwd: root, stdio: 'ignore', timeout: 5000 }).status === 0;
      if (inBase) {
        const diffArgs = ref === 'HEAD' ? ['diff', '-U0', 'HEAD', '--', rel] : ['diff', '-U0', ref, 'HEAD', '--', rel];
        const dr = spawnSync('git', ['--no-pager', ...diffArgs], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
        if (dr.status === 0) return parseUnifiedDiffAddedHunks(dr.stdout || '');
      }
    }
    return [diskText.split(/\r?\n/)];
  }
  if (!isHashOrFlag(curVal)) {
    if (curVal.length > MAX_AUDIT_BYTES || curVal.includes('\0')) return [];
    return !isHashOrFlag(baseVal) ? diffAddedHunks(baseVal, curVal) : [curVal.split(/\r?\n/)];
  }
  return [];
}

/**
 * Deterministic zero-dependency scanner for anti-cheat and root-cause signals on newly added lines:
 *  - test bypasses (.skip, .only, .todo, xit, xtest, describe/it/test.skip|.todo) in test files
 *  - silent error-swallowing empty/comment-only catch blocks or .catch(() => {} / null) in non-test code files
 *  - missing root-cause explanation in dev/worker reports on retries (cycle > 1) or bug-fix runs
 */
export function auditPatchSignals({ baseFiles = {}, curFiles = {}, root = ROOT, testsChangedAfterFail = [], reports = {}, cycle = 1, isBugFix = false, baselineDir = null, baseRef = 'HEAD', devIds = null, changedCodeFiles = null } = {}) {
  const signals = [];
  const skippedTests = [];
  const emptyCatches = [];
  const detectedCodeFiles = [];
  const candidateSet = new Set();
  for (const f of Object.keys(curFiles || {})) {
    if (!(f in (baseFiles || {})) || baseFiles[f] !== curFiles[f]) candidateSet.add(f);
  }
  for (const f of testsChangedAfterFail || []) if (f) candidateSet.add(f);

  let gitHeadChecked = null;
  const hasGitHead = () => {
    if (gitHeadChecked !== null) return gitHeadChecked;
    try {
      gitHeadChecked = spawnSync('git', ['rev-parse', '--verify', '-q', baseRef || 'HEAD'], { cwd: root, stdio: 'ignore', timeout: 5000 }).status === 0;
    } catch { gitHeadChecked = false; }
    return gitHeadChecked;
  };

  const seenRel = new Set();
  for (const rawPath of candidateSet) {
    const rel = String(rawPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || seenRel.has(rel)) continue;
    seenRel.add(rel);
    if (NON_CODE_FILE_RE.test(rel)) continue;
    if (!isTestFilePath(rel) && !/^docs\//i.test(rel)) detectedCodeFiles.push(rel);
    try {
      const baseVal = baseFiles?.[rawPath] ?? baseFiles?.[rel];
      const curVal = curFiles?.[rawPath] ?? curFiles?.[rel];
      const hunks = extractAddedHunks({ rel, root, baseVal, curVal, baselineDir, baseRef, hasGitHead });
      if (!hunks.length) continue;

      if (isTestFilePath(rel)) {
        const matched = new Set();
        for (const hunk of hunks) {
          for (const line of hunk) {
            if (/^\s*\/\//.test(line)) continue;
            const m = line.match(TEST_BYPASS_RE);
            if (m) matched.add(m[0].trim());
          }
        }
        if (matched.size) {
          skippedTests.push(rel);
          signals.push(`test bypass/skip detected in ${rel} (${[...matched].join(', ')})`);
        }
      } else {
        let foundCatch = false;
        for (const hunk of hunks) {
          const cleaned = hunk.map((l) => (/^[ \t]*\/\//.test(l) ? '' : l)).join('\n');
          if (EMPTY_CATCH_RE.test(cleaned) || EMPTY_PROMISE_CATCH_RE.test(cleaned)) { foundCatch = true; break; }
        }
        if (foundCatch) {
          emptyCatches.push(rel);
          signals.push(`silent error-swallowing catch block added in ${rel}`);
        }
      }
    } catch { /* never crash on unreadable or transient files */ }
  }

  let missingRootCause = false;
  const codeFiles = Array.isArray(changedCodeFiles) ? changedCodeFiles : detectedCodeFiles;
  const explicitDevIds = Array.isArray(devIds) ? devIds : null;
  let devText = '';
  if (typeof reports === 'string') {
    devText = reports.trim();
  } else if (reports && typeof reports === 'object') {
    if (explicitDevIds) {
      devText = explicitDevIds.map((id) => String(reports[id] || '').trim()).filter(Boolean).join('\n');
    } else if ('lead-dev' in reports) {
      devText = String(reports['lead-dev'] || '').trim();
    } else {
      devText = Object.entries(reports)
        .filter(([k]) => !NON_DEV_REPORT_KEY_RE.test(k))
        .map(([, v]) => String(v || '').trim())
        .filter(Boolean)
        .join('\n');
    }
  }
  const devRan = explicitDevIds ? explicitDevIds.length > 0 : Boolean(devText);
  if ((cycle > 1 || isBugFix) && (codeFiles.length > 0 || devRan)) {
    if (!devText || !ROOT_CAUSE_RE.test(devText)) {
      missingRootCause = true;
      signals.push('dev report on retry/bug-fix omits root cause (expected Symptom, Root Cause, or Blast Radius)');
    }
  }
  return { signals, skippedTests, emptyCatches, missingRootCause };
}

const SAFETY_SKIP_RE = /^\.harness\/(?:releases|visible|staging|completed|failed|worktrees|logs|archive)(?:\/|$)/i;
const DOC_SETEXT_RE = /\.(?:md|mdx|txt|rst)$/i;
const JS_TS_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx)$/i;
const SAFETY_ENV_RE = /\$\{[^}]+\}|\{\{[^}]+\}\}|<[^>\s]{2,}>|process\.env\.|import\.meta\.env\.|os\.environ|os\.getenv|ENV\[/i;
const SAFETY_PLACEHOLDER_RE = /(?:^|[^a-z0-9])(?:example|dummy|sample|placeholder|your[_-]|yourkey|test[_-]?key|fake|mock|redacted|changeme|insert[_-]?here|replace[_-]?me|not[_-]?a[_-]?secret|unset)(?:[^a-z0-9]|$)/i;
const SAFETY_REPEAT_RE = /^(.)\1{7,}$/;
const SAFETY_TEST_PREFIX_RE = /^(?:sk_test|pk_test|rk_test|sk-test)[_-]/i;

const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/;
const PROVIDER_SECRET_PATTERNS = [
  ['AWS access key', /\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g],
  ['Anthropic/OpenAI API key', /\bsk-ant-[A-Za-z0-9_-]{16,}\b|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['Stripe live key', /\b(?:sk_live|rk_live)_[0-9a-zA-Z]{16,}\b/g]
];
const CRED_ASSIGN_RE = /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret|password|passwd|db_pass)['"]?\s*[:=]\s*(['"])([A-Za-z0-9_+=/!@#$%^&*.-]{12,})\2/gi;
const CRED_URL_RE = /\b((?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis|amqps?|https?)):\/\/([^:\s/@'"`<>]+):([^@\s/'"`<>]{4,})@([^:\s/'"`<>]+)/gi;
const CONFLICT_BRACKET_RE = /^(?:<{7}(?:\s.*)?|>{7}(?:\s.*)?)\s*$/;
const CONFLICT_EQ_RE = /^={7}\s*$/;
const DEBUGGER_STMT_RE = /(?:^|[;{}])\s*debugger\b\s*(?:;|$)/;

function isPlaceholderToken(val) {
  if (!val) return true;
  if (SAFETY_ENV_RE.test(val) || SAFETY_PLACEHOLDER_RE.test(val) || SAFETY_REPEAT_RE.test(val) || SAFETY_TEST_PREFIX_RE.test(val)) return true;
  if (/(?:EXAMPLE|DUMMY|SAMPLE|PLACEHOLDER|YOUR_|REDACTED|FAKE|MOCK|0{10,}|x{10,}|X{10,})/.test(val)) return true;
  return false;
}

/**
 * Deterministic zero-dependency pre-commit patch safety scanner on newly added diff hunks.
 * Scans all non-binary changed/added files (including .json, .yml, .yaml, .toml, .md, etc.; skips .harness/releases/**):
 *  - Blocking: leaked API keys/tokens/private keys/credentialed URLs/hardcoded credentials (NEVER echoes matched secret; always redacted)
 *  - Blocking: unresolved merge conflict markers (<<<<<<<, >>>>>>>, and ======= when not a standalone Markdown Setext heading)
 *  - Warning (non-blocking): newly added JS/TS `debugger` statements
 */
export function scanPatchSafety({ baseFiles = {}, curFiles = {}, root = ROOT, baselineDir = null, baseRef = 'HEAD' } = {}) {
  const blocking = [];
  const warnings = [];
  const secretFiles = [];
  const conflictFiles = [];
  const debugFiles = [];

  const candidateSet = new Set();
  for (const f of Object.keys(curFiles || {})) {
    if (!(f in (baseFiles || {})) || baseFiles[f] !== curFiles[f]) candidateSet.add(f);
  }

  let gitHeadChecked = null;
  const hasGitHead = () => {
    if (gitHeadChecked !== null) return gitHeadChecked;
    try {
      gitHeadChecked = spawnSync('git', ['rev-parse', '--verify', '-q', baseRef || 'HEAD'], { cwd: root, stdio: 'ignore', timeout: 5000 }).status === 0;
    } catch { gitHeadChecked = false; }
    return gitHeadChecked;
  };

  const addUnique = (arr, val) => { if (val && !arr.includes(val)) arr.push(val); };

  const seenRel = new Set();
  for (const rawPath of candidateSet) {
    const rel = String(rawPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || seenRel.has(rel)) continue;
    seenRel.add(rel);
    if (SAFETY_SKIP_RE.test(rel)) continue;

    try {
      const baseVal = baseFiles?.[rawPath] ?? baseFiles?.[rel];
      const curVal = curFiles?.[rawPath] ?? curFiles?.[rel];
      const hunks = extractAddedHunks({ rel, root, baseVal, curVal, baselineDir, baseRef, hasGitHead });
      if (!hunks.length) continue;

      const flatLines = hunks.flat();
      let hasBracketMarker = flatLines.some((l) => CONFLICT_BRACKET_RE.test(l));
      let fileConflict = hasBracketMarker;

      if (!hasBracketMarker && flatLines.some((l) => CONFLICT_EQ_RE.test(l))) {
        if (!DOC_SETEXT_RE.test(rel)) {
          fileConflict = true;
        } else {
          // For Markdown/text docs, ======= is a Setext H1 underline unless <<<<<<< or >>>>>>> also exists in the file.
          let diskText = '';
          try { diskText = fs.readFileSync(path.resolve(root, rel), 'utf8'); } catch { diskText = !isHashOrFlag(curVal) ? String(curVal) : ''; }
          if (/^(?:<{7}|>{7})(?:\s|$)/m.test(diskText)) fileConflict = true;
        }
      }
      if (fileConflict) {
        addUnique(conflictFiles, rel);
        addUnique(blocking, `unresolved merge conflict marker in ${rel}`);
      }

      const isJsTs = JS_TS_RE.test(rel);
      for (const line of flatLines) {
        if (PRIVATE_KEY_RE.test(line) && !/-----BEGIN\s+(?:EXAMPLE|DUMMY|SAMPLE|TEST)\s+PRIVATE\s+KEY-----/i.test(line)) {
          addUnique(secretFiles, rel);
          addUnique(blocking, `leaked private key block in ${rel} (redacted)`);
        }

        for (const [label, re] of PROVIDER_SECRET_PATTERNS) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(line)) !== null) {
            if (!isPlaceholderToken(m[0])) {
              addUnique(secretFiles, rel);
              addUnique(blocking, `leaked ${label} in ${rel} (redacted)`);
              break;
            }
          }
        }

        if (!SAFETY_ENV_RE.test(line)) {
          CRED_ASSIGN_RE.lastIndex = 0;
          let cm;
          while ((cm = CRED_ASSIGN_RE.exec(line)) !== null) {
            const keyName = cm[1];
            const secretVal = cm[3];
            if (!isPlaceholderToken(secretVal)) {
              addUnique(secretFiles, rel);
              addUnique(blocking, `hardcoded credential (${keyName}) in ${rel} (redacted)`);
              break;
            }
          }
        }

        CRED_URL_RE.lastIndex = 0;
        let um;
        while ((um = CRED_URL_RE.exec(line)) !== null) {
          const [, scheme, user, pass, host] = um;
          const localHost = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|example\.com|example\.org)$/i.test(host);
          const docCred = (/^user(?:name)?$/i.test(user) && /^pass(?:word|wd)?$/i.test(pass));
          if (!localHost && !docCred && !SAFETY_ENV_RE.test(user) && !isPlaceholderToken(pass)) {
            addUnique(secretFiles, rel);
            addUnique(blocking, `credentialed URL (${scheme}://…@${host}) in ${rel} (redacted)`);
            break;
          }
        }

        if (isJsTs && !/^\s*(?:\/\/|\/\*|\*)/.test(line) && DEBUGGER_STMT_RE.test(line)) {
          addUnique(debugFiles, rel);
          addUnique(warnings, `debug statement (debugger) added in ${rel}`);
        }
      }
    } catch { /* never crash on transient or unreadable files */ }
  }

  return {
    blocked: blocking.length > 0,
    blocking,
    warnings,
    secretFiles,
    conflictFiles,
    debugFiles
  };
}

// ───────────────────────────── adaptive project layout & role scopes ─────────────────────────────

const LAYOUT_SKIP_DIRS = new Set([
  '.git', '.harness', '.claude', '.cursor', '.vscode', '.github', '.idea',
  '.next', '.nuxt', '.svelte-kit', '.astro', '.output', '.cache', '.turbo', '.parcel-cache',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv', 'env', '__pycache__',
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', 'demo-project', '.agent-state',
  'examples'
]);
const STD_DEV_DIRS = new Set(['src']);
const STD_DOC_DIRS = new Set(['docs']);
const STD_TEST_DIRS = new Set(['tests', 'test', '__tests__']);
const EXTRA_DOC_DIRS = new Set(['documentation', 'doc']);
const EXTRA_TEST_DIRS = new Set(['spec', 'specs', 'e2e', 'cypress', 'playwright', 'unit_tests']);
const STYLE_ONLY_DIR_NAMES = new Set(['styles', 'style', 'css', 'scss', 'less', 'theme', 'themes']);
const BACKEND_ONLY_DIRS = new Set(['server', 'api', 'cmd', 'internal', 'pkg', 'backend', 'worker', 'workers', 'prisma', 'db', 'migrations']);
const KNOWN_CODE_DIRS = new Set([
  'app', 'pages', 'components', 'lib', 'server', 'api', 'cmd', 'internal', 'pkg',
  'backend', 'frontend', 'web', 'core', 'utils', 'scripts', 'modules', 'routes',
  'services', 'views', 'models', 'controllers', 'handlers', 'apps', 'packages',
  'client', 'worker', 'workers', 'shared', 'common', 'features', 'hooks',
  'store', 'stores', 'context', 'actions', 'middleware', 'plugins', 'layouts',
  'templates', 'prisma', 'db', 'migrations', 'website'
]);
const UI_CAPABLE_DIRS = new Set([
  'src', 'app', 'pages', 'components', 'styles', 'style', 'css', 'scss', 'less',
  'theme', 'themes', 'views', 'layouts', 'templates', 'web', 'frontend', 'client',
  'apps', 'packages', 'website'
]);
const CODE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|py|go|rs|php|rb|java|kt|cs|vue|svelte|astro|html?)$/i;
const STYLE_EXT_RE = /\.(?:css|scss|less)$/i;
const UI_EXT_RE = /\.(?:css|scss|less|jsx|tsx|vue|svelte|astro|html?)$/i;

function scanDirStats(rootDir, relDir) {
  const stats = { fileCount: 0, hasCode: false, hasStyle: false, hasUi: false, hasGo: false, hasPy: false };
  const walk = (absDir, depth) => {
    if (stats.fileCount >= 1500 || depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (stats.fileCount >= 1500) break;
      if (e.name.startsWith('.') || LAYOUT_SKIP_DIRS.has(e.name)) continue;
      const full = path.join(absDir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      stats.fileCount++;
      if (STYLE_EXT_RE.test(e.name)) stats.hasStyle = true;
      if (UI_EXT_RE.test(e.name)) stats.hasUi = true;
      if (CODE_EXT_RE.test(e.name)) stats.hasCode = true;
      if (/\.go$/i.test(e.name)) stats.hasGo = true;
      if (/\.py$/i.test(e.name)) stats.hasPy = true;
    }
  };
  walk(path.join(rootDir, relDir), 0);
  return stats;
}

/**
 * Inspect top-level folders and language manifests under `root` without mutating anything.
 * Identifies extra code, test, doc, and style folders outside template defaults (`src`, `docs`, `tests`, `test`, `__tests__`).
 */
export function detectProjectLayout(root = ROOT) {
  const extraCodeDirs = [];
  const extraTestDirs = [];
  const extraDocDirs = [];
  const extraStyleDirs = [];
  const existingCodeDirs = [];
  let hasGo = fs.existsSync(path.join(root, 'go.mod'));
  let hasPy = ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'setup.py', 'requirements.txt', 'uv.lock'].some((f) => fs.existsSync(path.join(root, f)));
  let hasUi = false;

  let top = [];
  try { top = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { top = []; }

  for (const e of top) {
    if (!e.isDirectory() || e.name.startsWith('.') || LAYOUT_SKIP_DIRS.has(e.name)) continue;
    const name = e.name;
    const st = scanDirStats(root, name);
    if (!st.fileCount) continue;
    if (st.hasGo) hasGo = true;
    if (st.hasPy) hasPy = true;
    if (st.hasUi || st.hasStyle) hasUi = true;

    if (STD_DOC_DIRS.has(name)) continue;
    if (EXTRA_DOC_DIRS.has(name)) { extraDocDirs.push(name); continue; }
    if (STD_TEST_DIRS.has(name)) continue;
    if (EXTRA_TEST_DIRS.has(name)) { extraTestDirs.push(name); continue; }

    if (STYLE_ONLY_DIR_NAMES.has(name)) {
      if (st.hasStyle || st.fileCount > 0) extraStyleDirs.push(name);
      if (st.hasCode) { extraCodeDirs.push(name); existingCodeDirs.push(name); }
      continue;
    }

    if (STD_DEV_DIRS.has(name)) {
      existingCodeDirs.push(name);
      continue;
    }

    if (KNOWN_CODE_DIRS.has(name) || st.hasCode) {
      extraCodeDirs.push(name);
      existingCodeDirs.push(name);
      if ((UI_CAPABLE_DIRS.has(name) || st.hasUi || st.hasStyle) && (!BACKEND_ONLY_DIRS.has(name) || st.hasStyle || st.hasUi)) {
        extraStyleDirs.push(name);
      }
    }
  }

  return {
    extraCodeDirs,
    extraTestDirs,
    extraDocDirs,
    extraStyleDirs: [...new Set(extraStyleDirs)],
    existingCodeDirs,
    hasGo,
    hasPy,
    hasUi,
    uncoveredDirsCandidates: [...new Set([...extraCodeDirs, ...extraTestDirs, ...extraDocDirs, ...extraStyleDirs])]
  };
}

function cloneJson(v) { return JSON.parse(JSON.stringify(v)); }

function loadRolesFrom(dir) {
  const roles = {};
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const r = readJsonSafe(path.join(dir, f), null);
      if (r?.name) roles[String(r.name).toUpperCase()] = { ...r, file: f };
    }
  } catch { /* no roles dir */ }
  return roles;
}

/**
 * Plan additive scope updates so team.json, charter.md, and roles/*.json match `detectProjectLayout(root)`.
 * Strictly preserves all existing scopes and never widens past forbiddenPaths or overlap rules.
 */
export function planScopeAdaptation(root = ROOT, { team = null, roles = null, charter = null, allowTeam = true, allowCharter = true, allowRoles = true } = {}) {
  const layout = detectProjectLayout(root);
  const curTeam = team || loadTeam(path.join(root, '.harness', 'team.json'));
  const curRoles = roles || loadRolesFrom(path.join(root, '.harness', 'roles'));
  const curCharter = charter || readCharter(path.join(root, '.harness', 'charter.md'));

  const canRole = (name) => (allowRoles === true ? true : allowRoles && typeof allowRoles === 'object' ? allowRoles[name] === true : false);
  const forbidden = curCharter?.forbiddenPaths || [];
  const isSafeGlob = (g) => globProbes(g).every((p) => !matchesAny(p, forbidden));
  const coveredBy = (g, globs = []) => globs.includes(g) || (globs.length > 0 && globWithin(g, globs));

  const nextTeam = curTeam ? cloneJson(curTeam) : null;
  const nextRoles = cloneJson(curRoles);
  let nextAllowed = curCharter?.exists && Array.isArray(curCharter.allowedPaths) && curCharter.allowedPaths.length
    ? [...curCharter.allowedPaths]
    : null;

  const changes = [];
  const charterAdds = [];
  const addedRolePaths = {};
  const addCharterPath = (g) => {
    if (!nextAllowed || !isSafeGlob(g)) return;
    if (!coveredBy(g, nextAllowed)) {
      nextAllowed.push(g);
      charterAdds.push(g);
    }
  };

  if (nextTeam && Array.isArray(nextTeam.members)) {
    const leads = nextTeam.members.filter((m) => m.level === 'lead');
    const findLead = (roleName, preferredId) => leads.find((l) => l.id === preferredId && String(l.role).toUpperCase() === roleName)
      || leads.find((l) => String(l.role).toUpperCase() === roleName);

    const leadDev = findLead('DEV_ENGINEER', 'lead-dev');
    const leadQa = findLead('QA_AUDITOR', 'lead-qa');
    const leadUx = findLead('UX_DESIGNER', 'lead-ux');
    const leadBa = findLead('BA_ANALYST', 'lead-ba');

    const conflictsOtherLead = (selfLead, candidateGlob) => leads.some((other) => {
      if (other.id === selfLead.id) return false;
      return (other.scope || []).some((og) => {
        if (isFileTypeGlob(candidateGlob) !== isFileTypeGlob(og)) return false;
        return globsOverlap(candidateGlob, og);
      });
    });

    const addRoleWritable = (roleName, g) => {
      const r = nextRoles[roleName];
      if (!r || !Array.isArray(r.writablePaths)) return false;
      if (coveredBy(g, r.writablePaths)) return true;
      if (!canRole(roleName)) return false;
      r.writablePaths.push(g);
      (addedRolePaths[roleName] ||= []).push(g);
      return true;
    };

    const addLeadGlobs = (lead, candidates, { expandRole = false, roleGlobFor = (g) => g } = {}) => {
      if (!lead || !Array.isArray(lead.scope)) return [];
      const roleName = String(lead.role).toUpperCase();
      const roleObj = nextRoles[roleName];
      const added = [];
      for (const g of candidates) {
        if (!isSafeGlob(g)) continue;
        const rootFolder = `${g.split('/')[0]}/**`;
        addCharterPath(rootFolder);
        if (coveredBy(g, lead.scope) || conflictsOtherLead(lead, g)) continue;
        const roleGlob = roleGlobFor(g);
        const canFitRole = roleObj && (
          coveredBy(g, roleObj.writablePaths || [])
          || (allowTeam && expandRole && addRoleWritable(roleName, roleGlob))
        );
        if (!canFitRole) continue;
        if (allowTeam) {
          lead.scope.push(g);
          added.push(g);
        }
      }
      if (added.length) changes.push({ target: 'team', id: lead.id, role: roleName, added });
      return added;
    };

    // 1. BA docs folders
    if (layout.extraDocDirs.length) {
      addLeadGlobs(leadBa, layout.extraDocDirs.map((d) => `${d}/**`), { expandRole: allowTeam });
    }

    // 2. Dev code folders
    if (layout.extraCodeDirs.length) {
      addLeadGlobs(leadDev, layout.extraCodeDirs.map((d) => `${d}/**`));
    }

    // 3. UX style globs
    if (layout.extraStyleDirs.length) {
      const styleGlobs = [];
      for (const d of layout.extraStyleDirs) {
        for (const ext of ['css', 'scss', 'less']) styleGlobs.push(`${d}/**/*.${ext}`);
      }
      addLeadGlobs(leadUx, styleGlobs, { expandRole: allowTeam });
    }

    // 4. QA test folders + colocated tests in code dirs + Go/Python conventions
    {
      const qaGlobs = [];
      for (const d of layout.extraTestDirs) qaGlobs.push(`${d}/**`);
      for (const d of layout.extraCodeDirs) {
        qaGlobs.push(`${d}/**/*.test.*`, `${d}/**/*.spec.*`);
      }
      if (layout.hasGo) {
        for (const d of layout.existingCodeDirs) qaGlobs.push(`${d}/**/*_test.go`);
      }
      if (layout.hasPy) {
        for (const d of layout.existingCodeDirs) qaGlobs.push(`${d}/**/test_*.py`, `${d}/**/*_test.py`);
      }
      const qaRoleGlob = (g) => {
        if (g.endsWith('/**/*_test.go')) return '**/*_test.go';
        if (g.endsWith('/**/test_*.py')) return '**/test_*.py';
        if (g.endsWith('/**/*_test.py')) return '**/*_test.py';
        return g;
      };
      addLeadGlobs(leadQa, qaGlobs, { expandRole: allowTeam, roleGlobFor: qaRoleGlob });
    }
  } else {
    // Even without team.json, still adapt charter.allowedPaths if present
    for (const d of layout.uncoveredDirsCandidates) addCharterPath(`${d}/**`);
  }

  // If allowCharter is false, revert any proposed charter changes
  if (!allowCharter) {
    charterAdds.length = 0;
    nextAllowed = curCharter?.allowedPaths ? [...curCharter.allowedPaths] : null;
  }

  for (const [roleName, added] of Object.entries(addedRolePaths)) {
    if (added.length) changes.push({ target: 'role', id: nextRoles[roleName].file || roleName, role: roleName, added });
  }
  if (charterAdds.length) changes.push({ target: 'charter', id: 'charter.md', added: charterAdds });

  const uncoveredDirs = layout.uncoveredDirsCandidates.filter((d) => {
    const rootGlob = `${d}/**`;
    const matchesAdded = changes.some((c) => c.added.some((g) => g === rootGlob || g.startsWith(`${d}/`)));
    return matchesAdded;
  });

  return {
    changed: changes.length > 0,
    layout,
    uncoveredDirs,
    changes,
    nextTeam,
    nextCharterAllowedPaths: charterAdds.length ? nextAllowed : null,
    nextRoles
  };
}

/**
 * Apply (or preview with dryRun: true) adaptive layout scopes to .harness/team.json, .harness/charter.md,
 * changed .harness/roles/*.json, and re-sync .claude/agents/*.md. Validates result before writing.
 */
export function applyAdaptedScopes(root = ROOT, { dryRun = false, allowTeam = true, allowCharter = true, allowRoles = true, allowSyncAgents = true } = {}) {
  const harnessDir = path.join(root, '.harness');
  const teamPath = path.join(harnessDir, 'team.json');
  const charterPath = path.join(harnessDir, 'charter.md');
  const rolesDir = path.join(harnessDir, 'roles');
  const agentsDir = path.join(root, '.claude', 'agents');
  const cfgPath = path.join(harnessDir, 'config.json');

  const team = readJsonSafe(teamPath, null);
  const charter = readCharter(charterPath);
  const roles = loadRolesFrom(rolesDir);
  const cfg = readJsonSafe(cfgPath, {});

  const plan = planScopeAdaptation(root, { team, roles, charter, allowTeam, allowCharter, allowRoles });
  if (!plan.changed) return { applied: false, dryRun, writtenFiles: [], syncedAgents: [], ...plan };

  const validationCharter = plan.nextCharterAllowedPaths
    ? { ...charter, allowedPaths: plan.nextCharterAllowedPaths }
    : charter;
  if (plan.nextTeam) {
    const v = validateTeam(plan.nextTeam, {
      roles: plan.nextRoles,
      charter: validationCharter,
      plannerMaxWorkers: (cfg.planner || {}).maxWorkers || 4,
      engines: Object.keys(cfg.profiles || {})
    });
    if (v.errors.length) return { applied: false, dryRun, errors: v.errors, warnings: v.warnings, writtenFiles: [], syncedAgents: [], ...plan };
  }
  if (dryRun) return { applied: false, dryRun: true, writtenFiles: [], syncedAgents: [], ...plan };

  const writtenFiles = [];
  if (allowTeam && plan.nextTeam && plan.changes.some((c) => c.target === 'team')) {
    fs.writeFileSync(teamPath, `${JSON.stringify(plan.nextTeam, null, 2)}\n`);
    writtenFiles.push('.harness/team.json');
  }
  if (allowCharter && plan.nextCharterAllowedPaths && fs.existsSync(charterPath)) {
    const rawCharter = fs.readFileSync(charterPath, 'utf8');
    const updated = rawCharter.replace(/^(\s*[-*]\s*\**allowedPaths\**\s*:\s*)(.+?)\s*$/mi, (_, pfx) => `${pfx}${plan.nextCharterAllowedPaths.join(', ')}`);
    if (updated !== rawCharter) {
      fs.writeFileSync(charterPath, updated);
      writtenFiles.push('.harness/charter.md');
    }
  }
  for (const c of plan.changes.filter((x) => x.target === 'role')) {
    const r = plan.nextRoles[c.role];
    if (!r?.file) continue;
    const roleOut = { ...r };
    delete roleOut.file;
    fs.writeFileSync(path.join(rolesDir, r.file), `${JSON.stringify(roleOut, null, 2)}\n`);
    writtenFiles.push(`.harness/roles/${r.file}`);
  }
  let syncedAgents = [];
  const teamOrRolesWritten = writtenFiles.includes('.harness/team.json') || writtenFiles.some((w) => w.startsWith('.harness/roles/'));
  if (allowSyncAgents && plan.nextTeam && teamOrRolesWritten) {
    const ag = syncAgents(plan.nextTeam, plan.nextRoles, { dir: agentsDir, config: cfg });
    syncedAgents = ag.written;
  }
  return { applied: writtenFiles.length > 0, dryRun: false, writtenFiles, syncedAgents, ...plan };
}

export { ROOT };
