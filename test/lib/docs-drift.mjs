/**
 * test/lib/docs-drift.mjs — pure, zero-dependency "do the docs still state the truth?" checks.
 * Used by test/audit.mjs (on the real docs) and test/run-tests.mjs (on synthetic strings).
 *
 * Facts come from the source of truth: { leads: ['lead-ba', ...], roles: ['BA_ANALYST', ...], version: '1.0.20', agentCount, skills: [...], allowedPaths: [...] }.
 * Every check returns [{ line, rule, msg }] (1-based line numbers).
 *
 * Opt-out: put `docs-drift:ignore` on a line (or the line right above it), e.g. `<!-- docs-drift:ignore -->` in
 * Markdown or `// docs-drift:ignore` in TypeScript, for text that is genuinely about a subset (one phase, one tier).
 * Fenced json/js/ts code blocks are skipped (they are examples, not claims).
 */
export const IGNORE_MARKER = 'docs-drift:ignore';

const SHORT = (id) => id.replace(/^lead-/, '').toUpperCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isTreeBranch = (s) => /^\s*(?:[│|]\s*)*(?:[├└][-─]+|[+|\\`][-─]+)\s+\S/.test(s);

/** Lines as claim units: [{ line, text }]. Skips ignored lines and example code fences; joins wrapped lists & tree branches. */
export function claimUnits(text) {
  const raw = String(text).replace(/\r\n/g, '\n').split('\n');
  const units = [];
  const fenceRe = /^\s*```(\w*)/;
  let skipFence = false;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const fence = t.match(fenceRe);
    if (fence) { skipFence = skipFence ? false : /^(json|jsonc|js|javascript|mjs|ts|tsx)$/i.test(fence[1]); continue; }
    if (skipFence) continue;
    const ignored = (k) => k >= 0 && raw[k].includes(IGNORE_MARKER);
    if (ignored(i) || ignored(i - 1)) continue;
    let joined = t; let j = i; let treeMerged = false;
    // a list wrapped over lines ("`lead-ba`,\n`lead-dev`") or a tree diagram ("├─ lead-ba\n└─ lead-dev") is one claim
    while (j + 1 < raw.length && !fenceRe.test(raw[j + 1]) && raw[j + 1].trim() && !raw[j + 1].includes(IGNORE_MARKER)) {
      if (isTreeBranch(raw[j]) && isTreeBranch(raw[j + 1])) { j++; joined += ' ' + raw[j].trim(); treeMerged = true; }
      else if (/(,|·|\band|\bor|&|\+|\/)\s*$/.test(joined.trimEnd()) && !/[}\]]\s*,?\s*$/.test(joined.trimEnd())) { j++; joined += ' ' + raw[j].trim(); }
      else break;
    }
    units.push({ line: i + 1, text: joined });
    if (treeMerged) i = j;
  }
  return units;
}

/** a. a line naming 2+ distinct leads must name all of them. */
export function checkLeadRoster(text, facts) {
  const out = [];
  const ids = facts.leads;
  if (ids.length < 2) return out;
  const re = new RegExp(`(?<![\\w-])(${ids.map(esc).join('|')})(?![\\w-])`, 'g');
  for (const u of claimUnits(text)) {
    const seen = new Set([...u.text.matchAll(re)].map((m) => m[1]));
    if (seen.size >= 2 && seen.size < ids.length) out.push({ line: u.line, rule: 'lead-roster', msg: `names ${[...seen].join(', ')} but not ${ids.filter((x) => !seen.has(x)).join(', ')} (add them or mark the line ${IGNORE_MARKER})` });
  }
  return out;
}

/** b. abbreviated rosters: "Leads (BA, DEV, QA)", "BA, DEV and QA" when the team has more leads. */
export function checkAbbrevRoster(text, facts) {
  const out = [];
  const shorts = facts.leads.map(SHORT);
  if (shorts.length < 2) return out;
  const tok = shorts.map(esc).join('|');
  const re = new RegExp(`(?<![\\w-])(?:${tok})(?:\\s*(?:,\\s*(?:and\\s+|&\\s*)?|\\s+and\\s+|\\s*&\\s*|\\s*\\+\\s*|\\s*/\\s*)(?:${tok})(?![\\w-]))+`, 'g');
  for (const u of claimUnits(text)) {
    for (const m of u.text.matchAll(re)) {
      const set = new Set(m[0].match(new RegExp(tok, 'g')));
      if (set.size >= 2 && set.size < shorts.length) out.push({ line: u.line, rule: 'abbrev-roster', msg: `"${m[0]}" lists ${set.size} of ${shorts.length} leads (${shorts.join(', ')})` });
    }
  }
  return out;
}

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const KH = { '\u1798\u17bd\u1799': 1, '\u1796\u17b8\u179a': 2, '\u1794\u17b8': 3, '\u1794\u17bd\u1793': 4, '\u1794\u17d2\u179a\u17b6\u17c6': 5, '\u1794\u17d2\u179a\u17b6\u17c6\u1798\u17bd\u1799': 6 };

