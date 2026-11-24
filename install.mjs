#!/usr/bin/env node
/**
 * install.mjs — copy this harness into another project, without overwriting that project's files.
 *
 *   node install.mjs /path/to/your/project [--autonomous off] [--no-auto-assign] [--no-adapt-scopes] [--with-skills | --no-skills]
 *     default: once, also installs Skill Foundry's default skills (it decides the set); --with-skills all of them; --no-skills none; skipped with HARNESS_OFFLINE=1
 *   node install.mjs --reset [/path/to/your/project] [--autonomous off]   (clean a "Use this template" copy)
 *
 * - .harness/ is copied (your existing memory, inbox and logs are kept if already there).
 * - AGENTS.md / CLAUDE.md / GEMINI.md / copilot / cursor / windsurf files: created if missing;
 *   if they exist, a short "harness" section is appended once (never replaced).
 * - .vscode/tasks.json: created if missing; if it exists, the Harness tasks are merged in
 *   (if it cannot be parsed, e.g. it has comments, they go to .vscode/tasks.harness.json instead).
 * - .claude/: untouched template commands/agents refreshed on upgrade (custom edits stay), settings.json merged (your rules stay, nothing is loosened).
 * - Your own charter, backlog, customized team/roles/skills and memory are preserved (untouched template roles/team/starter stubs upgrade cleanly with new design & review steps). Re-running is safe.
 * - Local runtime files (live feed, state, logs) are never copied from this template.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const RESET = ARGS.includes('--reset');
const positional = ARGS.filter((a, i) => !a.startsWith('--') && ARGS[i - 1] !== '--autonomous');
const target = (positional[0] || (RESET ? '.' : '')) && path.resolve(positional[0] || '.');
if (!target) { console.error('Usage: node install.mjs /path/to/your/project [--autonomous off]\n       node install.mjs --reset [/path/to/your/project] [--autonomous off]'); process.exit(1); }
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) { console.error(`Not a folder: ${target}`); process.exit(1); }
if (!RESET && path.resolve(target) === path.resolve(SRC)) { console.error('Target is this template itself. (To clear its owner settings, use --reset.)'); process.exit(1); }
// Any copy of the template (a clone, a worktree, the lab) is never a target either, whichever installer copy runs
// (e.g. the one npx downloads): installing there would add a project's MANIFEST, deny rules and pointer sections to
// the template's own files.
{
  const isTemplateCopy = fs.existsSync(path.join(target, 'install.mjs')) && fs.existsSync(path.join(target, 'docs', 'MAINTAINING.md'))
    && /"name":\s*"agentic-harness"/.test((() => { try { return fs.readFileSync(path.join(target, 'package.json'), 'utf8'); } catch { return ''; } })());
  if (!RESET && isTemplateCopy) { console.error(`Target is a copy of the harness template (${target}), not a project. Nothing was installed. (To clear owner settings in a template copy, use --reset.)`); process.exit(1); }
}

const report = [];
// Runtime + personal history never travels to another project.
// approvals.json is per person (which AI tools THEY allowed): copying it would silently allow the template owner's tools.
// MANIFEST.json is written fresh for each install below.
const RUNTIME = new Set(['update-check.json', 'skill-registry.json', 'skill-fetch.lock', 'state.json', 'telemetry.log', 'daemon.pid', 'engine-probe.json', 'auto-lessons.md', 'live.log', 'auto-state.json', 'approvals.json', 'MANIFEST.json']);
// The target project's own data wins: memory, config, charter, backlog, roles, skills, team.
// A new project gets a blank profile, never the profile of whoever owns this template copy.
const PROFILE_TEMPLATE = `# Project profile

This file describes the PROJECT for every AI (the editor chat AND the harness workers). It is shared (committed), so
it holds nothing personal. Replace each "(fill me)", or tell your editor AI: "Read AGENTS.md and fill in the project
profile".

Your own name, language, answer style and hats (po, ba, ux, dev, qa) go in .harness/memory/me.md, which is
git-ignored and yours only: node .harness/memory.mjs me set --name "…" --language "…" --hats "dev"
(your AI asks you the first time). To let teammates see your name and hats: node .harness/memory.mjs me share

- What this project is: (fill me)
- Who it is for: (fill me)
- Things the AI must always ask before doing: (fill me — e.g. "deleting files, pushing to GitHub, paying for anything")
- House rules for every answer (optional): (fill me — e.g. "cite file:line for every claim")
`;
// A new project starts with no taught rules, never the rules of whoever owns this template copy.
const LESSONS_TEMPLATE = `# Lessons the user taught

Rules here are read by every AI (editor chats, terminal CLIs, cloud sessions) and
injected into every harness worker prompt.
Add permanent rule (git-tracked):         node .harness/memory.mjs remember "..."
Save local/technical lesson (git-ignored): node .harness/memory.mjs learn "..."
Remove rule:                               node .harness/memory.mjs forget L3
`;
const OBJECTIVES_PLACEHOLDER = '- Project objectives: (describe your product goals here to customize for your own app)';
// Skills that describe how to work ON this template (install.mjs, its tests, its engine profiles). They stay in this repo:
// an installed project's .claude/skills/ belongs to Skill Foundry, and these would inject unrelated rules into other workers.
const TEMPLATE_ONLY = ['.harness/skills/template-leak-check', '.harness/skills/engine-profile-checks'];
const sha256Norm = (text, trimEnd = false) => {
  const s = String(text || '').replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(trimEnd ? s.trimEnd() : s).digest('hex');
};
// SHA-256 digests (LF-normalized, exact or trimEnd) of historical template stock files so upgrades refresh untouched
// template commands, agents, roles, starter-stub spec-writer, and team configs while keeping any file the user edited.
const OLD_STOCK_SHA = {
  '.claude/commands/harness/auto.md': [
    '19b4b2f1d90f7e6ee47503c4f2dc95ebb3cf2206dbd482c2cf053c4270a5ca7e',
    '1be2268cc11063f942eafc26e00a9fa773c28009191829503acf6bfc9ec76573',
    '8c325913846a044e09e68009c1488c9e4f05bd89c9ac71ff1daf84f412729256',
    '3f32c962583b2f59d45c29e751818aa8c1303debf527d5429b7f1020e3a6775e'
  ],
  '.claude/commands/harness/feature.md': [
    'd1cf928ce5c83102d1461d2a2f570dd3336d7772f0f2c92a08dc28dec886287a',
    'e2179afc046732fa3b3835f84369a2ab9c48eba3681e64e2e308b4ab2de3a67b'
  ],
  '.claude/commands/harness/run.md': [
    '91e4348f14b366adfd2f8af15d3424e91009b7c0773eb6e596b4339379a34e25',
    '11a112248a02bc6d5f409f7d11dbd8dff96ed8edf24c45f94969f3692a31868f',
    '92376ff17b4d48b6065cff8e5e847241e9c3958a0f0a7521048ff495d384af27',
    '399c56a544b98e13e5e8eca9311d38a68c42a84da99fb74f62d6433d0cb10ae4',
    '66ba9a556b63e2e82949ab1158dff027485300d55a05b9170cedb44368f1509c',
    '7675d08f060b3e9439fc1d5f297491276ea267cb48d80248a468fe50e4eae174',
    'bdf8b7fa56540ceb979c9f6e07d34217ab067c8d3f7dfcbce6976673482f27a6',
    '2ab214e55c5c20d7729f7a9610caba41557686a22d007b326f7c5a91b1ba99c1',
    '4d701735192da92de932d51f0bfafdaa0ffe49b6e636e15b66853fa1f02b6008',
    '416c804a99754d4725da792e63c34867c757b01ec5f526470fbcf628b5622e0c',
    'ade0fe4f0ab99f211cf88f412e7dcbb54233f015802d662f35020f76155e15b9',
    '944501f9f386ac22a6bfdea4c4282fddec3357a1ebb7a0f0f8bc001b9ccb7bde',
    '9f3d69e96b11940239da3441df91178d6f3907f312abbecc883d2fe6b40fe84e',
    '84da97d24250cce575f21f0544e916695553f6e865ea44ba3c334a2f1bc8db71',
    'cc447d5041ff391f3858afbeaa67f5cab205f7bb2521126872237e1cce01574c',
    'e7d6255e861839e26a9749495658b33ea24c9fdedd0742b128bd45d5385ecbb1',
    '8032b3947b41b03a6d9b80462e9051b5e888657caeb7f0ba47fa15ede37c3d9f',
    '82e947b585e0ae43e048f166179ff94458c6e93e14bc86ccc3d6a56c4d5d3a93',
    '27e4deba6a58df2eca35501f7391b1186ae1be355a7f61861726eb4aa58520dc',
    'e6b52d22126dedc6ae93b3c0f3ed347b2e15e8386a9587473b38a7c500064ae8',
    '8f0a5db401a58b9dc9a096d8d1d42da457cf844483b3516f82187421fad1eb93',
    '6d16e6a17d7f002d9b987f7c842ac6ab30298f0b760e013ea57c85fdf5bea320'
  ],
  '.claude/commands/harness/sessions.md': [
    'cd5efa9437aece54154318230068435d9538b00b892d9475c217a269e54a355e',
    '98c49432ea7c4cfa9ea0c2dbf9e384aa2cb4b31e793f261d73dc7c6d49806ab3',
    '79540a01e717c84071ed8a808d98f99c3010fbce010cc74859a04bb5a010c82d',
    'eee2f14e541f1c6995b389c4a3bd2f250aabfb3e9bc2b7255e9b29c9fbb84a74'
  ],
  '.claude/commands/harness/status.md': [
    '5e865ff3bd1b7b5ba8c97c3f942a8bc26e1ab150042e43938c7969f7cceb785d',
    'bcd159d75d4128f8be9ad6de20a9bd858eb792aa3170af58e797c2546cdee6d0'
  ],
  '.claude/commands/harness/teach.md': [
    'a81b898b133eb87481618f4df3736a2abc9ca8e246b18e7f8fa129add2518668',
    'b4a0af7f0b8ed456953246ef47344ad8b6971dd578055566265f400e859abed2',
    '86e335b5580db76378eebaad838cf1e62273e2a393ca20287cb5aee3e9de8615',
    '53c85a04697ba7b352d3076e73fb60a45ffa0d04625973a1117d3c239dc1af2c'
  ],
  '.claude/agents/lead-ba.md': [
    'b21b5ff9b8f9746889cba32c8ee83a9bdc56dc75449d05d5a24b6db43b42a172',
    '3663767769dba2fb94a3c97f5c2c6e6805cf64778e2f4edb87994b0925c0ec8a'
  ],
  '.claude/agents/lead-dev.md': [
    'aaaa6a9864d24f5748927b6d97d4ee546399dfafedbb192465c7e22b447f7b55',
    'ee80d6682bb1fe6acd279a62e944d6c01249f57b1424ae146d13e4477ab6e896',
    '92d619cceafc46325d178a1d3bbe28744560383f8520e24027754e31bd8523e6',
    'bd349c5ecef47851e2852749e5d92ad4ad515a765853885872a3893607144673',
    'e9a10db9d17d4a1603765fc12fbcb7a40e858c48562a2b42943435ed5008e0af',
    '816632b5d508780bf3504cc2f2067ff965ab35f1f163f21e1c5d87a8f11839de'
  ],
  '.claude/agents/lead-qa.md': [
    'aac238a0a85cfc1cc19f53021e9a65d0a89cb5ffb39c893f67b00551ef3c0f44',
    '9f3ae5a228f346f631ad54f975bc6f82cb3a7db850f98cfbf0fcb62d223ba50a',
    '35ca0af7651ba2fdf0cd9513eb562e9c5d9a4a2f92be3278a2fe31a3eaff39a9',
    '592d9bf4c80fcd58850da1f91b80aaef357ceb751b8ed104815e385b3289b945',
    '796117ecc05d4467f1a3823ac6db63d57a5fe3faf8161c032d1addff0765a980',
    '77f225558ae3c94fcf9e5e7ad86453599cbf8e6c8c489f77dc5299ca488e9017',
    '8d36641a084773413e88d4ba8affd6d5400577b021792e0eedee411da7f1eca6',
    'e2842d41348deee21997389b74436af2f134bd694ab5232091b51b08dbc7148e'
  ],
  '.claude/agents/lead-ux.md': [
    '9b336d8b1afcc9ca60167d81eb19cf20816d87a801e984f523b460301f2eee33',
    '666e094bcbe5d981c34d569f1a63d4bd4eb4d347c05754aa33af0fae5e4668d2'
  ],
  '.claude/agents/reviewer.md': [
    'b67f1cc0c31c75dd83e5e6cedfacf4840d8dc6dcf811719a3fcb216591f1016d',
    '1778f220be9e254a790d98e23ffdc116fc6cd8c31eeea0ca8e4bdd5ca9608cfb',
    '95a056fae4bc811c73007a09f4e53fe9d6b3416d2588648ddcbe2f823b4cb937',
    'cb21d079c7b81f96011c1ee3d27fdd133cb61fb81b53d7ffdb146e181fdeddfc',
    '5cc7e8260253dcf739fb722f2698f1340e2a495073711e00157774608d2fccd9',
    'e6a7d7053d760b13a35ca68297aea477552e4e468def0b860b0a310722b810a0'
  ],
  '.claude/agents/security.md': [
    'b4c8647b93d87964a8f140ea8082375a361a3d28fcaceac31161b69cb6810d42',
    'd47754a480dba001494ad0bb77fe342dc8c2d14ef0314b06c276180a4c678efd'
  ],
  '.harness/roles/ba-analyst.json': [
    '13fda9506d6739e933cbb426970669af1263f049138b8cc539f7c83e6406eaf5',
    '7d16fbaa7f8ff2f4420da84d0acd3254993feb30bf835f4865e4880826e8ccae'
  ],
  '.harness/roles/dev-engineer.json': [
    '0262007148639c61dce183d921811b3910798efcf2eb5140baa231863b28159c',
    'f954b1d86bec6ebce3ab2c40e3ceacd568ee98dd9ccc6b29dc02a8a6c2e56c47',
    '1a5ee19adeddcd1006213d0e27408cde7e6e11a62308a92c156353f053d4d8f9',
    '46ab6ec32bdf202387065652ec022b1199e014ba07afb7ecb52c8d3127d5f191'
  ],
  '.harness/roles/qa-auditor.json': [
    'a41bc3cdd45161631e260acc52f46a7c37ec870e406033b0800f9d18c814c24e',
    '14b7fedc8e0176776c2fc664fe4604ba044833744651eb8b95442497cc35cd58',
    'eeb82c4c46ab29f34b336e4d2d51c76a79426387c420b113c54acb05ab43dd7c',
    'a6558f3983131943a2dfbbfbeca0e189667fe0b2639edbbae72d91f5e363489e'
  ],
  '.harness/roles/reviewer.json': [
    '589ac493de46acba64c1a03aacb476b1e88e0dc23f96f700d4bd8a321f2774b0',
    '86b1d503b62ab35d9c5dd1cb84cb6562e67ba1ab8ebaf47de2af4f76adbac799',
    '7aea8a77c0927faeef8ace6a4d9c0b2bf714cfabc8f9623b13d0fdde942127ba',
    '945fa5f236cf802f5bb7b9f223c6d00c77fabe79c52c749a6a06384190cfe741',
    '26a94e71bb92210f033751a38af202c5c1d1cf939c7b851914d3f97552836f6f',
    '0c8a3668c4e409bbf064e407fbdeeab033600218de5f37ec1a5483740b384a9f'
  ],
  '.harness/roles/security.json': [
    '54cc5270ffe639e73508f8ced3f14942077273ebebe32bedd0d52061298a5b4e',
    'fcae2f6c16d0c46260d1e9195bc32f8dd7c88a6d848a45c29411c2deca481fae'
  ],
  '.harness/roles/ux-designer.json': [
    'c14d7be4d4e686f8ff3619b8c8f285a4e7c226f045b5381c85aca53b2e3ce88c',
    '5d33acb9dff10f721e441d49b757adc9b10e7468f849f073e2230315258f78d7',
    '0a642d0497663af6fc6e18bb34a46bf11b273a8e2f3696f3fe14747cddff755c',
    'ba4cf22872dff3ca5e88903d9afe2f5b5636d9333761f4ab7a98b48711c3a08e'
  ],
  '.harness/skills/spec-writer/SKILL.md': [
    '90b9bddfc8cff8b02c4ab6f78d1abb750c1ba8963e14d1b0c8e58cbff57026e7',
    'f14d673bad4efe2ef816f55dd6f894a06603d7805eeec73dde88aa902ff6ca21',
    '00af0aa3e40020c29a2fffe323b8b90046aac84d7c3ad996a78247e82a989812',
    '7fb11973a154c1caa78e5451d023eeb203a62208d6c0066a22d8195319546ebd'
  ],
  '.harness/team.json': [
    '975e766a8d669f2c0a3d2664257feb36a1b505fd22bed31cfdc24bd41a469ded',
    '20b0b693a113a13c2b4c96a85e222681f27a7f71b07f0c863065802892324d74',
    'bc4f1872fb685c86a5025a8e433e9ae4e93511b92a127efbfa0bdfabefb92502',
    'b48fe0f34fc06bdbf0ed6a1dc9a2484528f9dfcb3ee5ec861cbe5834cf592f9d',
    '3730a85e6931d4921aa9683a6ba4c459f28654d2abd7b1537aa779e9ec9b76b9',
    '36dad7d9c893930c08b7baa06647e6a95ef14957b49db9604a9e2d77b7fac030',
    '86945d3152be59c81e0bd28696fb7b80a6c24d0337fa899cd9fa4c5add405814',
    '74fcf26dbc50cc10cebb311e101bac0d67701e062c1d3bbdc2517fad7c53e5d3'
  ]
};
const OLD_ROLE_MISSION_SHA = {
  'dev-engineer.json': ['10fc5c009384b4e955e69d1943dfe591164c4f976dedbb18ed3ee06add6ba974'],
  'qa-auditor.json': ['75df81945e4fc4508dfd96c1ff56338522e9a5ea02db7a394849e3d841b2d929'],
  'reviewer.json': [
    '12a00667bed3b4d2a0692f8f18b103a4e0f3b638ee0fd2f595a832fd574fd1a9',
    '7353fa5e7cbf241c661ac72025b752aaa46a2680168272792c3d7cb41fea4808',
    '283de608c428b0d9f6e179503d6e258178327b72415e99c977bbbe60dd4c0996'
  ],
  'security.json': ['1493b1f3cfb71f5969eb4a2e35d35d26b76427e9184b256d6780926476c1815b'],
  'ux-designer.json': ['a7daf890deea30a0fbdd2b1c0867654cf34dc6f8d95cb2179054ef13fe0038ab']
};
const matchesStock = (relPosix, text) => {
  const list = OLD_STOCK_SHA[relPosix];
  return Array.isArray(list) && (list.includes(sha256Norm(text, false)) || list.includes(sha256Norm(text, true)));
};

/**
 * Refresh an existing role JSON only when it was never hand-edited by the user (matches a prior stock role hash
 * or a prior stock mission with adapted writablePaths). Keeps custom/adapted paths and adds new template capabilities.
 */
function upgradeRole(existingText, templateText, fileName) {
  const relPosix = `.harness/roles/${fileName}`;
  if (matchesStock(relPosix, existingText)) return { text: templateText.replace(/\r\n?/g, '\n'), how: 'untouched template role -> latest instructions & paths' };
  let cur = null; let tpl = null;
  try { cur = JSON.parse(existingText); tpl = JSON.parse(templateText); } catch { return null; }
  if (!cur || !tpl || cur.name !== tpl.name) return null;
  const missions = OLD_ROLE_MISSION_SHA[fileName] || [];
  if (!missions.includes(sha256Norm(cur.mission, false))) return null;
  const nextTools = [...(Array.isArray(cur.allowedTools) ? cur.allowedTools : [])];
  for (const t of tpl.allowedTools || []) if (!nextTools.includes(t)) nextTools.push(t);
  const nextPaths = [...(Array.isArray(cur.writablePaths) ? cur.writablePaths : [])];
  for (const p of tpl.writablePaths || []) if (!nextPaths.includes(p)) nextPaths.push(p);
  const next = { ...cur, description: tpl.description, mission: tpl.mission, allowedTools: nextTools, writablePaths: nextPaths };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  return sha256Norm(existingText, false) === sha256Norm(text, false) ? null : { text, how: 'updated role instructions/paths; kept your custom paths' };
}