/** c. "three leads", "4 named agents": must equal the real lead count (named agents: leads or every named agent). */
export function checkCounts(text, facts) {
  const out = [];
  const n = facts.leads.length;
  const total = facts.agentCount || n;
  const reL = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:named\s+|lead\s+|team\s+)?(leads|lead agents|named agents|named leads)\b/gi;
  const reK = /\bleads?\s+(\u1794\u17d2\u179a\u17b6\u17c6\u1798\u17bd\u1799|\u1798\u17bd\u1799|\u1796\u17b8\u179a|\u1794\u17b8|\u1794\u17bd\u1793|\u1794\u17d2\u179a\u17b6\u17c6)(?![\u1780-\u17ff])/g;
  const pairBeforeRe = /\b(?:no|never|any|each|where|when|if|between)\s+$/i;
  const pairAfterRe = /^(?:'|\s+(?:share|have|could|can|may|with|that|overlap)\b)/i;
  for (const u of claimUnits(text)) {
    for (const m of u.text.matchAll(reL)) {
      const v = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM[m[1].toLowerCase()];
      const before = u.text.slice(0, m.index);
      const after = u.text.slice(m.index + m[0].length);
      if (v === 2 && /leads/i.test(m[2]) && (pairBeforeRe.test(before) || pairAfterRe.test(after))) continue;
      const named = /named agents/i.test(m[2]);
      if (v >= 2 && v !== n && !(named && v === total)) out.push({ line: u.line, rule: 'count', msg: `"${m[0]}" but team.json has ${n} leads${named ? ` (${total} named agents)` : ''}` });
    }
    for (const m of u.text.matchAll(reK)) if (KH[m[1]] !== n) out.push({ line: u.line, rule: 'count', msg: `"${m[0]}" (=${KH[m[1]]}) but team.json has ${n} leads` });
  }
  return out;
}

/** d. role tokens must be real files in .harness/roles. */
export function checkRoleNames(text, facts) {
  const out = [];
  const known = new Set(facts.roles);
  const reSuffix = /(?<![\w])[A-Z][A-Z]*(?:_[A-Z]+)*_(?:ANALYST|ENGINEER|DESIGNER|AUDITOR|ARCHITECT)(?![\w])/g;
  const reBare = /`(REVIEWER|SECURITY|COORDINATOR)`|^\s*\|\s*(REVIEWER|SECURITY|COORDINATOR)\s*\|/g;
  for (const u of claimUnits(text)) {
    for (const m of u.text.matchAll(reSuffix)) if (!known.has(m[0])) out.push({ line: u.line, rule: 'role-name', msg: `role ${m[0]} does not exist in .harness/roles (${[...known].join(', ')})` });
    for (const m of u.text.matchAll(reBare)) { const r = m[1] || m[2]; if (!known.has(r)) out.push({ line: u.line, rule: 'role-name', msg: `role ${r} does not exist in .harness/roles` }); }
  }
  return out;
}

/** e. "current/latest version", "this template is vX.Y.Z" and version badges must equal package.json. Dated notes are history. */
export function checkVersionClaims(text, facts) {
  const out = [];
  const v = facts.version;
  const pats = [
    /\b(?:current|latest)\s+(?:template\s+|harness\s+|release\s+)?version\b[^\d\n]{0,40}v?(\d+\.\d+\.\d+)/gi,
    /\bthis\s+template\s+is\s+\*{0,2}v?(\d+\.\d+\.\d+)/gi,
    /img\.shields\.io\/badge\/(?:version|release|v)[^)\s"']*?[-/=]v?(\d+\.\d+\.\d+)/gi,
  ];
  for (const u of claimUnits(text)) {
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(u.text)) continue; // a dated note is history, not a claim about now
    for (const re of pats) for (const m of u.text.matchAll(re)) if (m[1] !== v) out.push({ line: u.line, rule: 'version', msg: `claims version ${m[1]} but package.json is ${v}` });
  }
  return out;
}