const KEEP_IF_PRESENT = /^\.harness[\\/](memory[\\/]|inbox[\\/]|completed[\\/]|failed[\\/]|roles[\\/]|skills[\\/]|config\.json$|charter\.md$|backlog\.json$|team\.json$)/;
// A project's skills are its own and are kept. A BUILT-IN skill whose keywords line is still exactly an older shipped
// one, and that is otherwise identical to the new file, was never edited: it gets the new file (narrower keywords),
// so a fix for over-matching keywords reaches existing projects. Any other difference keeps the project's file.
const OLD_SKILL_KEYWORDS = {
  'security-guard': ['keywords: ["security", "auth", "login", "password", "token", "secret", "sql", "upload", "permission"]'],
  'api-craft': ['keywords: ["api", "endpoint", "route", "rest", "http", "json"]']
};
function untouchedOldSkill(relPath, mine, theirs) {
  const relPosix = relPath.split(path.sep).join('/');
  if (matchesStock(relPosix, mine) && sha256Norm(mine, false) !== sha256Norm(theirs, false)) return 'starter stub -> Flow & State Table + foundation ref';
  const m = relPosix.match(/^\.harness\/skills\/([^/]+)\/SKILL\.md$/);
  const olds = m && OLD_SKILL_KEYWORDS[m[1]];
  if (!olds) return '';
  const norm = (t) => t.replace(/\r\n/g, '\n');
  const kwLine = (t) => (norm(t).match(/^keywords:.*$/m) || [''])[0];
  const old = kwLine(mine);
  return olds.includes(old) && norm(mine).replace(old, kwLine(theirs)) === norm(theirs) ? 'built-in skill you had not edited: narrower keywords' : '';
}

// Clean defaults for a new project (used by a normal install and by --reset), so both follow the same rules.
const REMOVED_PROFILES = ['gemini', 'orca']; // engines the harness no longer supports (see docs/ENGINES.md)
function cleanCharter(text) {
  return text.replace(/^- Project objectives:[\s\S]*?(?=\n\n|\n## |(?![\s\S]))/m, OBJECTIVES_PLACEHOLDER)
    .replace(/^- autonomous: off$/m, '- autonomous: on'); // template default (use --autonomous off to opt out)
}
/** Returns the config text without removed engines (profiles and autoOrder), or null if it cannot be parsed or has no profiles. */
function cleanConfig(text) {
  let cfg = null; try { cfg = JSON.parse(text); } catch { return null; }
  if (!cfg || !cfg.profiles || typeof cfg.profiles !== 'object') return null;
  for (const k of REMOVED_PROFILES) delete cfg.profiles[k];
  if (Array.isArray(cfg.autoOrder)) cfg.autoOrder = cfg.autoOrder.filter((k) => !REMOVED_PROFILES.includes(k));
  if (REMOVED_PROFILES.includes(String(cfg.activeProfile).toLowerCase())) cfg.activeProfile = 'auto';
  return JSON.stringify(cfg, null, 2) + '\n';
}
// Known retired Antigravity template model defaults so existing projects migrate off discontinued IDs on upgrade
// while keeping any model ID the owner chose themselves.
const RETIRED_ANTIGRAVITY_MODEL = /^(?:gemini-3\.8-flash-|gemini-4-argon-)/i;

/**
 * Update an existing project's config.json from the template without overwriting the owner's choices:
 * removed engines are dropped (as on a new install), engine profiles the project lacks are added, keys a
 * profile lacks (e.g. new binaryCandidates) are filled in, retired Antigravity template defaults are refreshed,
 * and an unverified profile takes the template's invocation once the template marks that engine verified.
 * Returns { text, added[] } or null if either side is unreadable.
 */
function upgradeConfig(existingText, templateText) {
  let cur = null; let tpl = null;
  try { cur = JSON.parse(existingText); tpl = JSON.parse(cleanConfig(templateText) || 'null'); } catch { return null; }
  if (!cur || !tpl || typeof cur.profiles !== 'object' || !cur.profiles) return null;
  const cleaned = JSON.parse(cleanConfig(existingText));
  const added = [];
  for (const k of Object.keys(cur.profiles)) if (!(k in cleaned.profiles)) added.push(`-${k}`);
  for (const [name, prof] of Object.entries(tpl.profiles || {})) {
    if (!cleaned.profiles[name]) { cleaned.profiles[name] = prof; added.push(name); continue; }
    // An unverified profile never had its flags confirmed; once the template verified that engine, its tested invocation wins.
    if (prof.verified === true && cleaned.profiles[name].verified !== true) {
      for (const key of ['verified', 'note', 'args', 'promptVia', 'modelArgs', 'models', 'modelsNote']) {
        if (key in prof && JSON.stringify(cleaned.profiles[name][key]) !== JSON.stringify(prof[key])) { cleaned.profiles[name][key] = prof[key]; added.push(`${name}.${key}`); }
      }
    }
    for (const [key, val] of Object.entries(prof)) {
      if (!(key in cleaned.profiles[name])) { cleaned.profiles[name][key] = val; added.push(`${name}.${key}`); }
    }
  }
  const migrateModels = (curModels, tplModels, prefix) => {
    if (!curModels || !tplModels) return;
    for (const tier of ['fast', 'medium', 'high']) {
      const oldM = String(curModels[tier] || '');
      const nextM = tplModels[tier];
      if (nextM && RETIRED_ANTIGRAVITY_MODEL.test(oldM) && oldM !== nextM) {
        curModels[tier] = nextM;
        added.push(`${prefix}.${tier}`);
      }
    }
  };
  migrateModels(cleaned.profiles.antigravity?.models, tpl.profiles?.antigravity?.models, 'antigravity.models');
  if (cleaned.quotaFallback && typeof cleaned.quotaFallback === 'object' && tpl.quotaFallback) {
    for (const [k, fb] of Object.entries(cleaned.quotaFallback)) {
      if (fb?.engine === 'antigravity') migrateModels(fb.models, tpl.quotaFallback[k]?.models, `quotaFallback.${k}.models`);
    }
  }
  return { text: JSON.stringify(cleaned, null, 2) + '\n', added };
}
function cleanBacklog(text) {
  let src = {}; try { src = JSON.parse(text); } catch { /* broken backlog: use defaults */ }
  return JSON.stringify({ version: src.version || '2.0.0', project: '', maxAutoTasksPerRun: src.maxAutoTasksPerRun ?? 3, tasks: [] }, null, 2) + '\n';
}

function copyDir(from, to, rel = '.harness') {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const relPath = path.join(rel, entry.name);
    const s = path.join(from, entry.name); const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (TEMPLATE_ONLY.includes(relPath.split(path.sep).join('/'))) continue; // working methods for THIS template: never shipped to other projects
      if (['worktrees', 'staging', 'releases', 'visible'].includes(entry.name)) { fs.mkdirSync(d, { recursive: true }); continue; } // never copy history or open runs
      if (entry.name === 'sessions') { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '.gitkeep'), ''); continue; }
      copyDir(s, d, relPath); continue;
    }
    if (RUNTIME.has(entry.name) || (/^(inbox|completed|failed)$/.test(path.basename(from)) && entry.name !== '.gitkeep')) continue;
    if (fs.existsSync(d) && relPath === path.join('.harness', 'config.json')) {
      const up = upgradeConfig(fs.readFileSync(d, 'utf8'), fs.readFileSync(s, 'utf8'));
      if (up && up.added.length) { fs.writeFileSync(d, up.text); report.push(`update ${relPath} (your settings kept; engine profile changes: ${up.added.join(', ')})`); continue; }
    }
    if (relPath === path.join('.harness', 'memory', 'me.md')) continue; // a person's own profile (git-ignored) never travels and is never touched
    if (relPath === path.join('.harness', 'memory', 'people.md')) continue; // the template team's page never travels; a project's own is kept
    if (fs.existsSync(d)) {
      const oldSkillHow = untouchedOldSkill(relPath, fs.readFileSync(d, 'utf8'), fs.readFileSync(s, 'utf8'));
      if (oldSkillHow) { fs.copyFileSync(s, d); report.push(`update ${relPath} (${oldSkillHow})`); continue; }
      if (/^\.harness[\\/]roles[\\/][^\\/]+\.json$/.test(relPath)) {
        const roleUp = upgradeRole(fs.readFileSync(d, 'utf8'), fs.readFileSync(s, 'utf8'), entry.name);
        if (roleUp) { fs.writeFileSync(d, roleUp.text); report.push(`update ${relPath} (${roleUp.how})`); upgradedRoles.add(entry.name); continue; }
      }
    }
    if (fs.existsSync(d) && KEEP_IF_PRESENT.test(relPath)) { report.push(`kept   ${relPath} (already existed)`); continue; }
    if (relPath === path.join('.harness', 'memory', 'lessons.md')) { // the template owner's taught rules never travel
      fs.writeFileSync(d, LESSONS_TEMPLATE);
      report.push(`wrote  ${relPath} (no rules yet)`); continue;
    }
    if (relPath === path.join('.harness', 'memory', 'profile.md')) { // the template owner's personal profile never travels
      fs.writeFileSync(d, PROFILE_TEMPLATE);
      report.push(`wrote  ${relPath} (blank profile to fill in)`); continue;
    }
    if (relPath === path.join('.harness', 'charter.md')) { // the template owner's project objectives never travel
      fs.writeFileSync(d, cleanCharter(fs.readFileSync(s, 'utf8')));
      report.push(`wrote  ${relPath} (objectives left for you to fill in)`); continue;
    }
    if (relPath === path.join('.harness', 'config.json')) { // removed engines never travel
      const cleaned = cleanConfig(fs.readFileSync(s, 'utf8')); // broken or unexpected config: copy it unchanged
      if (cleaned) {
        fs.writeFileSync(d, cleaned);
        report.push(`wrote  ${relPath}`); continue;
      }
    }
    if (relPath === path.join('.harness', 'backlog.json')) { // the template's own tasks never travel: a new project starts with an empty backlog
      fs.writeFileSync(d, cleanBacklog(fs.readFileSync(s, 'utf8')));
      report.push(`wrote  ${relPath} (empty backlog)`); continue;
    }
    fs.copyFileSync(s, d);
    report.push(`wrote  ${relPath}`);
  }
}
// --reset: for a copy made with GitHub "Use this template" (or any project that has the harness), put the
// owner-specific files back to the clean defaults a new install gets. Nothing else is touched; git can undo it.
if (RESET) {
  const H = path.join(target, '.harness');
  if (!fs.existsSync(H)) { console.error(`No .harness/ folder in ${target}: nothing to reset. To install the harness, run without --reset.`); process.exit(1); }
  const off = (() => { const i = ARGS.indexOf('--autonomous'); return i > -1 && String(ARGS[i + 1]).toLowerCase() === 'off'; })();
  const steps = [
    ['memory/profile.md', () => PROFILE_TEMPLATE, 'blank profile to fill in'],
    ['memory/lessons.md', () => LESSONS_TEMPLATE, 'no taught rules'],
    ['charter.md', (t) => { const c = cleanCharter(t); return off ? c.replace(/^- autonomous: on$/m, '- autonomous: off') : c; }, `placeholder objectives, autonomous ${off ? 'off' : 'on'}`],
    ['config.json', (t) => cleanConfig(t), 'removed engines (gemini, orca) dropped'],
    ['backlog.json', (t) => cleanBacklog(t), 'empty backlog'],
  ];
  const done = [];
  for (const [rel, make, what] of steps) {
    const f = path.join(H, rel);
    if (!fs.existsSync(f)) { console.log(`  skip   .harness/${rel} (not found)`); continue; }
    const before = fs.readFileSync(f, 'utf8');
    const after = make(before);
    if (after == null) { console.log(`  skip   .harness/${rel} (could not read it as expected; left unchanged)`); continue; }
    if (after === before) { console.log(`  ok     .harness/${rel} (already clean)`); continue; }
    fs.writeFileSync(f, after);
    console.log(`  reset  .harness/${rel} (${what})`); done.push(`.harness/${rel}`);
  }
  // The template owner's team page lists their people: a template copy starts with nobody on it (git can undo this).
  const people = path.join(H, 'memory', 'people.md');
  if (fs.existsSync(people)) { fs.rmSync(people); console.log('  reset  .harness/memory/people.md (removed: the new team adds itself with memory.mjs me share)'); done.push('.harness/memory/people.md'); }
  console.log(done.length
    ? `\nReset ${done.length} file(s) in ${target}. Undo (if this folder is in git): git checkout -- ${done.join(' ')}\nNext: fill in .harness/memory/profile.md and the "Project objectives" in .harness/charter.md, then run: node .harness/doctor.mjs`
    : `\nNothing to reset in ${target}: it already has the clean defaults.`);
  process.exit(0);
}

const readJsonIf = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const preTeam = readJsonIf(path.join(target, '.harness', 'team.json'));
const preConfig = readJsonIf(path.join(target, '.harness', 'config.json'));
const preRoles = (() => {
  const r = {};
  const rd = path.join(target, '.harness', 'roles');
  try {
    for (const f of fs.readdirSync(rd).filter((x) => x.endsWith('.json'))) {
      const j = readJsonIf(path.join(rd, f));
      if (j?.name) r[String(j.name).toUpperCase()] = { ...j, file: f };
    }
  } catch { /* no roles dir yet */ }
  return r;
})();
const preHadBrandCraft = fs.existsSync(path.join(target, '.harness', 'skills', 'brand-craft', 'SKILL.md'));
const preManifestVersion = readJsonIf(path.join(target, '.harness', 'MANIFEST.json'))?.version || null;
const upgradedRoles = new Set();

copyDir(path.join(SRC, '.harness'), path.join(target, '.harness'));

// Product foundation (docs/foundation/): blank, short forms for PO, BA and UX/UI. A project's own filled-in files are never
// touched: a file is copied only when it does not exist (COPYFILE_EXCL refuses to overwrite even if one appears meanwhile).
for (const name of ['product.md', 'domain.md', 'brand.md']) {
  const from = path.join(SRC, 'docs', 'foundation', name); const to = path.join(target, 'docs', 'foundation', name);
  if (!fs.existsSync(from)) continue;
  if (fs.existsSync(to)) { report.push(`kept   docs/foundation/${name} (already existed)`); continue; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); report.push(`wrote  docs/foundation/${name} (blank form to fill in)`); }
  catch { report.push(`kept   docs/foundation/${name} (already existed)`); }
}

// Fingerprint of the harness core code, so doctor can tell when a project (or an AI in it) edited the template's files.
const { hashCore, winCommandLine } = await import(pathToFileURL(path.join(target, '.harness', 'lib', 'common.mjs')).href);
const { expectedAgentFiles, loadRoles, loadTeam, readCharter, validateTeam, applyAdaptedScopes } = await import(pathToFileURL(path.join(target, '.harness', 'lib', 'governance.mjs')).href);
const postRoles = loadRoles(path.join(target, '.harness', 'roles'));
const postConfig = readJsonIf(path.join(target, '.harness', 'config.json')) || {};
const postCharter = readCharter(path.join(target, '.harness', 'charter.md'));