/** f. hard-coded test counts go stale on the next commit: say "the test suite" instead of a number. */
export function checkTestCounts(text) {
  const out = [];
  const re = /\b\d+\s*(?:\/\s*\d+\s*)?(?:(?:generated|e2e|unit|automated)\s+)?(?:QA\s+)?tests?\b(?!\s*(?:dir|folder|file|script))/gi;
  for (const u of claimUnits(text)) {
    for (const m of u.text.matchAll(re)) out.push({ line: u.line, rule: 'test-count', msg: `hard-coded test count "${m[0]}" (reword without a number, or mark the line ${IGNORE_MARKER})` });
  }
  return out;
}

/** g. a block naming 3+ built-in skills must name all of them (use docs-drift:ignore for partial examples). */
export function checkSkillRoster(text, facts) {
  const out = [];
  const skills = Array.isArray(facts.skills) ? facts.skills : [];
  if (skills.length < 4) return out;
  const raw = String(text).replace(/\r\n/g, '\n').split('\n');
  const re = new RegExp(`(?<![\\w-])(${skills.map(esc).join('|')})(?![\\w-])`, 'g');
  const isStandaloneIgnore = (s) => /^(?:<!--[\s\S]*-->|\/\/.*|\/\*[\s\S]*\*\/)$/.test(s.trim()) && s.includes(IGNORE_MARKER);
  let skipFence = false;
  let ignoreBlock = false;
  let i = 0;
  while (i < raw.length) {
    const t = raw[i];
    const fence = t.match(/^\s*```(\w*)/);
    if (fence) { skipFence = skipFence ? false : /^(json|jsonc|js|javascript|mjs|ts|tsx)$/i.test(fence[1]); ignoreBlock = false; i++; continue; }
    if (skipFence) { i++; continue; }
    if (!t.trim() || /^\s*(?:#{1,6}\s|---+\s*$)/.test(t)) { ignoreBlock = false; i++; continue; }
    if (isStandaloneIgnore(t)) { ignoreBlock = true; i++; continue; }
    const start = i;
    const lines = [];
    while (i < raw.length) {
      const l = raw[i];
      if (!l.trim() || /^\s*```/.test(l) || /^\s*(?:#{1,6}\s|---+\s*$)/.test(l)) break;
      if (!l.includes(IGNORE_MARKER) && !(i > 0 && isStandaloneIgnore(raw[i - 1]))) lines.push(l);
      i++;
    }
    if (!ignoreBlock && lines.length) {
      const seen = new Set([...lines.join('\n').matchAll(re)].map((m) => m[1]));
      if (seen.size >= 3 && seen.size < skills.length) {
        out.push({ line: start + 1, rule: 'skill-roster', msg: `lists ${seen.size} of ${skills.length} built-in skills (missing ${skills.filter((x) => !seen.has(x)).join(', ')}; add them or mark with ${IGNORE_MARKER})` });
      }
    }
    ignoreBlock = false;
  }
  return out;
}

/** h. `- allowedPaths: ...` lines quoting charter.md section 0 must list every path in charter.md. */
export function checkCharterPaths(text, facts) {
  const out = [];
  const paths = Array.isArray(facts.allowedPaths) ? facts.allowedPaths : [];
  if (!paths.length) return out;
  for (const u of claimUnits(text)) {
    const m = u.text.match(/^\s*[-*]\s*\*{0,2}`?allowedPaths`?\*{0,2}\s*:\s*(.+)$/i);
    if (!m) continue;
    const rhs = m[1].split('←')[0];
    const missing = paths.filter((p) => !new RegExp(`(^|[\\s,\`])${esc(p)}(?=$|[\\s,\`|;])`).test(rhs));
    if (missing.length) out.push({ line: u.line, rule: 'charter-paths', msg: `allowedPaths quote is missing ${missing.join(', ')} (charter.md has ${paths.join(', ')})` });
  }
  return out;
}

/** Every rule on one file. opts.testCounts: also apply rule f (README + website copy only). */
export function checkDoc(text, facts, opts = {}) {
  return [
    ...checkLeadRoster(text, facts), ...checkAbbrevRoster(text, facts), ...checkCounts(text, facts),
    ...checkRoleNames(text, facts), ...checkVersionClaims(text, facts),
    ...checkSkillRoster(text, facts), ...checkCharterPaths(text, facts),
    ...(opts.testCounts ? checkTestCounts(text) : []),
  ].sort((a, b) => a.line - b.line);
}