// Refresh an existing template team.json when it was never customized away from the template team (keeps engine routing
// and adapted style/code globs; upgrades untouched pre-UX 3-lead teams or adds lead-ux design spec scope & brand-craft).
{
  const teamPath = path.join(target, '.harness', 'team.json');
  const tplTeamPath = path.join(SRC, '.harness', 'team.json');
  if (preTeam && fs.existsSync(teamPath) && fs.existsSync(tplTeamPath)) {
    const curRaw = fs.readFileSync(teamPath, 'utf8');
    const tplRaw = fs.readFileSync(tplTeamPath, 'utf8');
    const tplTeam = readJsonIf(tplTeamPath);
    let nextTeam = null; let how = '';
    if (matchesStock('.harness/team.json', curRaw) && sha256Norm(curRaw, false) !== sha256Norm(tplRaw, false)) {
      nextTeam = tplTeam;
      how = 'untouched template team -> added lead-ux docs/ux/**/*.md & brand-craft';
    } else if (tplTeam && Array.isArray(preTeam.members)) {
      const clone = JSON.parse(JSON.stringify(preTeam));
      const orch = clone.members.find((m) => m.id === 'orchestrator' && m.level === 'orchestrator' && String(m.role).toUpperCase() === 'PO_ARCHITECT');
      const hasCoreLeads = ['lead-ba', 'lead-dev', 'lead-qa'].every((id) => clone.members.some((m) => m.id === id && m.level === 'lead'));
      if (orch && hasCoreLeads) {
        const changes = [];
        const tplUx = tplTeam.members.find((m) => m.id === 'lead-ux');
        const ux = clone.members.find((m) => m.id === 'lead-ux' && m.level === 'lead' && String(m.role).toUpperCase() === 'UX_DESIGNER');
        const uxAgentExists = fs.existsSync(path.join(target, '.claude', 'agents', 'lead-ux.md'));
        const isOldSemver = (v) => { const p = String(v || '').split('.').map(Number); return p.length >= 3 && p[0] === 1 && p[1] === 0 && p[2] < 7; };
        if (!ux && !clone.members.some((m) => m.id === 'lead-ux') && tplUx && postRoles.UX_DESIGNER && clone.members.length === 4 && (!uxAgentExists || !preManifestVersion || isOldSemver(preManifestVersion))) {
          clone.members.push(JSON.parse(JSON.stringify(tplUx)));
          if (Array.isArray(orch.canDelegateTo) && !orch.canDelegateTo.includes('lead-ux')) orch.canDelegateTo.push('lead-ux');
          changes.push('added lead-ux');
        } else if (ux) {
          const otherOwnsDocsUx = clone.members.some((m) => m.id !== 'lead-ux' && m.id !== 'lead-ba' && (m.scope || []).some((s) => /^docs\/ux\//.test(s)));
          if (Array.isArray(ux.scope) && !ux.scope.some((s) => /^docs\/ux\//.test(s)) && ux.scope.some((s) => /\.(css|scss|less)$/.test(s)) && postRoles.UX_DESIGNER?.writablePaths?.includes('docs/ux/**') && !otherOwnsDocsUx) {
            ux.scope.push('docs/ux/**/*.md');
            changes.push('docs/ux/**/*.md');
          }
          const shouldAddBrand = !preHadBrandCraft || upgradedRoles.has('ux-designer.json') || changes.includes('docs/ux/**/*.md');
          const hasBrandSkill = fs.existsSync(path.join(target, '.harness', 'skills', 'brand-craft', 'SKILL.md'));
          const sk = Array.isArray(ux.skills) ? ux.skills : [];
          if (shouldAddBrand && hasBrandSkill && !sk.includes('brand-craft') && (sk.length === 0 || (sk.length === 1 && sk[0] === 'ui-craft'))) {
            ux.skills = sk.length ? [...sk, 'brand-craft'] : ['ui-craft', 'brand-craft'];
            changes.push('brand-craft');
          }
        }
        if (changes.length) {
          nextTeam = clone;
          how = `kept your engine routing/scopes; added ${changes.join(', ')}`;
        }
      }
    }
    if (nextTeam) {
      const v = validateTeam(nextTeam, { roles: postRoles, charter: postCharter, plannerMaxWorkers: (postConfig.planner || {}).maxWorkers || 4, engines: Object.keys(postConfig.profiles || {}) });
      if (!v.errors.length) {
        fs.writeFileSync(teamPath, `${JSON.stringify(nextTeam, null, 2)}\n`);
        const idx = report.findIndex((r) => /^kept\s+\.harness[\\/]team\.json\b/.test(r));
        const msg = `update .harness/team.json (${how})`;
        if (idx > -1) report[idx] = msg; else report.push(msg);
      }
    }
  }
}
const postTeam = loadTeam(path.join(target, '.harness', 'team.json'));
let upgradedFrom = null; let upgradedTo = null; // for the "what's new" summary at the end
{
  const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).version; } catch { return null; } })();
  // installing the same version again must change nothing: keep the first installedAt while version and fingerprints are identical
  const files = hashCore(target);
  const before = (() => { try { return JSON.parse(fs.readFileSync(path.join(target, '.harness', 'MANIFEST.json'), 'utf8')); } catch { return null; } })();
  const same = before && before.template === 'agentic-harness' && before.version === version && JSON.stringify(before.files) === JSON.stringify(files) && typeof before.installedAt === 'string';
  if (before?.version && version && before.version !== version) { upgradedFrom = before.version; upgradedTo = version; }
  fs.writeFileSync(path.join(target, '.harness', 'MANIFEST.json'), `${JSON.stringify({ template: 'agentic-harness', version, installedAt: same ? before.installedAt : new Date().toISOString(), note: 'Fingerprints of the harness core code from the template. Do not edit: doctor compares them; re-install to update.', files }, null, 2)}
`);
  report.push('wrote  .harness/MANIFEST.json (fingerprints of the harness core)');
}

const MARK = '<!-- agentic-harness -->';
const POINTER = `${MARK}\n## Agentic harness\n\nThis project has an agentic harness in \`.harness/\`. Read and follow \`AGENTS.md\` (section "Agentic harness" or the whole file) and the user's memory in \`.harness/memory/profile.md\`, \`.harness/memory/lessons.md\`, and \`.harness/memory/auto-lessons.md\` (or \`node .harness/memory.mjs context --goal "..." --files "..."\`) before working. Save permanent user rules with \`node .harness/memory.mjs remember "<rule>"\` and local technical pitfalls with \`node .harness/memory.mjs learn "<lesson>"\`. Never edit the harness core (\`.harness/*.mjs\`, \`.harness/lib/**\`): it comes from the template; report harness bugs instead of patching them here.\n`;
const OLD_POINTER_RE = /<!-- agentic-harness -->\r?\n## Agentic harness\r?\n+This project has an agentic harness in `\.harness\/`\.[^\n]*report harness bugs instead of patching them here\.\r?\n?/;
const LEGACY_STOCK_POINTERS = {
  'CLAUDE.md': '# CLAUDE.md\n\nAll instructions for this project live in AGENTS.md. The imports below load it and the\nuser\'s memory into every Claude Code session automatically.\n\n@AGENTS.md\n@.harness/memory/profile.md\n@.harness/memory/lessons.md',
  'GEMINI.md': '# GEMINI.md (Antigravity)\n\nRead and follow `AGENTS.md` in this folder before doing anything — it explains the\n`.harness/` agentic harness and the user\'s memory in `.harness/memory/`.\n\n@AGENTS.md\n@.harness/memory/profile.md\n@.harness/memory/lessons.md',
  '.github/copilot-instructions.md': '# Copilot instructions\n\nBefore answering, read and follow `AGENTS.md` at the repository root. It explains the\n`.harness/` agentic harness and requires you to read the user\'s memory first:\n`.harness/memory/profile.md` and `.harness/memory/lessons.md`. When the user corrects you or\nstates a preference, save it with `node .harness/memory.mjs remember "<rule>"`.',
  '.cursor/rules/harness.mdc': '---\ndescription: Agentic harness + user memory — read AGENTS.md first\nalwaysApply: true\n---\n\nBefore answering, read and follow `AGENTS.md` at the project root. It explains the\n`.harness/` agentic harness and requires you to read the user\'s memory first:\n`.harness/memory/profile.md` and `.harness/memory/lessons.md`. When the user corrects you or\nstates a preference, save it with `node .harness/memory.mjs remember "<rule>"`.',
  '.windsurfrules': 'Before answering, read and follow `AGENTS.md` at the project root. It explains the\n`.harness/` agentic harness and requires you to read the user\'s memory first:\n`.harness/memory/profile.md` and `.harness/memory/lessons.md`. When the user corrects you or\nstates a preference, save it with `node .harness/memory.mjs remember "<rule>"`.'
};

for (const rel of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursor/rules/harness.mdc', '.windsurfrules']) {
  const d = path.join(target, rel); const s = path.join(SRC, rel);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  if (!fs.existsSync(d)) { fs.copyFileSync(s, d); report.push(`wrote  ${rel}`); continue; }
  const body = fs.readFileSync(d, 'utf8');
  if (body.includes(MARK)) {
    if (rel !== 'AGENTS.md' && !body.includes('auto-lessons.md') && OLD_POINTER_RE.test(body)) {
      fs.writeFileSync(d, body.replace(OLD_POINTER_RE, POINTER));
      report.push(`updated harness pointer in ${rel}`);
    } else {
      report.push(`kept   ${rel} (harness section already present)`);
    }
    continue;
  }
  if (rel !== 'AGENTS.md' && LEGACY_STOCK_POINTERS[rel] && body.replace(/\r\n/g, '\n').trim() === LEGACY_STOCK_POINTERS[rel]) {
    fs.copyFileSync(s, d);
    report.push(`updated ${rel} (cross-tool rule parity)`);
    continue;
  }
  // Copies written by an earlier install (the template's own files carry no marker) or by a release before the marker
  // existed: they already hold the harness instructions, so appending again would duplicate them.
  const legacy = rel === 'AGENTS.md'
    ? /This project contains an \*\*Agentic Harness\*\*|^# Agentic harness\s*$/m.test(body)
    : /\.harness\/memory\/profile\.md/.test(body) && /agentic harness|AGENTS\.md/i.test(body);
  if (legacy) { report.push(`kept   ${rel} (harness instructions already present)`); continue; }
  // Their AGENTS.md exists: append the full harness instructions; others just get the pointer.
  const add = rel === 'AGENTS.md' ? `${MARK}\n${fs.readFileSync(s, 'utf8').replace(/^# .*\n/, '# Agentic harness\n')}` : POINTER;
  fs.writeFileSync(d, `${body.replace(/\s*$/, '')}\n\n${add}`);
  report.push(`added  harness section to existing ${rel}`);
}

const srcTasks = JSON.parse(fs.readFileSync(path.join(SRC, '.vscode', 'tasks.json'), 'utf8'));
const tasksPath = path.join(target, '.vscode', 'tasks.json');
fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
if (!fs.existsSync(tasksPath)) { fs.writeFileSync(tasksPath, JSON.stringify(srcTasks, null, 2)); report.push('wrote  .vscode/tasks.json'); }
else {
  try {
    const theirs = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    theirs.tasks = [...(theirs.tasks || []).filter((t) => !String(t.label).startsWith('Harness:')), ...srcTasks.tasks];
    const ids = new Set(srcTasks.inputs.map((i) => i.id));
    theirs.inputs = [...(theirs.inputs || []).filter((i) => !ids.has(i.id)), ...srcTasks.inputs];
    fs.writeFileSync(tasksPath, JSON.stringify(theirs, null, 2));
    report.push('merged Harness tasks into existing .vscode/tasks.json');
  } catch {
    fs.writeFileSync(path.join(target, '.vscode', 'tasks.harness.json'), JSON.stringify(srcTasks, null, 2));
    report.push('! .vscode/tasks.json has comments or is invalid JSON — wrote .vscode/tasks.harness.json; copy its tasks in by hand');
  }
}

// Claude Code project config: untouched stock commands/agents are refreshed on upgrade (custom edits are kept);
// settings.json is MERGED (union of permission rules, hook added once), never overwritten.
{
  const srcClaude = path.join(SRC, '.claude');
  if (fs.existsSync(srcClaude)) {
    const preExpectedAgents = preTeam ? expectedAgentFiles(preTeam, preRoles, preConfig || {}) : {};
    const preExpectedPostCfg = preTeam ? expectedAgentFiles(preTeam, preRoles, postConfig || {}) : {};
    const postExpectedAgents = postTeam ? expectedAgentFiles(postTeam, postRoles, postConfig || {}) : {};
    const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), path.join(rel, e.name)) : [path.join(rel, e.name)]));
    for (const rel of walk(srcClaude).filter((f) => f !== 'settings.json' && !f.startsWith('settings.local') && !/^skills[\\/]/.test(f))) {
      const d = path.join(target, '.claude', rel);
      const s = path.join(srcClaude, rel);
      const relPosix = rel.split(path.sep).join('/');
      const keyPosix = `.claude/${relPosix}`;
      fs.mkdirSync(path.dirname(d), { recursive: true });
      if (!fs.existsSync(d)) {
        const gen = relPosix.startsWith('agents/') ? postExpectedAgents[path.basename(relPosix)] : null;
        if (gen) fs.writeFileSync(d, gen);
        else fs.copyFileSync(s, d);
        report.push(`wrote  .claude/${rel}`);
        continue;
      }
      const curRaw = fs.readFileSync(d, 'utf8');
      if (relPosix.startsWith('agents/')) {
        const agentFile = path.basename(relPosix);
        const targetContent = postExpectedAgents[agentFile] || fs.readFileSync(s, 'utf8');
        if (sha256Norm(curRaw, false) === sha256Norm(targetContent, false)) {
          report.push(`kept   .claude/${rel} (already existed)`);
        } else if (matchesStock(keyPosix, curRaw)
          || (preExpectedAgents[agentFile] && sha256Norm(curRaw, false) === sha256Norm(preExpectedAgents[agentFile], false))
          || (preExpectedPostCfg[agentFile] && sha256Norm(curRaw, false) === sha256Norm(preExpectedPostCfg[agentFile], false))) {
          fs.writeFileSync(d, targetContent.replace(/\r\n?/g, '\n'));
          report.push(`update .claude/${rel} (${postExpectedAgents[agentFile] ? 'synced with latest team/roles' : 'untouched template agent -> latest rubric'})`);
        } else {
          report.push(`kept   .claude/${rel} (already existed; customized)`);
        }
        continue;
      }
      const tplRaw = fs.readFileSync(s, 'utf8');
      if (sha256Norm(curRaw, false) === sha256Norm(tplRaw, false)) {
        report.push(`kept   .claude/${rel} (already existed)`);
      } else if (matchesStock(keyPosix, curRaw)) {
        fs.copyFileSync(s, d);
        report.push(`update .claude/${rel} (untouched template command -> latest workflow)`);
      } else {
        report.push(`kept   .claude/${rel} (already existed; customized)`);
      }
    }
    const srcSet = JSON.parse(fs.readFileSync(path.join(srcClaude, 'settings.json'), 'utf8'));
    const setPath = path.join(target, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(setPath), { recursive: true });
    if (!fs.existsSync(setPath)) { fs.writeFileSync(setPath, JSON.stringify(srcSet, null, 2) + '\n'); report.push('wrote  .claude/settings.json'); }
    else {
      try {
        const mine = JSON.parse(fs.readFileSync(setPath, 'utf8'));
        mine.permissions = mine.permissions || {};
        for (const k of ['allow', 'ask', 'deny']) {
          // a rule the project already puts in a stricter list is not added to a looser one
          const stricter = { allow: ['ask', 'deny'], ask: ['deny'], deny: [] }[k];
          const have = new Set([...(mine.permissions[k] || [])]);
          for (const r of srcSet.permissions[k] || []) if (!stricter.some((o) => (mine.permissions[o] || []).includes(r))) have.add(r);
          mine.permissions[k] = [...have];
        }
        mine.hooks = mine.hooks || {};
        mine.hooks.SessionStart = mine.hooks.SessionStart || [];
        const cmd = (srcSet.hooks.SessionStart[0].hooks[0] || {}).command;
        for (const entry of mine.hooks.SessionStart) {
          for (const h of entry?.hooks || []) {
            if (typeof h?.command === 'string' && h.command.includes('$CLAUDE_PROJECT_DIR/.harness/hook-session.mjs')) h.command = cmd;
          }
        }
        const present = JSON.stringify(mine.hooks.SessionStart).includes('hook-session.mjs');
        if (!present) mine.hooks.SessionStart.push(srcSet.hooks.SessionStart[0]);
        // PreToolUse guard (hook-guard.mjs): added once; a project's own PreToolUse hooks stay
        mine.hooks.PreToolUse = mine.hooks.PreToolUse || [];
        const guardPresent = JSON.stringify(mine.hooks.PreToolUse).includes('hook-guard.mjs');
        if (!guardPresent && srcSet.hooks.PreToolUse?.[0]) mine.hooks.PreToolUse.push(srcSet.hooks.PreToolUse[0]);
        fs.writeFileSync(setPath, JSON.stringify(mine, null, 2) + '\n');
        report.push(`merged harness rules${present ? '' : ' + SessionStart hook'}${guardPresent ? '' : ' + PreToolUse guard'} into existing .claude/settings.json`);
      } catch {
        fs.writeFileSync(path.join(target, '.claude', 'settings.harness.json'), JSON.stringify(srcSet, null, 2) + '\n');
        report.push('! .claude/settings.json is not valid JSON — wrote .claude/settings.harness.json; merge it by hand');
      }
    }
  }
}

// In a PROJECT the harness core is read-only for Claude Code (people and agents use the harness, they do not edit it;
// a fix belongs in the template). The template repository itself has no such rule, so maintainers can work on it.
{
  const setPath = path.join(target, '.claude', 'settings.json');
  // Only Edit(path) rules exist for files: Claude Code applies them to every file-editing tool (Edit, Write, ...). A Write(path) rule is reported as invalid.
  const CORE_DENY = ['Edit(.harness/*.mjs)', 'Edit(.harness/lib/**)', 'Edit(.harness/MANIFEST.json)'];
  try {
    const s = JSON.parse(fs.readFileSync(setPath, 'utf8'));
    s.permissions = s.permissions || {};
    // Releases 1.0.1-1.0.3 also wrote invalid Write(.harness/...) rules (Claude Code reports them): remove those when re-installing.
    const OLD_INVALID = ['Write(.harness/*.mjs)', 'Write(.harness/lib/**)', 'Write(.harness/MANIFEST.json)'];
    const deny = new Set((s.permissions.deny || []).filter((r) => !OLD_INVALID.includes(r)));
    const removed = (s.permissions.deny || []).length - deny.size;
    const before = deny.size; CORE_DENY.forEach((r) => deny.add(r));
    if (deny.size !== before || removed) { s.permissions.deny = [...deny]; fs.writeFileSync(setPath, JSON.stringify(s, null, 2) + '\n'); report.push('added  .claude/settings.json deny rules: the harness core is read-only in this project'); }
  } catch { /* no or invalid settings.json: reported above */ }
}

const gi = path.join(target, '.gitignore');
// npm leaves .gitignore out of packages (npx installs), so fall back to this copy. A test keeps it equal to .gitignore.
const GITIGNORE_BLOCK = "# agentic-harness runtime (machine-specific or personal; never commit to a public template)\n.harness/state.json\n.harness/*.tmp\n.harness/telemetry.log\n.harness/daemon.pid\n.harness/engine-probe.json\n.harness/foundry-check.json\n.harness/update-check.json\n.harness/skill-registry.json\n.harness/skill-fetch.lock\n.harness/auto-state.json\n.harness/approvals.json\n.harness/live.log\n.harness/inbox/*\n.harness/completed/*\n.harness/failed/*\n.harness/staging/*\n.harness/releases/*\n.harness/visible/*\n.harness/worktrees/*\n.harness/memory/sessions/*\n.harness/memory/auto-lessons.md\n# Each person's own profile (name, language, answer style, hats); profile.md is the shared project profile\n.harness/memory/me.md\n# The folder/* form (instead of folder/) keeps each folder's .gitkeep, so the folders exist in the template.\n!.harness/**/.gitkeep\n\n# charter.md, backlog.json, roles/ and skills/ ARE committed (they define the project's governance).\n# profile.md and lessons.md ARE committed (the template ships generic starter versions).\n# In your own PUBLIC project, if they hold personal details, uncomment these two lines:\n# .harness/memory/profile.md\n# .harness/memory/lessons.md\n\n# Personal Claude Code overrides (never commit)\n.claude/settings.local.json\n# Personal profile and rules for this checkout (Claude Code loads it automatically)\nCLAUDE.local.md\n\n# A demo project created by `npm run demo` (examples/make-demo.mjs) lives next to the template, not in it\n/demo-project/\n\n# Per-person state and secrets (never commit)\n.agent-state/\n.env\n.env.*\n!.env.example\n";
const giSrc = path.join(SRC, '.gitignore');
const giBlock = fs.existsSync(giSrc) ? fs.readFileSync(giSrc, 'utf8') : GITIGNORE_BLOCK;
const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
if (!existing.includes('# agentic-harness runtime')) { fs.writeFileSync(gi, `${existing.replace(/\s*$/, '')}${existing ? '\n\n' : ''}${giBlock}`); report.push('updated .gitignore'); }
// Projects installed before 1.0.25 have the block but not the personal me.md line: add only that line.
else if (!/^\.harness\/memory\/me\.md\s*$/m.test(existing)) { fs.writeFileSync(gi, `${existing.replace(/\s*$/, '')}\n# Each person's own profile (name, language, answer style, hats); profile.md is the shared project profile\n.harness/memory/me.md\n`); report.push('added .harness/memory/me.md (personal profile) to .gitignore'); }
// Projects installed before 1.0.31 have the block but not the update-check cache line: add only that line.
// (1.0.32: also the Skill Foundry registry cache.)
for (const [line, what] of [['.harness/update-check.json', 'update check cache'], ['.harness/skill-registry.json', 'Skill Foundry registry cache'], ['.harness/skill-fetch.lock', 'skill fetch lock']]) {
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const esc = line.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  if (cur.includes('# agentic-harness runtime') && !new RegExp(`^${esc}\\s*$`, 'm').test(cur)) {
    fs.writeFileSync(gi, `${cur.replace(/\s*$/, '')}\n${line}\n`); report.push(`added ${line} (${what}) to .gitignore`);
  }
}

// Line endings: the harness parses its own files (charter.md, team.json, slash commands…) with LF-based rules. On Windows
// with core.autocrlf=true a teammate's clone would get CRLF and those rules could misread them, so pin LF for the files
// the harness owns. Only these paths: the project's own code keeps whatever line endings it already uses.
const GA_MARK = '# agentic-harness: keep its files LF on every OS';
const GA_BLOCK = `${GA_MARK} (its scripts parse them; CRLF from core.autocrlf would break that)\n.harness/** text eol=lf\n.claude/** text eol=lf\nAGENTS.md text eol=lf\nCLAUDE.md text eol=lf\nGEMINI.md text eol=lf\n`;
{
  const ga = path.join(target, '.gitattributes');
  const have = fs.existsSync(ga) ? fs.readFileSync(ga, 'utf8') : '';
  if (!have.includes(GA_MARK)) {
    fs.writeFileSync(ga, `${have.replace(/\s*$/, '')}${have ? '\n\n' : ''}${GA_BLOCK}`);
    report.push(have ? 'added  harness line-ending rules to existing .gitattributes' : 'wrote  .gitattributes (LF for the harness files)');
  }
}

// Smart engine routing: a freshly installed team.json gets each role routed to an AI CLI that is actually usable on
// this machine (team.mjs auto-assign). A team.json the project already had is never touched. --no-auto-assign skips it.
if (!ARGS.includes('--no-auto-assign') && report.some((r) => r.replaceAll('\\', '/').startsWith('wrote  .harness/team.json'))) {
  const r = spawnSync(process.execPath, [path.join(target, '.harness', 'team.mjs'), 'auto-assign'], { cwd: target, encoding: 'utf8', env: { ...process.env, HARNESS_ROOT: target } });
  const found = /Usable AI engines on this machine: (.*)/.exec(r.stdout || '');
  const routed = r.status === 0 && /Wrote the "engine"/.test(r.stdout || '');
  report.push(routed
    ? `routed team roles to your engines (${found ? found[1] : '?'}); see them with  node .harness/team.mjs show`
    : `! no AI engine allowed yet${found ? ` (${found[1]})` : ''}: team members use "auto". Log in to one, allow it with  node .harness/engines.mjs  then run  node .harness/team.mjs auto-assign`);
}

// Autonomous mode ships ON (it only acts on READY tasks you add, and plans new ones only once the charter objectives
// are filled in). `--autonomous off` writes a freshly installed charter with it switched off. A charter that already
// existed in the project is never touched.
const optI = process.argv.indexOf('--autonomous');
if (optI > -1) {
  const want = String(process.argv[optI + 1] || '').toLowerCase();
  if (!['on', 'off'].includes(want)) { console.error('--autonomous takes "on" or "off".'); process.exit(1); }
  const cp = path.join(target, '.harness', 'charter.md');
  if (want === 'off' && report.some((r) => r.replaceAll('\\', '/').startsWith('wrote  .harness/charter.md')) && fs.existsSync(cp)) {
    fs.writeFileSync(cp, fs.readFileSync(cp, 'utf8').replace(/^- autonomous: on$/m, '- autonomous: off'));
    report.push('set   autonomous mode OFF in the new .harness/charter.md');
  }
}

// Adaptive project layout scopes: for newly written .harness/team.json or .harness/charter.md, widen scopes additively
// to cover non-template project folders (app/, components/, styles/, cmd/, e2e/, etc.) and Go/Python test conventions.
// Existing team.json, charter.md, roles/*.json, or custom .claude/agents/*.md in the project are never modified.
if (!ARGS.includes('--no-adapt-scopes')) {
  const wroteFile = (rel) => report.some((r) => r.replaceAll('\\', '/').startsWith(`wrote  ${rel}`));
  const allowTeam = wroteFile('.harness/team.json');
  const allowCharter = wroteFile('.harness/charter.md');
  if (allowTeam || allowCharter) {
    const allowSyncAgents = !report.some((r) => /^kept +\.claude\/agents\//.test(r.replaceAll('\\', '/')));
    const res = applyAdaptedScopes(target, {
      allowTeam,
      allowCharter,
      allowRoles: {
        UX_DESIGNER: wroteFile('.harness/roles/ux-designer.json'),
        QA_AUDITOR: wroteFile('.harness/roles/qa-auditor.json'),
        BA_ANALYST: wroteFile('.harness/roles/ba-analyst.json')
      },
      allowSyncAgents
    });
    if (res.applied) {
      const sig = [...res.layout.extraCodeDirs, ...res.layout.extraStyleDirs, ...res.layout.extraTestDirs, ...res.layout.extraDocDirs].slice(0, 6).join(', ');
      report.push(`adapted scopes in ${res.writtenFiles.join(', ')} for detected project layout (${sig || 'Go/Python test files'})`);
    }
  }
}

// Skill Foundry (github:sumtaimo/Skill-Foundry), owner decisions:
//  - every NEW install gets Skill Foundry's DEFAULT skills (`add --default`: Skill Foundry decides the set). A Skill Foundry that
//    does not know `--default` yet answers with its usage line and we install FALLBACK_SKILLS (one fitting script-free skill per
//    role) instead. --with-skills installs all of them, --no-skills none; anyone who wants more uses Skill Foundry's own npx.
//  - the default is installed ONCE: .harness/foundry-default.json remembers it, so a skill the user removed on purpose is never
//    put back by a later install (and a project that already had Skill Foundry skills counts as done).
//  - skills that are installed but not wired to the harness yet (Skill Foundry installed first) are wired with
//    `update <those names> --quiet`, which keeps the user's own edits.
//  It never fails the install (offline, no npx, network error). HARNESS_OFFLINE=1 skips the network (tests set it);
//  HARNESS_FOUNDRY_CMD=<script.mjs> runs a local foundry CLI instead of npx (offline tests, forks).
const FOUNDRY = 'npx github:sumtaimo/Skill-Foundry';
const FALLBACK_SKILLS = ['spec-writer', 'copy-tight', 'test-planner', 'changelog-writer', 'ux-review'];
{
  const all = ARGS.includes('--with-skills');
  const local = process.env.HARNESS_FOUNDRY_CMD;
  const mark = path.join(target, '.harness', 'foundry-default.json');
  const csk = path.join(target, '.claude', 'skills');
  const stamped = () => (fs.existsSync(csk) ? fs.readdirSync(csk).filter((n) => fs.existsSync(path.join(csk, n, '.foundry.json'))) : []);
  const remember = () => { try { fs.writeFileSync(mark, `${JSON.stringify({ note: 'The Skill Foundry default skills were set up once for this project; a skill you remove stays removed. To get the defaults again: npx github:sumtaimo/Skill-Foundry add --default', at: new Date().toISOString().slice(0, 10) }, null, 2)}\n`); } catch { /* read-only: asked again next time */ } };
  const network = !ARGS.includes('--no-skills') && (local || process.env.HARNESS_OFFLINE !== '1');
  const win = process.platform === 'win32';
  const go = (what) => {
    if (local) return spawnSync(process.execPath, [path.resolve(local), ...what], { cwd: target, encoding: 'utf8', timeout: 180000 });
    const npxArgs = ['--yes', 'github:sumtaimo/Skill-Foundry', ...what];
    return win
      ? spawnSync(winCommandLine('npx.cmd', npxArgs), { cwd: target, encoding: 'utf8', timeout: 180000, shell: true })
      : spawnSync('npx', npxArgs, { cwd: target, encoding: 'utf8', timeout: 180000 });
  };
  const why = (r) => (r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n').pop();
  const hadSkills = stamped().length > 0;
  if (!ARGS.includes('--no-skills') && !all && !fs.existsSync(mark) && hadSkills) remember(); // the project chose its own skills
  else if (network && (all || !fs.existsSync(mark))) {
    let r = go(all ? ['add', '--all', '--quiet'] : ['add', '--default', '--quiet']);
    let how = all ? 'all Skill Foundry skills' : 'the default Skill Foundry skills';
    if (!all && r.status !== 0 && /usage:/i.test(`${r.stderr}${r.stdout}`)) { r = go(['add', ...FALLBACK_SKILLS, '--quiet']); how = `skills ${FALLBACK_SKILLS.join(', ')}`; }
    if (r.status === 0) { report.push(`added  ${how} (.claude/skills/ + .harness/skills/ pointers)`); remember(); }
    else report.push(`! Skill Foundry skill not installed (${why(r)}); the harness itself is installed`);
  }
  // Skill Foundry installed before the harness: its skills have no harness pointers yet, so workers do not get them.
  // A skill is wired when .harness/skills/<name>/SKILL.md exists AND is not the harness's own starter stub (Skill Foundry replaces
  // a starter stub and keeps the original as SKILL.md.orig; a skill of the user's own with that name is never touched).
  const STUB_SHA = new Set(['7fb11973a154c1caa78e5451d023eeb203a62208d6c0066a22d8195319546ebd', 'f14d673bad4efe2ef816f55dd6f894a06603d7805eeec73dde88aa902ff6ca21']);
  const isStub = (f) => { try { const t = fs.readFileSync(f, 'utf8'); return t.includes('starter-stub: agentic-harness') || STUB_SHA.has(crypto.createHash('sha256').update(t.replace(/\r\n?/g, '\n').trim()).digest('hex')); } catch { return false; } };
  const unwired = () => stamped().filter((n) => { const f = path.join(target, '.harness', 'skills', n, 'SKILL.md'); return !fs.existsSync(f) || isStub(f); });
  const pending = unwired();
  if (pending.length && network) {
    const r = go(['update', ...pending, '--quiet']);
    if (r.status === 0 && !unwired().length) report.push(`added  harness pointers for ${pending.join(', ')} (your own edits to the skills are kept)`);
    else report.push(`! ${pending.length} Skill Foundry skill(s) are not wired to harness workers yet (${pending.join(', ')}; ${why(r)}). Run:  ${FOUNDRY} update`);
  } else if (pending.length) report.push(`! ${pending.length} Skill Foundry skill(s) are not wired to harness workers yet (${pending.join(', ')}). Run:  ${FOUNDRY} update`);
}

console.log(`Installed the agentic harness into ${target}\n`);
report.forEach((l) => console.log(`  ${l}`));
console.log(`
Done. Your project now has the agentic harness. The workflow:
  human -> controller (task, charter, backlog, team) -> orchestrator (your editor session) -> named agents -> verify -> report to you
Next steps:
  1. Open the menu:    node .harness/start.mjs       (interactive launcher + live status)
     Check setup:      node .harness/doctor.mjs      (needs Node 18+ and one AI engine, e.g. Claude Code, logged in)
     Allow your AI tools once (headless runs use only allowed ones):  node .harness/engines.mjs     usage later:  node .harness/usage.mjs
                       several engines (claude, agy, codex)? see docs/MULTI-MODEL-SETUP.md in the harness repo, then  node .harness/team.mjs auto-assign
  2. Fill the charter: describe your project goals in .harness/charter.md ("Project objectives"); see the team with  node .harness/team.mjs show
     Fill the product foundation (short, plain words, PO / BA / UX): docs/foundation/product.md, domain.md, brand.md  (blank "(fill me)" lines)
  3. Prompt it:
       in Claude Code:  open the folder, accept the trust dialog once, restart the session so it loads the agents, then type
                        /harness:run <what you want done>     (the named agents appear working in your session; you get a report)
                        /harness:auto                         (autonomous: works through the READY backlog by itself)
       in Antigravity / Cursor / VS Code:  run  node .harness/hook-session.mjs --brief  or Tasks: Run Task -> Harness: Start Menu (interactive)
       in a terminal:   node .harness/start.mjs                   (numbered menu) or  node .harness/daemon.mjs  (watch live screen)
                        node .harness/dispatch.mjs --goal "<what you want>" --hierarchy --max-cost 2 --wait
  Autonomous mode is ON by default; it only acts on READY tasks you add. Turn it off: set "- autonomous: off" in .harness/charter.md
  (or install with  --autonomous off ). Every file above is plain text in your project; nothing is installed globally.`);

// What's new: on an upgrade, the CHANGELOG.md headlines of every version after the one this project had.
if (upgradedFrom && upgradedTo) {
  const num = (v) => String(v).split('.').map((n) => Number(n) || 0);
  const newer = (a, b) => { const x = num(a); const y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  let text = ''; try { text = fs.readFileSync(path.join(SRC, 'CHANGELOG.md'), 'utf8'); } catch { /* an older template without a changelog */ }
  const entries = [...text.matchAll(/^## (\d+\.\d+\.\d+)[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].filter(([, v]) => newer(v, upgradedFrom) && !newer(v, upgradedTo));
  console.log(`\nWhat's new (${upgradedFrom} → ${upgradedTo}):`);
  if (!entries.length) console.log('  (no CHANGELOG.md entries found; see the release branch history)');
  for (const [, v, body] of entries) {
    console.log(`  ${v}`);
    for (const m of body.matchAll(/^- (.+)$/gm)) {
      const bold = m[1].match(/^\*\*([^*]+)\*\*/);
      const line = (bold ? bold[1] : m[1].replace(/\*\*/g, '').split(/(?<=\.)\s/)[0]).replace(/\s+/g, ' ').trim();
      console.log(`    • ${line.length > 110 ? `${line.slice(0, 107)}…` : line}`);
    }
  }
  console.log('  Details, settings/hook changes and migration steps: CHANGELOG.md in the harness repository (branch release).');
}
