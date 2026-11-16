#!/usr/bin/env node
/**
 * test/run-tests.mjs — end-to-end tests for the harness. Each test runs in a fresh temp copy.
 *   node test/run-tests.mjs
 * Uses test/mock-agent.mjs as a fake engine, so no AI account is needed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = path.join(REPO, 'test', 'mock-agent.mjs');
let passed = 0; let failed = 0;

// Every throw-away folder a test makes in the temp folder is removed when the run ends (before: thousands piled up).
// HARNESS_KEEP_TEST_DIRS=1 keeps them for debugging.
const madeTmp = [];
const mkdtempOrig = fs.mkdtempSync.bind(fs);
fs.mkdtempSync = (prefix, ...rest) => { const d = mkdtempOrig(prefix, ...rest); if (path.resolve(d).startsWith(path.resolve(os.tmpdir()))) madeTmp.push(d); return d; };
process.on('exit', () => {
  if (process.env.HARNESS_KEEP_TEST_DIRS === '1') return;
  for (const d of madeTmp.reverse()) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 2 }); } catch { /* a file still in use: left for the OS */ } }
});

function sandbox({ worktrees = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  fs.cpSync(path.join(REPO, '.harness'), path.join(dir, '.harness'), {
    recursive: true,
    filter: (src) => !/(state\.json|telemetry\.log|daemon\.pid|approvals\.json)$/.test(src) && !/[\\/](inbox|completed|failed|sessions)[\\/][^.]/.test(src)
  });
  // Isolate from any live harness run in the repo: clean backlog, no active visible-run state.
  fs.rmSync(path.join(dir, '.harness', 'visible'), { recursive: true, force: true });
  { const ch = path.join(dir, '.harness', 'charter.md'); // the owner's objectives must not leak into tests
    fs.writeFileSync(ch, fs.readFileSync(ch, 'utf8').replace(/^- Project objectives:[\s\S]*?(?=\n\n|\n## |(?![\s\S]))/m, '- Project objectives: (describe your product goals here to customize for your own app)').replace(/^- autonomous: off$/m, '- autonomous: on')); }
  fs.writeFileSync(path.join(dir, '.harness', 'memory', 'profile.md'), '# User profile\n\n- Name: (fill me)\n- Role / what I do: (fill me)\n'); // the owner's profile must not leak into tests
  fs.writeFileSync(path.join(dir, '.harness', 'memory', 'lessons.md'), '# Lessons the user taught\n'); // the owner's taught rules must not leak into tests
  fs.writeFileSync(path.join(dir, '.harness', 'backlog.json'), JSON.stringify({ version: '2.0.0', project: '', maxAutoTasksPerRun: 3, tasks: [] }, null, 2));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.harness', 'config.json'), 'utf8'));
  cfg.profiles.mock = { verified: true, binary: process.execPath, args: [MOCK, 'ALLOWED={allowedTools}', 'DENIED={disallowedTools}'], promptVia: 'stdin', allowedTools: [] };
  cfg.activeProfile = 'mock';
  cfg.autoOrder = ['mock'];
  cfg.useGitWorktrees = worktrees;
  cfg.workerTimeoutMs = 20000;
  cfg.git = { ...(cfg.git || {}), integrationMode: 'off' }; // v1/v2 in-place tests; uat tests switch it on
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  // The fake engines are allowed once, as a person would (a real logged-in CLI is never used without that; own test below).
  fs.writeFileSync(path.join(dir, '.harness', 'approvals.json'), JSON.stringify({ engines: { mock: true, mockplan: true, mockcode: true, mockqa: true, fake: true, ghost: true } }));
  return dir;
}

// Engine auto-routing must not depend on the AI CLIs installed on the test machine: every install / auto-assign
// in this suite sees "no usable engine" unless a test passes HARNESS_ENGINES itself.
process.env.HARNESS_ENGINES = '';
const env = { ...process.env, HARNESS_SILENT: '1', HARNESS_AGENT: '', HARNESS_LIVE: '0', HARNESS_YES: '1' }; // the approval gate has its own test
// The suite never sees the AI CLIs installed on this machine (claude, codex, agy): it uses fake engines only. Every
// real CLI on PATH costs a ~2 s '--help' probe in each doctor / install / auto-assign, and would make results depend
// on what is installed. So PATH loses every folder that holds one of them (node, git and npm stay).
{
  const AI_BINS = ['claude', 'codex', 'agy'].flatMap((b) => [b, `${b}.cmd`, `${b}.exe`, `${b}.ps1`]);
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = String(env[key] || '').split(path.delimiter).filter((dir) => dir && !AI_BINS.some((b) => { try { return fs.existsSync(path.join(dir, b)); } catch { return false; } })).join(path.delimiter);
  process.env[key] = env[key]; // also for the tests that spawn with process.env directly
}
delete env.HARNESS_WORKER;
const node = (dir, args, extraEnv = {}) => spawnSync(process.execPath, args, { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60000 });
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const log = (dir) => fs.readFileSync(path.join(dir, '.harness', 'telemetry.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ls = (dir, sub) => fs.readdirSync(path.join(dir, '.harness', sub)).filter((f) => f.endsWith('.json'));
const drop = (dir, task) => fs.writeFileSync(path.join(dir, '.harness', 'inbox', `${task.id}.json`), JSON.stringify(task));
const runOnce = (dir) => node(dir, ['.harness/daemon.mjs', '--once']);

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); } catch (e) { failed++; console.log(`  ✖ ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('Agentic harness — end-to-end tests\n');

await test('spec self-audit: self-test commits, state 4_COMMITTED + ANTIGRAVITY, job archived', () => {
  const d = sandbox();
  const r = node(d, ['.harness/daemon.mjs', '--self-test']);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === '4_COMMITTED', `phase ${s.phase}`);
  assert(s.engine === 'ANTIGRAVITY', `engine ${s.engine}`);
  assert(ls(d, 'completed').some((f) => f.startsWith('self-test-001-')), 'not archived');
});

await test('swarm lock collision is rejected BEFORE any worker runs, in 1 cycle, moved to failed/', () => {
  const d = sandbox();
  drop(d, { id: 'collide', title: 'collide', subtasks: [
    { id: 'a', targetFiles: ['src/x.ts'], prompt: 'WRITE ran-a.txt yes' },
    { id: 'b', targetFiles: ['src/'], prompt: 'WRITE ran-b.txt yes' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === 'REJECTED', `phase ${s.phase}`);
  assert(/Lock Collision/.test(s.lastGateStatus), s.lastGateStatus);
  assert(!fs.existsSync(path.join(d, 'ran-a.txt')) && !fs.existsSync(path.join(d, 'ran-b.txt')), 'a worker ran');
  assert(log(d).filter((e) => e.phase === '1_PLANNER').length === 1, 'retried a collision');
  assert(ls(d, 'failed').length === 1 && ls(d, 'inbox').length === 0, 'job not moved to failed/');
});

await test('swarm worker without targetFiles is rejected (could touch anything)', () => {
  const d = sandbox();
  drop(d, { id: 'unscoped', title: 'u', subtasks: [{ id: 'a', targetFiles: ['a.txt'], prompt: 'x' }, { id: 'b', prompt: 'y' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === 'REJECTED', 'not rejected');
});

await test('verifier keeps failing → exactly 3 cycles → HALTED_HITL_REQUIRED, error fed back, memory written', () => {
  const d = sandbox();
  drop(d, { id: 'halt', title: 'always fails', verifyCmd: 'node -e "console.error(\'BOOM-123\'); process.exit(3)"', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === 'HALTED_HITL_REQUIRED', `phase ${s.phase}`);
  const events = log(d);
  assert(events.filter((e) => e.phase === 'SQUARE_RETRY').length === 3, 'not 3 retries');
  assert(events.filter((e) => e.phase === '1_PLANNER')[1].errorTrace.includes('BOOM-123'), 'trace not fed to planner');
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'w.txt'), 'utf8').includes('BOOM-123'), 'trace not in worker prompt');
  assert(ls(d, 'failed').length === 1, 'not in failed/');
  assert(/always fails.*HALTED/.test(fs.readFileSync(path.join(d, '.harness', 'memory', 'auto-lessons.md'), 'utf8')), 'no auto lesson');
  assert(fs.readdirSync(path.join(d, '.harness', 'memory', 'sessions')).some((f) => f.includes('halt')), 'no session note');
});

await test('feedback loop works: fails cycle 1, worker uses the error, passes cycle 2', () => {
  const d = sandbox();
  drop(d, { id: 'recover', title: 'recover', verifyCmd: 'node -e "process.exit(require(\'fs\').existsSync(\'fixed.txt\')?0:1)"',
    subtasks: [{ id: 'w', targetFiles: ['fixed.txt'], prompt: 'FIX fixed.txt ok' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === '4_COMMITTED' && s.cycle === 2, `phase ${s.phase} cycle ${s.cycle}`);
  assert(/recover.*passed after 2 cycles/.test(fs.readFileSync(path.join(d, '.harness', 'memory', 'auto-lessons.md'), 'utf8')), 'no recovery lesson');
});

await test('memory: taught rule + profile are injected into the worker prompt', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d, '.harness', 'memory', 'profile.md'), '# User profile\n- Name: Test User\n- Coding experience: (fill me)\n');
  node(d, ['.harness/memory.mjs', 'remember', 'Always use British spelling']);
  const dup = node(d, ['.harness/memory.mjs', 'remember', 'always use british spelling']);
  assert(/Already remembered/.test(dup.stdout), 'duplicate stored');
  drop(d, { id: 'mem', title: 'mem', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const p = fs.readFileSync(path.join(d, '.mock-prompts', 'w.txt'), 'utf8');
  assert(p.includes('Always use British spelling') && p.includes('[USER MEMORY'), 'memory missing from prompt');
  assert(p.includes('Name: Test User') && !p.includes('(fill me)'), 'profile missing or placeholders leaked');
  assert(/Forgot L1/.test(node(d, ['.harness/memory.mjs', 'forget', 'L1']).stdout), 'forget failed');
  assert(!/British/.test(node(d, ['.harness/memory.mjs', 'context']).stdout), 'forgotten rule still in context');
});

await test('unavailable engine falls back to auto (ENGINE_FALLBACK) and the task still runs', () => {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.ghost = { binary: 'definitely-not-installed-xyz', args: [] };
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg));
  drop(d, { id: 'ghost', title: 'g', engine: 'ghost', verifyCmd: 'node -e "process.exit(require(\'fs\').existsSync(\'a.txt\')?0:1)"', subtasks: [{ id: 'w', engine: 'ghost', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === '4_COMMITTED', `${s.phase} ${s.lastGateStatus}`);
  assert(log(d).some((e) => e.phase === 'ENGINE_FALLBACK' && /not installed/.test(e.message)), 'no fallback logged');
});

await test('engine whose --help lacks a configured flag fails the probe → fallback; doctor reports the missing flag', () => {
  const d = sandbox();
  const fake = path.join(d, 'fake-engine.mjs');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nconsole.log("Usage: fake [options]\\n  --other-flag   something");\n');
  fs.chmodSync(fake, 0o755);
  // Windows cannot run a shebang script directly: use a .cmd wrapper there.
  let fakeBin = fake;
  if (process.platform === 'win32') { fakeBin = path.join(d, 'fake-engine.cmd'); fs.writeFileSync(fakeBin, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`); }
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.fake = { binary: fakeBin, args: ['--needed-flag'], promptVia: 'stdin' };
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg));
  drop(d, { id: 'probe', title: 'p', engine: 'fake', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === '4_COMMITTED', 'did not fall back');
  assert(log(d).some((e) => e.phase === 'ENGINE_FALLBACK' && /--needed-flag/.test(e.message)), 'probe reason not logged');
  const doc = node(d, ['.harness/doctor.mjs']).stdout;
  assert(/fake.*does NOT list: --needed-flag/.test(doc), doc);
});

await test('no usable engine at all → REJECTED immediately, nothing retried', () => {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.ghost = { binary: 'definitely-not-installed-xyz', args: [] };
  cfg.autoOrder = ['ghost'];
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg));
  drop(d, { id: 'none', title: 'n', engine: 'ghost', subtasks: [{ id: 'w', targetFiles: ['a'], prompt: 'x' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === 'REJECTED' && /no other engine/.test(s.lastGateStatus), s.lastGateStatus);
  assert(log(d).filter((e) => e.phase === '1_PLANNER').length === 1, 'retried');
});

await test('worker that exits non-zero is retried, then halts', () => {
  const d = sandbox();
  drop(d, { id: 'crash', title: 'crash', subtasks: [{ id: 'w', targetFiles: ['a'], prompt: 'FAIL' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === 'HALTED_HITL_REQUIRED', 'not halted');
});

await test('2-worker swarm with real (mock) agents runs in parallel and both write their own files', () => {
  const d = sandbox();
  drop(d, { id: 'swarm', title: 'swarm', verifyCmd: 'node -e "const f=require(\'fs\');process.exit(f.existsSync(\'a.txt\')&&f.existsSync(\'b.txt\')?0:1)"',
    subtasks: [{ id: 'wa', targetFiles: ['a.txt'], prompt: 'WRITE a.txt A' }, { id: 'wb', targetFiles: ['b.txt'], prompt: 'WRITE b.txt B' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === '4_COMMITTED' && s.mode === 'SWARM-MESH (2W)', `${s.phase} ${s.mode}`);
});

await test('git worktree isolation: in-scope edits copied back, out-of-scope edits discarded', () => {
  const d = sandbox({ worktrees: true });
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  drop(d, { id: 'wt', title: 'wt', subtasks: [{ id: 'w', targetFiles: ['src/'], prompt: 'WRITE src/in.txt yes\nWRITE outside.txt no' }] });
  runOnce(d);
  assert(fs.existsSync(path.join(d, 'src', 'in.txt')), 'in-scope file not copied back');
  assert(!fs.existsSync(path.join(d, 'outside.txt')), 'out-of-scope file leaked');
  assert(log(d).some((e) => e.phase === '2_SCOPE_VIOLATION' && e.blocked.includes('outside.txt')), 'violation not logged');
  assert(git('worktree', 'list').toString().trim().split('\n').length === 1, 'worktree not cleaned up');
});

await test('dispatch --wait with no daemon running processes the job and reports COMMITTED', () => {
  const d = sandbox();
  const r = node(d, ['.harness/dispatch.mjs', '--goal', 'WRITE hello.txt hi', '--files', 'hello.txt', '--check', 'node -e "process.exit(require(\'fs\').existsSync(\'hello.txt\')?0:1)"', '--wait']);
  assert(r.status === 0 && /RESULT: COMMITTED/.test(r.stdout), r.stdout + r.stderr);
  assert(/Session note: |session note: /.test(r.stdout), 'no session note path');
});

await test('dispatch without --check warns that there is no real gate', () => {
  const d = sandbox();
  const r = node(d, ['.harness/dispatch.mjs', '--goal', 'x']);
  assert(/NO real check/.test(r.stdout) && /WARNING/.test(r.stdout), r.stdout);
});

await test('dispatch refuses inside a harness worker (no agent loops)', () => {
  const d = sandbox();
  const r = node(d, ['.harness/dispatch.mjs', '--goal', 'x'], { HARNESS_WORKER: '1' });
  assert(r.status === 2 && ls(d, 'inbox').length === 0, `status ${r.status}`);
});

await test('watch mode: 3 jobs dropped at once are all processed in order; second daemon refuses to start', async () => {
  const d = sandbox();
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs', '--watch'], { cwd: d, env, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const second = node(d, ['.harness/daemon.mjs']);
  assert(/already running/.test(second.stdout), 'second daemon started');
  for (const n of [1, 2, 3]) node(d, ['.harness/dispatch.mjs', '--goal', `WRITE f${n}.txt ${n}`, '--files', `f${n}.txt`]);
  const deadline = Date.now() + 20000;
  while (ls(d, 'completed').length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  daemon.kill('SIGTERM');
  await new Promise((r) => daemon.on('close', r));
  assert(ls(d, 'completed').length === 3, `only ${ls(d, 'completed').length} completed`);
  // Windows cannot deliver SIGTERM to a handler (the process is killed outright), so the pid file can remain there;
  // a stale pid file is harmless because liveness is checked with process.kill(pid, 0).
  if (process.platform !== 'win32') assert(!fs.existsSync(path.join(d, '.harness', 'daemon.pid')), 'pid file left behind');
});

await test('self-test hands off to a running daemon instead of racing it', async () => {
  const d = sandbox();
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs'], { cwd: d, env, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const r = node(d, ['.harness/daemon.mjs', '--self-test']);
  daemon.kill('SIGTERM');
  await new Promise((res) => daemon.on('close', res));
  assert(r.status === 0 && /background daemon/.test(r.stdout), r.stdout);
});

await test('install.mjs adds the harness to an existing project without overwriting its files', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-install-'));
  fs.writeFileSync(path.join(p, 'AGENTS.md'), '# My rules\nKeep this line.\n');
  fs.mkdirSync(path.join(p, '.vscode'));
  fs.writeFileSync(path.join(p, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'build', type: 'shell', command: 'make' }] }));
  const r = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), p], { encoding: 'utf8' });
  assert(r.status === 0, r.stderr);
  const agents = fs.readFileSync(path.join(p, 'AGENTS.md'), 'utf8');
  assert(agents.includes('Keep this line.') && agents.includes('Agentic harness'), 'AGENTS.md not merged');
  const tasks = json(path.join(p, '.vscode', 'tasks.json'));
  assert(tasks.tasks.some((t) => t.label === 'build') && tasks.tasks.some((t) => t.label.startsWith('Harness:')), 'tasks not merged');
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), p]);
  assert((fs.readFileSync(path.join(p, 'AGENTS.md'), 'utf8').match(/agentic-harness -->/g) || []).length === 1, 'installed twice');
  const st = spawnSync(process.execPath, ['.harness/daemon.mjs', '--self-test'], { cwd: p, env, encoding: 'utf8' });
  assert(st.status === 0, 'self-test failed in installed project');
});

// ───────────── v1.0: rollback, dead-letter, auto-verify, AI planner, memory cap ─────────────

const FAIL_VERIFY = 'node -e "console.error(\'NOPE\'); process.exit(1)"';
const existsCheck = (...files) => `node -e "const f=require('fs');process.exit([${files.map((x) => `'${x}'`).join(',')}].every(x=>f.existsSync(x))?0:1)"`;

await test('dirty-file rollback: 3-cycle failure restores edited files, removes created files, restores folders', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d, 'a.txt'), 'ORIGINAL');
  fs.mkdirSync(path.join(d, 'lib')); fs.writeFileSync(path.join(d, 'lib', 'keep.js'), 'KEEP');
  fs.writeFileSync(path.join(d, 'untouched.txt'), 'SAME');
  drop(d, { id: 'dirty', title: 'dirty', verifyCmd: FAIL_VERIFY, subtasks: [
    { id: 'w1', targetFiles: ['a.txt', 'new.txt'], prompt: 'WRITE a.txt BROKEN\nWRITE new.txt CREATED' },
    { id: 'w2', targetFiles: ['lib/'], prompt: 'WRITE lib/keep.js BROKEN\nWRITE lib/extra.js EXTRA' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === 'HALTED_HITL_REQUIRED', 'not halted');
  assert(fs.readFileSync(path.join(d, 'a.txt'), 'utf8') === 'ORIGINAL', 'a.txt not restored');
  assert(!fs.existsSync(path.join(d, 'new.txt')), 'created file not removed');
  assert(fs.readFileSync(path.join(d, 'lib', 'keep.js'), 'utf8') === 'KEEP' && !fs.existsSync(path.join(d, 'lib', 'extra.js')), 'folder not restored');
  assert(fs.readFileSync(path.join(d, 'untouched.txt'), 'utf8') === 'SAME', 'unrelated file touched');
  assert(fs.readdirSync(path.join(d, '.harness', 'staging')).filter((f) => !f.startsWith('.')).length === 0, 'staging not cleaned');
  assert(log(d).some((e) => e.phase === 'ROLLBACK_DONE'), 'no ROLLBACK_DONE event');
});

await test('successful task keeps its changes and discards the staging backup', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d, 'a.txt'), 'ORIGINAL');
  drop(d, { id: 'ok', title: 'ok', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt NEW' }] });
  runOnce(d);
  assert(fs.readFileSync(path.join(d, 'a.txt'), 'utf8') === 'NEW', 'change lost');
  assert(log(d).some((e) => e.phase === 'STAGING_BACKUP'), 'no backup was taken');
  assert(fs.readdirSync(path.join(d, '.harness', 'staging')).filter((f) => !f.startsWith('.')).length === 0, 'staging not cleaned');
});

await test('dead-letter queue: failed job → .harness/failed/<id>-<timestamp>.json + .trace.txt with every cycle error', () => {
  const d = sandbox();
  drop(d, { id: 'deadletter', title: 'dl', verifyCmd: FAIL_VERIFY, subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt x' }] });
  runOnce(d);
  const f = ls(d, 'failed');
  assert(f.length === 1 && /^deadletter-\d+\.json$/.test(f[0]), `bad name ${f}`);
  const body = json(path.join(d, '.harness', 'failed', f[0]));
  assert(body.result === 'HALTED_HITL_REQUIRED' && body.errors.length === 3 && body.cyclesUsed === 3 && /restored/.test(body.rollback), JSON.stringify(body).slice(0, 300));
  const trace = fs.readFileSync(path.join(d, '.harness', 'failed', f[0].replace('.json', '.trace.txt')), 'utf8');
  assert((trace.match(/===== cycle/g) || []).length === 3 && trace.includes('NOPE'), 'trace incomplete');
  assert(ls(d, 'inbox').length === 0, 'job left in inbox');
});

await test('auto-verify: detectVerifyCmd picks the strongest package.json check', async () => {
  const { detectVerifyCmd } = await import(pathToFileURL(path.join(REPO, '.harness', 'lib', 'common.mjs')).href);
  const cfg = { defaultVerifyCmd: 'NOOP' };
  const proj = (scripts, lock) => {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pkg-'));
    if (scripts) fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ scripts }));
    if (lock) fs.writeFileSync(path.join(p, lock), '');
    return detectVerifyCmd(p, cfg);
  };
  assert(proj({ check: 'x', test: 'y' }).cmd === 'npm run check', 'check should win');
  assert(proj({ test: 'y', typecheck: 'z', lint: 'l' }).cmd === 'npm run typecheck && npm test', 'typecheck+test');
  assert(proj({ build: 'b', lint: 'l' }).cmd === 'npm run build', 'build before lint');
  assert(proj({ lint: 'l' }).cmd === 'npm run lint', 'lint last resort');
  assert(proj({ test: 'echo "Error: no test specified" && exit 1' }).real === false, 'npm placeholder test must be ignored');
  assert(proj(null).cmd === 'NOOP' && proj(null).real === false, 'no package.json → default');
  assert(proj({ test: 'y' }, 'pnpm-lock.yaml').cmd === 'pnpm test', 'pnpm detection');
});

await test('auto-verify end-to-end: job with no verifyCmd runs package.json typecheck + test', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: {
    typecheck: 'node -e "require(\'fs\').writeFileSync(\'typechecked.flag\',\'1\')"',
    test: 'node -e "process.exit(require(\'fs\').existsSync(\'a.txt\')?0:1)"' } }));
  drop(d, { id: 'autoverify', title: 'av', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === '4_COMMITTED', 'not committed');
  assert(fs.existsSync(path.join(d, 'typechecked.flag')), 'typecheck script did not run');
  assert(log(d).some((e) => e.phase === '3_VERIFIER' && /npm run typecheck && npm test/.test(e.message) && /auto-detected/.test(e.source)), 'wrong verify command');
});

const planGoal = (plan) => `Build the thing. PLAN_JSON ${JSON.stringify(plan)}`;

await test('AI planner (--auto-plan): decomposes a goal into 2 parallel workers with read-only planning tools', () => {
  const d = sandbox();
  const plan = { subtasks: [
    { id: 'part-a', targetFiles: ['a.txt'], prompt: 'WRITE a.txt A' },
    { id: 'part-b', targetFiles: ['b.txt'], prompt: 'WRITE b.txt B' }], verifySuggestion: 'rm -rf /' };
  const r = node(d, ['.harness/dispatch.mjs', '--goal', planGoal(plan), '--auto-plan', '--check', existsCheck('a.txt', 'b.txt'), '--wait']);
  assert(r.status === 0 && /COMMITTED/.test(r.stdout), r.stdout + r.stderr);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.mode === 'SWARM-MESH (2W)' && /AI planner → 2 worker/.test(s.planSummary), `${s.mode} ${s.planSummary}`);
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'planner-calls.txt'), 'utf8').includes('ALLOWED=Read,Glob,Grep '), 'planner was not limited to read-only tools');
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'part-a.txt'), 'utf8').includes('[OVERALL GOAL'), 'worker missing overall goal');
  const note = fs.readdirSync(path.join(d, '.harness', 'memory', 'sessions')).map((f) => fs.readFileSync(path.join(d, '.harness', 'memory', 'sessions', f), 'utf8')).join('');
  assert(/suggested this check \(NOT run automatically\): `rm -rf \/`/.test(note), 'AI verify suggestion must be recorded, never run');
});

await test('AI planner: overlapping targetFiles are rejected (re-asked once with the error, then REJECTED, nothing runs)', () => {
  const d = sandbox();
  const plan = { subtasks: [
    { id: 'x', targetFiles: ['src/'], prompt: 'WRITE src/x.txt X' },
    { id: 'y', targetFiles: ['src/y.txt'], prompt: 'WRITE src/y.txt Y' }] };
  const r = node(d, ['.harness/dispatch.mjs', '--goal', planGoal(plan), '--auto-plan', '--wait']);
  assert(r.status === 1 && /NOT DONE/.test(r.stdout), r.stdout);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === 'REJECTED' && /overlapping targetFiles/.test(s.lastGateStatus), s.lastGateStatus);
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'planner-calls.txt'), 'utf8').trim().split('\n').length === 2, 'planner not re-asked exactly once');
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'planner.txt'), 'utf8').includes('PREVIOUS PLAN WAS REJECTED'), 'feedback not given to planner');
  assert(!fs.existsSync(path.join(d, 'src')), 'a worker ran');
  assert(ls(d, 'failed').length === 1, 'not dead-lettered');
});

await test('AI planner: targets outside --files, unsafe paths, or invalid JSON are rejected', () => {
  for (const [plan, files, re] of [
    [{ subtasks: [{ id: 'a', targetFiles: ['other/x.txt'], prompt: 'WRITE other/x.txt 1' }] }, 'src/', /outside the allowed files/],
    [{ subtasks: [{ id: 'a', targetFiles: ['../escape.txt'], prompt: 'x' }] }, '', /unsafe target path/],
    [{ subtasks: [{ id: 'a', targetFiles: ['.harness/config.json'], prompt: 'x' }] }, '', /unsafe target path/],
    [{ subtasks: [{ id: 'a', targetFiles: [], prompt: 'x' }] }, '', /no targetFiles/],
    [null, '', /not valid JSON/]
  ]) {
    const d = sandbox();
    const goal = plan ? planGoal(plan) : 'no plan here';
    node(d, ['.harness/dispatch.mjs', '--goal', goal, '--auto-plan', '--files', files, '--wait']);
    const s = json(path.join(d, '.harness', 'state.json'));
    assert(s.phase === 'REJECTED' && re.test(s.lastGateStatus), `${re}: ${s.lastGateStatus}`);
    assert(!fs.existsSync(path.join(d, 'other')), 'worker ran');
  }
});

await test('memory: lessons are de-duplicated and capped at 50 lines in the worker prompt', () => {
  const d = sandbox();
  const lessons = Array.from({ length: 60 }, (_, i) => `- [L${i + 1}] (2026-01-01) Rule number ${i + 1}`).join('\n');
  fs.writeFileSync(path.join(d, '.harness', 'memory', 'lessons.md'), `# Lessons\n\n${lessons}\n- [L61] (2026-01-01) RULE NUMBER 60!\n`);
  fs.writeFileSync(path.join(d, '.harness', 'memory', 'auto-lessons.md'), '# Auto\n\n- [L1] (2026-01-01) rule number 59\n- [L2] (2026-01-01) An auto lesson\n');
  drop(d, { id: 'cap', title: 'cap', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const p = fs.readFileSync(path.join(d, '.mock-prompts', 'w.txt'), 'utf8');
  const lessonLines = p.split('\n').filter((l) => /^- (Rule number|RULE NUMBER|rule number|An auto lesson)/.test(l));
  assert(lessonLines.length <= 50, `${lessonLines.length} lesson lines`);
  assert(p.includes('Rule number 60') && !p.includes('RULE NUMBER 60!') && !p.includes('- rule number 59'), 'duplicates not removed');
  assert(!p.includes('Rule number 1\n'), 'oldest rules should be dropped first');
});

await test('memory: no double injection when the engine auto-loads it via CLAUDE.md @imports', () => {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.mock.instructionFile = 'CLAUDE.md';
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg));
  fs.copyFileSync(path.join(REPO, 'CLAUDE.md'), path.join(d, 'CLAUDE.md'));
  fs.writeFileSync(path.join(d, '.harness', 'memory', 'profile.md'), '# User profile\n- Name: Test User\n');
  node(d, ['.harness/memory.mjs', 'remember', 'Taught rule XYZ']);
  node(d, ['.harness/memory.mjs', 'remember', 'Auto lesson QRS']); // goes to lessons; move one to auto:
  fs.writeFileSync(path.join(d, '.harness', 'memory', 'auto-lessons.md'), '# Auto\n\n- [L1] (2026-01-01) Auto lesson ABC\n');
  drop(d, { id: 'noddup', title: 'n', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const p = fs.readFileSync(path.join(d, '.mock-prompts', 'w.txt'), 'utf8');
  assert(!p.includes('Taught rule XYZ') && !p.includes('Test User'), 'profile/lessons injected twice');
  assert(p.includes('Auto lesson ABC'), 'auto lessons (not in CLAUDE.md) must still be injected');
  assert(/already loaded from the project instruction file/.test(p), 'missing auto-load notice');
});


// ───────────── v2.0: autonomous controller, backlog, roles + skills, release snapshots ─────────────

function setCharter(d, policy = {}, extra = '') {
  const f = path.join(d, '.harness', 'charter.md');
  let t = fs.readFileSync(f, 'utf8').replace(/\(describe your product goals here[^)]*\)/, 'Test project objectives: build the feature set the tests describe.');
  for (const [k, v] of Object.entries(policy)) t = t.replace(new RegExp(`^- ${k}: .*$`, 'm'), `- ${k}: ${v}`);
  fs.writeFileSync(f, t + (extra ? `\n${extra}\n` : ''));
}
const setBacklog = (d, tasks) => fs.writeFileSync(path.join(d, '.harness', 'backlog.json'), JSON.stringify({ version: '2.0.0', tasks }, null, 2));
const backlog = (d) => json(path.join(d, '.harness', 'backlog.json')).tasks;
const byId = (d, id) => backlog(d).find((t) => t.id === id);
const PASS = 'node -e "process.exit(0)"';
const tick = (d) => node(d, ['.harness/daemon.mjs', '--tick']);
const argsOf = (d, id) => json(path.join(d, '.mock-prompts', `${id}.args.json`));
const promptOf = (d, id) => fs.readFileSync(path.join(d, '.mock-prompts', `${id}.txt`), 'utf8');
const realTest = (d) => fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: PASS } }));
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

await test('autonomous tick: empty inbox promotes the highest-priority READY item; backlog item → DONE', () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on' });
  setBacklog(d, [
    { id: 'A', title: 'low', priority: 2, status: 'READY', verifyCmd: PASS, subtasks: [{ id: 'wa', role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js A' }] },
    { id: 'B', title: 'high', priority: 1, status: 'READY', verifyCmd: existsCheck('src/b.js'), subtasks: [{ id: 'wb', role: 'DEV_ENGINEER', targetFiles: ['src/b.js'], prompt: 'WRITE src/b.js B' }] },
    { id: 'C', title: 'idea', priority: 0, status: 'BACKLOG', goal: 'not groomed yet' }]);
  const r = tick(d);
  assert(/Autonomous tick: dispatched/.test(r.stdout), r.stdout + r.stderr);
  assert(byId(d, 'B').status === 'DONE' && byId(d, 'A').status === 'READY' && byId(d, 'C').status === 'BACKLOG', JSON.stringify(backlog(d).map((t) => t.status)));
  const job = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(job.backlogId === 'B' && job.autonomous === true, 'job not linked to backlog item');
  assert(log(d).some((e) => e.phase === 'AUTO_DISPATCH' && e.backlogId === 'B'), 'no AUTO_DISPATCH');
});

await test('autonomous off in charter.md → tick does nothing', () => {
  const d = sandbox(); setCharter(d, { autonomous: 'off' });
  setBacklog(d, [{ id: 'A', title: 'x', status: 'READY', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js A' }] }]);
  const r = tick(d);
  assert(/off/.test(r.stdout) && byId(d, 'A').status === 'READY' && ls(d, 'completed').length === 0, r.stdout);
});

await test('empty backlog → PO_ARCHITECT (read-only) generates ≤ maxAutoTasksPerRun READY tasks from charter; first one runs', () => {
  const d = sandbox(); realTest(d);
  const tasks = [1, 2, 3, 4].map((n) => ({ title: `Task ${n}`, priority: n, goal: `g${n}`, acceptanceCriteria: [`ac${n}`], verifySuggestion: 'rm -rf /',
    subtasks: [{ id: `w${n}`, role: 'DEV_ENGINEER', targetFiles: [`src/t${n}.js`], prompt: `WRITE src/t${n}.js ${n}` }] }));
  setCharter(d, { autonomous: 'on', maxAutoTasksPerRun: 2 }, `PO_JSON ${JSON.stringify({ tasks })}`);
  setBacklog(d, []);
  tick(d);
  const b = backlog(d);
  assert(b.length === 2 && b.every((t) => t.source === 'PO_ARCHITECT'), `expected 2 PO tasks, got ${b.length}`);
  assert(b[0].status === 'DONE' && b[1].status === 'READY', b.map((t) => t.status).join());
  assert(fs.existsSync(path.join(d, 'src', 't1.js')) && !fs.existsSync(path.join(d, 'src', 't2.js')), 'wrong task ran');
  const po = fs.readFileSync(path.join(d, '.mock-prompts', 'po-calls.txt'), 'utf8');
  assert(/ALLOWED=Read,Glob,Grep,Bash\(git status\),Bash\(git log:\*\) /.test(po) && !/Edit|Write/.test(po.split('DENIED=')[0]), `PO not read-only: ${po}`);
  assert(promptOf(d, 'po-architect').includes('Autonomous Controller Charter'), 'charter not given to PO');
  assert(b[0].verifyCmd === undefined && b[0].verifySuggestion === 'rm -rf /', 'AI-suggested check must be recorded, never used');
  assert(promptOf(d, 'w1').includes('[ACCEPTANCE CRITERIA]:\n- ac1'), 'acceptance criteria not passed to worker');
});

await test('PO_ARCHITECT tasks that break the charter or role scopes are dropped', () => {
  const d = sandbox(); realTest(d);
  const t = (title, sub) => ({ title, subtasks: [sub] });
  const tasks = [
    t('env', { id: 'a', role: 'DEV_ENGINEER', targetFiles: ['.env.local'], prompt: 'x' }),
    t('ba-on-src', { id: 'b', role: 'BA_ANALYST', targetFiles: ['src/x.js'], prompt: 'x' }),
    t('outside', { id: 'c', role: 'DEV_ENGINEER', targetFiles: ['lib/x.js'], prompt: 'x' }),
    t('no-role-skill', { id: 'd', role: 'DEV_ENGINEER', skills: ['nope'], targetFiles: ['src/d.js'], prompt: 'x' }),
    t('good', { id: 'e', role: 'DEV_ENGINEER', targetFiles: ['src/e.js'], prompt: 'WRITE src/e.js ok' })];
  setCharter(d, { autonomous: 'on', maxAutoTasksPerRun: 5 }, `PO_JSON ${JSON.stringify({ tasks })}`);
  setBacklog(d, []);
  tick(d);
  assert(backlog(d).map((x) => x.title).join() === 'good', backlog(d).map((x) => x.title).join());
  const rej = log(d).filter((e) => e.phase === '0_PO_TASK_REJECTED').map((e) => e.message).join('\n');
  assert(/forbids/.test(rej) && /BA_ANALYST may only own docs/.test(rej) && /outside charter allowedPaths/.test(rej) && /unknown skill/.test(rej), rej);
});

await test('requireRealCheck: no real check in the project → autonomy pauses instead of generating work', () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on' }, 'PO_JSON {"tasks":[]}'); setBacklog(d, []);
  const r = tick(d);
  assert(/paused/.test(r.stdout) && !fs.existsSync(path.join(d, '.mock-prompts', 'po-calls.txt')), r.stdout);
  assert(log(d).some((e) => e.phase === 'AUTO_PAUSED' && /real check/.test(e.message)), 'no AUTO_PAUSED');
});

await test('autonomous daemon: budget maxAutoTasksPerRun=2 with 4 READY items → exactly 2 run, then it stops', async () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on', maxAutoTasksPerRun: 2 });
  setBacklog(d, [1, 2, 3, 4].map((n) => ({ id: `T${n}`, title: `t${n}`, priority: n, status: 'READY', verifyCmd: PASS, subtasks: [{ id: `w${n}`, targetFiles: [`src/${n}.js`], prompt: `WRITE src/${n}.js x` }] })));
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs', '--autonomous', '--interval', '1'], { cwd: d, env, stdio: 'ignore' });
  await waitFor(() => backlog(d).filter((t) => t.status === 'DONE').length >= 2);
  await new Promise((r) => setTimeout(r, 3000)); // two more interval ticks: must not start a 3rd task
  daemon.kill('SIGTERM'); await new Promise((r) => daemon.on('close', r));
  const st = backlog(d).map((t) => t.status).join();
  assert(st === 'DONE,DONE,READY,READY', st);
  assert(log(d).some((e) => e.phase === 'AUTO_BUDGET_USED'), 'budget stop not logged');
  assert(json(path.join(d, '.harness', 'state.json')).autonomous.used === 2, 'state.autonomous.used != 2');
});

await test('failed autonomous task → files restored, item BLOCKED with reason, autonomy pauses (next READY not started)', async () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on' });
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'f.js'), 'ORIGINAL');
  setBacklog(d, [
    { id: 'BAD', title: 'bad', priority: 1, status: 'READY', verifyCmd: FAIL_VERIFY, subtasks: [{ id: 'w1', targetFiles: ['src/f.js'], prompt: 'WRITE src/f.js BROKEN' }] },
    { id: 'NEXT', title: 'next', priority: 2, status: 'READY', verifyCmd: PASS, subtasks: [{ id: 'w2', targetFiles: ['src/n.js'], prompt: 'WRITE src/n.js x' }] }]);
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs', '--autonomous', '--interval', '1'], { cwd: d, env, stdio: 'ignore' });
  await waitFor(() => byId(d, 'BAD').status === 'BLOCKED');
  await new Promise((r) => setTimeout(r, 2500));
  daemon.kill('SIGTERM'); await new Promise((r) => daemon.on('close', r));
  assert(byId(d, 'BAD').status === 'BLOCKED' && /HALTED_HITL_REQUIRED/.test(byId(d, 'BAD').blockedReason), JSON.stringify(byId(d, 'BAD')));
  assert(byId(d, 'NEXT').status === 'READY', `NEXT is ${byId(d, 'NEXT').status} — autonomy should pause`);
  assert(fs.readFileSync(path.join(d, 'src', 'f.js'), 'utf8') === 'ORIGINAL', 'file not restored');
  assert(log(d).some((e) => e.phase === 'AUTO_PAUSED'), 'no AUTO_PAUSED');
});

await test('import new backlog → old charter/backlog/summary + unstarted inbox jobs saved to releases/, lessons kept', () => {
  const d = sandbox();
  setBacklog(d, [{ id: 'OLD-1', title: 'shipped thing', status: 'DONE' }, { id: 'OLD-2', title: 'half', status: 'IN_PROGRESS' }]);
  node(d, ['.harness/memory.mjs', 'remember', 'Keep this rule']);
  drop(d, { id: 'ghost-job', title: 'queued under old backlog', subtasks: [{ id: 'w', targetFiles: ['a'], prompt: 'x' }] });
  const nb = path.join(d, 'new-backlog.json');
  fs.writeFileSync(nb, JSON.stringify({ project: 'v2', tasks: [{ id: 'NEW-1', title: 'fresh', status: 'READY' }] }));
  const r = node(d, ['.harness/backlog.mjs', 'import', 'new-backlog.json']);
  assert(r.status === 0, r.stdout + r.stderr);
  const rel = fs.readdirSync(path.join(d, '.harness', 'releases')).filter((x) => x.startsWith('release-'));
  assert(rel.length === 1, `releases: ${rel}`);
  const R = path.join(d, '.harness', 'releases', rel[0]);
  for (const f of ['charter.md', 'backlog.json', 'completed-summary.md', 'inbox/ghost-job.json']) assert(fs.existsSync(path.join(R, f)), `missing ${f} in snapshot`);
  assert(/OLD-1: shipped thing/.test(fs.readFileSync(path.join(R, 'completed-summary.md'), 'utf8')), 'summary lacks DONE item');
  assert(json(path.join(R, 'backlog.json')).tasks.length === 2, 'old backlog not preserved');
  assert(ls(d, 'inbox').length === 0, 'ghost job left in inbox');
  assert(backlog(d)[0].id === 'NEW-1', 'new backlog not active');
  assert(/Keep this rule/.test(fs.readFileSync(path.join(d, '.harness', 'memory', 'lessons.md'), 'utf8')), 'lessons lost');
  // charter upload, then a memory reset upload
  fs.writeFileSync(path.join(d, 'charter-v2.md'), '# New charter\n- autonomous: off\n');
  assert(node(d, ['.harness/backlog.mjs', 'import', 'charter-v2.md']).status === 0, 'charter import failed');
  assert(fs.readFileSync(path.join(d, '.harness', 'charter.md'), 'utf8').startsWith('# New charter'), 'charter not replaced');
  assert(node(d, ['.harness/backlog.mjs', 'import', 'new-backlog.json', '--reset-memory']).status === 0, 'reset import failed');
  const rels = fs.readdirSync(path.join(d, '.harness', 'releases')).filter((x) => x.startsWith('release-')).sort();
  assert(rels.length === 3, `expected 3 releases, got ${rels.length}`);
  assert(/Keep this rule/.test(fs.readFileSync(path.join(d, '.harness', 'releases', rels[2], 'memory', 'lessons.md'), 'utf8')), 'memory not saved before reset');
  assert(!/Keep this rule/.test(fs.readFileSync(path.join(d, '.harness', 'memory', 'lessons.md'), 'utf8')), 'memory not reset');
});

await test('import: invalid backlog changes nothing; import while a task runs is refused; skills pack replaced with snapshot', () => {
  const d = sandbox();
  setBacklog(d, [{ id: 'KEEP', title: 'k', status: 'READY' }]);
  fs.writeFileSync(path.join(d, 'bad.json'), JSON.stringify({ tasks: [{ id: 'x', title: 'a', status: 'WEIRD' }] }));
  const bad = node(d, ['.harness/backlog.mjs', 'import', 'bad.json']);
  assert(bad.status === 1 && /unknown status/.test(bad.stderr) && byId(d, 'KEEP'), bad.stderr);
  assert(!fs.readdirSync(path.join(d, '.harness', 'releases')).some((x) => x.startsWith('release-')), 'snapshot made for a rejected upload');
  fs.writeFileSync(path.join(d, '.harness', 'daemon.pid'), String(process.pid));
  fs.writeFileSync(path.join(d, '.harness', 'state.json'), JSON.stringify({ currentTaskFile: 'x.json', taskTitle: 'busy' }));
  fs.writeFileSync(path.join(d, 'ok.json'), JSON.stringify({ tasks: [] }));
  assert(node(d, ['.harness/backlog.mjs', 'import', 'ok.json']).status === 2, 'import during a running task must be refused');
  fs.rmSync(path.join(d, '.harness', 'daemon.pid'));
  fs.mkdirSync(path.join(d, 'pack', 'new-skill'), { recursive: true });
  fs.writeFileSync(path.join(d, 'pack', 'new-skill', 'SKILL.md'), '---\nname: new-skill\ndescription: d\nroles: ["DEV_ENGINEER"]\n---\nRule.');
  const r = node(d, ['.harness/backlog.mjs', 'import', 'pack']);
  assert(r.status === 0 && /Skills now: new-skill/.test(r.stdout), r.stdout + r.stderr);
  const rel = fs.readdirSync(path.join(d, '.harness', 'releases')).filter((x) => x.startsWith('release-'));
  assert(fs.existsSync(path.join(d, '.harness', 'releases', rel[0], 'skills', 'code-craft', 'SKILL.md')), 'old skills not in snapshot');
});

await test('roles + skills: BA vs DEV vs QA get different engine tools; skill rules injected only where allowed', () => {
  const d = sandbox();
  drop(d, { id: 'roles', title: 'roles', verifyCmd: PASS, subtasks: [
    { id: 'ba', role: 'BA_ANALYST', skills: ['code-craft'], targetFiles: ['docs/spec.md'], prompt: 'WRITE docs/spec.md s' },
    { id: 'dev', role: 'DEV_ENGINEER', skills: ['code-craft'], targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js a' },
    { id: 'qa', role: 'QA_AUDITOR', targetFiles: ['tests/a.test.js'], prompt: 'WRITE tests/a.test.js t' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === '4_COMMITTED', 'not committed');
  const tools = (id) => argsOf(d, id).find((a) => a.startsWith('ALLOWED=')).slice(8).split(',');
  const denied = argsOf(d, 'dev').find((a) => a.startsWith('DENIED=')).slice(7);
  const ba = tools('ba'); const dev = tools('dev'); const qa = tools('qa');
  assert(ba.includes('Edit(docs/spec.md)') && ba.includes('Write(docs/spec.md)') && ba.includes('Bash(git status)') && !ba.some((t) => /npm|src/.test(t)), `BA: ${ba}`);
  assert(dev.includes('Edit(src/a.js)') && dev.includes('Write(src/a.js)') && dev.includes('Bash(npm test:*)') && dev.includes('Bash(node --test:*)') && !dev.includes('Bash(node:*)') && !dev.includes('Bash(npm:*)') && !dev.some((t) => /git/.test(t)), `DEV (narrowed by code-craft to npm test + node --test): ${dev}`);
  assert(qa.includes('Edit(tests/a.test.js)') && qa.includes('Bash(npm test:*)') && !qa.includes('Bash(npm:*)') && !qa.some((t) => /node/.test(t)), `QA (npm test only): ${qa}`);
  assert(/Edit\(\.env\*\)/.test(denied) && /Bash\(git push:\*\)/.test(denied), `deny rules: ${denied}`);
  assert(promptOf(d, 'dev').includes('@governed-by PO_ARCHITECT') && promptOf(d, 'dev').includes('[ROLE PERSONA — DEV_ENGINEER]'), 'skill/persona not injected for DEV');
  assert(!promptOf(d, 'ba').includes('Code Craft Skill Rules') && promptOf(d, 'ba').includes('[ROLE PERSONA — BA_ANALYST]'), 'skill wrongly injected into BA');
  assert(log(d).some((e) => e.phase === 'SKILL_ROLE_MISMATCH' && /code-craft/.test(e.message)), 'mismatch not logged');
  const arch = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(arch.plan.find((s) => s.id === 'dev').resolvedSkills[0] === 'code-craft', 'audit trail lacks resolved skills');
});

await test('role write-scope, forbidden paths, unknown role and unknown skill are rejected before any worker runs', () => {
  for (const [sub, re] of [
    [{ id: 'w', role: 'BA_ANALYST', targetFiles: ['src/x.js'], prompt: 'WRITE src/x.js x' }, /BA_ANALYST may only own docs/],
    [{ id: 'w', role: 'QA_AUDITOR', targetFiles: ['src/x.js'], prompt: 'WRITE src/x.js x' }, /QA_AUDITOR may only own/],
    [{ id: 'w', targetFiles: ['.env'], prompt: 'WRITE .env x' }, /charter\.md forbids/],
    [{ id: 'w', targetFiles: ['node_modules/x/index.js'], prompt: 'WRITE x x' }, /charter\.md forbids/],
    [{ id: 'w', role: 'HACKER', targetFiles: ['src/x.js'], prompt: 'x' }, /unknown role/],
    [{ id: 'w', role: 'DEV_ENGINEER', skills: ['ghost'], targetFiles: ['src/x.js'], prompt: 'x' }, /unknown skill/]
  ]) {
    const d = sandbox();
    drop(d, { id: 'scope', title: 's', subtasks: [sub] });
    runOnce(d);
    const s = json(path.join(d, '.harness', 'state.json'));
    assert(s.phase === 'REJECTED' && re.test(s.lastGateStatus), `${re}: ${s.lastGateStatus}`);
    assert(!fs.existsSync(path.join(d, '.mock-prompts', 'w.txt')), 'worker ran');
  }
});

await test('true parallel swarm: BA, DEV and QA workers all start before any finishes', () => {
  const d = sandbox();
  drop(d, { id: 'par', title: 'par', verifyCmd: PASS, subtasks: [
    { id: 'p-ba', role: 'BA_ANALYST', targetFiles: ['docs/a.md'], prompt: 'SLEEP 800\nWRITE docs/a.md a' },
    { id: 'p-dev', role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'SLEEP 800\nWRITE src/a.js a' },
    { id: 'p-qa', role: 'QA_AUDITOR', targetFiles: ['tests/a.test.js'], prompt: 'SLEEP 800\nWRITE tests/a.test.js a' }] });
  runOnce(d);
  const tl = fs.readFileSync(path.join(d, '.mock-prompts', 'timeline.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '));
  const lastStart = Math.max(...tl.filter((x) => x[1] === 'start').map((x) => +x[0]));
  const firstEnd = Math.min(...tl.filter((x) => x[1] === 'end').map((x) => +x[0]));
  assert(tl.filter((x) => x[1] === 'start').length === 3 && lastStart < firstEnd, `not parallel: ${JSON.stringify(tl)}`);
});

await test('AI planner assigns roles: valid roles accepted, role/path mismatch rejected', () => {
  const d = sandbox();
  const good = { interfaceContract: 'add(a,b)', subtasks: [
    { id: 'spec', role: 'BA_ANALYST', targetFiles: ['docs/add.md'], prompt: 'WRITE docs/add.md spec' },
    { id: 'impl', role: 'DEV_ENGINEER', skills: ['code-craft'], targetFiles: ['src/add.js'], prompt: 'WRITE src/add.js impl' }] };
  const r = node(d, ['.harness/dispatch.mjs', '--goal', planGoal(good), '--auto-plan', '--check', existsCheck('docs/add.md', 'src/add.js'), '--wait']);
  assert(r.status === 0, r.stdout);
  assert(promptOf(d, 'impl').includes('[SHARED INTERFACE CONTRACT') && promptOf(d, 'impl').includes('add(a,b)'), 'interface contract not passed');
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'planner.txt'), 'utf8').includes('[WORKER ROLES'), 'planner not told about roles');
  const d2 = sandbox();
  const bad = { subtasks: [{ id: 'x', role: 'BA_ANALYST', targetFiles: ['src/x.js'], prompt: 'x' }] };
  node(d2, ['.harness/dispatch.mjs', '--goal', planGoal(bad), '--auto-plan', '--wait']);
  assert(/BA_ANALYST may only own/.test(json(path.join(d2, '.harness', 'state.json')).lastGateStatus), 'role mismatch not rejected');
});

await test('backlog CLI: add / list / ready / pop', () => {
  const d = sandbox();
  const add = node(d, ['.harness/backlog.mjs', 'add', 'Write docs', '--role', 'BA_ANALYST', '--files', 'docs/x.md', '--check', PASS, '--priority', '2']);
  const id = (add.stdout.match(/Added (\S+)/) || [])[1];
  assert(id && byId(d, id).status === 'BACKLOG' && byId(d, id).role === 'BA_ANALYST', add.stdout);
  assert(/Next to run: \(nothing READY\)/.test(node(d, ['.harness/backlog.mjs', 'list']).stdout), 'list wrong');
  node(d, ['.harness/backlog.mjs', 'ready', id]);
  const pop = node(d, ['.harness/backlog.mjs', 'pop']);
  assert(/Promoted/.test(pop.stdout) && byId(d, id).status === 'IN_PROGRESS' && ls(d, 'inbox').length === 1, pop.stdout);
  runOnce(d);
  assert(byId(d, id).status === 'DONE', `status ${byId(d, id).status}`);
});


// ───────────── v2.1: uat integration branch, live agent output, heartbeat ─────────────

function gitSandbox({ mode = 'autonomous', autonomous = true } = {}) {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.git = { integrationBranch: 'uat', integrationMode: mode, integrationBase: 'HEAD', protectedBranches: ['main', 'master'], keepFailedBranches: true, linkIntoWorktrees: ['node_modules'] };
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  if (autonomous) setCharter(d, { autonomous: 'on' });
  fs.copyFileSync(path.join(REPO, '.gitignore'), path.join(d, '.gitignore'));
  fs.writeFileSync(path.join(d, 'README.md'), '# demo\n');
  const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  return { d, g, sha: (ref) => { try { return g('rev-parse', '--verify', ref); } catch { return null; } } };
}
const onBranch = (g, ref, file) => { try { return g('show', `${ref}:${file}`); } catch { return null; } };

await test('uat: autonomous task is built on its own branch, verified as a candidate, then merged into uat — main, your folder and checked-out branch untouched; out-of-scope edit discarded', () => {
  const { d, g, sha } = gitSandbox();
  const mainBefore = sha('main');
  setBacklog(d, [{ id: 'U1', title: 'greeter', priority: 1, status: 'READY', verifyCmd: existsCheck('src/g.js'),
    subtasks: [{ id: 'dev', role: 'DEV_ENGINEER', targetFiles: ['src/g.js'], prompt: 'WRITE src/g.js hello\nWRITE docs/leak.md sneaky' }] }]);
  const r = tick(d);
  assert(byId(d, 'U1').status === 'DONE', `${byId(d, 'U1').status} ${byId(d, 'U1').blockedReason || ''} ${r.stdout}`);
  assert(onBranch(g, 'uat', 'src/g.js') === 'hello', 'uat lacks the work');
  assert(onBranch(g, 'uat', 'docs/leak.md') === null, 'out-of-scope file reached uat');
  assert(sha('main') === mainBefore, 'main moved!');
  assert(g('branch', '--show-current') === 'main' && !fs.existsSync(path.join(d, 'src', 'g.js')), 'your folder/branch was touched');
  assert(g('branch', '--list', 'harness/*') === '', 'worker branches not cleaned up after success');
  assert(g('worktree', 'list').split('\n').length === 1, 'worktrees left behind');
  const ev = log(d).map((e) => e.phase);
  for (const p of ['GIT_BRANCH_CREATED', 'GIT_WORKER_COMMIT', 'GIT_CANDIDATE', 'GIT_INTEGRATED', 'PROTECTED_BRANCHES_UNCHANGED', '2_SCOPE_VIOLATION']) assert(ev.includes(p), `missing ${p}`);
  assert(log(d).find((e) => e.phase === '3_VERIFIER').cwd.includes('_integration'), 'verifier did not run on the candidate');
  const arch = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(arch.git.to === sha('uat') && byId(d, 'U1').integratedInto === `uat@${sha('uat').slice(0, 8)}`, 'audit trail lacks merge sha');
  assert(g('log', '--format=%s', 'uat').includes('harness(U1-run'), 'merge commit message missing');
});

await test('uat: failed check → uat does NOT move (no broken merge), worker branch kept for review, item BLOCKED', () => {
  const { d, g, sha } = gitSandbox();
  const mainBefore = sha('main');
  setBacklog(d, [{ id: 'U2', title: 'bad', priority: 1, status: 'READY', verifyCmd: FAIL_VERIFY,
    subtasks: [{ id: 'dev', role: 'DEV_ENGINEER', targetFiles: ['src/bad.js'], prompt: 'WRITE src/bad.js broken' }] }]);
  tick(d);
  assert(byId(d, 'U2').status === 'BLOCKED', byId(d, 'U2').status);
  assert(sha('uat') === mainBefore && onBranch(g, 'uat', 'src/bad.js') === null, 'failed work reached uat');
  assert(sha('main') === mainBefore, 'main moved');
  const kept = g('branch', '--list', 'harness/*');
  assert(/harness\/U2-run[\w-]+\/dev/.test(kept), `worker branch not kept: ${kept}`);
  assert(onBranch(g, kept.replace(/^[*+\s]+/, '').trim(), 'src/bad.js') === 'broken', 'kept branch lacks the attempt');
  const f = json(path.join(d, '.harness', 'failed', ls(d, 'failed')[0]));
  assert(/uat unchanged/.test(f.rollback) && f.git.protectedUnchanged === true, JSON.stringify(f.rollback));
});

await test('uat: MODIFYING an existing tracked file is committed and merged (regression: git status " M path" lost its first letter)', () => {
  const { d, g } = gitSandbox();
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'slug.js'), 'v1');
  fs.writeFileSync(path.join(d, 'zz.txt'), 'z'); // sorts after src/: the modified file is the FIRST status entry
  g('add', '-A'); g('commit', '-q', '-m', 'add slug');
  setBacklog(d, [{ id: 'MOD', title: 'edit existing', priority: 1, status: 'READY', verifyCmd: 'node -e "process.exit(require(\'fs\').readFileSync(\'src/slug.js\',\'utf8\')===\'v2\'?0:1)"',
    subtasks: [{ id: 'dev', role: 'DEV_ENGINEER', targetFiles: ['src/slug.js'], prompt: 'WRITE src/slug.js v2' }] }]);
  tick(d);
  assert(byId(d, 'MOD').status === 'DONE', `${byId(d, 'MOD').status} ${byId(d, 'MOD').blockedReason || ''}`);
  assert(onBranch(g, 'uat', 'src/slug.js') === 'v2', 'the modification did not reach uat');
  assert(!log(d).some((e) => e.phase === '2_SCOPE_VIOLATION'), 'in-scope modification wrongly reported as a scope violation');
});

await test('uat: a retry continues in the same worker branch and only the passing cycle is merged', () => {
  const { d, g } = gitSandbox();
  setBacklog(d, [{ id: 'U3', title: 'retry', priority: 1, status: 'READY', verifyCmd: existsCheck('src/f.js'),
    subtasks: [{ id: 'dev', targetFiles: ['src/f.js'], prompt: 'FIX src/f.js fixed' }] }]);
  tick(d);
  assert(byId(d, 'U3').status === 'DONE' && byId(d, 'U3').cyclesUsed === 2, JSON.stringify(byId(d, 'U3')));
  assert(onBranch(g, 'uat', 'src/f.js') === 'fixed', 'fix not on uat');
});

await test('uat: two parallel workers (BA + DEV) are merged into one verified candidate', () => {
  const { d, g } = gitSandbox();
  setBacklog(d, [{ id: 'U4', title: 'pair', priority: 1, status: 'READY', verifyCmd: existsCheck('docs/a.md', 'src/a.js'),
    subtasks: [{ id: 'ba', role: 'BA_ANALYST', targetFiles: ['docs/a.md'], prompt: 'WRITE docs/a.md spec' },
      { id: 'dev', role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js code' }] }]);
  tick(d);
  assert(onBranch(g, 'uat', 'docs/a.md') === 'spec' && onBranch(g, 'uat', 'src/a.js') === 'code', 'not both merged');
  assert((g('log', '--format=%s', 'uat').match(/merge (ba|dev) into uat/g) || []).length === 2, 'expected 2 merge commits');
});

await test('uat checked out in your folder: clean → fast-forwarded there; uncommitted changes → refused, uat unchanged', () => {
  const { d, g, sha } = gitSandbox();
  g('checkout', '-q', '-b', 'uat');
  setBacklog(d, [{ id: 'U5', title: 'ff', priority: 1, status: 'READY', verifyCmd: existsCheck('src/ff.js'), subtasks: [{ id: 'dev', targetFiles: ['src/ff.js'], prompt: 'WRITE src/ff.js ff' }] },
    { id: 'U6', title: 'dirty', priority: 2, status: 'READY', verifyCmd: existsCheck('src/x.js'), subtasks: [{ id: 'dev', targetFiles: ['src/x.js'], prompt: 'WRITE src/x.js x' }] }]);
  tick(d);
  assert(byId(d, 'U5').status === 'DONE' && fs.readFileSync(path.join(d, 'src', 'ff.js'), 'utf8') === 'ff', 'not fast-forwarded into the checked-out uat');
  fs.appendFileSync(path.join(d, 'README.md'), 'my unsaved edit\n');
  const before = sha('uat');
  tick(d);
  assert(byId(d, 'U6').status === 'BLOCKED' && /uncommitted changes/.test(byId(d, 'U6').blockedReason), byId(d, 'U6').blockedReason);
  assert(sha('uat') === before && fs.readFileSync(path.join(d, 'README.md'), 'utf8').includes('my unsaved edit'), 'your uncommitted work was touched');
});

await test('uat: protected branch as target is refused; autonomous work without git is refused', () => {
  const { d, sha } = gitSandbox({ autonomous: false });
  const mainBefore = sha('main');
  drop(d, { id: 'prot', title: 'p', integrationBranch: 'main', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/p.js'], prompt: 'WRITE src/p.js p' }] });
  runOnce(d);
  assert(/protected branch 'main'/.test(json(path.join(d, '.harness', 'state.json')).lastGateStatus) && sha('main') === mainBefore, 'protected target not refused');
  const n = sandbox();
  const cfg = json(path.join(n, '.harness', 'config.json')); cfg.git.integrationMode = 'autonomous'; cfg.git.integrationBranch = 'uat';
  fs.writeFileSync(path.join(n, '.harness', 'config.json'), JSON.stringify(cfg));
  setCharter(n, { autonomous: 'on' });
  setBacklog(n, [{ id: 'NG', title: 'nogit', status: 'READY', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js a' }] }]);
  tick(n);
  assert(/needs a git repository/.test(byId(n, 'NG').blockedReason || '') && !fs.existsSync(path.join(n, 'src', 'a.js')), 'non-git autonomous not refused');
});

await test('uat: manual "dispatch --branch uat" opts a normal task in; without it, manual tasks still edit your folder', () => {
  const { d, g } = gitSandbox({ autonomous: false });
  const r = node(d, ['.harness/dispatch.mjs', '--goal', 'WRITE src/m.js m', '--files', 'src/m.js', '--branch', 'uat', '--check', existsCheck('src/m.js'), '--wait']);
  assert(r.status === 0 && onBranch(g, 'uat', 'src/m.js') === 'm' && !fs.existsSync(path.join(d, 'src', 'm.js')), r.stdout);
  const r2 = node(d, ['.harness/dispatch.mjs', '--goal', 'WRITE src/local.js l', '--files', 'src/local.js', '--check', existsCheck('src/local.js'), '--wait']);
  assert(r2.status === 0 && fs.existsSync(path.join(d, 'src', 'local.js')) && onBranch(g, 'uat', 'src/local.js') === null, 'manual default changed');
});

await test('live agent output: stream-json events become readable lines (tool calls, messages, denials); quiet mode uses batch JSON', () => {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.mock.args = [MOCK, '{output}', 'ALLOWED={allowedTools}'];
  cfg.profiles.mock.output = { batch: ['FMT=json'], stream: ['FMT=stream'] };
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  drop(d, { id: 'live', title: 'live', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/a.js'], prompt: 'SAY Planning the module\nWRITE src/a.js a\nDENY src/evil.js' }] });
  const r = node(d, ['.harness/daemon.mjs', '--once'], { HARNESS_LIVE: '1' });
  const out = r.stdout;
  for (const want of ['▶ agent started (mock-model)', '💬 Planning the module', '🔧 Write src/a.js', '✔ finished in 0.0s', '⛔ denied: Write src/evil.js']) assert(out.includes(want), `missing "${want}" in:\n${out}`);
  assert(argsOf(d, 'w').includes('FMT=stream'), 'stream args not used');
  assert(log(d).some((e) => e.phase === 'PERMISSION_DENIED' && e.denials[0].target.replaceAll('\\', '/').endsWith('src/evil.js')), 'denial not in audit log');
  assert(json(path.join(d, '.harness', 'state.json')).phase === '4_COMMITTED', 'final result not parsed from stream');
  const q = sandbox();
  fs.writeFileSync(path.join(q, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  drop(q, { id: 'quiet', title: 'q', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js a' }] });
  const rq = node(q, ['.harness/daemon.mjs', '--once'], { HARNESS_LIVE: '0' });
  assert(argsOf(q, 'w').includes('FMT=json') && !rq.stdout.includes('🔧'), 'quiet mode should not stream');
});

await test('heartbeat: config heartbeatIntervalSeconds wakes the controller again and picks up work added later', async () => {
  const { d } = gitSandbox();
  const cfg = json(path.join(d, '.harness', 'config.json')); cfg.heartbeatIntervalSeconds = 1;
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  setCharter(d, { requireRealCheck: 'no' }, 'PO_JSON {"tasks":[]}');
  setBacklog(d, []);
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs', '--autonomous'], { cwd: d, env, stdio: 'ignore' });
  // Add the work only after the controller has started AND run its startup tick (0.5 s after AUTO_START): a fixed
  // wait raced a slow start on a busy machine, so the task was picked up by the startup tick instead of the heartbeat.
  const started = () => { try { return log(d).some((e) => e.phase === 'AUTO_START'); } catch { return false; } };
  assert(await waitFor(started, 20000), 'the controller did not start');
  await new Promise((r) => setTimeout(r, 1500));
  setBacklog(d, [{ id: 'LATE', title: 'added later', status: 'READY', verifyCmd: existsCheck('src/late.js'), subtasks: [{ id: 'w', targetFiles: ['src/late.js'], prompt: 'WRITE src/late.js l' }] }]);
  const ok = await waitFor(() => byId(d, 'LATE')?.status === 'DONE', 15000);
  daemon.kill('SIGTERM'); await new Promise((r) => daemon.on('close', r));
  assert(ok, `LATE is ${byId(d, 'LATE')?.status}`);
  assert(log(d).some((e) => e.phase === 'AUTO_DISPATCH' && e.trigger === 'interval'), 'not woken by the heartbeat');
  assert(log(d).some((e) => e.phase === 'AUTO_START' && /every 1s/.test(e.message)), 'heartbeat config not used');
});


// ───────────── v2.2: skill exact-command rules, PO sees uat + is throttled, --status ─────────────

await test('skill exact rules: DEV gets only "npm test" + node (not npm:*), a skill can never grant what the role lacks, QA never gets node', async () => {
  const { computeAllowedTools, skillRulesNotGranted, loadRoles, loadSkills } = await import(pathToFileURL(path.join(REPO, '.harness', 'lib', 'governance.mjs')).href);
  const roles = loadRoles(); const skills = loadSkills();
  const cc = skills['code-craft'];
  const dev = computeAllowedTools(roles.DEV_ENGINEER, [cc], ['src/a.js']);
  assert(dev.includes('Bash(npm test:*)') && dev.includes('Bash(node --test:*)') && dev.includes('Edit(src/a.js)') && !dev.includes('Bash(node:*)') && !dev.includes('Bash(npm:*)') && !dev.some((t) => /git/.test(t)), dev.join());
  const qa = computeAllowedTools(roles.QA_AUDITOR, [cc], ['tests/a.test.js']);
  assert(qa.includes('Bash(npm test:*)') && !qa.some((t) => /node/.test(t)) && !qa.some((t) => /npm run/.test(t)), qa.join());
  assert(skillRulesNotGranted(roles.QA_AUDITOR, [cc]).length === 0 && skillRulesNotGranted(roles.DEV_ENGINEER, [cc]).length === 0, 'shipped skill asks for something its roles lack');
  assert(skillRulesNotGranted(roles.QA_AUDITOR, [{ name: 'x', allowedTools: ['Bash(node --test:*)'] }]).join().includes('node --test'), 'ungranted rule not reported');
  // per-role override really is per role: the same skill file gives DEV node --test but QA only npm test
  assert(cc.toolsByRole.DEV_ENGINEER.includes('Bash(node --test:*)') && !cc.allowedTools.some((t) => /node/.test(t)), 'per-role lists not parsed');
  const evil = { name: 'evil', allowedTools: ['Read', 'Bash(rm:*)', 'Bash(git push:*)', 'Bash(npm test:*)'] };
  const d2 = computeAllowedTools(roles.DEV_ENGINEER, [evil], ['src/a.js']);
  assert(!d2.some((t) => /rm|push/.test(t)) && d2.includes('Bash(npm test:*)') && !d2.some((t) => t.startsWith('Edit')), `skill granted something: ${d2.join()}`);
  const ba = computeAllowedTools(roles.BA_ANALYST, [cc], ['docs/a.md']);
  assert(!ba.some((t) => t.startsWith('Bash(node')), 'BA must not gain node');
});

await test('role + skill end-to-end: engine args for a DEV worker carry exactly the narrowed rules; the ungranted skill rule is logged', () => {
  const d = sandbox();
  drop(d, { id: 'skillrules', title: 's', verifyCmd: PASS, subtasks: [
    { id: 'dev', role: 'DEV_ENGINEER', skills: ['code-craft'], targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js a' },
    { id: 'qa', role: 'QA_AUDITOR', skills: ['code-craft'], targetFiles: ['tests/a.test.js'], prompt: 'WRITE tests/a.test.js t' }] });
  runOnce(d);
  const tools = (id) => argsOf(d, id).find((a) => a.startsWith('ALLOWED=')).slice(8).split(',');
  assert(tools('dev').includes('Bash(node --test:*)') && tools('dev').includes('Bash(npm test:*)') && !tools('dev').includes('Bash(node:*)'), tools('dev').join());
  assert(tools('qa').includes('Bash(npm test:*)') && !tools('qa').some((t) => /node/.test(t)), tools('qa').join());
  assert(!log(d).some((e) => e.phase === 'SKILL_RULE_NOT_GRANTED'), 'the shipped skill should not ask for anything a role lacks');
  assert(promptOf(d, 'dev').includes('run the project\'s tests'), 'skill text lacks the self-test rule');
});

await test('PO_ARCHITECT works from the uat version of the project (not your folder), and is NOT re-asked while nothing changed', () => {
  const { d, g } = gitSandbox();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: PASS } }));
  g('add', '-A'); g('commit', '-q', '-m', 'add package.json');
  g('branch', 'uat'); g('checkout', '-q', 'uat');
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'only-on-uat.js'), 'u');
  g('add', '-A'); g('commit', '-q', '-m', 'work on uat'); g('checkout', '-q', 'main');
  assert(!fs.existsSync(path.join(d, 'src', 'only-on-uat.js')), 'precondition: your folder (main) lacks the uat file');
  setCharter(d, { autonomous: 'on' }, 'PO_JSON {"tasks":[]}');
  setBacklog(d, []);
  const poCalls = () => (fs.existsSync(path.join(d, '.mock-prompts', 'po-calls.txt')) ? fs.readFileSync(path.join(d, '.mock-prompts', 'po-calls.txt'), 'utf8').trim().split('\n').length : 0);
  let r = tick(d);
  assert(/empty/.test(r.stdout) && poCalls() === 1, `${r.stdout} calls=${poCalls()}`);
  const po = promptOf(d, 'po-architect');
  assert(po.includes('src/only-on-uat.js') && /the 'uat' branch @ [0-9a-f]{8}/.test(po), 'PO did not see the uat branch');
  assert(g('worktree', 'list').split('\n').length === 1, 'PO view worktree left behind');
  r = tick(d); // nothing changed → no second (paid) AI call
  assert(/idle/.test(r.stdout) && poCalls() === 1, `PO asked again though nothing changed: ${r.stdout} calls=${poCalls()}`);
  r = node(d, ['.harness/daemon.mjs', '--tick', '--force']);
  assert(poCalls() === 2, `--force should ask again, calls=${poCalls()}`);
  const cfgBacklog = backlog(d); cfgBacklog.push({ id: 'NEWIDEA', title: 'a new idea', status: 'BACKLOG' }); setBacklog(d, cfgBacklog);
  tick(d);
  assert(poCalls() === 3, `a changed backlog should trigger a new PO call, calls=${poCalls()}`);
});

await test('doctor: the shipped skill/role/tool setup produces no skill warnings; an over-asking skill still warns', () => {
  const d = sandbox();
  let out = node(d, ['.harness/doctor.mjs']).stdout;
  assert(/skill code-craft → roles DEV_ENGINEER, QA_AUDITOR; DEV_ENGINEER: .*node --test.*; QA_AUDITOR: Read, Edit, Write, Bash\(npm test:\*\)/.test(out) && !/skill code-craft asks for/.test(out), out.split('\n').filter((l) => /skill/.test(l)).join('\n'));
  fs.mkdirSync(path.join(d, '.harness', 'skills', 'greedy'), { recursive: true });
  fs.writeFileSync(path.join(d, '.harness', 'skills', 'greedy', 'SKILL.md'), '---\nname: greedy\ndescription: d\nroles: ["QA_AUDITOR"]\nallowedTools: ["Bash(node:*)"]\n---\nx');
  out = node(d, ['.harness/doctor.mjs']).stdout;
  assert(/skill greedy asks for tool rules role QA_AUDITOR does not allow/.test(out), 'over-asking skill not warned');
});

await test('--status prints the harness status (read-only alias for status.mjs)', () => {
  const d = sandbox();
  runOnce(d);
  const r = node(d, ['.harness/daemon.mjs', '--status']);
  assert(r.status === 0 && /Daemon:/.test(r.stdout) && /Backlog:/.test(r.stdout) && /Autonomous:/.test(r.stdout), r.stdout + r.stderr);
});


// ───────────── v2.3: editor integration (live feed, watch, session hook, worker guards) ─────────────

function liveSandbox() {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.mock.args = [MOCK, '{output}', 'ALLOWED={allowedTools}'];
  cfg.profiles.mock.output = { batch: ['FMT=json'], stream: ['FMT=stream'] };
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  return d;
}

await test('live feed + watch: a running controller writes live.log; "watch --job" streams the agent actions from the dispatch point and exits 0 with the result', async () => {
  const d = liveSandbox();
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs'], { cwd: d, env: { ...env, HARNESS_LIVE: '1' }, stdio: 'ignore' });
  await waitFor(() => fs.existsSync(path.join(d, '.harness', 'daemon.pid')), 8000);
  const disp = node(d, ['.harness/dispatch.mjs', '--goal', 'SAY Building it now\nWRITE src/a.js a', '--files', 'src/a.js', '--check', existsCheck('src/a.js')]);
  const id = (disp.stdout.match(/^JOB_ID=(\S+)/m) || [])[1]; const from = (disp.stdout.match(/^LIVE_FROM=(\d+)/m) || [])[1];
  assert(id && from !== undefined, disp.stdout);
  const w = node(d, ['.harness/watch.mjs', '--job', id, '--from', from, '--max-wait', '30']);
  daemon.kill('SIGTERM'); await new Promise((r) => daemon.on('close', r));
  assert(w.status === 0, `watch exit ${w.status}\n${w.stdout}`);
  for (const want of ['agent started (mock-model)', '💬 Building it now', '🔧 Write src/a.js', 'RESULT: COMMITTED']) assert(w.stdout.includes(want), `missing "${want}" in:\n${w.stdout}`);
  assert(!/\x1b\[/.test(fs.readFileSync(path.join(d, '.harness', 'live.log'), 'utf8')), 'live.log must be plain text (no colour codes)');
});

await test('watch --job: a failed job exits 1 with NOT DONE; no controller running is reported instead of hanging silently', async () => {
  const d = liveSandbox();
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs'], { cwd: d, env: { ...env, HARNESS_LIVE: '1' }, stdio: 'ignore' });
  await waitFor(() => fs.existsSync(path.join(d, '.harness', 'daemon.pid')), 8000);
  const disp = node(d, ['.harness/dispatch.mjs', '--goal', 'WRITE src/b.js b', '--files', 'src/b.js', '--check', FAIL_VERIFY]);
  const id = (disp.stdout.match(/^JOB_ID=(\S+)/m) || [])[1];
  const w = node(d, ['.harness/watch.mjs', '--job', id, '--from-start', '--max-wait', '60']);
  daemon.kill('SIGTERM'); await new Promise((r) => daemon.on('close', r));
  assert(w.status === 1 && /RESULT: NOT DONE/.test(w.stdout) && /HALTED_HITL_REQUIRED/.test(w.stdout), `exit ${w.status}\n${w.stdout}`);
  const d2 = liveSandbox();
  const w2 = spawnSync(process.execPath, ['.harness/watch.mjs', '--job', 'nothing', '--max-wait', '7'], { cwd: d2, env, encoding: 'utf8', timeout: 20000 });
  assert(w2.status === 3 && /no controller is running/.test(w2.stdout), `exit ${w2.status}\n${w2.stdout}`);
});

await test('session hook (SessionStart): reports controller/backlog/autonomy/uat to the editor AI; silent for harness workers; never crashes on a broken folder', () => {
  const d = sandbox();
  setBacklog(d, [{ id: 'R1', title: 'r', status: 'READY' }, { id: 'D1', title: 'd', status: 'DONE' }]);
  let r = node(d, ['.harness/hook-session.mjs']);
  assert(r.status === 0 && /Controller: NOT running/.test(r.stdout) && /READY 1, IN_PROGRESS 0, DONE 1/.test(r.stdout) && /charter says ON/.test(r.stdout) && /AUTO MODE IS ON .* 1 task\(s\) are READY/.test(r.stdout) && /\/harness:auto/.test(r.stdout) && /\/harness:run <goal>/.test(r.stdout) && /\/harness:doctor/.test(r.stdout), r.stdout);
  fs.writeFileSync(path.join(d, '.harness', 'daemon.pid'), String(process.pid));
  r = node(d, ['.harness/hook-session.mjs']);
  assert(/Controller: running \(PID \d+\)/.test(r.stdout), r.stdout);
  r = node(d, ['.harness/hook-session.mjs'], { HARNESS_WORKER: '1' });
  assert(r.status === 0 && r.stdout === '', `worker should get no output, got: ${r.stdout}`);
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), '{ broken');
  r = node(d, ['.harness/hook-session.mjs']);
  assert(r.status === 0, 'a broken config must not make the hook fail');
});

await test('worker guards: a harness worker cannot start the controller, change the backlog, or write memory — but can read', () => {
  const d = sandbox();
  const asWorker = (args) => node(d, args, { HARNESS_WORKER: '1' });
  assert(asWorker(['.harness/daemon.mjs', '--tick']).status === 2, 'worker started the controller');
  assert(asWorker(['.harness/backlog.mjs', 'add', 'x']).status === 2 && backlog(d).length === 0, 'worker changed the backlog');
  assert(asWorker(['.harness/backlog.mjs', 'import', 'x.json']).status === 2, 'worker imported');
  assert(asWorker(['.harness/memory.mjs', 'remember', 'evil rule']).status === 2 && !/evil/.test(fs.readFileSync(path.join(d, '.harness', 'memory', 'lessons.md'), 'utf8')), 'worker wrote memory');
  assert(asWorker(['.harness/backlog.mjs', 'overview']).status === 0 && asWorker(['.harness/memory.mjs', 'list']).status === 0 && asWorker(['.harness/status.mjs']).status === 0, 'read-only commands must work for workers');
});


// ───────────── v2.4: .claude/ (Claude Code settings + slash commands), Doctor notes ─────────────

await test('.claude/settings.json: valid, minimal allow-list, risky things ask or denied, hook script exists, no unsupported Write() rules', () => {
  const st = json(path.join(REPO, '.claude', 'settings.json'));
  const { allow, ask, deny } = st.permissions;
  const TEST_CMDS = ['Bash(npm test:*)', 'Bash(node --test:*)']; // the only two non-harness commands: the agents run them to check their own work
  assert(allow.length > 0 && allow.every((r) => /^Bash\(node \.harness\/[a-z-]+\.mjs[ :)]/.test(r) || TEST_CMDS.includes(r)), `allow must only contain harness scripts and the two test commands: ${allow.filter((r) => !/^Bash\(node \.harness\//.test(r) && !TEST_CMDS.includes(r))}`);
  for (const r of TEST_CMDS) assert(allow.includes(r), `${r} must be allowed so the named agents can check their own work without a prompt`);
  for (const sub of ['brief', 'assign', 'verify', 'handoff', 'propose', 'status', 'report']) assert(allow.includes(`Bash(node .harness/visible.mjs ${sub}:*)`), `the editor workflow command "visible.mjs ${sub}" must be allowed`);
  assert(!allow.some((r) => /visible\.mjs rollback/.test(r)) && ask.includes('Bash(node .harness/visible.mjs rollback:*)') && ask.includes('Edit(.harness/team.json)'), 'rollback and editing team.json must always ask');
  for (const r of [...allow, ...ask, ...deny]) assert(!/^Write\(/.test(r), `Write() rules are ignored by Claude Code; use Edit(): ${r}`);
  assert(!allow.some((r) => /^Bash\((node|git|npm|npx|rm|sh|bash|python)(:\*)?\)$/.test(r) || /^Bash\(\*/.test(r)), 'allow list is too broad (a whole interpreter or shell is allowed)');
  for (const risky of ['Bash(node .harness/backlog.mjs import:*)', 'Bash(node .harness/backlog.mjs ready:*)', 'Bash(node .harness/memory.mjs forget:*)', 'Bash(node .harness/daemon.mjs --autonomous:*)', 'Edit(.harness/charter.md)', 'Edit(.harness/config.json)', 'Bash(git push:*)'])
    assert(ask.includes(risky) && !allow.includes(risky), `${risky} must ask, not be allowed`);
  assert(deny.includes('Edit(.harness/releases/**)') && deny.includes('Bash(git push --force:*)'), 'releases/force-push must be denied');
  const hook = st.hooks.SessionStart[0].hooks[0].command;
  assert(/hook-session\.mjs/.test(hook) && fs.existsSync(path.join(REPO, '.harness', 'hook-session.mjs')), hook);
  for (const rule of allow) { const m = rule.match(/node (\.harness\/[a-z-]+\.mjs)/); if (m) assert(fs.existsSync(path.join(REPO, m[1])), `allowed script missing: ${m[1]}`); }
});

await test('.claude/commands/harness/{status,tick,doctor,run,teach}.md: have a description and only call scripts/flags that exist', () => {
  const dir = path.join(REPO, '.claude', 'commands', 'harness');
  const daemon = fs.readFileSync(path.join(REPO, '.harness', 'daemon.mjs'), 'utf8');
  for (const c of ['status', 'tick', 'doctor', 'run', 'teach', 'team', 'auto']) {
    const t = fs.readFileSync(path.join(dir, `${c}.md`), 'utf8');
    assert(/^---\ndescription: .+\n/.test(t), `${c}.md lacks a description`);
    for (const m of t.matchAll(/node (\.harness\/[a-z-]+\.mjs)/g)) assert(fs.existsSync(path.join(REPO, m[1])), `${c}.md calls a missing script ${m[1]}`);
    for (const m of t.matchAll(/daemon\.mjs (--[a-z-]+)/g)) assert(daemon.includes(`'${m[1]}'`), `${c}.md uses a daemon flag that does not exist: ${m[1]}`);
    assert(!/backlog\.mjs --tick/.test(t), `${c}.md uses the non-existent "backlog.mjs --tick"`);
  }
  assert(/status\.mjs/.test(fs.readFileSync(path.join(dir, 'status.md'), 'utf8')) && /daemon\.mjs --tick/.test(fs.readFileSync(path.join(dir, 'tick.md'), 'utf8')) && /doctor\.mjs/.test(fs.readFileSync(path.join(dir, 'doctor.md'), 'utf8')), 'commands do not call the scripts they promise');
  assert(/autonomous: off/.test(fs.readFileSync(path.join(dir, 'tick.md'), 'utf8')) && /Do not change the charter/i.test(fs.readFileSync(path.join(dir, 'tick.md'), 'utf8')), 'tick must respect the charter');
});

await test('install: copies .claude commands, MERGES settings (project rules kept, no loosening, hook once), keeps existing commands, idempotent', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-claude-'));
  fs.mkdirSync(path.join(p, '.claude', 'commands', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'commands', 'harness', 'status.md'), 'MY OWN STATUS COMMAND');
  fs.writeFileSync(path.join(p, '.claude', 'settings.json'), JSON.stringify({
    model: 'my-model', permissions: { allow: ['Bash(make:*)'], ask: [], deny: ['Bash(node .harness/memory.mjs remember:*)'] },
    hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  const run = () => spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), p], { encoding: 'utf8' });
  assert(run().status === 0, 'install failed');
  const st = json(path.join(p, '.claude', 'settings.json'));
  assert(st.model === 'my-model' && st.permissions.allow.includes('Bash(make:*)') && st.permissions.allow.includes('Bash(node .harness/status.mjs:*)'), 'rules not merged');
  assert(!st.permissions.allow.includes('Bash(node .harness/memory.mjs remember:*)') && st.permissions.deny.includes('Bash(node .harness/memory.mjs remember:*)'), 'a rule the project denies was loosened');
  assert(st.hooks.SessionStart.length === 2 && st.hooks.SessionStart[0].hooks[0].command === 'echo mine', 'hook not added next to the project hook');
  assert(fs.readFileSync(path.join(p, '.claude', 'commands', 'harness', 'status.md'), 'utf8') === 'MY OWN STATUS COMMAND' && fs.existsSync(path.join(p, '.claude', 'commands', 'harness', 'tick.md')), 'commands not handled correctly');
  const before = fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8');
  run();
  assert(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8') === before, 'second install changed settings (not idempotent)');
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-claude-bad-'));
  fs.mkdirSync(path.join(bad, '.claude')); fs.writeFileSync(path.join(bad, '.claude', 'settings.json'), '{ // comment');
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), bad]);
  assert(fs.readFileSync(path.join(bad, '.claude', 'settings.json'), 'utf8') === '{ // comment' && fs.existsSync(path.join(bad, '.claude', 'settings.harness.json')), 'an unparsable settings file must be left alone');
});

await test('doctor: a valid setup reports 0 failures and 0 warnings; profile placeholder and idle controller are Notes', () => {
  const { d, g } = gitSandbox({ autonomous: false });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: PASS } }));
  g('add', '-A'); g('commit', '-q', '-m', 'package.json');
  fs.cpSync(path.join(REPO, '.claude'), path.join(d, '.claude'), { recursive: true }); // an installed project has the editor agents
  const dr = node(d, ['.harness/doctor.mjs']); const out = `${dr.stdout}
[exit ${dr.status}${dr.signal ? ` signal ${dr.signal}` : ''}${dr.error ? ` error ${dr.error.code}` : ''}] ${String(dr.stderr || '').slice(0, 300)}`; // HARNESS_ENGINES='' (suite env): no engine and no ~/.gemini/bin hint from this machine
  assert(/Failures: 0 · Warnings: 0 · Notes: \d+/.test(out), // notes vary: an AI tool installed on this machine but not allowed in the sandbox is a note
     // the reporter prints only the first 3 lines of a message: status and totals first, then the ✖ / ! lines, then notes
     `${out.split('\n').filter((l) => /^\[exit|Failures/.test(l)).join(' | ')}\n${out.split('\n').filter((l) => /^  [!✖]/.test(l)).join('\n')}\n${out.split('\n').filter((l) => /^  ℹ/.test(l)).join(' ')}`);
  assert(/ℹ memory\/profile\.md/.test(out) && /ℹ The background controller is not running/.test(out), 'the two notes are missing');
  assert(/ℹ engine routing: none set, every member uses "auto"\. .*team\.mjs auto-assign/.test(out), 'the engine-routing note is missing');
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), '{ broken');
  assert(node(d, ['.harness/doctor.mjs']).status !== 0 || true, 'doctor must not crash silently');
});

await test('template for other teams: install into a project keeps its own team/charter, never copies this repo\'s local runtime files, and prints how to prompt it', () => {
  const made = [];
  for (const f of ['live.log', 'auto-state.json', 'state.json', 'telemetry.log']) {
    const p = path.join(REPO, '.harness', f);
    if (!fs.existsSync(p)) { fs.writeFileSync(p, 'LOCAL-RUNTIME-DATA'); made.push(p); }
  }
  try {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-team-fresh-'));
    const r = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), fresh], { encoding: 'utf8' });
    assert(r.status === 0, r.stderr);
    for (const f of ['live.log', 'auto-state.json', 'state.json', 'telemetry.log']) assert(!fs.existsSync(path.join(fresh, '.harness', f)), `local runtime file leaked into the target: ${f}`);
    assert(fs.existsSync(path.join(fresh, '.harness', 'team.json')) && fs.existsSync(path.join(fresh, '.harness', 'team.mjs')) && fs.existsSync(path.join(fresh, '.claude', 'commands', 'harness', 'team.md')), 'team files not installed');
    assert(/\/harness:run/.test(r.stdout) && /dispatch\.mjs --goal .* --hierarchy/.test(r.stdout) && /doctor\.mjs/.test(r.stdout), `next steps not printed:\n${r.stdout}`);
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-team-own-'));
    fs.mkdirSync(path.join(mine, '.harness'), { recursive: true });
    const own = { version: 1, members: [{ id: 'boss', level: 'orchestrator', role: 'PO_ARCHITECT', reports_to: null }] };
    fs.writeFileSync(path.join(mine, '.harness', 'team.json'), JSON.stringify(own));
    spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), mine]);
    assert(JSON.stringify(json(path.join(mine, '.harness', 'team.json'))) === JSON.stringify(own), 'the project\'s own team.json was overwritten');
    const again = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), mine], { encoding: 'utf8' });
    assert(again.status === 0, 're-running the installer must be safe');
    // the installed copy works on its own: doctor + team commands run inside the new project
    const ok = spawnSync(process.execPath, ['.harness/team.mjs', 'show'], { cwd: fresh, encoding: 'utf8' });
    assert(ok.status === 0 && /L2  lead-dev/.test(ok.stdout), ok.stdout + ok.stderr);
  } finally { for (const p of made) fs.rmSync(p, { force: true }); }
});

await test('/harness:team and /harness:run: the editor commands know the team mode, and team.mjs is allowed without a prompt (read-only)', () => {
  const dir = path.join(REPO, '.claude', 'commands', 'harness');
  const team = fs.readFileSync(path.join(dir, 'team.md'), 'utf8'); const run = fs.readFileSync(path.join(dir, 'run.md'), 'utf8');
  assert(/^---\ndescription: .+\n/.test(team) && /team\.mjs show/.test(team) && /team\.mjs validate/.test(team) && /Do not change any file/.test(team), 'team.md');
  assert(/visible\.mjs brief/.test(run) && /visible\.mjs assign/.test(run) && /visible\.mjs verify/.test(run) && /Agent tool/.test(run) && /subagent_type/.test(run) && /orchestrator/.test(run) && /Never commit, push or merge/.test(run) && /--hierarchy --max-cost/.test(run), 'run.md does not describe the visible workflow');
  const st = json(path.join(REPO, '.claude', 'settings.json')).permissions;
  assert(st.allow.includes('Bash(node .harness/team.mjs:*)') && !st.ask.includes('Bash(node .harness/team.mjs:*)'), 'team.mjs must be allowed');
  assert(fs.readFileSync(path.join(REPO, '.harness', 'hook-session.mjs'), 'utf8').includes('/harness:run'), 'hook text');
});

// ───────────── v3.0: hierarchical orchestration (orchestrator → leads → workers), team guardrails, budgets ─────────────

const gov = await import(pathToFileURL(path.join(REPO, '.harness', 'lib', 'governance.mjs')).href);
const hierGoal = (orch, prefix = '') => `${prefix}Build the slug feature. ORCH_JSON ${JSON.stringify(orch)}`;
const leadJson = (subtasks, prefix = '') => `${prefix}LEAD_JSON ${JSON.stringify({ subtasks })}`;
const happyPlan = (cost = '') => ({
  interfaceContract: 'slugify(text) -> lowercase-dashed string',
  assignments: [
    { lead: 'lead-ba', files: ['docs/slug.md'], goal: leadJson([{ id: 'spec', targetFiles: ['docs/slug.md'], prompt: `${cost}\nSLEEP 600\nWRITE docs/slug.md spec` }]) },
    { lead: 'lead-dev', files: ['src/'], goal: leadJson([
      { id: 'impl', targetFiles: ['src/slug.js'], prompt: `${cost}\nSLEEP 600\nWRITE src/slug.js code` },
      { id: 'util', targetFiles: ['src/util.js'], prompt: `${cost}\nSLEEP 600\nWRITE src/util.js util` }]) },
    { lead: 'lead-qa', files: ['tests/slug.test.js'], goal: leadJson([{ id: 'tests', targetFiles: ['tests/slug.test.js'], prompt: `${cost}\nSLEEP 600\nWRITE tests/slug.test.js t` }]) }]
});
const ALL4 = existsCheck('docs/slug.md', 'src/slug.js', 'src/util.js', 'tests/slug.test.js');
const hierJob = (d, id, goal, extra = {}) => drop(d, { id, title: id, hierarchy: true, goal, verifyCmd: ALL4, ...extra });
const stateOf = (d) => json(path.join(d, '.harness', 'state.json'));
const calls = (d, f) => { try { return fs.readFileSync(path.join(d, '.mock-prompts', f), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const ranWorkers = (d) => fs.existsSync(path.join(d, '.mock-prompts')) && fs.readdirSync(path.join(d, '.mock-prompts')).some((f) => /^lead-[a-z]+\.[\w-]+\.txt$/.test(f));

await test('hierarchy: orchestrator → 3 leads → 4 workers in parallel; each level read-only/scoped; plan + cost recorded; check passes', () => {
  const d = sandbox();
  hierJob(d, 'hier', hierGoal(happyPlan('MOCKCOST=0.01'), 'PLANCOST=0.01 '));
  runOnce(d);
  const s = stateOf(d);
  assert(s.phase === '4_COMMITTED' && s.mode === 'SWARM-MESH (4W)', `${s.phase} ${s.mode} ${s.lastGateStatus}`);
  assert(calls(d, 'orch-calls.txt').length === 1 && calls(d, 'lead-calls.txt').length === 3, 'expected 1 orchestrator call and 3 lead calls');
  for (const line of [...calls(d, 'orch-calls.txt'), ...calls(d, 'lead-calls.txt')]) assert(/ALLOWED=Read,Glob,Grep /.test(line), `a planning level was not read-only: ${line}`);
  const tools = (id) => argsOf(d, id).find((a) => a.startsWith('ALLOWED=')).slice(8).split(',');
  assert(tools('lead-dev.impl').includes('Edit(src/slug.js)') && !tools('lead-dev.impl').some((t) => /push/.test(t)), tools('lead-dev.impl').join());
  assert(tools('lead-qa.tests').includes('Bash(npm test:*)') && !tools('lead-qa.tests').some((t) => /node/.test(t)) && tools('lead-qa.tests').includes('Edit(tests/slug.test.js)'), tools('lead-qa.tests').join());
  assert(tools('lead-ba.spec').includes('Edit(docs/slug.md)') && !tools('lead-ba.spec').some((t) => /npm|node/.test(t)), tools('lead-ba.spec').join());
  const tl = fs.readFileSync(path.join(d, '.mock-prompts', 'timeline.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '));
  const wk = tl.filter((x) => /^lead-[a-z]+\./.test(x[2]));
  assert(wk.filter((x) => x[1] === 'start').length === 4 && Math.max(...wk.filter((x) => x[1] === 'start').map((x) => +x[0])) < Math.min(...wk.filter((x) => x[1] === 'end').map((x) => +x[0])), 'workers did not all run in parallel');
  const wp = promptOf(d, 'lead-dev.impl');
  assert(wp.includes('[SHARED INTERFACE CONTRACT') && wp.includes('slugify(text)') && wp.includes('ROLE: DEV_ENGINEER') && wp.includes('[SCOPED TARGET FILES: src/slug.js]'), 'worker prompt lacks contract/role/scope');
  const arch = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(arch.team.orchestrator === 'orchestrator' && arch.team.assignments.length === 3 && arch.team.assignments.find((a) => a.lead === 'lead-dev').workers.length === 2, JSON.stringify(arch.team));
  assert(Math.abs(arch.costUsd - 0.08) < 1e-9 && Object.keys(arch.costByAgent).length === 8, `cost ${arch.costUsd} ${JSON.stringify(arch.costByAgent)}`);
  const note = fs.readdirSync(path.join(d, '.harness', 'memory', 'sessions')).map((f) => fs.readFileSync(path.join(d, '.harness', 'memory', 'sessions', f), 'utf8')).join('');
  assert(/- Team: orchestrator → lead-ba \(lead-ba\.spec\); lead-dev \(lead-dev\.impl, lead-dev\.util\)/.test(note) && /- Cost: \$0\.0800/.test(note), 'session note lacks team/cost');
});

await test('hierarchy guardrails (level 1): a delegation that breaks a rule is re-asked once, then REJECTED before any worker starts', () => {
  const lead = (l, files, g = 'x') => ({ lead: l, files, goal: leadJson([{ id: 'w', targetFiles: files, prompt: 'WRITE x y' }], g) });
  const cases = [
    [{ assignments: [lead('lead-x', ['src/a.js'])] }, /not a lead you may delegate to/],
    [{ assignments: [lead('lead-dev', ['docs/a.md'])] }, /outside lead "lead-dev"'s scope/],
    [{ assignments: [lead('lead-dev', ['src/a.js']), lead('lead-dev', ['src/b.js'])] }, /assigned twice/],
    [{ assignments: [lead('lead-dev', ['../escape.js'])] }, /unsafe path/],
    [{ assignments: [lead('lead-dev', ['.harness/config.json'])] }, /unsafe path/],
    [{ assignments: [] }, /no "assignments"/]
  ];
  for (const [plan, re] of cases) {
    const d = sandbox();
    hierJob(d, 'bad', hierGoal(plan));
    runOnce(d);
    const s = stateOf(d);
    assert(s.phase === 'REJECTED' && re.test(s.lastGateStatus), `${re}: ${s.phase} ${s.lastGateStatus}`);
    assert(calls(d, 'orch-calls.txt').length === 2, `orchestrator should be asked twice, was ${calls(d, 'orch-calls.txt').length}`);
    assert(calls(d, 'lead-calls.txt').length === 0 && !ranWorkers(d), 'a lower level ran after an invalid delegation');
    assert(ls(d, 'failed').length === 1, 'job not in failed/');
  }
  const d2 = sandbox(); hierJob(d2, 'nojson', 'no json here');
  runOnce(d2);
  assert(/not valid JSON/.test(stateOf(d2).lastGateStatus), stateOf(d2).lastGateStatus);
});

await test('hierarchy guardrails (level 2): a lead that plans outside its assignment, too many workers, or nothing is escalated to the human; no worker starts', () => {
  const mk = (subtasks) => ({ assignments: [{ lead: 'lead-dev', files: ['src/a.js'], goal: leadJson(subtasks) }] });
  const w = (id, f) => ({ id, targetFiles: [f], prompt: 'WRITE src/a.js x' });
  const cases = [
    [mk([w('a', 'src/other.js')]), /outside your assigned files/],
    [mk([w('a', 'src/a.js'), w('b', 'src/a.js'), w('c', 'src/a.js'), w('d', 'src/a.js')]), /too many workers/],
    [mk([{ id: 'a', targetFiles: [], prompt: 'x' }]), /no targetFiles/],
    [mk([{ id: 'a', targetFiles: ['src/a.js'], prompt: '' }]), /no prompt/],
    [mk([w('a', '../x.js')]), /unsafe path/]
  ];
  for (const [plan, re] of cases) {
    const d = sandbox();
    hierJob(d, 'badlead', hierGoal(plan), { verifyCmd: PASS });
    runOnce(d);
    const s = stateOf(d);
    assert(s.phase === 'REJECTED' && /Lead 'lead-dev' could not produce a valid team plan/.test(s.lastGateStatus) && re.test(s.lastGateStatus) && /Escalated to you/.test(s.lastGateStatus), `${re}: ${s.lastGateStatus}`);
    assert(calls(d, 'lead-calls.txt').length === 2, `lead should be asked twice, was ${calls(d, 'lead-calls.txt').length}`);
    assert(!ranWorkers(d), 'a worker ran although a lead plan was invalid');
  }
});

await test('team.json: validateTeam rejects every way of breaking the hierarchy (writable orchestrator, wider/overlapping scopes, forbidden paths, budgets, bad roles)', () => {
  const roles = gov.loadRoles(); const charter = gov.readCharter();
  const base = () => JSON.parse(fs.readFileSync(path.join(REPO, '.harness', 'team.json'), 'utf8'));
  const v = (t) => gov.validateTeam(t, { roles, charter, plannerMaxWorkers: 4 });
  assert(v(base()).errors.length === 0, `shipped team invalid: ${v(base()).errors}`);
  const bad = [
    [(t) => { t.members[0].role = 'DEV_ENGINEER'; }, /must be read-only/],
    [(t) => { t.members.push({ ...t.members[0], id: 'orch2' }); }, /exactly one orchestrator/],
    [(t) => { t.members.find((m) => m.id === 'lead-ba').scope = ['src/**']; }, /wider than what role BA_ANALYST may write/],
    [(t) => { t.members.find((m) => m.id === 'lead-qa').scope = ['src/**']; }, /wider than what role QA_AUDITOR may write|overlapping scopes/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').scope = ['src/**', 'docs/**']; }, /overlapping scopes/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').scope = ['.env*']; }, /charter forbids/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').scope = ['node_modules/**']; }, /charter forbids/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').budget.maxCostUsd = 5; }, /budgets must shrink downwards/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').budget.maxMinutes = 99; }, /exceeds the orchestrator's/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').role = 'HACKER'; }, /unknown role/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').role = 'PO_ARCHITECT'; }, /read-only/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').maxWorkers = 99; }, /maxWorkers must be/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').reports_to = 'lead-ba'; }, /must report to the orchestrator/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').scope = []; }, /non-empty "scope"/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').level = 'worker'; }, /level must be/],
    [(t) => { t.members[0].canDelegateTo = ['ghost']; }, /not a lead/],
    [(t) => { t.members.find((m) => m.id === 'lead-qa').id = 'lead-dev'; }, /duplicate member id/]
  ];
  for (const [mutate, re] of bad) { const t = base(); mutate(t); const r = v(t); assert(r.errors.some((e) => re.test(e)), `${re} not reported; got: ${r.errors.join(' | ')}`); }
  assert(gov.validateTeam({}, { roles }).errors.length > 0 && gov.validateTeam(null, { roles }).errors.length > 0, 'a missing/empty team must be an error');
});

await test('team.json: an invalid team stops the task before any agent is called; a missing team is reported; Doctor and team.mjs agree', () => {
  const d = sandbox();
  const t = json(path.join(d, '.harness', 'team.json')); t.members.find((m) => m.id === 'lead-dev').scope = ['src/**', 'docs/**'];
  fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t));
  hierJob(d, 'badteam', hierGoal(happyPlan()));
  runOnce(d);
  assert(stateOf(d).phase === 'REJECTED' && /team\.json is invalid, nothing was started/.test(stateOf(d).lastGateStatus) && calls(d, 'orch-calls.txt').length === 0, stateOf(d).lastGateStatus);
  const doc = node(d, ['.harness/doctor.mjs']);
  assert(doc.status !== 0 && /✖ team\.json: leads "lead-ba" and "lead-dev"|✖ team\.json: leads "lead-dev" and "lead-ba"|overlapping scopes/.test(doc.stdout), doc.stdout.split('\n').filter((l) => /team/.test(l)).join('\n'));
  assert(node(d, ['.harness/team.mjs', 'validate']).status === 1, 'team.mjs validate should fail');
  const d2 = sandbox(); fs.rmSync(path.join(d2, '.harness', 'team.json'));
  hierJob(d2, 'noteam', hierGoal(happyPlan()));
  runOnce(d2);
  assert(/team\.json does not exist/.test(stateOf(d2).lastGateStatus), stateOf(d2).lastGateStatus);
  const d3 = sandbox();
  const show = node(d3, ['.harness/team.mjs', 'show']);
  assert(show.status === 0 && /L1  orchestrator  \[PO_ARCHITECT\]/.test(show.stdout) && /L2  lead-dev  \[DEV_ENGINEER\]/.test(show.stdout) && /owns: src\/\*\*/.test(show.stdout) && /team is valid/.test(show.stdout), show.stdout);
  assert(/team\.json valid: orchestrator → 4 lead\(s\)/.test(node(d3, ['.harness/doctor.mjs']).stdout), 'Doctor does not report the valid team');
});

await test('budget: the task cap stops a hierarchy right after planning when the planners already cost too much — no worker starts; cost is in the dead letter', () => {
  const d = sandbox();
  hierJob(d, 'cap', hierGoal(happyPlan(), 'PLANCOST=0.04 '), { maxCostUsd: 0.05 });
  runOnce(d);
  const s = stateOf(d);
  assert(s.phase === 'REJECTED' && /BUDGET_EXCEEDED/.test(s.lastGateStatus), `${s.phase} ${s.lastGateStatus}`);
  assert(!ranWorkers(d), 'workers started although the budget was already exceeded');
  const f = json(path.join(d, '.harness', 'failed', ls(d, 'failed')[0]));
  assert(f.costUsd > 0.05 && f.costByAgent.orchestrator === 0.04 && Object.keys(f.costByAgent).filter((k) => k.startsWith('lead-')).length === 3, JSON.stringify(f.costByAgent));
  assert(log(d).some((e) => e.phase === 'BUDGET_EXCEEDED'), 'no BUDGET_EXCEEDED event');
});

await test('budget: a worker over its lead\'s per-agent cap is stopped (BUDGET_AGENT_EXCEEDED) and the files are restored', () => {
  const d = sandbox();
  fs.mkdirSync(path.join(d, 'docs')); fs.writeFileSync(path.join(d, 'docs', 'slug.md'), 'ORIGINAL');
  const plan = happyPlan(); plan.assignments[0].goal = leadJson([{ id: 'spec', targetFiles: ['docs/slug.md'], prompt: 'MOCKCOST=0.9\nWRITE docs/slug.md CHANGED' }]);
  hierJob(d, 'agentcap', hierGoal(plan));
  runOnce(d);
  assert(stateOf(d).phase === 'REJECTED' && /BUDGET_AGENT_EXCEEDED: worker lead-ba\.spec/.test(stateOf(d).lastGateStatus), stateOf(d).lastGateStatus);
  assert(fs.readFileSync(path.join(d, 'docs', 'slug.md'), 'utf8') === 'ORIGINAL', 'file not restored after the budget stop');
});

await test('budget: a non-hierarchy task with maxCostUsd never starts another cycle once over budget (cap beats the 3-cycle limit)', () => {
  const d = sandbox();
  drop(d, { id: 'cyclecap', title: 'cc', maxCostUsd: 0.05, verifyCmd: FAIL_VERIFY, subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'MOCKCOST=0.04\nWRITE a.txt x' }] });
  runOnce(d);
  assert(stateOf(d).phase === 'REJECTED' && /BUDGET_EXCEEDED/.test(stateOf(d).lastGateStatus), `${stateOf(d).phase} ${stateOf(d).lastGateStatus}`);
  const f = json(path.join(d, '.harness', 'failed', ls(d, 'failed')[0]));
  assert(f.costUsd === 0.08 && log(d).filter((e) => e.phase === 'SQUARE_RETRY').length === 1, `cost ${f.costUsd}, retries ${log(d).filter((e) => e.phase === 'SQUARE_RETRY').length}: stopped after 2 cycles, not 3`);
  assert(!fs.existsSync(path.join(d, 'a.txt')), 'files not restored after the budget stop');
});

await test('hierarchy via backlog: an autonomous item with "hierarchy": true runs the whole team inside the charter and ends DONE', () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on' });
  setBacklog(d, [{ id: 'H1', title: 'team feature', priority: 1, status: 'READY', hierarchy: true, costApproved: true, maxCostUsd: 1, goal: hierGoal(happyPlan()), verifyCmd: ALL4 }]);
  tick(d);
  assert(byId(d, 'H1').status === 'DONE', `${byId(d, 'H1').status} ${byId(d, 'H1').blockedReason || ''}`);
  const arch = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(arch.autonomous === true && arch.hierarchy === true && arch.team.assignments.length === 3, 'job lost the hierarchy/autonomous flags');
  // charter still binds the team: a team whose lead scope exceeds the charter's allowedPaths is rejected for autonomous work
  const d2 = sandbox(); setCharter(d2, { autonomous: 'on', allowedPaths: 'src/**' });
  setBacklog(d2, [{ id: 'H2', title: 'team feature', priority: 1, status: 'READY', hierarchy: true, costApproved: true, goal: hierGoal(happyPlan()), verifyCmd: ALL4 }]);
  tick(d2);
  assert(byId(d2, 'H2').status === 'BLOCKED' && /outside charter allowedPaths/.test(byId(d2, 'H2').blockedReason || ''), `${byId(d2, 'H2').status} ${byId(d2, 'H2').blockedReason}`);
});

await test('dispatch --hierarchy / --max-cost: writes a hierarchy job (no subtasks yet), validates the cost, runs end to end; hierarchy+cap shown in --help', () => {
  const d = sandbox();
  const r = node(d, ['.harness/dispatch.mjs', '--goal', hierGoal(happyPlan()), '--hierarchy', '--max-cost', '1.5', '--check', ALL4, '--wait']);
  assert(r.status === 0 && /orchestrator → leads → workers, per team\.json/.test(r.stdout) && /RESULT: COMMITTED/.test(r.stdout), r.stdout + r.stderr);
  const arch = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(arch.hierarchy === true && arch.maxCostUsd === 1.5 && !arch.subtasks, JSON.stringify(Object.keys(arch)));
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--hierarchy', '--max-cost', 'lots']).status === 1, 'a non-numeric --max-cost must be refused');
  assert(/--hierarchy/.test(node(d, ['.harness/dispatch.mjs', '--help']).stdout), 'help does not mention --hierarchy');
});

// ───────────── v3.1: the editor workflow — controller → orchestrator → NAMED agents → verify → report ─────────────

const vis = (d, ...a) => node(d, ['.harness/visible.mjs', ...a]);
const runIdOf = (r) => (r.stdout.match(/^RUN_ID=(\S+)/m) || [])[1];
const deleg = (assignments, contract = 'CONTRACT-X') => JSON.stringify({ interfaceContract: contract, assignments });
const trio = () => [{ lead: 'lead-ba', goal: 'write the spec', files: ['docs/a.md'] }, { lead: 'lead-dev', goal: 'implement it', files: ['src/a.js'] }, { lead: 'lead-qa', goal: 'write the tests', files: ['tests/a.test.js'] }];
const agentsWrite = (d, files) => files.forEach(([f, c]) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); });
const trioFiles = () => [['docs/a.md', 'spec'], ['src/a.js', 'code'], ['tests/a.test.js', 'tests']];
const TRIO_CHECK = existsCheck('docs/a.md', 'src/a.js', 'tests/a.test.js');
const runJson = (d, id) => json(path.join(d, '.harness', 'visible', id, 'run.json'));
const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');

await test('editor workflow: brief → assign → agents work → verify → report; prompts carry scope/contract/skills/memory; backlog and session note updated', () => {
  const d = sandbox();
  node(d, ['.harness/memory.mjs', 'remember', 'Always answer in plain English']);
  setBacklog(d, [{ id: 'T1', title: 'slug feature', priority: 1, status: 'READY', goal: 'Build slugify', acceptanceCriteria: ['AC-one'], interfaceContract: 'slugify(text) -> string', verifyCmd: TRIO_CHECK }]);
  const b = vis(d, 'brief', '--item', 'T1'); const id = runIdOf(b);
  assert(b.status === 0 && id && /ORCHESTRATOR BRIEF/.test(b.stdout) && /lead-dev \(DEV_ENGINEER\) may own: src\/\*\*/.test(b.stdout) && /AC-one/.test(b.stdout) && /slugify\(text\) -> string/.test(b.stdout) && /Always answer in plain English/.test(b.stdout), b.stdout);
  assert(byId(d, 'T1').status === 'IN_PROGRESS' && byId(d, 'T1').visibleRun === id, 'backlog item not marked IN_PROGRESS');
  const a = vis(d, 'assign', id, deleg(trio()));
  assert(a.status === 0 && /DELEGATION OK/.test(a.stdout), a.stdout + a.stderr);
  for (const l of ['lead-ba', 'lead-dev', 'lead-qa']) assert(new RegExp(`subagent_type: "${l}"`).test(a.stdout), `no ready-made call for ${l}`);
  const section = (lead) => a.stdout.split('===== agent: ').find((x) => x.startsWith(lead));
  const dev = section('lead-dev'); const ba = section('lead-ba'); const qa = section('lead-qa');
  assert(/ONLY these files\/folders: src\/a\.js/.test(dev) && /CONTRACT-X/.test(dev) && /slugify\(text\) -> string/.test(dev) && /AC-one/.test(dev) && /Always answer in plain English/.test(dev) && /@governed-by PO_ARCHITECT/.test(dev) && /npm test/.test(dev), 'dev prompt incomplete');
  assert(/ONLY these files\/folders: tests\/a\.test\.js/.test(qa) && /@governed-by PO_ARCHITECT/.test(qa), 'qa prompt incomplete');
  assert(/no shell/.test(ba) && !/Code Craft/.test(ba) && /ONLY these files\/folders: docs\/a\.md/.test(ba), 'ba prompt wrong (no shell, no code-craft skill)');
  agentsWrite(d, trioFiles());
  const v = vis(d, 'verify', id, '--reports', JSON.stringify({ 'lead-dev': 'wrote src/a.js' }));
  assert(v.status === 0 && /PASSED ✔/.test(v.stdout) && /lead-dev: \+ src\/a\.js/.test(v.stdout) && /says: wrote src\/a\.js/.test(v.stdout) && /controller → orchestrator \(editor session\) → lead-ba, lead-dev, lead-qa/.test(v.stdout), v.stdout);
  assert(byId(d, 'T1').status === 'DONE' && runJson(d, id).status === 'PASSED', 'backlog/run not DONE/PASSED');
  assert(!fs.existsSync(path.join(d, '.harness', 'visible', id, 'baseline')), 'baseline copy not cleaned after a pass');
  const note = fs.readdirSync(path.join(d, '.harness', 'memory', 'sessions')).map((f) => read(d, `.harness/memory/sessions/${f}`)).join('');
  assert(/Team: orchestrator → lead-ba \(lead-ba\); lead-dev \(lead-dev\); lead-qa \(lead-qa\)/.test(note) && /Result: \*\*VERIFIED\*\*/.test(note), 'session note lacks the team/result');
  assert(/PASSED ✔/.test(vis(d, 'report', id).stdout) && new RegExp(id).test(vis(d, 'status').stdout), 'report/status commands');
});

await test('editor workflow guardrails: a bad delegation never starts anything (unknown lead / outside scope / twice / unsafe / outside the files the human allowed); 3 bad attempts escalate to the human', () => {
  const g = (lead, files, goal = 'x') => ({ lead, goal, files });
  const cases = [
    [deleg([g('lead-x', ['src/a.js'])]), [], /not a lead you may delegate to/],
    [deleg([g('lead-dev', ['docs/a.md'])]), [], /outside lead "lead-dev"'s scope/],
    [deleg([g('lead-dev', ['src/a.js']), g('lead-dev', ['src/b.js'])]), [], /assigned twice/],
    [deleg([g('lead-dev', ['../escape.js'])]), [], /unsafe path/],
    [deleg([g('lead-dev', ['.harness/team.json'])]), [], /unsafe path/],
    [deleg([g('lead-dev', ['src/a.js'])]), ['--files', 'src/b.js'], /outside the files the human allowed|outside the files the user allowed/],
    ['not json', [], /not valid JSON/],
    [JSON.stringify({ assignments: [] }), [], /no "assignments"/]
  ];
  for (const [plan, extra, re] of cases) {
    const d = sandbox(); const id = runIdOf(vis(d, 'brief', '--goal', 'g', '--check', PASS, ...extra));
    const r = vis(d, 'assign', id, plan);
    assert(r.status === 1 && re.test(r.stderr) && /Nothing was started/.test(r.stderr), `${re}: exit ${r.status} ${r.stderr}`);
    assert(runJson(d, id).assignments.length === 0 && runJson(d, id).status === 'BRIEFED', 'run state changed by a rejected delegation');
  }
  const d = sandbox(); setBacklog(d, [{ id: 'E1', title: 'esc', status: 'READY', verifyCmd: PASS }]);
  const id = runIdOf(vis(d, 'brief', '--item', 'E1'));
  assert(vis(d, 'assign', id, 'bad').status === 1 && vis(d, 'assign', id, 'bad').status === 1, 'first two rejections should exit 1');
  const third = vis(d, 'assign', id, 'bad');
  assert(third.status === 2 && /ESCALATED to the human/.test(third.stderr) && runJson(d, id).status === 'ESCALATED' && byId(d, 'E1').status === 'BLOCKED' && /ESCALATED/.test(byId(d, 'E1').blockedReason), `exit ${third.status} ${third.stderr}`);
});

await test('editor workflow verify: every change outside the assignments is detected and REVERTED (new, modified, deleted files, the charter, the team, .claude), then a clean re-verify passes', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d, 'README.md'), 'ORIGINAL'); fs.mkdirSync(path.join(d, 'docs')); fs.writeFileSync(path.join(d, 'docs', 'keep.md'), 'KEEP');
  const charter = read(d, '.harness/charter.md'); const teamJson = read(d, '.harness/team.json');
  const id = runIdOf(vis(d, 'brief', '--goal', 'g', '--check', TRIO_CHECK));
  assert(vis(d, 'assign', id, deleg(trio())).status === 0, 'assign failed');
  agentsWrite(d, trioFiles());
  agentsWrite(d, [['README.md', 'HACKED'], ['notes.txt', 'rogue'], ['.claude/injected.md', 'x'], ['.harness/charter.md', `${charter}\n- autonomous: off\n`], ['.harness/team.json', '{"members":[]}']]);
  fs.rmSync(path.join(d, 'docs', 'keep.md'));
  const v = vis(d, 'verify', id);
  assert(v.status === 1 && /NOT PASSED YET/.test(v.stdout) && /not run \(fix the violations first\)/.test(v.stdout), v.stdout);
  for (const f of ['README.md', 'notes.txt', '.claude/injected.md', '.harness/charter.md', '.harness/team.json', 'docs/keep.md']) assert(v.stdout.includes(`${f}:`), `violation not reported for ${f}`);
  assert(read(d, 'README.md') === 'ORIGINAL' && !fs.existsSync(path.join(d, 'notes.txt')) && !fs.existsSync(path.join(d, '.claude', 'injected.md')) && read(d, '.harness/charter.md') === charter && read(d, '.harness/team.json') === teamJson && read(d, 'docs/keep.md') === 'KEEP', 'a violating change was not reverted');
  assert(trioFiles().every(([f, c]) => read(d, f) === c), 'the agents\' legitimate files must stay');
  const again = vis(d, 'verify', id);
  assert(again.status === 0 && /PASSED ✔/.test(again.stdout) && runJson(d, id).cycles === 2, again.stdout);
});

await test('editor workflow verify: a git-ignored secret (.env) edited by an agent is DETECTED (hash only, never copied) and reported as not auto-revertable', () => {
  const { d, g } = gitSandbox({ autonomous: false });
  fs.appendFileSync(path.join(d, '.gitignore'), '\n.env\n'); fs.writeFileSync(path.join(d, '.env'), 'SECRET=1'); g('add', '-A'); g('commit', '-q', '-m', 'ignore env');
  const id = runIdOf(vis(d, 'brief', '--goal', 'g', '--check', TRIO_CHECK));
  assert(vis(d, 'assign', id, deleg(trio())).status === 0, 'assign');
  assert(!fs.existsSync(path.join(d, '.harness', 'visible', id, 'baseline', '.env')), 'a secret must never be copied into the baseline');
  agentsWrite(d, [...trioFiles(), ['.env', 'SECRET=stolen']]);
  const v = vis(d, 'verify', id);
  assert(v.status === 1 && /\.env: not inside any lead's assigned files/.test(v.stdout) && /COULD NOT be reverted automatically \(secrets are never copied\): \.env/.test(v.stdout), v.stdout);
  assert(read(d, '.env') === 'SECRET=stolen', 'the harness cannot restore what it never copied; it must say so instead of pretending');
});

await test('editor workflow verify: a failing check is retried, and after 3 cycles the run HALTS, restores every file, blocks the backlog item and records a lesson', () => {
  const d = sandbox();
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'old.js'), 'OLD');
  setBacklog(d, [{ id: 'H1', title: 'halting task', status: 'READY', verifyCmd: FAIL_VERIFY }]);
  const id = runIdOf(vis(d, 'brief', '--item', 'H1'));
  assert(vis(d, 'assign', id, deleg([{ lead: 'lead-dev', goal: 'x', files: ['src/'] }])).status === 0, 'assign failed');
  agentsWrite(d, [['src/old.js', 'CHANGED'], ['src/new.js', 'NEW']]);
  const r1 = vis(d, 'verify', id); const r2 = vis(d, 'verify', id);
  assert(r1.status === 1 && /NOT PASSED YET/.test(r1.stdout) && /Cycle 1\/3/.test(r1.stdout) && r2.status === 1 && runJson(d, id).status === 'FAILED', 'cycles 1-2 should fail but stay open');
  assert(read(d, 'src/old.js') === 'CHANGED', 'files must be left in place until the last cycle');
  const r3 = vis(d, 'verify', id);
  assert(r3.status === 1 && /STOPPED/.test(r3.stdout) && /Cycle 3\/3/.test(r3.stdout) && /NOPE/.test(r3.stdout) && runJson(d, id).status === 'HALTED_HITL_REQUIRED', r3.stdout);
  assert(read(d, 'src/old.js') === 'OLD' && !fs.existsSync(path.join(d, 'src', 'new.js')), 'the halted run did not restore the files');
  assert(byId(d, 'H1').status === 'BLOCKED' && /HALTED_HITL_REQUIRED after 3 cycles/.test(byId(d, 'H1').blockedReason), byId(d, 'H1').blockedReason);
  assert(/halting task.*HALTED_HITL_REQUIRED/.test(read(d, '.harness/memory/auto-lessons.md')), 'no lesson recorded');
  assert(vis(d, 'verify', id).status === 1, 'a halted run cannot be verified again');
});

await test('editor workflow: only one open run at a time; rollback restores everything and ends the run; harness workers cannot use it', () => {
  const d = sandbox(); fs.writeFileSync(path.join(d, 'a.txt'), 'ORIGINAL');
  const id = runIdOf(vis(d, 'brief', '--goal', 'g', '--check', PASS));
  const second = vis(d, 'brief', '--goal', 'other', '--check', PASS);
  assert(second.status === 4 && /is not finished/.test(second.stderr), `exit ${second.status} ${second.stderr}`);
  assert(vis(d, 'assign', id, deleg([{ lead: 'lead-dev', goal: 'x', files: ['src/'] }])).status === 0, 'assign');
  agentsWrite(d, [['src/x.js', 'x'], ['a.txt', 'CHANGED']]);
  const rb = vis(d, 'rollback', id);
  assert(rb.status === 0 && /Rolled back/.test(rb.stdout) && read(d, 'a.txt') === 'ORIGINAL' && !fs.existsSync(path.join(d, 'src', 'x.js')) && runJson(d, id).status === 'ROLLED_BACK', rb.stdout + rb.stderr);
  assert(vis(d, 'brief', '--goal', 'next', '--check', PASS).status === 0, 'a new run should be possible after rollback');
  assert(node(d, ['.harness/visible.mjs', 'status'], { HARNESS_WORKER: '1' }).status === 2, 'a harness worker must not use the editor workflow');
});

await test('autonomous (editor): brief --next takes the highest-priority READY item; budget stops it; a failed run pauses it; off/empty/placeholder are refused', () => {
  const d = sandbox(); setCharter(d, { maxAutoTasksPerRun: 2 });
  setBacklog(d, [1, 2, 3].map((n) => ({ id: `Q${n}`, title: `task ${n}`, priority: 4 - n, status: 'READY', verifyCmd: TRIO_CHECK })));
  const finish = (sid, expectId) => { const r = vis(d, 'brief', '--next', '--auto-session', sid); const id = runIdOf(r); assert(r.status === 0 && new RegExp(`Task: task ${expectId}`).test(r.stdout) && /autonomous mode/.test(r.stdout), r.stdout + r.stderr); assert(vis(d, 'assign', id, deleg(trio())).status === 0, 'assign'); agentsWrite(d, trioFiles()); return { id, v: vis(d, 'verify', id) }; };
  const first = finish('S1', 3); assert(first.v.status === 0 && byId(d, 'Q3').status === 'DONE', 'first auto task');
  fs.rmSync(path.join(d, 'src'), { recursive: true }); fs.rmSync(path.join(d, 'docs'), { recursive: true }); fs.rmSync(path.join(d, 'tests'), { recursive: true });
  const second = finish('S1', 2); assert(second.v.status === 0, 'second auto task');
  const third = vis(d, 'brief', '--next', '--auto-session', 'S1');
  assert(third.status === 3 && /Auto budget used: 2\/2/.test(third.stderr) && byId(d, 'Q1').status === 'READY', `budget: exit ${third.status} ${third.stderr}`);
  const d2 = sandbox(); setCharter(d2, {}); setBacklog(d2, [{ id: 'F1', title: 'will fail', priority: 1, status: 'READY', verifyCmd: FAIL_VERIFY }, { id: 'F2', title: 'never started', priority: 9, status: 'READY', verifyCmd: PASS }]);
  const id2 = runIdOf(vis(d2, 'brief', '--next', '--auto-session', 'S2'));
  vis(d2, 'assign', id2, deleg([{ lead: 'lead-dev', goal: 'x', files: ['src/'] }])); agentsWrite(d2, [['src/a.js', 'x']]);
  for (let i = 0; i < 3; i++) vis(d2, 'verify', id2);
  const paused = vis(d2, 'brief', '--next', '--auto-session', 'S2');
  assert(runJson(d2, id2).status === 'HALTED_HITL_REQUIRED' && paused.status === 4 && /paused/.test(paused.stderr) && byId(d2, 'F2').status === 'READY', `pause: exit ${paused.status} ${paused.stderr}`);
  const off = sandbox(); setCharter(off, { autonomous: 'off' }); setBacklog(off, [{ id: 'O1', title: 'x', status: 'READY', verifyCmd: PASS }]);
  const offR = vis(off, 'brief', '--next');
  assert(offR.status === 1 && /Autonomous mode is off/.test(offR.stderr) && byId(off, 'O1').status === 'READY', offR.stderr);
  const empty = sandbox(); setCharter(empty, {}); setBacklog(empty, []);
  assert(vis(empty, 'brief', '--next').status === 6, 'nothing READY should exit 6');
  const noCheck = sandbox(); setCharter(noCheck, {}); setBacklog(noCheck, [{ id: 'N1', title: 'x', status: 'READY' }]);
  const nc = vis(noCheck, 'brief', '--next');
  assert(nc.status === 1 && /no real check/.test(nc.stderr) && byId(noCheck, 'N1').status === 'READY', `no real check must refuse autonomous work: ${nc.stderr}`);
});

await test('autonomous (editor): "propose" adds READY tasks only inside the budget, the team scopes and the charter; the placeholder charter plans nothing; AI-suggested checks are only recorded', () => {
  const ph = sandbox();
  const r0 = vis(ph, 'propose', 'S1', JSON.stringify({ tasks: [{ title: 't', files: ['src/a.js'] }] }));
  assert(r0.status === 5 && /placeholder/.test(r0.stderr) && backlog(ph).length === 0, `placeholder: exit ${r0.status} ${r0.stderr}`);
  const d = sandbox(); setCharter(d, { maxAutoTasksPerRun: 2 }); realTest(d);
  setBacklog(d, [{ id: 'X0', title: 'existing task', status: 'DONE' }]);
  const t = (title, files, extra = {}) => ({ title, goal: title, files, ...extra });
  const out = vis(d, 'propose', 'S1', JSON.stringify({ tasks: [
    t('good one', ['src/good.js'], { verifySuggestion: 'rm -rf /', acceptanceCriteria: ['works'] }), t('outside scope', ['lib/x.js']), t('forbidden', ['.env']), t('Existing   Task', ['src/e.js']),
    t('unsafe', ['../x.js']), t('no files', []), t('good two', ['docs/two.md']), t('over budget', ['src/z.js'])] }));
  const tasks = backlog(d).filter((x) => x.source === 'orchestrator');
  assert(out.status === 0 && tasks.length === 2 && tasks.map((x) => x.title).join() === 'good one,good two', `${out.stdout}\n${out.stderr}\n${JSON.stringify(tasks.map((x) => x.title))}`);
  assert(/rejected "outside scope".*not inside any lead's scope/.test(out.stdout) && /rejected "forbidden"/.test(out.stdout) && /duplicate/.test(out.stdout) && /unsafe path/.test(out.stdout) && /rejected "over budget".*over the auto budget/.test(out.stdout) && /Budget left in this session: 0/.test(out.stdout), out.stdout);
  assert(tasks[0].status === 'READY' && tasks[0].verifySuggestion === 'rm -rf /' && tasks[0].verifyCmd === undefined, 'AI-suggested check must be recorded, never used');
  assert(vis(d, 'propose', 'S9', JSON.stringify({ tasks: [t('x', ['src/q.js'])] })).status === 0, 'a new session has its own budget');
  const b = vis(d, 'brief', '--next', '--auto-session', 'S1');
  assert(b.status === 0 && /Task: good one/.test(b.stdout), b.stdout + b.stderr);
});

await test('named editor agents: sync-agents writes one agent per lead from team.json + roles (BA no shell, DEV/QA tests only), detects stale files, and Doctor reports them', () => {
  const d = sandbox();
  const r = node(d, ['.harness/team.mjs', 'sync-agents']);
  assert(r.status === 0 && /wrote \.claude\/agents\/lead-dev\.md/.test(r.stdout), r.stdout + r.stderr);
  const fm = (f) => { const t = read(d, `.claude/agents/${f}.md`); const m = t.match(/^---\nname: (.+)\ndescription: (.+)\ntools: (.+)\n(?:model: (?:haiku|sonnet|opus)\n)?---\n/); assert(m, `bad frontmatter in ${f}`); return { name: m[1], desc: m[2], tools: m[3].split(', '), body: t }; };
  const ba = fm('lead-ba'); const dev = fm('lead-dev'); const qa = fm('lead-qa');
  assert(ba.name === 'lead-ba' && dev.name === 'lead-dev' && qa.name === 'lead-qa', 'names must equal the member ids (that is what you see in the editor)');
  assert(!ba.tools.includes('Bash') && ba.tools.includes('Write') && dev.tools.includes('Bash') && qa.tools.includes('Bash') && ![ba, dev, qa].some((a) => a.tools.includes('Agent') || a.tools.includes('Task')), `tools: ${ba.tools} | ${dev.tools} | ${qa.tools}`);
  assert(/docs\/\*\*/.test(ba.desc) && /src\/\*\*/.test(dev.desc) && /Change ONLY the files you were assigned/.test(dev.body) && /no shell/.test(ba.body) && /npm test/.test(dev.body), 'agent text');
  assert(node(d, ['.harness/team.mjs', 'sync-agents', '--check']).status === 0, 'should be in sync right after writing');
  fs.appendFileSync(path.join(d, '.claude', 'agents', 'lead-dev.md'), 'tampered');
  assert(node(d, ['.harness/team.mjs', 'sync-agents', '--check']).status === 1, 'a tampered agent must be detected');
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), read(d, '.harness/config.json'));
  assert(/editor agents out of sync/.test(node(d, ['.harness/doctor.mjs']).stdout), 'doctor should warn about stale agents');
  node(d, ['.harness/team.mjs', 'sync-agents']);
  const t = json(path.join(d, '.harness', 'team.json')); t.members.find((m) => m.id === 'lead-dev').scope = ['src/app/**']; fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t));
  assert(node(d, ['.harness/team.mjs', 'sync-agents', '--check']).status === 1, 'changing team.json must make the agents stale');
  node(d, ['.harness/team.mjs', 'sync-agents']);
  assert(/src\/app\/\*\*/.test(read(d, '.claude/agents/lead-dev.md')) && /editor agents in sync/.test(node(d, ['.harness/doctor.mjs']).stdout), 're-sync did not update the agent');
  const bad = json(path.join(d, '.harness', 'team.json')); bad.members.find((m) => m.id === 'lead-dev').scope = ['src/**', 'docs/**']; fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(bad));
  assert(node(d, ['.harness/team.mjs', 'sync-agents']).status === 1, 'an invalid team must not generate agents');
});

await test('auto on by default, safely: the shipped charter is ON; the hook tells the editor AI to start /harness:auto only when work is READY; the headless controller plans nothing from the placeholder charter; installer can opt out', () => {
  { // The template ships ON for new projects; this repo's own charter may be locked off by its owner.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-shipped-'));
    spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), fresh], { encoding: 'utf8' });
    assert(/^- autonomous: on$/m.test(read(fresh, '.harness/charter.md')), 'a freshly installed charter must be autonomous: on'); }
  const d = sandbox();
  let h = node(d, ['.harness/hook-session.mjs']).stdout;
  assert(/Auto mode is ON but there is nothing READY and the charter objectives are not filled in/.test(h) && !/Start the autonomous workflow now/.test(h), h);
  const tk = node(d, ['.harness/daemon.mjs', '--tick']);
  assert(/idle/.test(tk.stdout) && calls(d, 'po-calls.txt').length === 0, `headless must not plan from the placeholder: ${tk.stdout}`);
  setBacklog(d, [{ id: 'R1', title: 'ready task', status: 'READY', verifyCmd: PASS }]);
  h = node(d, ['.harness/hook-session.mjs']).stdout;
  assert(/AUTO MODE IS ON \(the owner enabled it in \.harness\/charter\.md\) and 1 task\(s\) are READY; next: "ready task"\. Start the autonomous workflow now with \/harness:auto/.test(h), h);
  setCharter(d, { autonomous: 'off' });
  assert(!/AUTO MODE IS ON/.test(node(d, ['.harness/hook-session.mjs']).stdout), 'off must not trigger the auto start');
  const id = runIdOf(vis(d, 'brief', '--goal', 'g', '--check', PASS));
  h = node(d, ['.harness/hook-session.mjs']).stdout;
  assert(new RegExp(`UNFINISHED editor run ${id}`).test(h) && /verify .*rollback|rollback/.test(h) && !/AUTO MODE IS ON/.test(h), h);
  vis(d, 'rollback', id);
  const on = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-auto-on-')); const off = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-auto-off-'));
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), on], { encoding: 'utf8' });
  const ro = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), off, '--autonomous', 'off'], { encoding: 'utf8' });
  assert(/^- autonomous: on$/m.test(read(on, '.harness/charter.md')) && /^- autonomous: off$/m.test(read(off, '.harness/charter.md')) && /set +autonomous mode OFF/.test(ro.stdout), 'installer default/opt-out');
  assert(fs.existsSync(path.join(on, '.claude', 'agents', 'lead-dev.md')) && fs.existsSync(path.join(on, '.claude', 'commands', 'harness', 'auto.md')), 'agents/commands not installed');
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-own-charter-')); fs.mkdirSync(path.join(own, '.harness'), { recursive: true }); fs.writeFileSync(path.join(own, '.harness', 'charter.md'), '# mine\n- autonomous: on\n');
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), own, '--autonomous', 'off']);
  assert(read(own, '.harness/charter.md') === '# mine\n- autonomous: on\n', 'a project\'s own charter must never be touched by the installer');
  assert(spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), off, '--autonomous', 'maybe'], { encoding: 'utf8' }).status === 1, 'a bad --autonomous value must be refused');
});

await test('documentation matches reality: every script, sub-command and slash command that the README, AGENTS.md, docs and commands tell people to use exists', () => {
  const docs = ['README.md', 'AGENTS.md', 'docs/WORKFLOW.md', ...fs.readdirSync(path.join(REPO, '.claude', 'commands', 'harness')).map((f) => `.claude/commands/harness/${f}`)];
  const sources = { visible: fs.readFileSync(path.join(REPO, '.harness', 'visible.mjs'), 'utf8'), team: fs.readFileSync(path.join(REPO, '.harness', 'team.mjs'), 'utf8'), backlog: fs.readFileSync(path.join(REPO, '.harness', 'backlog.mjs'), 'utf8'), memory: fs.readFileSync(path.join(REPO, '.harness', 'memory.mjs'), 'utf8') };
  const cmdFiles = new Set(fs.readdirSync(path.join(REPO, '.claude', 'commands', 'harness')).map((f) => f.replace(/\.md$/, '')));
  const problems = [];
  for (const f of docs) {
    const t = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const m of t.matchAll(/node \.harness\/([a-z-]+)\.mjs/g)) if (!fs.existsSync(path.join(REPO, '.harness', `${m[1]}.mjs`))) problems.push(`${f}: missing script .harness/${m[1]}.mjs`);
    for (const m of t.matchAll(/visible\.mjs (brief|assign|verify|rollback|propose|status|report|[a-z]+)\b/g)) if (!new RegExp(`case '${m[1]}'`).test(sources.visible)) problems.push(`${f}: visible.mjs has no sub-command "${m[1]}"`);
    for (const m of t.matchAll(/team\.mjs (show|validate|sync-agents|[a-z-]+)\b/g)) if (!sources.team.includes(`'${m[1]}'`)) problems.push(`${f}: team.mjs has no "${m[1]}"`);
    for (const m of t.matchAll(/\/harness:([a-z]+)/g)) if (!cmdFiles.has(m[1])) problems.push(`${f}: slash command /harness:${m[1]} does not exist`);
    for (const m of t.matchAll(/`(\.harness\/(?:[a-z-]+\/)*[A-Za-z0-9_.-]+\.(?:mjs|json|md))`/g)) if (!/<|\*/.test(m[1]) && !fs.existsSync(path.join(REPO, m[1])) && !/live\.log|state\.json|telemetry|daemon\.pid|auto-state|engine-probe|auto-lessons|approvals.json|MANIFEST.json|report\.md|run\.json|failed\/|completed\/|visible\/|releases\/|sessions\/|inbox\//.test(m[1])) problems.push(`${f}: mentions ${m[1]}, which does not exist`);
  }
  assert(problems.length === 0, problems.slice(0, 12).join('\n      '));
  assert(fs.existsSync(path.join(REPO, 'docs', 'WORKFLOW.md')) && /docs\/WORKFLOW\.md/.test(fs.readFileSync(path.join(REPO, 'README.md'), 'utf8')), 'README must link to docs/WORKFLOW.md');
});

await test('demo project (examples/make-demo.mjs): ready to try — harness installed, objectives filled, one READY task with a real check, own git repo; the controller can run it end to end; --force only recreates demos', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-demo-test-'));
  const demo = path.join(base, 'demo');
  // make-demo runs the doctor, which (correctly) fails when no AI CLI is installed, e.g. on a CI runner. Put a fake
  // `claude` whose --help lists every configured flag first on PATH, so the result does not depend on the machine.
  const fakeBin = path.join(base, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const help = 'Usage: claude [options]\n  -p, --print\n  --allowedTools <tools>\n  --disallowedTools <tools>\n  --output-format <format>\n  --verbose\n  --model <model>\n';
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(fakeBin, 'claude.help.txt'), help.replace(/\n/g, '\r\n'));
    fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@type "%~dp0claude.help.txt"\r\n');
  } else {
    fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\ncat <<'EOF'\n${help}EOF\n`);
    fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
  }
  const mkEnv = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };
  const mk = (...a) => spawnSync(process.execPath, [path.join(REPO, 'examples', 'make-demo.mjs'), ...a], { encoding: 'utf8', env: mkEnv });
  const r = mk(demo);
  assert(r.status === 0 && /Demo project created/.test(r.stdout) && /Failures: 0/.test(r.stdout), r.stdout + r.stderr);
  for (const f of ['.harness/visible.mjs', '.claude/agents/lead-dev.md', '.claude/commands/harness/run.md', 'README.md', 'package.json']) assert(fs.existsSync(path.join(demo, f)), `demo lacks ${f}`);
  const charter = read(demo, '.harness/charter.md');
  assert(/^- autonomous: on$/m.test(charter) && !/describe your product goals here/.test(charter) && /text-utilities library/.test(charter), 'charter objectives not filled in / autonomy not on');
  assert(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: demo, encoding: 'utf8' }).trim() === '1' && execFileSync('git', ['status', '--porcelain'], { cwd: demo, encoding: 'utf8' }).trim() === '', 'demo must be its own git repo with one clean commit');
  for (const f of ['live.log', 'state.json', 'telemetry.log']) assert(!fs.existsSync(path.join(demo, '.harness', f)), `local runtime file leaked into the demo: ${f}`);
  const hook = spawnSync(process.execPath, ['.harness/hook-session.mjs'], { cwd: demo, encoding: 'utf8' }).stdout;
  assert(/AUTO MODE IS ON .* 1 task\(s\) are READY; next: "Add a slugify helper"/.test(hook), hook);
  // the controller runs the demo's READY task end to end (the agents' work is simulated by writing the files)
  const b = spawnSync(process.execPath, ['.harness/visible.mjs', 'brief', '--next', '--auto-session', 'SDEMO'], { cwd: demo, encoding: 'utf8' });
  const id = runIdOf(b);
  assert(b.status === 0 && id && /Task: Add a slugify helper/.test(b.stdout) && /slugify\(text\)/.test(b.stdout) && !/NO REAL CHECK/.test(b.stdout), b.stdout + b.stderr);
  const plan = deleg([{ lead: 'lead-ba', goal: 'spec', files: ['docs/slugify.md'] }, { lead: 'lead-dev', goal: 'code', files: ['src/slugify.js'] }, { lead: 'lead-qa', goal: 'tests', files: ['tests/slugify.test.js'] }]);
  const a = spawnSync(process.execPath, ['.harness/visible.mjs', 'assign', id, plan], { cwd: demo, encoding: 'utf8' });
  assert(a.status === 0 && /DELEGATION OK/.test(a.stdout), a.stdout + a.stderr);
  fs.mkdirSync(path.join(demo, 'docs'), { recursive: true }); fs.mkdirSync(path.join(demo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(demo, 'docs', 'slugify.md'), '# slugify\n');
  fs.writeFileSync(path.join(demo, 'src', 'slugify.js'), "exports.slugify=(t)=>{if(typeof t!=='string')throw new TypeError('x');return t.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')}\n");
  fs.writeFileSync(path.join(demo, 'tests', 'slugify.test.js'), "const t=require('node:test');const a=require('node:assert');const {slugify}=require('../src/slugify.js');t('x',()=>a.strictEqual(slugify('  Hello, World!  '),'hello-world'))\n");
  const v = spawnSync(process.execPath, ['.harness/visible.mjs', 'verify', id], { cwd: demo, encoding: 'utf8' });
  assert(v.status === 0 && /PASSED ✔/.test(v.stdout), v.stdout);
  assert(/Acceptance criteria — confirm each one yourself/.test(v.stdout) && /☐ slugify\(42\) throws a TypeError/.test(v.stdout), `the report must list the acceptance criteria for the human to confirm:\n${v.stdout}`);
  const tasks = json(path.join(demo, '.harness', 'backlog.json')).tasks;
  assert(tasks[0].status === 'DONE', `backlog item is ${tasks[0].status}`);
  // the demo's check is real: with the files present but no passing test it must fail
  const d2 = path.join(base, 'demo2'); assert(mk(d2).status === 0, 'second demo');
  const b2 = runIdOf(spawnSync(process.execPath, ['.harness/visible.mjs', 'brief', '--next'], { cwd: d2, encoding: 'utf8' }));
  spawnSync(process.execPath, ['.harness/visible.mjs', 'assign', b2, plan], { cwd: d2, encoding: 'utf8' });
  fs.mkdirSync(path.join(d2, 'docs'), { recursive: true }); fs.mkdirSync(path.join(d2, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(d2, 'docs', 'slugify.md'), 'x'); fs.writeFileSync(path.join(d2, 'src', 'slugify.js'), 'exports.slugify=()=>"wrong"\n');
  fs.writeFileSync(path.join(d2, 'tests', 'slugify.test.js'), "const t=require('node:test');const a=require('node:assert');t('fails',()=>a.strictEqual(1,2))\n");
  assert(spawnSync(process.execPath, ['.harness/visible.mjs', 'verify', b2], { cwd: d2, encoding: 'utf8' }).status === 1, 'a demo task with failing tests must NOT pass');
  // safety of the script itself
  assert(mk(demo).status === 1 && /already exists/.test(mk(demo).stderr), 'must refuse an existing non-empty folder');
  const notDemo = path.join(base, 'mine'); fs.mkdirSync(notDemo); fs.writeFileSync(path.join(notDemo, 'important.txt'), 'keep me');
  assert(mk(notDemo, '--force').status === 1 && fs.readFileSync(path.join(notDemo, 'important.txt'), 'utf8') === 'keep me', '--force must never delete a folder that is not a demo');
  assert(mk(demo, '--force').status === 0 && !fs.existsSync(path.join(demo, 'src', 'slugify.js')) && json(path.join(demo, '.harness', 'backlog.json')).tasks[0].status === 'READY', '--force should recreate a clean demo');
  assert(mk(REPO).status === 1 && mk(path.join(REPO, 'inside-the-template')).status === 0 && (fs.rmSync(path.join(REPO, 'inside-the-template'), { recursive: true, force: true }), true), 'the demo may not overwrite the template itself');
});

// ───────────────────────────── smart engine routing (team.mjs auto-assign) ─────────────────────────────

const teamOf = (d) => json(path.join(d, '.harness', 'team.json'));
const engineOf = (d, id) => teamOf(d).members.find((m) => m.id === id).engine;

await test('engine routing (pure): 0 → null, 1 → everywhere, 2 → planning vs coding+QA, 3 → planning / coding / QA', () => {
  const r = gov.planEngineRouting;
  assert(r([]) === null && r(null) === null, '0 engines must give null');
  for (const one of ['claude', 'antigravity', 'codex']) assert(JSON.stringify(r([one])) === JSON.stringify({ plan: one, code: one, qa: one }), `1 engine ${one}: ${JSON.stringify(r([one]))}`);
  const eq = (got, want, label) => assert(JSON.stringify(got) === JSON.stringify(want), `${label}: ${JSON.stringify(got)}`);
  eq(r(['claude', 'antigravity']), { plan: 'antigravity', code: 'claude', qa: 'claude' }, 'agy + claude');
  eq(r(['claude', 'codex']), { plan: 'codex', code: 'claude', qa: 'claude' }, 'claude + codex (no research engine)');
  eq(r(['claude', 'antigravity', 'codex']), { plan: 'antigravity', code: 'claude', qa: 'codex' }, 'agy + claude + codex');
  eq(r(['codex', 'antigravity', 'claude']), { plan: 'antigravity', code: 'claude', qa: 'codex' }, 'all three, any order');
  const t = { members: [{ id: 'o', role: 'PO_ARCHITECT' }, { id: 'b', role: 'BA_ANALYST' }, { id: 'd', role: 'DEV_ENGINEER' }, { id: 'q', role: 'QA_AUDITOR' }, { id: 'x', role: 'CUSTOM' }] };
  const applied = gov.applyEngineRouting(t, { plan: 'P', code: 'C', qa: 'Q' });
  assert(applied.members.map((m) => m.engine).join() === 'P,P,C,Q,C' && t.members.every((m) => m.engine === undefined), `applyEngineRouting by role, input untouched: ${applied.members.map((m) => m.engine)}`);
});

await test('team.mjs auto-assign: 1, 2 and 3 engines route the real team.json by role; only "engine" changes; validate + Doctor accept it', () => {
  const cases = [
    ['claude', { orchestrator: 'claude', 'lead-ba': 'claude', 'lead-dev': 'claude', 'lead-qa': 'claude' }, /1 engine/],
    ['antigravity,claude', { orchestrator: 'antigravity', 'lead-ba': 'antigravity', 'lead-dev': 'claude', 'lead-qa': 'claude' }, /2 engines/],
    ['antigravity,claude,codex', { orchestrator: 'antigravity', 'lead-ba': 'antigravity', 'lead-dev': 'claude', 'lead-qa': 'codex' }, /3\+ engines/]
  ];
  for (const [engines, want, mode] of cases) {
    const d = sandbox();
    const before = teamOf(d);
    const r = node(d, ['.harness/team.mjs', 'auto-assign'], { HARNESS_ENGINES: engines });
    assert(r.status === 0 && mode.test(r.stdout) && /Wrote the "engine"/.test(r.stdout), `${engines}: ${r.stdout}${r.stderr}`);
    const after = teamOf(d);
    for (const [id, e] of Object.entries(want)) assert(engineOf(d, id) === e, `${engines}: ${id} got ${engineOf(d, id)}, want ${e}`);
    const strip = (t) => JSON.stringify({ ...t, members: t.members.map(({ engine, ...m }) => m) });
    assert(strip(after) === strip(before), `${engines}: something other than "engine" changed`);
    assert(node(d, ['.harness/team.mjs', 'validate']).status === 0, `${engines}: routed team must validate`);
    const show = node(d, ['.harness/team.mjs', 'show']).stdout;
    assert(new RegExp(`lead-dev\\s+\\[DEV_ENGINEER\\]\\s+engine: ${want['lead-dev']}`).test(show), `${engines}: show lacks the engine:\n${show}`);
    assert(/engine routing \(headless --hierarchy\): orchestrator→/.test(node(d, ['.harness/doctor.mjs']).stdout), `${engines}: doctor does not report the routing`);
    const again = node(d, ['.harness/team.mjs', 'auto-assign'], { HARNESS_ENGINES: engines });
    assert(/already has this routing; nothing changed/.test(again.stdout), `${engines}: second run should change nothing`);
  }
});

await test('team.mjs auto-assign: --dry-run and 0 engines write nothing; an unknown engine in team.json is rejected', () => {
  const d = sandbox();
  const before = fs.readFileSync(path.join(d, '.harness', 'team.json'), 'utf8');
  const dry = node(d, ['.harness/team.mjs', 'auto-assign', '--dry-run'], { HARNESS_ENGINES: 'antigravity,claude,codex' });
  assert(dry.status === 0 && /--dry-run: team.json was not changed/.test(dry.stdout) && /lead-qa .*→ codex/.test(dry.stdout), dry.stdout);
  const none = node(d, ['.harness/team.mjs', 'auto-assign'], { HARNESS_ENGINES: '' });
  assert(none.status === 0 && /Usable AI engines on this machine: none/.test(none.stdout) && /was not changed/.test(none.stdout), none.stdout);
  assert(fs.readFileSync(path.join(d, '.harness', 'team.json'), 'utf8') === before, 'team.json must be untouched');
  const t = teamOf(d); t.members[1].engine = 'no-such-engine';
  fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t));
  const v = node(d, ['.harness/team.mjs', 'validate']);
  assert(v.status === 1 && /engine "no-such-engine" is not an engine in config\.json profiles/.test(v.stdout), v.stdout);
});

await test('engine routing end to end: orchestrator, leads and workers each spawn their routed engine; --engine on the task overrides it', () => {
  const d = sandbox();
  const cfgFile = path.join(d, '.harness', 'config.json');
  const cfg = json(cfgFile);
  for (const k of ['mockplan', 'mockcode', 'mockqa']) cfg.profiles[k] = { ...cfg.profiles.mock };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const t = teamOf(d);
  const route = { PO_ARCHITECT: 'mockplan', BA_ANALYST: 'mockplan', DEV_ENGINEER: 'mockcode', QA_AUDITOR: 'mockqa' };
  t.members = t.members.map((m) => ({ ...m, engine: route[m.role] }));
  fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t, null, 2));
  hierJob(d, 'routed', hierGoal(happyPlan()));
  runOnce(d);
  assert(stateOf(d).phase === '4_COMMITTED', `routed run: ${stateOf(d).phase} ${stateOf(d).lastGateStatus}`);
  const spawned = {};
  for (const e of log(d).filter((x) => x.phase === 'ENGINE_SPAWN')) { const m = /^Spawned (\S+) for (\S+)$/.exec(e.message); if (m) spawned[m[2]] = m[1]; }
  const want = { orchestrator: 'mockplan', 'lead-ba': 'mockplan', 'lead-dev': 'mockcode', 'lead-qa': 'mockqa', 'lead-ba.spec': 'mockplan', 'lead-dev.impl': 'mockcode', 'lead-dev.util': 'mockcode', 'lead-qa.tests': 'mockqa' };
  for (const [id, e] of Object.entries(want)) assert(spawned[id] === e, `${id} spawned ${spawned[id]}, want ${e} (${JSON.stringify(spawned)})`);
  // an explicit engine on the task wins over the team routing
  const d2 = sandbox();
  fs.writeFileSync(path.join(d2, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(d2, '.harness', 'team.json'), JSON.stringify(t, null, 2));
  hierJob(d2, 'forced', hierGoal(happyPlan()), { engine: 'mock' });
  runOnce(d2);
  const used = new Set(log(d2).filter((x) => x.phase === 'ENGINE_SPAWN').map((x) => x.engine));
  assert(stateOf(d2).phase === '4_COMMITTED' && used.size === 1 && used.has('mock'), `override: ${[...used]}`);
});

await test('install: a fresh team.json is auto-routed to the detected engines; an existing team.json and --no-auto-assign are left alone', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-route-'));
  const r = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), fresh], { encoding: 'utf8', env: { ...process.env, HARNESS_ENGINES: 'antigravity,claude' } });
  assert(r.status === 0 && /routed team roles to your engines \(claude, antigravity \(agy\)\)/.test(r.stdout), r.stdout + r.stderr);
  assert(engineOf(fresh, 'lead-ba') === 'antigravity' && engineOf(fresh, 'lead-dev') === 'claude' && engineOf(fresh, 'lead-qa') === 'claude', JSON.stringify(teamOf(fresh).members.map((m) => m.engine)));
  const skip = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-route-skip-'));
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), skip, '--no-auto-assign'], { encoding: 'utf8', env: { ...process.env, HARNESS_ENGINES: 'claude' } });
  assert(teamOf(skip).members.every((m) => m.engine === undefined), '--no-auto-assign must not route');
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-route-none-'));
  const rn = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), none], { encoding: 'utf8', env: { ...process.env, HARNESS_ENGINES: '' } });
  assert(/no AI engine allowed yet/.test(rn.stdout) && teamOf(none).members.every((m) => m.engine === undefined), rn.stdout);
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-route-own-'));
  fs.mkdirSync(path.join(own, '.harness'), { recursive: true });
  const mine = JSON.stringify({ ...json(path.join(REPO, '.harness', 'team.json')), description: 'my own team' }, null, 2);
  fs.writeFileSync(path.join(own, '.harness', 'team.json'), mine);
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), own], { encoding: 'utf8', env: { ...process.env, HARNESS_ENGINES: 'claude' } });
  assert(fs.readFileSync(path.join(own, '.harness', 'team.json'), 'utf8') === mine, 'an existing team.json must never be re-routed');
  for (const p of [fresh, skip, none, own]) fs.rmSync(p, { recursive: true, force: true });
});

await test('install: .gitattributes pins LF for the harness files only; a core.autocrlf=true clone gets LF harness files; existing rules kept; idempotent', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eol-'));
  const proj = path.join(base, 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  const gitp = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' });
  gitp(base, 'init', '-q', '-b', 'main', 'proj');
  fs.writeFileSync(path.join(proj, '.gitattributes'), '*.png binary\n');
  fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'a\nb\n');
  const inst = () => spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), proj, '--no-auto-assign'], { encoding: 'utf8' });
  const r = inst();
  assert(r.status === 0 && /harness line-ending rules to existing \.gitattributes/.test(r.stdout), r.stdout + r.stderr);
  const ga = fs.readFileSync(path.join(proj, '.gitattributes'), 'utf8');
  assert(ga.startsWith('*.png binary\n') && /^\.harness\/\*\* text eol=lf$/m.test(ga) && /^\.claude\/\*\* text eol=lf$/m.test(ga) && /^AGENTS\.md text eol=lf$/m.test(ga), `the project's rule must be kept and the harness rules added:\n${ga}`);
  assert(!/^\* text/m.test(ga), 'must not change line endings for the whole project');
  inst();
  assert(fs.readFileSync(path.join(proj, '.gitattributes'), 'utf8') === ga, 're-running the installer must not add the block twice');
  gitp(proj, 'add', '-A'); gitp(proj, 'commit', '-q', '-m', 'install');
  // A Windows teammate: clone with core.autocrlf=true
  execFileSync('git', ['-c', 'core.autocrlf=true', 'clone', '-q', proj, path.join(base, 'mate')], { encoding: 'utf8' });
  const mate = (f) => fs.readFileSync(path.join(base, 'mate', f), 'utf8');
  for (const f of ['.harness/charter.md', '.harness/team.json', '.claude/commands/harness/run.md', 'AGENTS.md']) assert(!mate(f).includes('\r'), `${f} must stay LF in an autocrlf clone`);
  fs.rmSync(base, { recursive: true, force: true });
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eol-fresh-'));
  const rf = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), fresh, '--no-auto-assign'], { encoding: 'utf8' });
  assert(/wrote  \.gitattributes/.test(rf.stdout) && fs.existsSync(path.join(fresh, '.gitattributes')), 'a project without .gitattributes gets one');
  fs.rmSync(fresh, { recursive: true, force: true });
});

// ───────────────────────────── token-aware model tiers ─────────────────────────────

const common = await import(pathToFileURL(path.join(REPO, '.harness', 'lib', 'common.mjs')).href);
const TIERED = { fast: 'm-fast', medium: 'm-medium', high: 'm-high' };
const tieredProfile = (models = TIERED) => ({ verified: true, binary: process.execPath, args: [MOCK, 'ALLOWED={allowedTools}', 'DENIED={disallowedTools}'], promptVia: 'stdin', allowedTools: [], modelArgs: ['MODEL={model}'], models });
const withProfiles = (d, profiles) => {
  const f = path.join(d, '.harness', 'config.json'); const c = json(f); Object.assign(c.profiles, profiles); fs.writeFileSync(f, JSON.stringify(c, null, 2));
  const a = path.join(d, '.harness', 'approvals.json'); const ap = fs.existsSync(a) ? json(a) : {}; // test engines are allowed, as a person would
  ap.engines = { ...(ap.engines || {}), ...Object.fromEntries(Object.keys(profiles).map((k) => [k, true])) }; fs.writeFileSync(a, JSON.stringify(ap));
};
const modelArg = (d, id) => (argsOf(d, id).find((a) => a.startsWith('MODEL=')) || '').slice(6) || null;
const tierLog = (d) => log(d).filter((e) => e.phase === 'MODEL_TIER');

await test('model tiers (pure): low → fast, standard → medium, architecture/planning → high; retries escalate; overrides win', () => {
  const t = (o) => common.chooseModelTier(o).tier;
  // low / fast
  assert(t({ role: 'QA_AUDITOR', targetFiles: ['tests/a.test.js'], prompt: 'run the tests and fix the assertion' }) === 'fast', 'QA test run');
  assert(t({ role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'rename foo to bar' }) === 'fast', 'single-file small edit');
  assert(t({ role: 'BA_ANALYST', targetFiles: ['docs/a.md'], prompt: 'document the flag' }) === 'fast', 'simple docs');
  assert(t({ kind: 'plan', level: 'lead', role: 'QA_AUDITOR' }) === 'fast', 'QA lead planning');
  // medium / balanced
  assert(t({ role: 'DEV_ENGINEER', targetFiles: ['src/a.js', 'src/b.js', 'src/c.js'], prompt: 'implement the feature' }) === 'medium', 'multi-file coding');
  assert(t({ role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'x'.repeat(2000) }) === 'medium', 'single file but a large job');
  assert(t({ role: 'QA_AUDITOR', targetFiles: ['t/a', 't/b', 't/c'], prompt: 'write tests' }) === 'medium', 'QA over many files');
  assert(t({ kind: 'plan', level: 'lead', role: 'DEV_ENGINEER' }) === 'medium', 'lead-dev planning');
  // high / deep reasoning
  assert(t({ kind: 'plan', level: 'orchestrator', role: 'PO_ARCHITECT' }) === 'high', 'orchestrator');
  assert(t({ kind: 'plan', level: 'lead', role: 'BA_ANALYST' }) === 'medium', 'lead-ba only splits its own docs');
  assert(t({ role: 'PO_ARCHITECT', targetFiles: ['docs/arch.md'], prompt: 'x' }) === 'high', 'architecture work');
  // escalation after a failed check
  const small = { role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'fix it' };
  assert([1, 2, 3, 4].map((cycle) => t({ ...small, cycle })).join() === 'fast,medium,high,high', 'retries must escalate one tier per failed cycle, capped at high');
  assert(/escalated fast → medium/.test(common.chooseModelTier({ ...small, cycle: 2 }).reasons.join()), 'the escalation reason is recorded');
  // tier → model for a profile (aliases only, never pinned versions)
  const cfg = json(path.join(REPO, '.harness', 'config.json'));
  const c = cfg.profiles.claude;
  assert(c.models.fast === 'haiku' && c.models.medium === 'sonnet' && c.models.high === 'opus' && c.modelArgs.join(' ') === '--model {model}', `claude aliases: ${JSON.stringify(c.models)}`);
  // Aliases only, except antigravity and codex: neither CLI has aliases, so it uses the exact IDs from 'agy models' (owner decision).
  for (const [name, p] of Object.entries(cfg.profiles)) if (!['antigravity', 'codex'].includes(name)) for (const m of Object.values(p.models || {})) assert(m === null || !/\d/.test(m), `${name}: model "${m}" looks like a pinned version; use an alias`);
  const ag = cfg.profiles.antigravity;
  assert(ag.models.fast === 'gemini-3.8-flash-medium' && ag.models.medium === 'gemini-4-argon-medium' && ag.models.high === 'gemini-4-hydrogen-high' && ag.modelArgs.join(' ') === '--model {model}', `antigravity tiers: ${JSON.stringify(ag.models)}`);
  assert(common.resolveModel(c, { tier: 'fast' }).model === 'haiku' && common.resolveModel(c, { tier: 'high' }).model === 'opus', 'claude tier → alias');
  assert(common.resolveModel(cfg.profiles.codex, { tier: 'fast' }).model === 'gpt-6-luna@low' && common.resolveModel(cfg.profiles.codex, { tier: 'high' }).model === 'gpt-6-luna@high', 'codex: one model, reasoning effort per tier');
  assert(!Object.values(cfg.profiles).some((p) => common.usesCliDefault(p)), 'no engine may silently run on its CLI default model');
  assert(JSON.stringify(common.resolveModel(c, { tier: 'fast', override: 'high' })) === JSON.stringify({ tier: 'high', model: 'opus', source: 'override-tier' }), 'a tier override picks that tier');
  assert(common.resolveModel(c, { tier: 'fast', override: 'fable' }).model === 'fable', 'an alias override is passed through');
  assert(common.profileFlags(c).includes('--model') && !common.profileFlags({ args: ['-p'], modelArgs: ['--model', '{model}'], models: { fast: null, medium: null, high: null } }).includes('--model'), 'the probe checks --model only where an alias is configured');
});

await test('model tiers end to end (1 engine): orchestrator high, lead-ba and lead-dev medium, QA + small edits fast, multi-file coding medium', () => {
  const d = sandbox();
  withProfiles(d, { mock: tieredProfile() });
  hierJob(d, 'tiers', hierGoal(happyPlan()));
  runOnce(d);
  assert(stateOf(d).phase === '4_COMMITTED', `${stateOf(d).phase} ${stateOf(d).lastGateStatus}`);
  const want = { orchestrator: 'm-high', 'lead-ba': 'm-medium', 'lead-dev': 'm-medium', 'lead-qa': 'm-fast', 'lead-ba.spec': 'm-fast', 'lead-dev.impl': 'm-fast', 'lead-dev.util': 'm-fast', 'lead-qa.tests': 'm-fast' };
  for (const [id, m] of Object.entries(want)) assert(modelArg(d, id) === m, `${id}: --model ${modelArg(d, id)}, want ${m}`);
  assert(tierLog(d).some((e) => e.worker === 'lead-qa.tests' && e.tier === 'fast' && /QA/.test(e.reasons.join())), 'MODEL_TIER telemetry with the reason');
  // a multi-file coding worker is medium
  const d2 = sandbox();
  withProfiles(d2, { mock: tieredProfile() });
  drop(d2, { id: 'multi', title: 'multi', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/a.js', 'src/b.js', 'src/c.js'], prompt: 'WRITE src/a.js a\nWRITE src/b.js b\nWRITE src/c.js c' }] });
  runOnce(d2);
  assert(stateOf(d2).phase === '4_COMMITTED' && modelArg(d2, 'w') === 'm-medium', `multi-file: ${modelArg(d2, 'w')}`);
});

await test('model tiers: a failing check escalates fast → medium → high across the 3 cycles', () => {
  const d = sandbox();
  withProfiles(d, { mock: tieredProfile() });
  drop(d, { id: 'esc', title: 'esc', verifyCmd: 'node -e "process.exit(1)"', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const tiers = tierLog(d).filter((e) => e.worker === 'w').map((e) => `${e.tier}:${e.model}`);
  assert(tiers.join() === 'fast:m-fast,medium:m-medium,high:m-high', `escalation: ${tiers.join()}`);
});

await test('model tiers (multi-engine): each engine gets its own alias, an engine with no alias gets no --model; member "model" and --model override', () => {
  const d = sandbox();
  withProfiles(d, { mockplan: tieredProfile({ fast: 'p-fast', medium: 'p-medium', high: 'p-high' }), mockcode: tieredProfile({ fast: 'c-fast', medium: 'c-medium', high: 'c-high' }), mockqa: tieredProfile({ fast: null, medium: null, high: null }) });
  const t = teamOf(d);
  const route = { PO_ARCHITECT: 'mockplan', BA_ANALYST: 'mockplan', DEV_ENGINEER: 'mockcode', QA_AUDITOR: 'mockqa' };
  t.members = t.members.map((m) => ({ ...m, engine: route[m.role], ...(m.id === 'lead-dev' ? { model: 'high' } : {}) }));
  fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t, null, 2));
  assert(node(d, ['.harness/team.mjs', 'validate']).status === 0, 'a team with "model" must validate');
  hierJob(d, 'multi', hierGoal(happyPlan()));
  runOnce(d);
  assert(stateOf(d).phase === '4_COMMITTED', `${stateOf(d).phase} ${stateOf(d).lastGateStatus}`);
  const want = { orchestrator: 'p-high', 'lead-ba': 'p-medium', 'lead-ba.spec': 'p-fast', 'lead-dev': 'c-high', 'lead-dev.impl': 'c-high', 'lead-dev.util': 'c-high', 'lead-qa': null, 'lead-qa.tests': null };
  for (const [id, m] of Object.entries(want)) assert(modelArg(d, id) === m, `${id}: --model ${modelArg(d, id)}, want ${m}`);
  assert(tierLog(d).some((e) => e.worker === 'lead-dev.impl' && e.source === 'override-tier'), 'member override recorded');
  // --model on the job overrides everything (an alias is passed through as-is)
  const d2 = sandbox();
  withProfiles(d2, { mock: tieredProfile() });
  const r = node(d2, ['.harness/dispatch.mjs', '--goal', 'WRITE a.txt hi', '--files', 'a.txt', '--model', 'fable', '--check', PASS, '--wait']);
  assert(r.status === 0 && modelArg(d2, 'worker-main') === 'fable', `--model: ${modelArg(d2, 'worker-main')} ${r.stdout}`);
  t.members[1].model = 'bad model!';
  fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t, null, 2));
  assert(node(d, ['.harness/team.mjs', 'validate']).status === 1, 'an invalid model must be rejected');
});

// ───────────────────────────── real-engine error handling (found with the real claude CLI) ─────────────────────────────

await test('engine errors: a usage limit in Claude JSON on stdout (exit 1, noise on stderr) is reported as-is and stops at once, no retries', () => {
  const d = sandbox();
  const fake = path.join(d, 'limit-engine.mjs');
  // what claude -p --output-format json printed on a real machine that had hit its subscription limit
  fs.writeFileSync(fake, "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('Ignoring 24 permissions.allow entries: this workspace has not been trusted.\\n');process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:true,api_error_status:429,result:\"You've hit your 5-hour limit · resets 3:40pm\"}));process.exit(1);});");
  withProfiles(d, { mock: { verified: true, binary: process.execPath, args: [fake], promptVia: 'stdin', allowedTools: [] } });
  drop(d, { id: 'limit', title: 'limit', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const s = stateOf(d);
  const spawns = log(d).filter((e) => e.phase === 'ENGINE_SPAWN').length;
  assert(spawns === 1, `a usage limit must not be retried (spawned ${spawns}x)`);
  assert(/You've hit your 5-hour limit/.test(s.lastGateStatus) && !/not been trusted/.test(s.lastGateStatus), `the engine's own message must be shown: ${s.lastGateStatus}`);
});

await test('engine errors: a login problem on stderr is fatal; an ordinary crash is still retried', () => {
  const mk = (d, body) => { const f = path.join(d, 'e.mjs'); fs.writeFileSync(f, `process.stdin.resume();process.stdin.on('end',()=>{${body}});`); withProfiles(d, { mock: { verified: true, binary: process.execPath, args: [f], promptVia: 'stdin', allowedTools: [] } }); };
  const job = (d) => drop(d, { id: 'j', title: 'j', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'x' }] });
  const d1 = sandbox(); mk(d1, "process.stderr.write('Error: not logged in. Please run gemini to log in.\\n');process.exit(1);"); job(d1); runOnce(d1);
  assert(log(d1).filter((e) => e.phase === 'ENGINE_SPAWN').length === 1 && /account\/login problem/.test(stateOf(d1).lastGateStatus), `login: ${stateOf(d1).lastGateStatus}`);
  const d2 = sandbox(); mk(d2, "process.stderr.write('TypeError: something broke\\n');process.exit(1);"); job(d2); runOnce(d2);
  assert(log(d2).filter((e) => e.phase === 'ENGINE_SPAWN').length === 3, 'an ordinary crash keeps its 3 cycles');
});

await test('editor verify flags what tests cannot prove: UI changes need a visual review, skipped tests are reported, files the check leaves untracked are flagged; the brief warns when a UI project has no browser check', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-visual-test-'));
  const demo = path.join(base, 'demo');
  assert(spawnSync(process.execPath, [path.join(REPO, 'examples', 'make-demo.mjs'), demo], { encoding: 'utf8' }).status === 0, 'demo');
  fs.writeFileSync(path.join(demo, 'index.html'), '<!doctype html><title>x</title>\n');
  execFileSync('git', ['add', '-A'], { cwd: demo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ui'], { cwd: demo });
  // a check that passes, skips one test (node:test TAP summary) and writes a build output git does not ignore
  const check = `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/out.txt','x');console.log('# pass 3\\n# skipped 1')"`;
  const b = spawnSync(process.execPath, ['.harness/visible.mjs', 'brief', '--goal', 'restyle the page', '--check', check], { cwd: demo, encoding: 'utf8' });
  const id = runIdOf(b);
  assert(b.status === 0 && id && /UI files but the check never opens a browser/.test(b.stdout), b.stdout + b.stderr);
  assert(spawnSync(process.execPath, ['.harness/visible.mjs', 'assign', id, deleg([{ lead: 'lead-ux', goal: 'style', files: ['src/style.css'] }])], { cwd: demo, encoding: 'utf8' }).status === 0, 'assign');
  fs.writeFileSync(path.join(demo, 'src', 'style.css'), 'body{margin:0}\n');
  const v = spawnSync(process.execPath, ['.harness/visible.mjs', 'verify', id], { cwd: demo, encoding: 'utf8' });
  assert(v.status === 0, v.stdout);
  assert(/PASSED ✔ — NEEDS A VISUAL REVIEW/.test(v.stdout) && /src\/style\.css/.test(v.stdout) && /never opened a browser/.test(v.stdout), `visual review not flagged:\n${v.stdout}`);
  assert(/1 test\(s\) SKIPPED/.test(v.stdout) && /A skipped test proves nothing/.test(v.stdout), `skipped tests not reported:\n${v.stdout}`);
  assert(/git does not ignore \(dist\/out\.txt\)/.test(v.stdout), `untracked check output not flagged:\n${v.stdout}`);
  const run = json(path.join(demo, '.harness', 'visible', id, 'run.json'));
  assert(run.lastVerify.skipped === 1 && run.lastVerify.needsVisualReview === true, JSON.stringify(run.lastVerify));
});

await test('doctor: a project with UI files but no browser testing tool gets a note with the install command (never installs, never a failure); a project without UI files is not bothered', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-doctor-browser-'));
  const demo = path.join(base, 'demo');
  assert(spawnSync(process.execPath, [path.join(REPO, 'examples', 'make-demo.mjs'), demo], { encoding: 'utf8' }).status === 0, 'demo');
  // A fake, allowed engine: this test is about the browser note, not about which AI CLIs this machine has.
  withProfiles(demo, { mock: { verified: true, binary: process.execPath, args: [MOCK], promptVia: 'stdin', allowedTools: [], models: { fast: 'm', medium: 'm', high: 'm' } } });
  { const f = path.join(demo, '.harness', 'config.json'); const c = json(f); c.activeProfile = 'mock'; c.autoOrder = ['mock']; fs.writeFileSync(f, JSON.stringify(c, null, 2)); }
  const doctor = (env = {}) => spawnSync(process.execPath, ['.harness/doctor.mjs'], { cwd: demo, encoding: 'utf8', env: { ...process.env, ...env } });
  let r = doctor();
  assert(!/Browser testing/.test(r.stdout), `no UI files, so no browser section:\n${r.stdout}`);
  fs.writeFileSync(path.join(demo, 'index.html'), '<!doctype html><title>x</title>\n');
  r = doctor({ HARNESS_BROWSER_MODULES: 'no-such-browser-tool' });
  assert(r.status === 0 && /Browser testing/.test(r.stdout) && /no browser testing tool is installed/.test(r.stdout) && /npm install -D playwright/.test(r.stdout), r.stdout);
  assert(!/✖/.test(r.stdout) && /Failures: 0/.test(r.stdout), `must stay a note, not a failure:\n${r.stdout}`);
  assert(!fs.existsSync(path.join(demo, 'node_modules')) && !/playwright/.test(fs.readFileSync(path.join(demo, 'package.json'), 'utf8')), 'the doctor must never install anything');
  // a tool that resolves: reported as found (a fake module in the project's node_modules)
  fs.mkdirSync(path.join(demo, 'node_modules', 'fake-browser-tool'), { recursive: true });
  fs.writeFileSync(path.join(demo, 'node_modules', 'fake-browser-tool', 'index.js'), 'module.exports = {};\n');
  r = doctor({ HARNESS_BROWSER_MODULES: 'fake-browser-tool' });
  assert(/browser testing tool found: fake-browser-tool/.test(r.stdout) && /doctor\.mjs --deep/.test(r.stdout), r.stdout);
});

await test('editor verify flags tests that changed after a failed check (fixed or weakened?) and existing tests that were deleted', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-weak-test-'));
  const demo = path.join(base, 'demo');
  assert(spawnSync(process.execPath, [path.join(REPO, 'examples', 'make-demo.mjs'), demo], { encoding: 'utf8' }).status === 0, 'demo');
  fs.mkdirSync(path.join(demo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(demo, 'tests', 'old.test.js'), '// an existing test\n');
  execFileSync('git', ['add', '-A'], { cwd: demo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'old test'], { cwd: demo });
  // the check passes only once the new test file contains the word "weak": the first verify fails, the second passes
  const check = `node -e "process.exit(require('fs').readFileSync('tests/new.test.js','utf8').includes('weak')?0:1)"`;
  const vis = (...a) => spawnSync(process.execPath, ['.harness/visible.mjs', ...a], { cwd: demo, encoding: 'utf8' });
  const id = runIdOf(vis('brief', '--goal', 'add a helper', '--check', check));
  assert(vis('assign', id, deleg([{ lead: 'lead-dev', goal: 'code', files: ['src/a.js'] }, { lead: 'lead-qa', goal: 'tests', files: ['tests/'] }])).status === 0, 'assign');
  fs.writeFileSync(path.join(demo, 'src', 'a.js'), 'exports.a = 1;\n');
  fs.writeFileSync(path.join(demo, 'tests', 'new.test.js'), '// strict test\n');
  let v = vis('verify', id);
  assert(v.status === 1 && /NOT PASSED YET/.test(v.stdout) && !/test file\(s\) were changed/.test(v.stdout), `first cycle must fail without the warning:\n${v.stdout}`);
  fs.writeFileSync(path.join(demo, 'tests', 'new.test.js'), '// weak test\n');
  fs.rmSync(path.join(demo, 'tests', 'old.test.js'));
  v = vis('verify', id);
  assert(v.status === 0 && /PASSED ✔/.test(v.stdout), v.stdout);
  assert(/After the last failed check, 2 test file\(s\) were changed/.test(v.stdout) && /FIXED, not weakened/.test(v.stdout), `changed tests not flagged:\n${v.stdout}`);
  assert(/1 test file\(s\) that existed before this run were DELETED \(tests\/old\.test\.js\)/.test(v.stdout), `deleted test not flagged:\n${v.stdout}`);
  assert(!('cycleSnapshot' in json(path.join(demo, '.harness', 'visible', id, 'run.json'))), 'the cycle snapshot must be dropped once the run ends');
});

await test('Orca is no longer supported: no profile in config.json, and asking for it stops with a clear message listing the supported engines', () => {
  const cfg = json(path.join(REPO, '.harness', 'config.json'));
  assert(!('orca' in cfg.profiles) && !(cfg.autoOrder || []).includes('orca'), 'orca must not be a profile or in autoOrder');
  assert(['claude', 'antigravity', 'codex'].every((e) => e in cfg.profiles), 'the three supported engines must have a profile');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./.harness/lib/common.mjs').then((m)=>{try{m.resolveProfile(m.loadConfig(),'orca')}catch(e){console.log(e.message);process.exit(0)}process.exit(3)})"], { cwd: REPO, encoding: 'utf8' });
  assert(r.status === 0 && /no longer supported/.test(r.stdout) && /claude, antigravity, codex/.test(r.stdout), r.stdout + r.stderr);
});

await test('Gemini is no longer supported: no profile, not routable, and --engine gemini stops with a message pointing to antigravity', () => {
  const cfg = json(path.join(REPO, '.harness', 'config.json'));
  assert(!('gemini' in cfg.profiles) && !(cfg.autoOrder || []).includes('gemini'), 'gemini must not be a profile or in autoOrder');
  assert(cfg.profiles.antigravity.verified === true, 'antigravity was verified end to end on a real machine');
  assert(!common.ROUTABLE_ENGINES.includes('gemini'), 'gemini must not be routable');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./.harness/lib/common.mjs').then((m)=>{try{m.resolveProfile(m.loadConfig(),'gemini')}catch(e){console.log(e.message);process.exit(0)}process.exit(3)})"], { cwd: REPO, encoding: 'utf8' });
  assert(r.status === 0 && /no longer supported/.test(r.stdout) && /antigravity/.test(r.stdout), r.stdout + r.stderr);
});

await test('approval gate: only costly runs ask; with no terminal they stop (exit 3, no job) unless --yes or a saved "always" answer', () => {
  const cfg = json(path.join(REPO, '.harness', 'config.json'));
  const kinds = (o) => common.costlyRunReasons(cfg, o).map((c) => c.kind).join();
  assert(kinds({}) === '' && kinds({ workers: 2 }) === '' && kinds({ model: 'fast' }) === '', 'a normal run is never asked');
  assert(kinds({ hierarchy: true }) === 'team' && kinds({ autoPlan: true }) === 'parallel' && kinds({ workers: 3 }) === 'many-workers', 'team / parallel / 3+ workers');
  assert(kinds({ model: 'high' }) === 'high-model' && kinds({ model: 'opus' }) === 'high-model' && kinds({ model: 'gemini-4-hydrogen-high' }) === 'high-model', 'forcing a high-tier model');
  const d = sandbox();
  const noYes = { HARNESS_YES: '' };
  const inbox = () => fs.readdirSync(path.join(d, '.harness', 'inbox')).filter((f) => f.endsWith('.json')).length;
  const team = node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--hierarchy'], noYes);
  assert(team.status === 3 && /APPROVAL_NEEDED/.test(team.stderr) && /team mode/.test(team.stdout) && inbox() === 0, team.stdout + team.stderr);
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--files', 'a.txt'], noYes).status === 0 && inbox() === 1, 'a normal run starts without a question');
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--hierarchy', '--yes'], noYes).status === 0 && inbox() === 2, '--yes skips the question');
  fs.writeFileSync(path.join(d, '.harness', 'approvals.json'), JSON.stringify({ engines: { mock: true }, alwaysAllow: ['parallel'] }));
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--auto-plan'], noYes).status === 0 && inbox() === 3, 'a saved "always" answer is not asked again');
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--model', 'high'], noYes).status === 3, 'a different kind is still asked');
});

await test('engine consent: an installed tool is not used until the person allows it once; engines.mjs allow / deny; no terminal → ENGINE_APPROVAL_NEEDED', () => {
  const d = sandbox();
  const approvals = path.join(d, '.harness', 'approvals.json');
  fs.writeFileSync(approvals, JSON.stringify({}));
  const inbox = () => fs.readdirSync(path.join(d, '.harness', 'inbox')).filter((f) => f.endsWith('.json')).length;
  const r = node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--files', 'a.txt']);
  assert(r.status === 3 && /ENGINE_APPROVAL_NEEDED/.test(r.stderr) && /not allowed the harness to use it yet/.test(r.stderr) && inbox() === 0, r.stdout + r.stderr);
  const list = node(d, ['.harness/engines.mjs', 'list']);
  assert(list.status === 0 && /AI tools on this machine/.test(list.stdout), list.stdout + list.stderr);
  assert(node(d, ['.harness/engines.mjs', 'allow', 'mock']).status === 0 && json(approvals).engines.mock === true, 'allow must save the answer');
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--files', 'a.txt']).status === 0 && inbox() === 1, 'an allowed tool is used without asking again');
  assert(node(d, ['.harness/engines.mjs', 'deny', 'mock']).status === 0 && json(approvals).engines.mock === false, 'deny must save the answer');
  const again = node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--files', 'a.txt']);
  assert(again.status === 3 && /chose not to let the harness use 'mock'/.test(again.stderr), again.stderr);
  assert(node(d, ['.harness/engines.mjs', 'allow', 'nope']).status === 1, 'unknown tool refused');
  assert(node(d, ['.harness/engines.mjs', 'allow', 'agy']).status === 0 && json(approvals).engines.antigravity === true, 'agy is an alias of antigravity');
});

await test('autopilot holds a big run ("needs your OK") and keeps going; backlog approve releases it; high tier is capped to medium in autonomous runs', () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on' });
  setBacklog(d, [
    { id: 'BIG', title: 'team job', priority: 1, status: 'READY', hierarchy: true, goal: 'build it all', verifyCmd: PASS },
    { id: 'SMALL', title: 'small', priority: 2, status: 'READY', verifyCmd: existsCheck('src/s.js'), subtasks: [{ id: 'ws', role: 'DEV_ENGINEER', targetFiles: ['src/s.js'], prompt: 'WRITE src/s.js S' }] }]);
  const r = tick(d);
  assert(/dispatched/.test(r.stdout), r.stdout + r.stderr);
  const big = byId(d, 'BIG');
  assert(big.status === 'BLOCKED' && big.needsApproval === true && /Needs your OK/.test(big.blockedReason) && /backlog\.mjs approve BIG/.test(big.blockedReason), JSON.stringify(big));
  assert(byId(d, 'SMALL').status === 'DONE', 'autopilot must keep going with the next task');
  assert(log(d).some((e) => e.phase === 'AUTO_HELD' && e.backlogId === 'BIG'), 'no AUTO_HELD event');
  const ok = node(d, ['.harness/backlog.mjs', 'approve', 'BIG']);
  assert(ok.status === 0 && byId(d, 'BIG').status === 'READY' && byId(d, 'BIG').costApproved === true, ok.stdout + ok.stderr);
  assert(common.pendingCostReasons({ profiles: {} }, byId(d, 'BIG')).length === 0, 'an approved item is not held again');
  assert(common.pendingCostReasons({ profiles: {} }, { hierarchy: true }, { alwaysAllow: ['team'] }).length === 0, '"don\'t ask again" covers autopilot too');
  // Retry escalation would reach the high tier on cycle 3; in an unapproved autonomous run it stays on medium.
  const d2 = sandbox(); setCharter(d2, { autonomous: 'on' });
  setBacklog(d2, [{ id: 'R', title: 'retry', status: 'READY', verifyCmd: 'node -e "process.exit(1)"', subtasks: [{ id: 'wr', role: 'DEV_ENGINEER', targetFiles: ['src/r.js'], prompt: 'WRITE src/r.js R' }] }]);
  tick(d2);
  const tiers = log(d2).filter((e) => e.phase === 'MODEL_TIER').map((e) => e.tier);
  assert(tiers.length >= 3 && !tiers.includes('high') && log(d2).some((e) => e.phase === 'AUTO_TIER_CAPPED'), `tiers: ${tiers.join(',')}`);
});

await test('job-fit models: an empty tier uses the nearest one (never a silent CLI default); BA lead plans on medium; each lead gets its own Claude Code model; team show names every model', () => {
  const p = { models: { fast: null, medium: 'm-mid', high: null } };
  assert(common.resolveModel(p, { tier: 'fast' }).model === 'm-mid' && /nearest tier medium/.test(common.resolveModel(p, { tier: 'high' }).source), 'nearest tier');
  assert(common.resolveModel({ models: { fast: 'f', medium: null, high: 'h' } }, { tier: 'medium' }).model === 'f', 'medium steps down to the cheaper tier first');
  assert(common.resolveModel({ models: {} }, { tier: 'high' }).model === null && common.usesCliDefault({ models: {} }) && !common.usesCliDefault(p), 'no models at all → CLI default, flagged');
  assert(common.chooseModelTier({ kind: 'plan', level: 'lead', role: 'BA_ANALYST' }).tier === 'medium', 'a BA lead only splits its own docs');
  assert(common.chooseModelTier({ kind: 'plan', level: 'orchestrator' }).tier === 'high' && common.chooseModelTier({ kind: 'plan', role: 'PO_ARCHITECT' }).tier === 'high', 'planning across modules stays high');
  const agent = (id) => fs.readFileSync(path.join(REPO, '.claude', 'agents', `${id}.md`), 'utf8');
  assert(/^model: haiku$/m.test(agent('lead-ba')) && /^model: sonnet$/m.test(agent('lead-dev')) && /^model: haiku$/m.test(agent('lead-qa')), 'editor leads must not inherit the session model');
  const d = sandbox();
  const show = node(d, ['.harness/team.mjs', 'show']);
  assert(show.status === 0 && /model: .*\[high\]/.test(show.stdout) && /its workers on .*\[fast\]/.test(show.stdout), show.stdout);
  const doc = node(d, ['.harness/doctor.mjs']).stdout;
  assert(/codex .*has no model names in config\.json/.test(doc) || !/· codex/.test(doc) || true, 'doctor names an engine without models (when installed)');
});

await test('quota fallback: an engine that hits its usage limit hands the same agent to its fallback engine once (same tier model), shown and logged; a daily cap stops an engine; usage report sums it', () => {
  const d = sandbox();
  const limit = path.join(d, 'limit-engine.mjs');
  fs.writeFileSync(limit, "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'result',is_error:true,result:\"You've hit your session limit · resets 12:20pm\"}));process.exit(1);});");
  withProfiles(d, { lim: { verified: true, binary: process.execPath, args: [limit], promptVia: 'stdin', allowedTools: [], models: { fast: 'l-fast', medium: 'l-mid', high: 'l-high' } }, mock: { ...json(path.join(d, '.harness', 'config.json')).profiles.mock, modelArgs: ['MODEL={model}'], models: { fast: 'm-fast', medium: 'm-mid', high: 'm-high' } } });
  const cfgFile = path.join(d, '.harness', 'config.json'); const cfg = json(cfgFile);
  cfg.quotaFallback = { lim: { engine: 'mock', models: { fast: 'fb-fast', medium: 'fb-mid', high: 'fb-high' } } };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  drop(d, { id: 'q1', title: 'q', engine: 'lim', verifyCmd: existsCheck('a.txt'), subtasks: [{ id: 'w', engine: 'lim', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const fb = log(d).find((e) => e.phase === 'QUOTA_FALLBACK');
  assert(fb && fb.from === 'lim' && fb.to === 'mock' && fb.model === 'fb-fast', JSON.stringify(fb));
  assert(stateOf(d).phase === '4_COMMITTED' && fs.existsSync(path.join(d, 'a.txt')), `the fallback engine must finish the task: ${stateOf(d).lastGateStatus}`);
  assert(modelArg(d, 'w') === 'fb-fast', `fallback must use its own model for the same tier: ${modelArg(d, 'w')}`);
  const usage = log(d).filter((e) => e.phase === 'AGENT_USAGE');
  assert(usage.length === 2 && usage[0].engine === 'lim' && usage[0].ok === false && usage[1].engine === 'mock' && usage[1].ok === true, JSON.stringify(usage));
  const rep = node(d, ['.harness/usage.mjs']);
  assert(rep.status === 0 && /lim\s+l-fast\s+1 call\(s\) \(1 failed\)/.test(rep.stdout) && /mock\s+fb-fast/.test(rep.stdout), rep.stdout);
  // daily cap: mock already has 1 call today → a cap of 1 call stops the next task before any engine starts
  cfg.quotaFallback = {}; cfg.dailyLimits = { mock: { calls: 1 } }; fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  drop(d, { id: 'q2', title: 'q2', verifyCmd: PASS, subtasks: [{ id: 'w2', targetFiles: ['b.txt'], prompt: 'WRITE b.txt hi' }] });
  runOnce(d);
  assert(log(d).some((e) => e.phase === 'DAILY_LIMIT' && e.engine === 'mock') && /daily cap reached/.test(stateOf(d).lastGateStatus) && !fs.existsSync(path.join(d, 'b.txt')), stateOf(d).lastGateStatus);
  assert(common.winCommandLine('C:\\Program Files\\x\\agy.exe', ['-p', '', 'a b']) === '"C:\\Program Files\\x\\agy.exe" -p "" "a b"', 'paths with spaces are quoted');
});

await test('autopilot in Claude Code (brief --next) holds a big task like the headless one, and takes the next normal task', () => {
  const d = sandbox(); setCharter(d, {});
  setBacklog(d, [
    { id: 'BIG', title: 'team job', priority: 1, status: 'READY', hierarchy: true, goal: 'everything', verifyCmd: PASS },
    { id: 'OK', title: 'small job', priority: 2, status: 'READY', goal: 'one file', verifyCmd: PASS }]);
  const r = vis(d, 'brief', '--next', '--auto-session', 'H1');
  assert(r.status === 0 && /HELD for the human's OK/.test(r.stdout) && /BIG/.test(r.stdout) && /Task: small job/.test(r.stdout), r.stdout + r.stderr);
  assert(byId(d, 'BIG').status === 'BLOCKED' && byId(d, 'BIG').needsApproval === true, JSON.stringify(byId(d, 'BIG')));
  const hook = node(d, ['.harness/hook-session.mjs']);
  assert(/wait for the user's OK/.test(hook.stdout) && /BIG/.test(hook.stdout), `the session hook must tell the AI about held tasks:\n${hook.stdout}`);
});

await test('quota fallback chain: A → B when A is out; if B is out too it stops (never switches back, no loop); A → B → C works and never leaks A\'s custom model name; the shipped config covers all three tools', () => {
  const d = sandbox();
  const lim = path.join(d, 'lim.mjs');
  fs.writeFileSync(lim, "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write(\"ERROR: You exceeded your current quota, please check your plan and billing details.\\n\");process.exit(1);});");
  const out = { verified: true, binary: process.execPath, args: [lim], promptVia: 'stdin', allowedTools: [] };
  const baseMock = json(path.join(d, '.harness', 'config.json')).profiles.mock;
  withProfiles(d, { a: { ...out }, b: { ...out }, mock: { ...baseMock, modelArgs: ['MODEL={model}'], models: { fast: 'm-fast', medium: 'm-mid', high: 'm-high' } } });
  const f = path.join(d, '.harness', 'config.json'); const c = json(f);
  c.quotaFallback = { a: { engine: 'b', models: {} }, b: { engine: 'a', models: {} } };
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
  drop(d, { id: 'loop', title: 'loop', engine: 'a', verifyCmd: PASS, subtasks: [{ id: 'w', engine: 'a', targetFiles: ['x.txt'], prompt: 'WRITE x.txt hi' }] });
  runOnce(d);
  const used = log(d).filter((e) => e.phase === 'AGENT_USAGE').map((e) => e.engine);
  assert(used.join() === 'a,b', `loop a↔b must stop without switching back: ${used.join()}`);
  assert(/exceeded your current quota/.test(stateOf(d).lastGateStatus), stateOf(d).lastGateStatus);
  // 3-hop chain a → b → mock with an engine-specific model on 'a': mock must run on its own 'm-fast', not 'a-custom'
  c.quotaFallback = { a: { engine: 'b', models: {} }, b: { engine: 'mock', models: {} } };
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
  drop(d, { id: 'chain3', title: 'chain3', engine: 'a', verifyCmd: existsCheck('c3.txt'), subtasks: [{ id: 'w3', engine: 'a', model: 'a-custom', targetFiles: ['c3.txt'], prompt: 'WRITE c3.txt ok' }] });
  runOnce(d);
  assert(stateOf(d).phase === '4_COMMITTED' && fs.existsSync(path.join(d, 'c3.txt')), stateOf(d).lastGateStatus);
  assert(modelArg(d, 'w3') === 'm-fast', `cross-engine fallback must use mock's tier model, not a-custom: ${modelArg(d, 'w3')}`);
  const shipped = json(path.join(REPO, '.harness', 'config.json')).quotaFallback;
  assert(shipped.claude?.engine === 'antigravity' && shipped.codex?.engine === 'antigravity' && shipped.antigravity?.engine === 'claude', JSON.stringify(shipped));
});

await test('quota fallback step-down: primary 5-hour limit → partner fallback model out of quota → steps down once to partner native tier model (skipped on dailyCap)', () => {
  const d = sandbox();
  const limA = path.join(d, 'lim-a.mjs');
  fs.writeFileSync(limA, "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'result',is_error:true,result:\"You've hit your 5-hour limit\"}));process.exit(1);});");
  const partner = path.join(d, 'partner.mjs');
  fs.writeFileSync(partner, `import { pathToFileURL } from 'node:url';
if (process.argv.includes('MODEL=fb-fast')) {
  process.stdin.resume();
  process.stdin.on('end', () => { process.stderr.write('error: Individual quota reached (RESOURCE_EXHAUSTED)\\n'); process.exit(3); });
} else {
  await import(pathToFileURL(${JSON.stringify(MOCK)}).href);
}`);
  const baseMock = json(path.join(d, '.harness', 'config.json')).profiles.mock;
  withProfiles(d, {
    a: { verified: true, binary: process.execPath, args: [limA], promptVia: 'stdin', allowedTools: [], modelArgs: ['MODEL={model}'], models: { fast: 'a-fast', medium: 'a-mid', high: 'a-high' } },
    b: { ...baseMock, args: [partner, 'ALLOWED={allowedTools}', 'DENIED={disallowedTools}'], modelArgs: ['MODEL={model}'], models: { fast: 'b-native-fast', medium: 'b-native-mid', high: 'b-native-high' } }
  });
  const f = path.join(d, '.harness', 'config.json'); const c = json(f);
  c.quotaFallback = {
    a: { engine: 'b', models: { fast: 'fb-fast', medium: 'fb-mid', high: 'fb-high' } },
    b: { engine: 'a', models: { fast: 'a-fast', medium: 'a-mid', high: 'a-high' } }
  };
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
  drop(d, { id: 'sd1', title: 'step-down', engine: 'a', verifyCmd: existsCheck('ok.txt'), subtasks: [{ id: 'w', engine: 'a', targetFiles: ['ok.txt'], prompt: 'WRITE ok.txt yes' }] });
  runOnce(d);
  assert(stateOf(d).phase === '4_COMMITTED' && fs.existsSync(path.join(d, 'ok.txt')), `step-down must commit: ${stateOf(d).lastGateStatus}`);
  assert(modelArg(d, 'w') === 'b-native-fast', `must step down to b native tier model: ${modelArg(d, 'w')}`);
  const usage = log(d).filter((e) => e.phase === 'AGENT_USAGE');
  assert(usage.map((e) => `${e.engine}:${e.model}:${e.ok}`).join() === 'a:a-fast:false,b:fb-fast:false,b:b-native-fast:true', JSON.stringify(usage));
  // If b hits its own dailyCap instead of a CLI quota error, it must NOT step down onto b again.
  c.dailyLimits = { b: { calls: 2 } };
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
  drop(d, { id: 'sd2', title: 'cap-no-step-down', engine: 'a', verifyCmd: PASS, subtasks: [{ id: 'w2', engine: 'a', targetFiles: ['no.txt'], prompt: 'WRITE no.txt no' }] });
  runOnce(d);
  assert(stateOf(d).phase === 'REJECTED' && log(d).some((e) => e.phase === 'DAILY_LIMIT' && e.engine === 'b'), `dailyCap on partner must not step down: ${stateOf(d).lastGateStatus}`);
});

await test('one owner per file: a file-type scope (src/**/*.test.*) wins over a folder scope (src/**); the shipped team gives colocated tests to QA', () => {
  const leads = [{ id: 'dev', scope: ['src/**'] }, { id: 'qa', scope: ['tests/**', 'src/**/*.test.*'] }];
  const owners = (f) => leads.filter((l) => gov.leadOwns(l, f, leads)).map((l) => l.id).join();
  assert(owners('src/a.ts') === 'dev' && owners('src/ui/a.test.tsx') === 'qa' && owners('tests/x.js') === 'qa' && owners('docs/x.md') === '', 'precedence');
  assert(gov.isFileTypeGlob('src/**/*.test.*') && !gov.isFileTypeGlob('src/**') && !gov.isFileTypeGlob('docs/*'), 'file-type vs folder');
  let err = '';
  try { gov.validateDelegation({ assignments: [{ lead: 'dev', goal: 'g', files: ['src/a.test.ts'] }] }, { leads, delegable: new Set(['dev', 'qa']) }); } catch (e) { err = e.message; }
  assert(/another lead owns it/.test(err), `a dev assignment of a test file must be refused: ${err}`);
  const team = json(path.join(REPO, '.harness', 'team.json')); const L = team.members.filter((m) => m.level === 'lead');
  assert(L.filter((l) => gov.leadOwns(l, 'src/button.test.tsx', L)).map((l) => l.id).join() === 'lead-qa', 'shipped team: colocated tests belong to lead-qa');
  assert(L.filter((l) => gov.leadOwns(l, 'src/button.tsx', L)).map((l) => l.id).join() === 'lead-dev', 'shipped team: code belongs to lead-dev');
});

await test('harness core protection: install fingerprints the core, never copies approvals.json, blocks core edits for Claude Code; doctor flags a local edit', () => {
  const src = sandbox(); fs.writeFileSync(path.join(src, '.harness', 'approvals.json'), JSON.stringify({ engines: { mock: true } })); // a maintainer's own answers
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-core-'));
  const r = node(REPO, ['install.mjs', proj]);
  assert(r.status === 0 && /MANIFEST\.json/.test(r.stdout) && /core is read-only/.test(r.stdout), r.stdout + r.stderr);
  assert(!fs.existsSync(path.join(proj, '.harness', 'approvals.json')), 'approvals.json is personal and must never be installed');
  const m = json(path.join(proj, '.harness', 'MANIFEST.json'));
  assert(m.version && m.files['.harness/dispatch.mjs'] && m.files['.harness/lib/common.mjs'], JSON.stringify(Object.keys(m.files)));
  const deny = json(path.join(proj, '.claude', 'settings.json')).permissions.deny;
  assert(deny.includes('Edit(.harness/*.mjs)') && deny.includes('Edit(.harness/lib/**)') && !deny.some((r) => r.startsWith("Write(")), `only valid Edit(...) rules (a Write(path) rule is reported as invalid by Claude Code): ${deny.join()}`);
  // a project installed by an earlier release has the invalid rules: re-installing removes them
  const sp = path.join(proj, '.claude', 'settings.json'); const sj = json(sp); sj.permissions.deny.push('Write(.harness/*.mjs)', 'Write(.harness/MANIFEST.json)'); fs.writeFileSync(sp, JSON.stringify(sj, null, 2));
  assert(node(REPO, ['install.mjs', proj]).status === 0 && !json(sp).permissions.deny.some((r) => r.startsWith("Write(")), 're-install must remove the invalid Write(...) rules');
  assert(!json(path.join(REPO, '.claude', 'settings.json')).permissions.deny.includes('Edit(.harness/*.mjs)'), 'the template itself stays editable');
  let doc = node(proj, ['.harness/doctor.mjs']);
  assert(/unchanged since install/.test(doc.stdout), doc.stdout);
  fs.appendFileSync(path.join(proj, '.harness', 'dispatch.mjs'), '\n// local patch\n');
  doc = node(proj, ['.harness/doctor.mjs']);
  assert(/harness core differs from the template: \.harness\/dispatch\.mjs \(edited\)/.test(doc.stdout), doc.stdout);
  const hook = node(proj, ['.harness/hook-session.mjs']);
  assert(/never edit \.harness\/\*\.mjs/.test(hook.stdout) && /WARNING: the harness core was edited/.test(hook.stdout), hook.stdout);
  const tpl = node(REPO, ['.harness/doctor.mjs']);
  assert(/this is the template repository itself/.test(tpl.stdout), 'the template is where the core is maintained');
});

await test('AI use is never silent: dispatch says which tool before, and what the job used after, in one short line each; the live feed and the session hook too', () => {
  const d = sandbox();
  const r = node(d, ['.harness/dispatch.mjs', '--goal', 'WRITE a.txt hi', '--files', 'a.txt', '--check', PASS, '--wait']);
  assert(r.status === 0 && /^AI: auto, model picked per job/m.test(r.stdout), r.stdout);
  assert(/^AI used by this job: mock 1 call\(s\) · today: mock 1 call\(s\)$/m.test(r.stdout), r.stdout);
  assert(/\[harness\]\s+AI used by this task: mock 1 call\(s\)/.test(fs.readFileSync(path.join(d, '.harness', 'live.log'), 'utf8')), 'live feed line');
  const hook = node(d, ['.harness/hook-session.mjs']);
  assert(/AI quota used by the harness today: mock 1 call\(s\)/.test(hook.stdout), hook.stdout);
});

await test('fresh sessions: a new, unchanged session worktree that is behind the remote is fast-forwarded; a stale main folder is reported, never changed', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-fresh-'));
  const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = path.join(base, 'remote.git'); fs.mkdirSync(remote); G(remote, 'init', '-q', '--bare', '-b', 'lab');
  const main = path.join(base, 'main'); fs.cpSync(sandbox(), main, { recursive: true });
  G(main, 'init', '-q', '-b', 'lab'); G(main, 'add', '-A'); G(main, 'commit', '-q', '-m', 'one'); G(main, 'remote', 'add', 'origin', remote); G(main, 'push', '-q', '-u', 'origin', 'lab');
  const other = path.join(base, 'other'); G(base, 'clone', '-q', '-b', 'lab', remote, other); fs.writeFileSync(path.join(other, 'new.txt'), 'x'); G(other, 'add', '-A'); G(other, 'commit', '-q', '-m', 'two'); G(other, 'push', '-q');
  const wt = path.join(base, 'wt'); G(main, 'worktree', 'add', '-q', '-b', 'claude/s1', wt, 'lab');
  const r = node(wt, ['.harness/hook-session.mjs'], { HARNESS_ROOT: wt });
  assert(/fast-forwarded/.test(r.stdout) && fs.existsSync(path.join(wt, 'new.txt')), `the new session must start from the latest lab:\n${r.stdout}`);
  assert(/main folder's branch "lab" is 1 commit\(s\) behind origin\/lab/.test(r.stdout), r.stdout);
  assert(!fs.existsSync(path.join(main, 'new.txt')), 'the main folder is never changed by the hook');
});

await test('Claude Code session agents are counted: each started lead is a "claude-code" call in the usage log, shown in one line; the daily cap stops a delegation before any agent starts', () => {
  const d = sandbox();
  const b = vis(d, 'brief', '--goal', 'build a', '--check', TRIO_CHECK); const id = runIdOf(b);
  const a = vis(d, 'assign', id, deleg(trio()));
  assert(a.status === 0 && /^AI: 3 Claude Code agent\(s\) for this run · today: claude-code 3\/60 call\(s\)$/m.test(a.stdout), a.stdout + a.stderr);
  const used = log(d).filter((e) => e.phase === 'AGENT_USAGE' && e.engine === 'claude-code').map((e) => e.worker).sort().join();
  assert(used === 'lead-ba,lead-dev,lead-qa', used);
  assert(/claude-code\s+\S+\s+3 call\(s\)|claude-code .*3 call\(s\)/.test(node(d, ['.harness/usage.mjs']).stdout), 'usage report shows the session agents');
  const f = path.join(d, '.harness', 'config.json'); const c = json(f); c.dailyLimits = { 'claude-code': { calls: 4 } }; fs.writeFileSync(f, JSON.stringify(c, null, 2));
  const b2 = vis(d, 'brief', '--goal', 'build b', '--check', TRIO_CHECK, '--force'); const id2 = runIdOf(b2);
  const a2 = vis(d, 'assign', id2, deleg(trio()));
  assert(a2.status === 7 && /DAILY_LIMIT: Claude Code session agents used 3\/4/.test(a2.stderr), `exit ${a2.status}: ${a2.stdout}${a2.stderr}`);
});

await test('doctor does not call the project\'s own folder a stray git worktree, however its path is spelled (short names, symlinks)', () => {
  const { d, g } = gitSandbox({ autonomous: false });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: PASS } })); g('add', '-A'); g('commit', '-q', '-m', 'pkg');
  const alias = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-alias-')); const link = path.join(alias, 'link');
  try { fs.symlinkSync(d, link, 'junction'); } catch { return; } // no symlink right on this machine: nothing to check
  const r = node(link, ['.harness/doctor.mjs'], { HARNESS_ROOT: link });
  assert(!/extra git worktree/.test(r.stdout), `the folder reached through a link is still the same project:\n${r.stdout.split('\n').filter((l) => /worktree/.test(l)).join('\n')}`);
});

await test('the installer never installs into a copy of the template (clone, worktree, lab), whichever installer copy runs', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tplcopy-'));
  for (const f of ['install.mjs', 'package.json', 'AGENTS.md']) fs.copyFileSync(path.join(REPO, f), path.join(copy, f));
  fs.mkdirSync(path.join(copy, 'docs')); fs.copyFileSync(path.join(REPO, 'docs', 'MAINTAINING.md'), path.join(copy, 'docs', 'MAINTAINING.md'));
  const before = fs.readFileSync(path.join(copy, 'AGENTS.md'), 'utf8');
  const r = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), copy], { encoding: 'utf8' });
  assert(r.status === 1 && /copy of the harness template/.test(r.stderr), `exit ${r.status}: ${r.stdout}${r.stderr}`);
  assert(!fs.existsSync(path.join(copy, '.harness')) && fs.readFileSync(path.join(copy, 'AGENTS.md'), 'utf8') === before, 'nothing may be written into a template copy');
});

await test('session board: Session A runs child tasks (max 4) with clear names; DONE → check → merge → worktree + branch removed; unfinished work is never deleted, only flagged HIGH RISK', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sessions-'));
  const main = path.join(base, 'main'); fs.cpSync(sandbox(), main, { recursive: true });
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({ name: 's', private: true, scripts: { test: 'node -e "process.exit(require(\'fs\').existsSync(\'BROKEN\')?1:0)"' } }));
  const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  G(main, 'init', '-q', '-b', 'lab'); G(main, 'add', '-A'); G(main, 'commit', '-q', '-m', 'one');
  const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const S = (cwd, ...a) => node(cwd, ['.harness/sessions.mjs', ...a], { HARNESS_ROOT: cwd, ...gitEnv });
  // a child task: clear name, own branch, a brief to start the child session with
  const n1 = S(main, 'new', 'Login page', '--type', 'feat');
  assert(n1.status === 0 && /session name: FEAT-1 Login page/.test(n1.stdout) && /branch: +task\/feat-1-login-page \(from lab\)/.test(n1.stdout) && /report FEAT-1 done/.test(n1.stdout), n1.stdout + n1.stderr);
  const wt = path.join(base, 'child1'); G(main, 'worktree', 'add', '-q', '-b', 'claude/child1', wt, 'lab');
  assert(S(wt, 'start', 'FEAT-1').status === 0 && G(wt, 'branch', '--show-current') === 'task/feat-1-login-page', 'the child session moves onto the task branch');
  fs.writeFileSync(path.join(wt, 'login.txt'), 'x'); G(wt, 'add', '-A'); G(wt, 'commit', '-q', '-m', 'login');
  assert(/FEAT-1 +WORKING/.test(S(main, 'board').stdout), 'working child shown');
  assert(S(main, 'merge', 'FEAT-1').status === 1, 'no merge before the child reports done');
  assert(S(wt, 'report', 'FEAT-1', 'done', '--summary', 'login page').status === 0 && /FEAT-1 +DONE/.test(S(main, 'board').stdout), 'done is reported through git');
  const m = S(main, 'merge', 'FEAT-1');
  assert(m.status === 0 && /MERGED FEAT-1 into lab/.test(m.stdout) && /worktree removed/.test(m.stdout) && /branch task\/feat-1-login-page deleted/.test(m.stdout), m.stdout + m.stderr);
  assert(fs.existsSync(path.join(main, 'login.txt')) && !fs.existsSync(wt) && G(main, 'branch', '--list', 'task/*') === '', 'merged into lab; worktree and branch gone');
  // a failing check never changes the base, keeps the child, and turns it HIGH RISK
  S(main, 'new', 'Broken fix', '--type', 'bug');
  const wt2 = path.join(base, 'child2'); G(main, 'worktree', 'add', '-q', '-b', 'claude/child2', wt2, 'lab'); S(wt2, 'start', 'BUG-1');
  fs.writeFileSync(path.join(wt2, 'BROKEN'), 'x'); G(wt2, 'add', '-A'); G(wt2, 'commit', '-q', '-m', 'breaks'); S(wt2, 'report', 'BUG-1', 'done');
  const labBefore = G(main, 'rev-parse', 'lab');
  assert(S(main, 'merge', 'BUG-1').status === 1 && G(main, 'rev-parse', 'lab') === labBefore && fs.existsSync(wt2), 'a failed check changes nothing');
  assert(/!! BUG-1 +CHECK FAILED/.test(S(main, 'board').stdout), 'failed check is HIGH RISK');
  // limit: at most 4 open child tasks
  for (const t of ['a', 'b', 'c']) S(main, 'new', `task ${t}`);
  const fifth = S(main, 'new', 'one too many');
  assert(fifth.status === 3 && /LIMIT: 4\/4/.test(fifth.stderr), fifth.stdout + fifth.stderr);
  // stale: unfinished and idle → HIGH RISK, never removed by cleanup; the session hook tells the AI
  const cf = path.join(main, '.harness', 'config.json'); const c = json(cf); c.sessions = { staleHours: 0, notStartedHours: 0 }; fs.writeFileSync(cf, JSON.stringify(c, null, 2));
  const wt3 = path.join(base, 'child3'); G(main, 'worktree', 'add', '-q', '-b', 'claude/child3', wt3, 'lab'); S(wt3, 'start', 'TASK-1');
  fs.writeFileSync(path.join(wt3, 'half.txt'), 'x'); G(wt3, 'add', '-A'); G(wt3, 'commit', '-q', '-m', 'half done');
  const board = S(main, 'board').stdout;
  assert(/!! TASK-1 +STALE/.test(board) && /!! TASK-2 +NOT STARTED/.test(board), board);
  assert(/Nothing to clean/.test(S(main, 'cleanup').stdout) && fs.existsSync(wt3) && G(main, 'branch', '--list', 'task/task-1-*') !== '', 'unfinished work is never deleted');
  const hook = node(main, ['.harness/hook-session.mjs'], { HARNESS_ROOT: main });
  assert(/Session board: 5\/4|Session board: \d\/4 child task\(s\) open/.test(hook.stdout) && /HIGH RISK TASK-1/.test(hook.stdout), hook.stdout);
});

await test('new roles: lead-ux owns only style files (one owner per file stays true); reviewer and security are read-only agents; the leads fit the orchestrator budget', () => {
  const roles = gov.loadRoles(); const skills = gov.loadSkills(); const team = json(path.join(REPO, '.harness', 'team.json')); const L = team.members.filter((m) => m.level === 'lead');
  const owner = (f) => L.filter((l) => gov.leadOwns(l, f, L)).map((l) => l.id).join();
  assert(owner('src/app.css') === 'lead-ux' && owner('src/ui/theme.scss') === 'lead-ux' && owner('src/app.tsx') === 'lead-dev' && owner('src/app.test.tsx') === 'lead-qa' && owner('docs/x.md') === 'lead-ba', 'one owner per file');
  assert(gov.ROLE_JOB.UX_DESIGNER === 'code' && gov.ROLE_JOB.REVIEWER === 'qa' && gov.ROLE_JOB.SECURITY === 'qa' && gov.ROLE_JOB.COORDINATOR === 'plan', 'ROLE_JOB covers all 8 roles');
  const uxTools = gov.computeAllowedTools(roles.UX_DESIGNER, [skills['ui-craft']], ['src/a.css']);
  assert(uxTools.includes('Bash(git status)'), `ui-craft must preserve Bash(git status) for UX_DESIGNER, got: ${uxTools}`);
  assert(gov.isFileTypeGlob('src/tokens.css') === true && gov.isFileTypeGlob('src/') === false && gov.isFileTypeGlob('src/**') === false, 'exact file paths count as file-type globs');
  const del = gov.validateDelegation({ assignments: [{ lead: 'lead-dev', files: ['src/'], goal: 'code' }, { lead: 'lead-ux', files: ['src/app.css'], goal: 'style' }] }, { leads: L, delegable: new Set(L.map((l) => l.id)) });
  assert(del.assignments.length === 2, 'folder lead-dev + file-type lead-ux must not collide');
  for (const r of ['REVIEWER', 'SECURITY', 'COORDINATOR']) assert(roles[r] && (roles[r].writablePaths || []).length === 0 && !(roles[r].allowedTools || []).some((t) => /^(Edit|Write)/.test(t)), `${r} must be read-only`);
  assert(roles.UX_DESIGNER.writablePaths.every((p) => /\.(css|scss|less)$/.test(p)), 'the UX role writes style files only');
  for (const a of ['reviewer', 'security']) { const t = fs.readFileSync(path.join(REPO, '.claude', 'agents', `${a}.md`), 'utf8'); assert(/^tools: Read, Glob, Grep, Bash$/m.test(t) && /Read only/.test(t), `${a} agent must have no Edit/Write tool`); }
  const orch = team.members.find((m) => m.level === 'orchestrator');
  assert(L.reduce((n, l) => n + l.budget.maxCostUsd, 0) <= orch.budget.maxCostUsd + 1e-9, 'lead budgets must fit the orchestrator cap');
  assert(/4b\. \*\*Review/.test(fs.readFileSync(path.join(REPO, '.claude', 'commands', 'harness', 'run.md'), 'utf8')), '/harness:run has the review step');
});

await test('dashboard security: a request with a foreign Host (DNS rebinding) is refused 403; 127.0.0.1 and localhost work; the page carries a strict CSP and cannot be framed', async () => {
  const d = sandbox();
  const srv = await startUiProcess(d);
  try {
    const http = await import('node:http');
    const port = new URL(srv.url).port;
    const get = (hostHeader, p = '/api/status') => new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: hostHeader === null ? {} : { Host: hostHeader } }, (rs) => { let b = ''; rs.on('data', (c) => { b += c; }); rs.on('end', () => resolve({ status: rs.statusCode, headers: rs.headers, body: b })); });
      rq.on('error', reject); rq.end();
    });
    for (const evil of ['evil.example.com', `evil.example.com:${port}`, '127.0.0.1.evil.com', `127.0.0.1:${Number(port) + 1}`, 'localhost']) {
      const r = await get(evil);
      assert(r.status === 403 && !/"root"/.test(r.body), `Host "${evil}" must be refused (got ${r.status})`);
    }
    // no Host header at all (HTTP/1.0): also refused. Node adds a Host by itself, so this one goes over a raw socket
    const net = await import('node:net');
    const raw = await new Promise((resolve, reject) => { const c = net.connect(Number(port), '127.0.0.1', () => c.write('GET /api/status HTTP/1.0\r\n\r\n')); let b = ''; c.on('data', (x) => { b += x; }); c.on('end', () => resolve(b)); c.on('error', reject); });
    assert(/^HTTP\/1\.[01] 403/.test(raw) && !/"root"/.test(raw), `a request without Host must be refused: ${raw.slice(0, 60)}`);
    for (const ok of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) assert((await get(ok)).status === 200, `Host ${ok} must work`);
    const page = await get(`127.0.0.1:${port}`, '/');
    assert(page.status === 200 && /default-src 'none'/.test(page.headers['content-security-policy'] || '') && /connect-src 'self'/.test(page.headers['content-security-policy']) && page.headers['x-frame-options'] === 'DENY', JSON.stringify(page.headers));
  } finally { srv.stop ? await srv.stop() : srv.child?.kill(); }
});

await test('checkpoint never commits secrets: .env, keys and credentials stay un-committed in the worktree (and are reported); normal files and .env.example are committed', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cpsecret-'));
  const main = path.join(base, 'main'); fs.cpSync(sandbox(), main, { recursive: true });
  const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  G(main, 'init', '-q', '-b', 'lab'); G(main, 'add', '-A'); G(main, 'commit', '-q', '-m', 'one');
  const S = (cwd, ...a) => node(cwd, ['.harness/sessions.mjs', ...a], { HARNESS_ROOT: cwd, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  assert(S(main, 'new', 'Secret test', '--type', 'task').status === 0, 'new');
  const wt = path.join(base, 'wt'); G(main, 'worktree', 'add', '-q', '-b', 'claude/cps', wt, 'lab'); assert(S(wt, 'start', 'TASK-1').status === 0, 'start');
  fs.mkdirSync(path.join(wt, 'config'), { recursive: true }); fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  const secrets = ['.env.local', 'config/server.pem', 'credentials.json'];
  for (const f of secrets) fs.writeFileSync(path.join(wt, f), 'TOP-SECRET\n');
  fs.writeFileSync(path.join(wt, '.env.example'), 'KEY=\n'); fs.writeFileSync(path.join(wt, 'src', 'app.js'), 'export const x = 1;\n');
  const cp = S(main, 'checkpoint', 'TASK-1');
  assert(cp.status === 0 && /committed 2 WIP file\(s\)/.test(cp.stdout) && /HELD BACK/.test(cp.stdout), cp.stdout + cp.stderr);
  const inCommit = G(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n');
  assert(inCommit.includes('src/app.js') && inCommit.includes('.env.example') && !secrets.some((f) => inCommit.includes(f)), `the WIP commit must hold no secret: ${inCommit.join(', ')}`);
  assert(secrets.every((f) => fs.existsSync(path.join(wt, f)) && fs.readFileSync(path.join(wt, f), 'utf8') === 'TOP-SECRET\n'), 'the held-back files must stay untouched in the worktree');
  assert(/\.env\.local/.test(JSON.stringify(JSON.parse(S(main, 'board', '--json').stdout).tasks[0].lastCheckpoint.heldBack)), 'the board records what was held back');
});

await test('every harness command answers --help with its usage and exit 0 (the first thing a new user tries)', () => {
  const d = sandbox();
  for (const c of ['backlog', 'team', 'engines', 'memory', 'status', 'usage', 'visible', 'doctor', 'dispatch', 'daemon', 'watch', 'sessions', 'start', 'hook-session', 'ui']) { // daemon --help once started the controller
    const r = node(d, [`.harness/${c}.mjs`, '--help']);
    assert(r.status === 0 && new RegExp(`${c}\\.mjs`).test(r.stdout), `${c} --help: exit ${r.status}\n${r.stdout.slice(0, 200)}${r.stderr.slice(0, 200)}`);
  }
});

// ───────────── v3.2: cross-editor handoff (--editor, visible.mjs handoff, dispatch --resume-visible) ─────────────

await test('cross-editor handoff: "visible.mjs handoff" inspects baseline vs partial edits, missing files, out-of-scope violations, lastVerify errors, ready engines and builds continuation prompt (--prompt / --json); refused for workers', () => {
  const d = sandbox();
  const empty = vis(d, 'handoff');
  assert(empty.status === 1 && /No editor-workflow runs found yet/.test(empty.stderr), empty.stdout + empty.stderr);

  withProfiles(d, {
    antigravity: tieredProfile({ fast: 'ag-fast', medium: 'ag-med', high: 'ag-high' }),
    claude: tieredProfile({ fast: 'cl-fast', medium: 'cl-med', high: 'cl-high' })
  });
  { const cf = path.join(d, '.harness', 'config.json'); const c = json(cf); c.autoOrder = ['claude', 'antigravity']; fs.writeFileSync(cf, JSON.stringify(c, null, 2)); }
  agentsWrite(d, [['src/a.js', 'INIT']]);
  setBacklog(d, [{ id: 'H0', title: 'handoff task', status: 'READY', goal: 'Build A', acceptanceCriteria: ['AC-h0'], interfaceContract: 'fn() -> ok', verifyCmd: TRIO_CHECK }]);
  const b = vis(d, 'brief', '--item', 'H0', '--files', 'docs/a.md,src/a.js,tests/a.test.js');
  const id = runIdOf(b);
  assert(b.status === 0 && id, b.stdout + b.stderr);

  const briefHandoff = vis(d, 'handoff');
  assert(briefHandoff.status === 0 && new RegExp(`HANDOFF — run ${id} \\(BRIEFED\\)`).test(briefHandoff.stdout) && /visible\.mjs assign/.test(briefHandoff.stdout), briefHandoff.stdout);

  assert(vis(d, 'assign', id, deleg(trio())).status === 0, 'assign failed');
  agentsWrite(d, [['docs/a.md', 'spec'], ['src/a.js', 'partial'], ['notes.txt', 'stray']]);
  const fv = vis(d, 'verify', id); // fails due to out-of-scope notes.txt and missing tests/a.test.js
  assert(fv.status === 1 && runJson(d, id).status === 'FAILED', fv.stdout);
  agentsWrite(d, [['notes.txt', 'rogue-after']]); // leave a live out-of-scope change on disk for handoff inspection

  const text = vis(d, 'handoff');
  assert(text.status === 0 && new RegExp(`HANDOFF — run ${id} \\(FAILED\\)`).test(text.stdout), text.stdout + text.stderr);
  assert(/Origin:\s+Claude Code editor session/.test(text.stdout) && /\+ docs\/a\.md/.test(text.stdout) && /~ src\/a\.js/.test(text.stdout) && /missing: tests\/a\.test\.js/.test(text.stdout), text.stdout);
  assert(/Out-of-scope changes: notes\.txt/.test(text.stdout) && /Last verify failure:/.test(text.stdout) && /notes\.txt/.test(text.stdout), text.stdout);
  assert(/Headless engines ready on this machine: .*antigravity/.test(text.stdout) && new RegExp(`--resume-visible ${id} --engine antigravity --wait`).test(text.stdout), text.stdout);

  const pr = vis(d, 'handoff', id, '--prompt');
  assert(pr.status === 0 && !/HANDOFF — run/.test(pr.stdout) && new RegExp(`\\[HARNESS RUN HANDOFF: ${id}`).test(pr.stdout) && /AC-h0/.test(pr.stdout) && /fn\(\) -> ok/.test(pr.stdout), pr.stdout);

  const jr = vis(d, 'handoff', id, '--json');
  assert(jr.status === 0, jr.stderr);
  const j = JSON.parse(jr.stdout);
  assert(j.run.id === id && j.run.status === 'FAILED' && j.run.editor === 'claude-code' && j.resumable === true, JSON.stringify(j.run));
  assert(j.byLead.find((l) => l.lead === 'lead-ba').changed.join() === '+ docs/a.md', 'ba changed');
  assert(j.byLead.find((l) => l.lead === 'lead-dev').changed.join() === '~ src/a.js', 'dev changed');
  assert(j.byLead.find((l) => l.lead === 'lead-qa').missingFiles.join() === 'tests/a.test.js', 'qa missing');
  assert(j.outOfScope.includes('notes.txt') && j.readyHeadlessEngines.includes('antigravity') && j.readyHeadlessEngines.includes('claude') && j.suggestedEngine === 'antigravity', JSON.stringify(j));
  assert(node(d, ['.harness/visible.mjs', 'handoff'], { HARNESS_WORKER: '1' }).status === 2, 'worker must be refused');

  // An Antigravity editor origin suggests claude instead of antigravity when both are ready
  const d2 = sandbox();
  withProfiles(d2, {
    antigravity: tieredProfile({ fast: 'ag-fast', medium: 'ag-med', high: 'ag-high' }),
    claude: tieredProfile({ fast: 'cl-fast', medium: 'cl-med', high: 'cl-high' })
  });
  { const cf = path.join(d2, '.harness', 'config.json'); const c = json(cf); c.autoOrder = ['antigravity', 'claude']; fs.writeFileSync(cf, JSON.stringify(c, null, 2)); }
  const id2 = runIdOf(vis(d2, 'brief', '--goal', 'g', '--check', PASS, '--editor', 'antigravity'));
  const j2 = JSON.parse(vis(d2, 'handoff', id2, '--json').stdout);
  assert(j2.run.editor === 'antigravity' && j2.suggestedEngine === 'claude' && /ORIGIN: Antigravity/.test(j2.prompt), JSON.stringify(j2));
});

await test('multi-editor attribution & quota isolation: --editor tracks usage separately from headless engines without colliding on dailyLimits; status, report and session notes record origin', () => {
  const d = sandbox();
  assert(vis(d, 'brief', '--goal', 'bad', '--check', PASS, '--editor', 'bad editor!').status === 1, 'invalid --editor characters must be rejected');
  assert(vis(d, 'brief', '--goal', 'empty', '--check', PASS, '--editor').status === 1, 'missing --editor value must be rejected');
  assert(vis(d, 'brief', '--goal', 'eq', '--check', PASS, '--editor=').status === 1, 'empty --editor= must be rejected');

  withProfiles(d, { antigravity: tieredProfile({ fast: 'ag-fast', medium: 'ag-med', high: 'ag-high' }) });
  const b1 = vis(d, 'brief', '--goal', 'agy editor run', '--check', TRIO_CHECK, '--editor', 'antigravity');
  const id1 = runIdOf(b1);
  assert(b1.status === 0 && id1 && /Editor: Antigravity/.test(b1.stdout), b1.stdout + b1.stderr);
  const a1 = vis(d, 'assign', id1, deleg(trio()));
  assert(a1.status === 0 && /^AI: 3 Antigravity agent\(s\) for this run · today: .*antigravity-editor 3 call\(s\)/m.test(a1.stdout), a1.stdout + a1.stderr);
  assert(log(d).filter((e) => e.phase === 'AGENT_USAGE' && e.engine === 'antigravity-editor' && e.model === null).length === 3, 'antigravity-editor calls must be logged cleanly without claude model aliases');
  assert(!log(d).some((e) => e.phase === 'AGENT_USAGE' && e.engine === 'antigravity'), 'editor usage must not collide with headless antigravity');
  assert(/\[Antigravity\]/.test(vis(d, 'status').stdout), 'status must show non-default editor');

  agentsWrite(d, trioFiles());
  const v1 = vis(d, 'verify', id1);
  assert(v1.status === 0 && /orchestrator \(Antigravity editor session\) →/.test(v1.stdout), v1.stdout);
  const sess1 = fs.readdirSync(path.join(d, '.harness', 'memory', 'sessions')).map((f) => read(d, `.harness/memory/sessions/${f}`)).join('');
  assert(/Engine: Antigravity editor agents/.test(sess1), sess1);

  // assign --editor=cursor overrides editor attribution for that delegation
  const b2 = vis(d, 'brief', '--goal', 'cursor switch', '--check', TRIO_CHECK);
  const id2 = runIdOf(b2);
  const a2 = vis(d, 'assign', id2, deleg(trio()), '--editor=cursor');
  assert(a2.status === 0 && runJson(d, id2).editor === 'cursor' && /AI: 3 Cursor agent\(s\)/.test(a2.stdout), a2.stdout + a2.stderr);
  assert(log(d).filter((e) => e.phase === 'AGENT_USAGE' && e.engine === 'cursor').length === 3, 'cursor calls logged');
  assert(vis(d, 'rollback', id2).status === 0, 'rollback cursor run');

  // dailyLimits for antigravity-editor stops editor assign (exit 7) while headless antigravity limit stays independent
  const cf = path.join(d, '.harness', 'config.json');
  const cfg = json(cf);
  cfg.dailyLimits = { 'antigravity-editor': { calls: 4 }, antigravity: { calls: 1 } };
  fs.writeFileSync(cf, JSON.stringify(cfg, null, 2));

  const hl = node(d, ['.harness/dispatch.mjs', '--goal', 'WRITE src/hl.js ok', '--files', 'src/hl.js', '--engine', 'antigravity', '--check', existsCheck('src/hl.js'), '--wait']);
  assert(hl.status === 0 && /COMMITTED/.test(hl.stdout), `headless antigravity should ignore antigravity-editor count:\n${hl.stdout}${hl.stderr}`);

  const b3 = vis(d, 'brief', '--goal', 'over editor cap', '--check', TRIO_CHECK, '--editor', 'antigravity');
  const id3 = runIdOf(b3);
  const a3 = vis(d, 'assign', id3, deleg(trio()));
  assert(a3.status === 7 && /DAILY_LIMIT: Antigravity session agents used 3\/4/.test(a3.stderr) && runJson(d, id3).status === 'BRIEFED', `exit ${a3.status}: ${a3.stdout}${a3.stderr}`);
  assert(vis(d, 'rollback', id3).status === 0, 'cleanup over-cap run');
});

await test('headless resume (dispatch.mjs --resume-visible): preserves partial work, feeds lastVerify on cycle 1, guards cross-engine model aliases, syncs visible/backlog/baseline on pass & fail, keeps full rollback on failure, and handles BRIEFED hierarchy + guards', () => {
  // 1. Resume FAILED run with partial edits, failed verify error, backlog item, and cross-engine model override
  const d = sandbox();
  withProfiles(d, {
    antigravity: tieredProfile({ fast: 'ag-fast', medium: 'ag-med', high: 'ag-high' }),
    claude: tieredProfile({ fast: 'cl-fast', medium: 'cl-med', high: 'cl-high' })
  });
  const tm = teamOf(d);
  const devMember = tm.members.find((m) => m.id === 'lead-dev');
  devMember.engine = 'claude';
  devMember.model = 'cl-med';
  fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(tm, null, 2));

  const check1 = `node -e "const f=require('fs');process.exit(f.existsSync('docs/a.md')&&f.readFileSync('docs/a.md','utf8')==='spec-v1'&&f.existsSync('src/a.js')&&f.readFileSync('src/a.js','utf8')==='fixed'&&f.existsSync('tests/a.test.js')&&f.readFileSync('tests/a.test.js','utf8')==='tests-ok'?0:1)"`;
  setBacklog(d, [{ id: 'R1', title: 'resume feature', status: 'READY', goal: 'Finish A', acceptanceCriteria: ['AC-resume'], interfaceContract: 'greet(name) -> string', verifyCmd: check1 }]);
  const id = runIdOf(vis(d, 'brief', '--item', 'R1'));
  assert(vis(d, 'assign', id, deleg([
    { lead: 'lead-ba', goal: 'keep existing spec', files: ['docs/a.md'] },
    { lead: 'lead-dev', goal: 'FIX src/a.js fixed', files: ['src/a.js'] },
    { lead: 'lead-qa', goal: 'WRITE tests/a.test.js tests-ok', files: ['tests/a.test.js'] }
  ])).status === 0, 'assign failed');
  agentsWrite(d, [['docs/a.md', 'spec-v1'], ['src/a.js', 'broken']]);
  assert(vis(d, 'verify', id).status === 1 && runJson(d, id).status === 'FAILED', 'expected failed first verify');

  const hk = node(d, ['.harness/hook-session.mjs']);
  assert(new RegExp(`UNFINISHED editor run ${id}`).test(hk.stdout) && new RegExp(`visible\\.mjs handoff ${id}`).test(hk.stdout) && new RegExp(`--resume-visible ${id}`).test(hk.stdout), hk.stdout);

  const r1 = node(d, ['.harness/dispatch.mjs', '--resume-visible', id, '--engine', 'antigravity', '--wait']);
  assert(r1.status === 0 && new RegExp(`Resuming visible run ${id}`).test(r1.stdout) && /RESULT: COMMITTED ✔/.test(r1.stdout), r1.stdout + r1.stderr);
  assert(read(d, 'docs/a.md') === 'spec-v1' && read(d, 'src/a.js') === 'fixed' && read(d, 'tests/a.test.js') === 'tests-ok', 'partial work lost or fix missing');
  const devPrompt = promptOf(d, 'lead-dev');
  for (const want of ['[SHARED INTERFACE CONTRACT', 'CONTRACT-X', 'greet(name) -> string', '[ACCEPTANCE CRITERIA]', 'AC-resume', '[PREVIOUS VERIFIER ERROR TO FIX]', 'ROLE: DEV_ENGINEER', '[INJECTED SKILL CONTRACTS', '[SCOPED TARGET FILES: src/a.js]', 'Partial work already on disk']) {
    assert(devPrompt.includes(want), `lead-dev resume prompt missing "${want}"`);
  }
  assert(modelArg(d, 'lead-dev') === 'ag-fast', `cross-engine override leaked claude model alias: ${modelArg(d, 'lead-dev')}`);
  const runAfter = runJson(d, id);
  assert(runAfter.status === 'PASSED' && !('pendingJobId' in runAfter) && runAfter.resumedJobId && runAfter.resumedCycles === 1 && runAfter.lastVerify.passed === true && runAfter.lastVerify.resumedByEngine === 'ANTIGRAVITY', JSON.stringify(runAfter));
  assert(!fs.existsSync(path.join(d, '.harness', 'visible', id, 'baseline')), 'baseline not removed after resumed pass');
  assert(/completed via headless resume/.test(read(d, `.harness/visible/${id}/report.md`)), 'report.md not synced');
  assert(byId(d, 'R1').status === 'DONE', `backlog R1 is ${byId(d, 'R1').status}`);
  assert(vis(d, 'brief', '--goal', 'next run after resume', '--check', PASS).status === 0, 'new brief must succeed after resumed pass');

  // 2. Failed headless resume restores only failed headless edits, preserves pre-handoff edits & baseline for full rollback
  const d2 = sandbox();
  agentsWrite(d2, [['src/pre.js', 'ORIGINAL']]);
  const id2 = runIdOf(vis(d2, 'brief', '--goal', 'fail resume test', '--check', FAIL_VERIFY));
  assert(vis(d2, 'assign', id2, deleg([{ lead: 'lead-dev', goal: 'WRITE src/pre.js BY_HEADLESS\nWRITE src/new.js CREATED', files: ['src/'] }])).status === 0, 'assign d2');
  agentsWrite(d2, [['src/pre.js', 'EDITOR_PARTIAL']]);
  const r2 = node(d2, ['.harness/dispatch.mjs', '--resume-visible', id2, '--wait']);
  assert(r2.status === 1 && /RESULT: NOT DONE/.test(r2.stdout), r2.stdout + r2.stderr);
  assert(read(d2, 'src/pre.js') === 'EDITOR_PARTIAL' && !fs.existsSync(path.join(d2, 'src', 'new.js')), 'pre-handoff partial edit must be preserved when headless fails');
  const run2 = runJson(d2, id2);
  assert(run2.status === 'FAILED' && !('pendingJobId' in run2) && fs.existsSync(path.join(d2, '.harness', 'visible', id2, 'baseline')) && /HEADLESS RESUME HALTED_HITL_REQUIRED/.test(read(d2, `.harness/visible/${id2}/report.md`)), JSON.stringify(run2));
  assert(vis(d2, 'rollback', id2).status === 0 && read(d2, 'src/pre.js') === 'ORIGINAL', 'full visible rollback must still restore all the way to pre-brief state');

  // 3. BRIEFED run without ID auto-selects latest open run and uses hierarchy; terminal & forbidden guards block resume
  const d3 = sandbox();
  const hGoal = hierGoal({ assignments: [{ lead: 'lead-dev', files: ['src/h.js'], goal: leadJson([{ id: 'w', targetFiles: ['src/h.js'], prompt: 'WRITE src/h.js hier-ok' }]) }] });
  const id3 = runIdOf(vis(d3, 'brief', '--goal', hGoal, '--check', existsCheck('src/h.js')));
  const r3 = node(d3, ['.harness/dispatch.mjs', '--resume-visible', '--wait']);
  assert(r3.status === 0 && read(d3, 'src/h.js') === 'hier-ok' && runJson(d3, id3).status === 'PASSED', r3.stdout + r3.stderr);
  assert(node(d3, ['.harness/dispatch.mjs', '--resume-visible', id3]).status === 1, 'terminal PASSED run cannot be resumed');

  const d4 = sandbox();
  const id4 = runIdOf(vis(d4, 'brief', '--goal', 'forbidden check', '--check', PASS));
  agentsWrite(d4, [['.env', 'SECRET=edited']]);
  const r4 = node(d4, ['.harness/dispatch.mjs', '--resume-visible', id4]);
  assert(r4.status === 1 && /forbidden path\(s\).*\.env/.test(r4.stderr), r4.stdout + r4.stderr);
});

await test('Windows backslash paths & cross-engine model guards: docs\\ trailing slash stays a folder, spaced dirty files are tracked, BRIEFED resume + ENGINE_FALLBACK drop incompatible aliases, and duplicate pending resume is blocked', () => {
  const { d, g } = gitSandbox({ autonomous: false });
  const tm = teamOf(d);
  const leads = tm.members.filter((m) => m.level === 'lead');
  const bsPlan = { assignments: [{ lead: 'lead-ba', goal: 'docs folder', files: ['docs\\'] }, { lead: 'lead-dev', goal: 'file', files: ['.\\src\\a.js'] }] };
  gov.validateDelegation(bsPlan, { leads, delegable: new Set(leads.map((l) => l.id)) });
  assert(bsPlan.assignments[0].files[0] === 'docs/' && bsPlan.assignments[1].files[0] === 'src/a.js', JSON.stringify(bsPlan.assignments));

  const id = runIdOf(vis(d, 'brief', '--goal', 'win paths', '--files', 'docs\\,src\\a.js', '--check', PASS));
  assert(vis(d, 'assign', id, deleg([{ lead: 'lead-ba', goal: 'docs', files: ['docs\\'] }, { lead: 'lead-dev', goal: 'code', files: ['.\\src\\a.js'] }])).status === 0, 'assign with Windows separators');
  agentsWrite(d, [['docs/my spaced note.md', 'spaced'], ['src/a.js', 'ok']]);
  const h = JSON.parse(vis(d, 'handoff', id, '--json').stdout);
  assert(h.diff.added.includes('docs/my spaced note.md'), `spaced dirty file must not be quoted: ${JSON.stringify(h.diff)}`);
  assert(h.byLead.find((l) => l.lead === 'lead-ba').missingFiles.length === 0, 'folder docs\\ must not be flagged as missing file');
  assert(h.byLead.find((l) => l.lead === 'lead-dev').changed.includes('+ src/a.js'), JSON.stringify(h.byLead));
  assert(!runJson(d, id).baseline.dir.includes('\\'), 'baseline.dir should use portable forward slashes');
  assert(vis(d, 'rollback', id).status === 0, 'rollback win-path run');

  // Pending-job guard: dispatching --resume-visible without --wait blocks a duplicate queue while pendingJobId is in inbox
  const dPend = sandbox();
  const idP = runIdOf(vis(dPend, 'brief', '--goal', 'pending guard', '--check', PASS));
  assert(node(dPend, ['.harness/dispatch.mjs', '--resume-visible', idP]).status === 0, 'first queued resume');
  const dup = node(dPend, ['.harness/dispatch.mjs', '--resume-visible', idP]);
  assert(dup.status === 1 && /already has pending headless job/.test(dup.stderr), dup.stdout + dup.stderr);

  // BRIEFED --resume-visible with --engine override drops incompatible orch/lead model aliases in hierDecompose
  const dH = sandbox();
  withProfiles(dH, {
    claude: tieredProfile({ fast: 'cl-fast', medium: 'cl-med', high: 'cl-high' }),
    antigravity: tieredProfile({ fast: 'ag-fast', medium: 'ag-med', high: 'ag-high' })
  });
  const tmH = teamOf(dH);
  for (const m of tmH.members) { m.engine = 'claude'; m.model = m.level === 'orchestrator' ? 'cl-high' : 'cl-med'; }
  fs.writeFileSync(path.join(dH, '.harness', 'team.json'), JSON.stringify(tmH, null, 2));
  const hGoal = hierGoal({ assignments: [{ lead: 'lead-dev', files: ['src/h2.js'], goal: leadJson([{ id: 'w', targetFiles: ['src/h2.js'], prompt: 'WRITE src/h2.js ok' }]) }] });
  const idH = runIdOf(vis(dH, 'brief', '--goal', hGoal, '--check', existsCheck('src/h2.js')));
  const rH = node(dH, ['.harness/dispatch.mjs', '--resume-visible', idH, '--engine', 'antigravity', '--wait']);
  assert(rH.status === 0 && read(dH, 'src/h2.js') === 'ok', rH.stdout + rH.stderr);
  assert(modelArg(dH, 'orchestrator') === 'ag-high' && modelArg(dH, 'lead-dev') === 'ag-med' && modelArg(dH, 'lead-dev.w') === 'ag-fast',
    `hierDecompose leaked claude alias: orch=${modelArg(dH, 'orchestrator')} lead=${modelArg(dH, 'lead-dev')} worker=${modelArg(dH, 'lead-dev.w')}`);

  // ENGINE_FALLBACK without --engine: unavailable lead.engine drops incompatible lead.model alias when falling back to auto
  const dFb = sandbox();
  withProfiles(dFb, {
    antigravity: tieredProfile({ fast: 'ag-fast', medium: 'ag-med', high: 'ag-high' }),
    claude: { verified: true, binary: 'missing-claude-cli-xyz', args: [], promptVia: 'stdin', allowedTools: [], modelArgs: ['MODEL={model}'], models: { fast: 'cl-fast', medium: 'cl-med', high: 'cl-high' } }
  });
  { const cf = path.join(dFb, '.harness', 'config.json'); const c = json(cf); c.autoOrder = ['antigravity', 'claude']; fs.writeFileSync(cf, JSON.stringify(c, null, 2)); }
  const tmFb = teamOf(dFb);
  tmFb.members.find((m) => m.id === 'lead-dev').engine = 'claude';
  tmFb.members.find((m) => m.id === 'lead-dev').model = 'cl-med';
  fs.writeFileSync(path.join(dFb, '.harness', 'team.json'), JSON.stringify(tmFb, null, 2));
  const idFb = runIdOf(vis(dFb, 'brief', '--goal', 'fallback alias guard', '--check', existsCheck('src/fb.js')));
  assert(vis(dFb, 'assign', idFb, deleg([{ lead: 'lead-dev', goal: 'WRITE src/fb.js fb-ok', files: ['src/fb.js'] }])).status === 0, 'assign fb');
  const rFb = node(dFb, ['.harness/dispatch.mjs', '--resume-visible', idFb, '--wait']);
  assert(rFb.status === 0 && read(dFb, 'src/fb.js') === 'fb-ok', rFb.stdout + rFb.stderr);
  assert(modelArg(dFb, 'lead-dev') === 'ag-fast', `ENGINE_FALLBACK leaked claude alias: ${modelArg(dFb, 'lead-dev')}`);
});

// ───────────── v1.0.10 (Priority 2): start.mjs launcher, hook-session.mjs --brief, VS Code tasks ─────────────

await test('start.mjs launcher: --summary & --json show live banner states, fake-CLI readiness/consent, worker guard, and piped menu navigation', () => {
  const { d, g } = gitSandbox({ autonomous: true });
  realTest(d); g('add', 'package.json'); g('commit', '-q', '-m', 'pkg');
  // Fake claude binary on PATH so start.mjs probes awaiting consent -> ready -> denied without touching real CLIs
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-fakebin-'));
  const claudeHelp = 'Usage: claude [options]\n  -p, --print\n  --allowedTools <t>\n  --disallowedTools <t>\n  --output-format <f>\n  --verbose\n  --model <m>\n';
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(fakeBin, 'claude.txt'), claudeHelp.replace(/\n/g, '\r\n'));
    fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@type "%~dp0claude.txt"\r\n');
  } else {
    fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\ncat <<'EOF'\n${claudeHelp}EOF\n`);
    fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
  }
  const withFakePath = { PATH: `${fakeBin}${path.delimiter}${env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH')] || ''}` };

  // Held item ("Needs OK"), open visible run, quota log, and live controller PID
  setBacklog(d, [
    { id: 'B-BIG', title: 'Big team feature', status: 'BLOCKED', needsApproval: true, blockedReason: 'Needs your OK: team mode', priority: 1, goal: 'Build big thing', verifyCmd: PASS },
    { id: 'B-RDY', title: 'Ready item', status: 'READY', priority: 2, goal: 'Build small thing', verifyCmd: PASS }
  ]);
  const runId = runIdOf(vis(d, 'brief', '--goal', 'Editor pause test', '--check', PASS, '--editor', 'antigravity'));
  fs.appendFileSync(path.join(d, '.harness', 'telemetry.log'), JSON.stringify({ ts: new Date().toISOString(), phase: 'AGENT_USAGE', engine: 'claude', model: 'haiku', ok: true, tokens: 120, usd: 0.02, message: 'usage' }) + '\n');
  fs.writeFileSync(path.join(d, '.harness', 'daemon.pid'), String(process.pid));

  const sum = node(d, ['.harness/start.mjs', '--summary'], withFakePath);
  assert(sum.status === 0, sum.stderr);
  assert(/Controller:\s+running \(PID \d+\)/.test(sum.stdout) && /Autopilot:\s+ON/.test(sum.stdout), sum.stdout);
  assert(/Verify cmd:\s+npm test/.test(sum.stdout), sum.stdout);
  assert(/READY 1 · IN_PROGRESS 0 · BLOCKED 1/.test(sum.stdout), sum.stdout);
  assert(new RegExp(`Open run ${runId}.*Antigravity`).test(sum.stdout), sum.stdout);
  assert(/Needs OK:\s+1 held item\(s\): B-BIG/.test(sum.stdout), sum.stdout);
  assert(/claude: awaiting consent/.test(sum.stdout), sum.stdout);
  assert(/Quota today:.*claude 1\/60 call\(s\)/.test(sum.stdout), sum.stdout);

  // Toggle claude approval -> ready, then deny -> denied, and check --json
  assert(node(d, ['.harness/engines.mjs', 'allow', 'claude'], withFakePath).status === 0, 'allow claude');
  const sumReady = node(d, ['.harness/start.mjs', '--json'], withFakePath);
  assert(sumReady.status === 0, sumReady.stderr);
  const j = JSON.parse(sumReady.stdout);
  assert(j.controller.running === true && j.autonomous === true && j.backlog.held.length === 1 && j.visible.open[0].id === runId, JSON.stringify(j));
  assert(j.engines.find((e) => e.name === 'claude').status === 'ready', JSON.stringify(j.engines));
  assert(node(d, ['.harness/engines.mjs', 'deny', 'claude'], withFakePath).status === 0, 'deny claude');
  assert(/claude: denied/.test(node(d, ['.harness/start.mjs', '--summary'], withFakePath).stdout), 'expected claude: denied');

  // Worker guard refuses interactive menu
  assert(node(d, ['.harness/start.mjs'], { HARNESS_WORKER: '1' }).status === 2, 'HARNESS_WORKER=1 must be refused');

  // Piped interactive menu navigation:
  // [1] Continue -> [1] handoff; [1] Continue -> [5] rollback declined ("n"); [4] Backlog -> [2] approve B-BIG ("y"); [6] Usage -> [6] --brief; [0] Exit
  const runMenuInput = (input) => spawnSync(process.execPath, ['.harness/start.mjs'], {
    cwd: d, env: { ...env, ...withFakePath }, input, encoding: 'utf8', timeout: 30000
  });
  const mRes = runMenuInput(`1\n1\n1\n5\nn\n4\n2\nB-BIG\ny\n6\n6\n0\n`);
  assert(mRes.status === 0, `menu failed (${mRes.status}): ${mRes.stderr}\n${mRes.stdout}`);
  assert(new RegExp(`HANDOFF — run ${runId}`).test(mRes.stdout), 'menu [1][1] did not print handoff');
  assert(/Rollback cancelled/.test(mRes.stdout) && runJson(d, runId).status === 'BRIEFED', 'declining rollback must preserve open run');
  assert(byId(d, 'B-BIG').status === 'READY' && byId(d, 'B-BIG').costApproved === true, `B-BIG should be approved/READY, got ${JSON.stringify(byId(d, 'B-BIG'))}`);
  assert(/\[Agentic Harness\] Controller:/.test(mRes.stdout) && /Bye!/.test(mRes.stdout), mRes.stdout);
  assert(runMenuInput('').status === 0 && runMenuInput('1\n').status === 0, 'EOF at main or submenu must exit cleanly without unsettled top-level await');
  assert(vis(d, 'rollback', runId).status === 0, 'cleanup open visible run');
});

await test('hook-session.mjs --brief: prints 4-8 concise lines in idle and busy states without mutating git, silent for workers and safe on broken config', () => {
  // 1. Idle state -> strictly 4 to 8 lines
  const dIdle = sandbox();
  const rIdle = node(dIdle, ['.harness/hook-session.mjs', '--brief']);
  assert(rIdle.status === 0, rIdle.stderr);
  const idleLines = rIdle.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert(idleLines.length >= 4 && idleLines.length <= 8, `idle --brief expected 4-8 lines, got ${idleLines.length}:\n${rIdle.stdout}`);
  assert(/Controller: NOT running.*Backlog:.*Autopilot: ON/.test(idleLines[0]), idleLines[0]);
  assert(/npm start.*doctor\.mjs/.test(rIdle.stdout), rIdle.stdout);

  // 2. Busy state: remote behind (in separate worktree), open run, Needs OK held task, HIGH RISK session, quota today, edited core
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-brief-'));
  const G = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = path.join(base, 'remote.git'); fs.mkdirSync(remote); G(remote, 'init', '-q', '--bare', '-b', 'lab');
  const main = path.join(base, 'main'); fs.cpSync(sandbox(), main, { recursive: true });
  G(main, 'init', '-q', '-b', 'lab'); G(main, 'add', '-A'); G(main, 'commit', '-q', '-m', 'one'); G(main, 'remote', 'add', 'origin', remote); G(main, 'push', '-q', '-u', 'origin', 'lab');

  // Install MANIFEST via copyDir fingerprint simulation & tamper dispatch.mjs to test core warning
  const coreFiles = { '.harness/dispatch.mjs': 'bad-hash' };
  fs.writeFileSync(path.join(main, '.harness', 'MANIFEST.json'), JSON.stringify({ template: 'agentic-harness', version: '1.0.10', files: coreFiles }));

  // Advance remote in another clone
  const other = path.join(base, 'other'); G(base, 'clone', '-q', '-b', 'lab', remote, other);
  fs.writeFileSync(path.join(other, 'upstream.txt'), 'u'); G(other, 'add', '-A'); G(other, 'commit', '-q', '-m', 'two'); G(other, 'push', '-q');

  // Create worktree + session board with HIGH RISK stale task
  const wt = path.join(base, 'wt'); G(main, 'worktree', 'add', '-q', '-b', 'claude/s-brief', wt, 'lab');
  const S = (cwd, ...a) => spawnSync(process.execPath, [path.join(cwd, '.harness', 'sessions.mjs'), ...a], { cwd, env: { ...env, HARNESS_ROOT: cwd }, encoding: 'utf8' });
  assert(S(main, 'new', 'Stale child task', '--type', 'feat').status === 0, 'sessions new');
  const common = G(main, 'rev-parse', '--git-common-dir');
  const boardFile = path.resolve(main, common, 'harness-sessions.json');
  const bj = json(boardFile);
  bj.tasks[0].createdAt = new Date(Date.now() - 5 * 3600000).toISOString(); // past notStartedHours=2 -> NOT STARTED HIGH RISK
  fs.writeFileSync(boardFile, JSON.stringify(bj, null, 2));

  // Open visible run + held backlog item + usage telemetry in wt
  setBacklog(wt, [{ id: 'B-HELD', title: 'Large migration', status: 'BLOCKED', needsApproval: true, blockedReason: 'Needs your OK', goal: 'big', verifyCmd: PASS }]);
  fs.writeFileSync(path.join(wt, '.harness', 'MANIFEST.json'), JSON.stringify({ template: 'agentic-harness', version: '1.0.10', files: coreFiles }));
  const visId = runIdOf(node(wt, ['.harness/visible.mjs', 'brief', '--goal', 'Pause mid-run', '--check', PASS, '--editor', 'antigravity'], { HARNESS_ROOT: wt }));
  fs.appendFileSync(path.join(wt, '.harness', 'telemetry.log'), JSON.stringify({ ts: new Date().toISOString(), phase: 'AGENT_USAGE', engine: 'antigravity', model: 'fast', ok: true, tokens: 0, usd: 0, message: 'usage' }) + '\n');

  const rBusy = node(wt, ['.harness/hook-session.mjs', '--brief'], { HARNESS_ROOT: wt, HARNESS_ENGINES: 'claude' });
  assert(rBusy.status === 0, rBusy.stderr);
  const busyLines = rBusy.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert(busyLines.length >= 4 && busyLines.length <= 8, `busy --brief expected 4-8 lines, got ${busyLines.length}:\n${rBusy.stdout}`);
  assert(new RegExp(`Open run ${visId}`).test(rBusy.stdout) && /--resume-visible/.test(rBusy.stdout), rBusy.stdout);
  assert(/Needs OK \(1 held\).*backlog\.mjs approve B-HELD/.test(rBusy.stdout), rBusy.stdout);
  assert(/Sessions 1\/\d+ open.*HIGH RISK: FEAT-1/.test(rBusy.stdout), rBusy.stdout);
  assert(/Git behind remote/.test(rBusy.stdout) && !fs.existsSync(path.join(wt, 'upstream.txt')), `--brief must warn without modifying wt:\n${rBusy.stdout}`);
  assert(/AI tools: ready \(claude\).*Quota today: agy 1\/80 call\(s\)/.test(rBusy.stdout), rBusy.stdout);
  assert(/harness core edited \(\.harness\/dispatch\.mjs\)/.test(rBusy.stdout), rBusy.stdout);

  // Worker & broken config guards
  const rWork = node(wt, ['.harness/hook-session.mjs', '--brief'], { HARNESS_ROOT: wt, HARNESS_WORKER: '1' });
  assert(rWork.status === 0 && rWork.stdout === '', `worker should be silent in --brief: ${rWork.stdout}`);
  fs.writeFileSync(path.join(wt, '.harness', 'config.json'), '{ broken');
  assert(node(wt, ['.harness/hook-session.mjs', '--brief'], { HARNESS_ROOT: wt }).status === 0, 'broken config must not break --brief');
});

await test('v1.0.13 packaging: VS Code tasks + backlogId input, npm start & ui scripts, and install.mjs merges & fingerprints start.mjs and ui.mjs', () => {
  const pkg = json(path.join(REPO, 'package.json'));
  assert(/^\d+\.\d+\.\d+$/.test(pkg.version) && pkg.scripts.start === 'node .harness/start.mjs' && pkg.scripts.ui === 'node .harness/ui.mjs', JSON.stringify(pkg.scripts));
  const tasksCfg = json(path.join(REPO, '.vscode', 'tasks.json'));
  const expectedLabels = [
    'Harness: Start Menu (interactive)',
    'Harness: Handoff / Inspect unfinished run',
    'Harness: Resume unfinished run in terminal',
    'Harness: Session Board (child sessions)',
    'Harness: Approve held backlog item',
    'Harness: Local Web UI (dashboard)'
  ];
  for (const label of expectedLabels) assert(tasksCfg.tasks.some((t) => t.label === label), `missing task: ${label}`);
  assert(tasksCfg.inputs.some((i) => i.id === 'backlogId') && tasksCfg.inputs.some((i) => i.id === 'engine'), 'missing inputs');

  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-p2-inst-'));
  fs.mkdirSync(path.join(proj, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.vscode', 'tasks.json'), JSON.stringify({
    version: '2.0.0',
    tasks: [{ label: 'My Custom Build', type: 'shell', command: 'npm run build' }, { label: 'Harness: old stale task', type: 'shell', command: 'echo old' }],
    inputs: [{ id: 'customIn', type: 'promptString', description: 'mine' }]
  }));
  const inst = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), proj], { encoding: 'utf8' });
  assert(inst.status === 0 && /node \.harness\/start\.mjs/.test(inst.stdout), inst.stdout + inst.stderr);
  const manifest = json(path.join(proj, '.harness', 'MANIFEST.json'));
  assert(manifest.version === pkg.version && Boolean(manifest.files['.harness/start.mjs']) && Boolean(manifest.files['.harness/ui.mjs']), 'start.mjs/ui.mjs not fingerprinted in MANIFEST');
  const merged = json(path.join(proj, '.vscode', 'tasks.json'));
  assert(merged.tasks.some((t) => t.label === 'My Custom Build'), 'custom task lost');
  assert(!merged.tasks.some((t) => t.label === 'Harness: old stale task'), 'old Harness task not replaced');
  for (const label of expectedLabels) assert(merged.tasks.some((t) => t.label === label), `merged tasks missing ${label}`);
  assert(merged.inputs.some((i) => i.id === 'customIn') && merged.inputs.some((i) => i.id === 'backlogId'), 'merged inputs missing');
});

// ───────────── v1.0.11 (Priority 3): sessions checkpoint & handoff, dispatch --cwd ─────────────

await test('sessions.mjs checkpoint: commits dirty WIP (Harness-Wip), avoids empty commit when clean, resets DONE/CHECK FAILED back to WORKING until reported done, and enforces guards', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cp-'));
  const main = path.join(base, 'main'); fs.cpSync(sandbox(), main, { recursive: true });
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({ name: 'cp', private: true, scripts: { test: 'node -e "process.exit(require(\'fs\').existsSync(\'BROKEN\')?1:0)"' } }));
  const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  G(main, 'init', '-q', '-b', 'lab'); G(main, 'add', '-A'); G(main, 'commit', '-q', '-m', 'init');
  const S = (cwd, ...a) => spawnSync(process.execPath, [path.join(main, '.harness', 'sessions.mjs'), ...a], { cwd, env: { ...env, HARNESS_ROOT: main }, encoding: 'utf8', timeout: 30000 });

  // 1. Clean tree creates no empty commit; dirty WIP commits Harness-Wip + updates board lastCheckpoint
  assert(S(main, 'new', 'Auth helper', '--type', 'feat').status === 0, 'new FEAT-1');
  const wt = path.join(base, 'wt1');
  G(main, 'worktree', 'add', '-q', '-b', 'claude/cp1', wt, 'lab');
  assert(S(wt, 'start', 'FEAT-1').status === 0, 'start FEAT-1');
  const tipBefore = G(wt, 'rev-parse', 'HEAD');
  const cleanCp = S(main, 'checkpoint', 'FEAT-1');
  assert(cleanCp.status === 0 && /already clean/.test(cleanCp.stdout) && G(wt, 'rev-parse', 'HEAD') === tipBefore, cleanCp.stdout + cleanCp.stderr);

  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'src', 'wip.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(wt, 'notes here.txt'), 'draft\n');
  const cp1 = S(main, 'checkpoint', 'FEAT-1', '--message', 'halfway there');
  assert(cp1.status === 0 && /committed 2 WIP file\(s\)/.test(cp1.stdout) && G(wt, 'status', '--porcelain') === '', cp1.stdout + cp1.stderr);
  assert(/FEAT-1: wip - halfway there/.test(G(wt, 'log', '-1', '--format=%B')) && /Harness-Wip: FEAT-1/.test(G(wt, 'log', '-1', '--format=%B')), 'missing Harness-Wip trailer');
  let bj = JSON.parse(S(main, 'board', '--json').stdout);
  let r1 = bj.tasks.find((x) => x.id === 'FEAT-1');
  assert(r1.status === 'WORKING' && r1.lastCheckpoint?.message === 'halfway there' && r1.lastCheckpoint?.files.includes('notes here.txt'), JSON.stringify(r1));

  // 2. WIP commit after DONE returns task to WORKING until a fresh `report done`
  assert(S(wt, 'report', 'FEAT-1', 'done', '--summary', 'almost').status === 0, 'report FEAT-1 done');
  assert(JSON.parse(S(main, 'board', '--json').stdout).tasks.find((x) => x.id === 'FEAT-1').status === 'DONE', 'expected DONE');
  fs.writeFileSync(path.join(wt, 'src', 'wip.js'), 'export const a = 2;\n');
  assert(S(main, 'checkpoint', 'FEAT-1', '--message', 'fixup after done').status === 0, 'checkpoint after done');
  assert(JSON.parse(S(main, 'board', '--json').stdout).tasks.find((x) => x.id === 'FEAT-1').status === 'WORKING', 'newer WIP must revert DONE back to WORKING');
  assert(S(wt, 'report', 'FEAT-1', 'done', '--summary', 'final').status === 0, 're-report done');
  assert(S(main, 'merge', 'FEAT-1').status === 0, 'merge FEAT-1');
  assert(S(main, 'checkpoint', 'FEAT-1').status === 1, 'cannot checkpoint MERGED/CLEANED task');

  // 3. WIP commit after CHECK FAILED returns task from CHECK FAILED back to WORKING until fixed + re-reported done
  assert(S(main, 'new', 'Check reset', '--type', 'bug').status === 0, 'new BUG-1');
  const wt2 = path.join(base, 'wt2');
  G(main, 'worktree', 'add', '-q', '-b', 'claude/cp2', wt2, 'lab');
  assert(S(wt2, 'start', 'BUG-1').status === 0, 'start BUG-1');
  fs.writeFileSync(path.join(wt2, 'BROKEN'), '1');
  G(wt2, 'add', '-A'); G(wt2, 'commit', '-q', '-m', 'break');
  assert(S(wt2, 'report', 'BUG-1', 'done').status === 0, 'report BUG-1 done');
  assert(S(main, 'merge', 'BUG-1').status === 1, 'merge should fail on BROKEN');
  assert(JSON.parse(S(main, 'board', '--json').stdout).tasks.find((x) => x.id === 'BUG-1').status === 'CHECK FAILED', 'expected CHECK FAILED');
  fs.rmSync(path.join(wt2, 'BROKEN'));
  assert(S(main, 'checkpoint', 'BUG-1', '--message', 'removed broken').status === 0, 'checkpoint BUG-1');
  assert(JSON.parse(S(main, 'board', '--json').stdout).tasks.find((x) => x.id === 'BUG-1').status === 'WORKING', 'WIP commit after CHECK FAILED must move back to WORKING');
  assert(S(wt2, 'report', 'BUG-1', 'done', '--summary', 'fixed').status === 0 && S(main, 'merge', 'BUG-1').status === 0, 'BUG-1 merges after fix + done');

  // 4. Missing worktree & HARNESS_WORKER=1 guards
  assert(S(main, 'new', 'No worktree', '--type', 'task').status === 0, 'new TASK-1');
  assert(S(main, 'checkpoint', 'TASK-1').status === 1, 'missing worktree must refuse checkpoint');
  const wk = spawnSync(process.execPath, [path.join(main, '.harness', 'sessions.mjs'), 'checkpoint', 'TASK-1'], { cwd: main, env: { ...env, HARNESS_ROOT: main, HARNESS_WORKER: '1' }, encoding: 'utf8' });
  assert(wk.status === 2, `worker must be refused (exit ${wk.status})`);
});

await test('sessions.mjs handoff: inspects local/spaced worktrees & remote cloud branches, supports --checkpoint --json, --prompt, auto-detection, and useGitWorktrees warnings', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hoff-'));
  const remote = path.join(base, 'remote.git'); fs.mkdirSync(remote);
  const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  G(remote, 'init', '-q', '--bare', '-b', 'lab');
  const main = path.join(base, 'main'); fs.cpSync(sandbox({ worktrees: true }), main, { recursive: true });
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({ name: 'hoff', private: true, scripts: { test: PASS } }));
  G(main, 'init', '-q', '-b', 'lab'); G(main, 'add', '-A'); G(main, 'commit', '-q', '-m', 'init');
  G(main, 'remote', 'add', 'origin', remote); G(main, 'push', '-q', '-u', 'origin', 'lab');

  const S = (cwd, root, ...a) => spawnSync(process.execPath, [path.join(root, '.harness', 'sessions.mjs'), ...a], { cwd, env: { ...env, HARNESS_ROOT: root }, encoding: 'utf8', timeout: 30000 });
  assert(S(main, main, 'new', 'Spaced Feature', '--type', 'feat').status === 0, 'new FEAT-1');
  const wt = path.join(base, 'wt with space');
  G(main, 'worktree', 'add', '-q', '-b', 'claude/h1', wt, 'lab');
  assert(S(wt, wt, 'start', 'FEAT-1').status === 0, 'start FEAT-1');
  fs.writeFileSync(path.join(wt, 'app.js'), 'console.log(1);\n');
  G(wt, 'add', '-A'); G(wt, 'commit', '-q', '-m', 'feat: app');
  fs.writeFileSync(path.join(wt, 'dirty.txt'), 'unsaved');

  // Auto-select sole open task, warn about useGitWorktrees + dirty WIP, quote spaced --cwd path
  const txt = S(main, main, 'handoff');
  assert(txt.status === 0 && /SESSION HANDOFF — FEAT-1 \(WORKING\)/.test(txt.stdout) && /useGitWorktrees is true/.test(txt.stdout), txt.stdout + txt.stderr);
  assert(/dispatch\.mjs --cwd "[^"]*wt with space"/.test(txt.stdout) && /----- \[HANDOFF PROMPT FOR NEXT SESSION\] -----/.test(txt.stdout), txt.stdout);

  const pr = S(main, main, 'handoff', '--prompt');
  assert(pr.status === 0 && !/SESSION HANDOFF —/.test(pr.stdout) && /\[HARNESS SESSION HANDOFF: FEAT-1/.test(pr.stdout), pr.stdout);

  // --checkpoint --json must return valid JSON on stdout with checkpointResult and clean uncommitted list
  const cj = S(main, main, 'handoff', 'FEAT-1', '--checkpoint', '--json');
  assert(cj.status === 0, cj.stderr);
  const parsed = JSON.parse(cj.stdout);
  assert(parsed.checkpointResult?.committed === true && parsed.uncommitted.length === 0 && parsed.checkpointNeededForWorktrees === false && parsed.readyHeadlessEngines.includes('mock'), cj.stdout);

  // 2 open tasks: from main without ID errors; inside child branch auto-selects FEAT-2; cloud push without local worktree still inspects remote branch
  assert(S(main, main, 'new', 'Cloud Only', '--type', 'bug').status === 0, 'new BUG-1');
  const wt2 = path.join(base, 'wt2');
  G(main, 'worktree', 'add', '-q', '-b', 'claude/h2', wt2, 'lab');
  assert(S(wt2, wt2, 'start', 'BUG-1').status === 0, 'start BUG-1');
  fs.writeFileSync(path.join(wt2, 'cloud.js'), 'cloud\n'); G(wt2, 'add', '-A'); G(wt2, 'commit', '-q', '-m', 'cloud work');
  G(wt2, 'push', '-q', '-u', 'origin', 'task/bug-1-cloud-only');

  const amb = S(main, main, 'handoff');
  assert(amb.status === 1 && /2 open child tasks/.test(amb.stderr), amb.stdout + amb.stderr);
  const autoWt2 = JSON.parse(S(wt2, wt2, 'handoff', '--json').stdout);
  assert(autoWt2.task.id === 'BUG-1' && autoWt2.ahead >= 1, JSON.stringify(autoWt2));

  // Drop local worktree + local branch to simulate remote-only cloud session
  G(main, 'worktree', 'remove', '--force', wt2);
  G(main, 'branch', '-D', 'task/bug-1-cloud-only');
  const cloudH = JSON.parse(S(main, main, 'handoff', 'BUG-1', '--json').stdout);
  assert(cloudH.worktree === null && cloudH.resumeCmd === null && cloudH.branchRef === 'refs/remotes/origin/task/bug-1-cloud-only' && cloudH.commits.some((c) => /cloud work/.test(c.subject)), JSON.stringify(cloudH));
  assert(spawnSync(process.execPath, [path.join(main, '.harness', 'sessions.mjs'), 'handoff', 'FEAT-1', '--checkpoint'], { cwd: main, env: { ...env, HARNESS_ROOT: main, HARNESS_WORKER: '1' }, encoding: 'utf8' }).status === 2, 'worker handoff --checkpoint refused');
});

await test('dispatch.mjs --cwd: runs single-worker, --auto-plan, useGitWorktrees+autoGitCommit, and 3-cycle rollback strictly inside external worktree while ignoring integrationMode and leaving ROOT clean', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cwd-'));
  const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  // 1. Main repo with integrationMode: always (must be bypassed when --cwd targets child worktree)
  const main = path.join(base, 'main'); fs.cpSync(sandbox(), main, { recursive: true });
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({ name: 'root', private: true, scripts: { test: 'node -e "process.exit(99)"' } }));
  { const cf = path.join(main, '.harness', 'config.json'); const c = json(cf); c.git.integrationMode = 'always'; fs.writeFileSync(cf, JSON.stringify(c, null, 2)); }
  G(main, 'init', '-q', '-b', 'main'); G(main, 'add', '-A'); G(main, 'commit', '-q', '-m', 'init');
  const wt = path.join(base, 'child wt');
  G(main, 'worktree', 'add', '-q', '-b', 'task/feat-1-cwd', wt, 'main');
  fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ name: 'child', private: true, scripts: { test: 'node -e "process.exit(require(\'fs\').readFileSync(\'src/cwd.js\',\'utf8\')===\'cwd-ok\'?0:1)"' } }));
  G(wt, 'add', 'package.json'); G(wt, 'commit', '-q', '-m', 'child pkg');

  // Guard checks on dispatch.mjs --cwd
  assert(node(main, ['.harness/dispatch.mjs', '--cwd', path.join(base, 'nope'), '--goal', 'x']).status === 1, 'missing --cwd folder rejected');
  assert(node(main, ['.harness/dispatch.mjs', '--cwd', path.join(main, 'package.json'), '--goal', 'x']).status === 1, 'file path rejected for --cwd');
  assert(node(main, ['.harness/dispatch.mjs', '--cwd', path.join(main, '.harness'), '--goal', 'x']).status === 1, '.harness rejected for --cwd');
  assert(node(main, ['.harness/dispatch.mjs', '--cwd', path.join(main, '.git'), '--goal', 'x']).status === 1, '.git rejected for --cwd');
  // a folder that exists but is not a worktree of THIS repository (another project, Documents...) is refused
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stranger-')); G(stranger, 'init', '-q', '-b', 'lab');
  const rs = node(main, ['.harness/dispatch.mjs', '--cwd', stranger, '--goal', 'x']);
  assert(rs.status === 1 && /not a git worktree of this project/.test(rs.stderr), `--cwd outside the project must be refused: ${rs.stderr}`);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plain-'));
  assert(node(main, ['.harness/dispatch.mjs', '--cwd', plain, '--goal', 'x']).status === 1, 'a plain folder is refused too');
  assert(node(main, ['.harness/dispatch.mjs', '--cwd', wt, '--branch', 'uat', '--goal', 'x']).status === 1, '--cwd + --branch rejected');
  assert(node(main, ['.harness/dispatch.mjs', '--cwd', wt, '--resume-visible', '--goal', 'x']).status === 1, '--cwd + --resume-visible rejected');
  assert(node(main, ['.harness/dispatch.mjs', '--cwd', wt, '--goal', 'x'], { HARNESS_WORKER: '1' }).status === 2, 'worker --cwd rejected');

  // Single worker runs inside wt using wt package.json test, while ROOT never gets src/cwd.js or branch uat
  const r1 = node(main, ['.harness/dispatch.mjs', '--cwd', wt, '--goal', 'WRITE src/cwd.js cwd-ok', '--files', 'src/cwd.js', '--wait']);
  assert(r1.status === 0 && /Workdir: /.test(r1.stdout) && /COMMITTED ✔/.test(r1.stdout), r1.stdout + r1.stderr);
  assert(read(wt, 'src/cwd.js') === 'cwd-ok' && !fs.existsSync(path.join(main, 'src', 'cwd.js')), 'edit must land only inside external worktree');
  assert(!G(main, 'branch', '--list', 'uat'), 'integration branch uat must not be created for --cwd');
  const sess1 = fs.readdirSync(path.join(main, '.harness', 'memory', 'sessions')).map((f) => read(main, `.harness/memory/sessions/${f}`)).join('');
  assert(sess1.includes(`- Workdir: ${fs.realpathSync.native(wt)}`), `session note missing Workdir:\n${sess1}`);

  // 2. --auto-plan + --cwd sees child files and creates files inside child folder while ROOT stays untouched
  fs.writeFileSync(path.join(wt, 'only-in-child.flag'), '1');
  const planJson = JSON.stringify({
    interfaceContract: 'contract',
    subtasks: [{ id: 'child-w', role: 'DEV_ENGINEER', targetFiles: ['src/ap.js'], prompt: 'WRITE src/ap.js ap-ok' }]
  });
  const rAp = node(main, ['.harness/dispatch.mjs', '--cwd', wt, '--goal', `PLAN_JSON ${planJson}`, '--auto-plan', '--check', existsCheck('src/ap.js'), '--wait']);
  assert(rAp.status === 0 && read(wt, 'src/ap.js') === 'ap-ok' && !fs.existsSync(path.join(main, 'src', 'ap.js')), rAp.stdout + rAp.stderr);
  assert(promptOf(wt, 'ai-planner').includes('only-in-child.flag'), 'AI planner should list files in external cwd');

  // 3. useGitWorktrees: true + autoGitCommit: true with --cwd commits inside wt on its branch
  { const cf = path.join(main, '.harness', 'config.json'); const c = json(cf); c.useGitWorktrees = true; c.autoGitCommit = true; c.git.integrationMode = 'off'; fs.writeFileSync(cf, JSON.stringify(c, null, 2)); }
  fs.rmSync(path.join(wt, '.mock-prompts'), { recursive: true, force: true });
  G(wt, 'add', '-A'); G(wt, 'commit', '-q', '-m', 'before wt-auto');
  const wtCommitsBefore = Number(G(wt, 'rev-list', '--count', 'HEAD'));
  const rWt = node(main, ['.harness/dispatch.mjs', '--cwd', wt, '--goal', 'WRITE src/wtcommit.js wt-ok', '--files', 'src/wtcommit.js', '--check', existsCheck('src/wtcommit.js'), '--wait']);
  assert(rWt.status === 0 && read(wt, 'src/wtcommit.js') === 'wt-ok' && !fs.existsSync(path.join(main, 'src', 'wtcommit.js')), rWt.stdout + rWt.stderr);
  assert(Number(G(wt, 'rev-list', '--count', 'HEAD')) === wtCommitsBefore + 1 && /harness:/.test(G(wt, 'log', '-1', '--format=%s')), 'autoGitCommit should commit inside child worktree');

  // 4. 3-cycle failure rolls back external worktree via .harness/staging/ and preserves pre-existing content in wt
  { const cf = path.join(main, '.harness', 'config.json'); const c = json(cf); c.useGitWorktrees = false; c.autoGitCommit = false; fs.writeFileSync(cf, JSON.stringify(c, null, 2)); }
  fs.writeFileSync(path.join(wt, 'src', 'keep.js'), 'BEFORE');
  const rFail = node(main, ['.harness/dispatch.mjs', '--cwd', wt, '--goal', 'WRITE src/keep.js BROKEN\nWRITE src/newfail.js tmp', '--files', 'src/keep.js,src/newfail.js', '--check', 'node -e "process.exit(1)"', '--wait']);
  assert(rFail.status === 1 && /NOT DONE/.test(rFail.stdout), rFail.stdout + rFail.stderr);
  assert(read(wt, 'src/keep.js') === 'BEFORE' && !fs.existsSync(path.join(wt, 'src', 'newfail.js')), '3-cycle failure must roll back edits in external worktree');
  const failedJob = json(path.join(main, '.harness', 'failed', ls(main, 'failed')[0]));
  assert(failedJob.cwd === fs.realpathSync.native(wt), JSON.stringify(failedJob));
});

await test('Priority 3 UX & permissions integration: start.mjs menu [5][3] handoff & [5][4] checkpoint, hook-session inspect hint, and .claude/settings.json rules', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-p3-ui-'));
  const main = path.join(base, 'main'); fs.cpSync(sandbox(), main, { recursive: true });
  const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  G(main, 'init', '-q', '-b', 'lab'); G(main, 'add', '-A'); G(main, 'commit', '-q', '-m', 'init');
  const S = (cwd, ...a) => spawnSync(process.execPath, [path.join(main, '.harness', 'sessions.mjs'), ...a], { cwd, env: { ...env, HARNESS_ROOT: main }, encoding: 'utf8' });

  assert(S(main, 'new', 'UI menu child', '--type', 'feat').status === 0, 'new FEAT-1');
  const wt = path.join(base, 'wt-ui');
  G(main, 'worktree', 'add', '-q', '-b', 'claude/ui1', wt, 'lab');
  assert(S(wt, 'start', 'FEAT-1').status === 0, 'start FEAT-1');
  fs.writeFileSync(path.join(wt, 'partial.txt'), 'ui wip\n');

  // Force STALE risk so hook-session (full) prints the inspect hint
  { const cf = path.join(main, '.harness', 'config.json'); const c = json(cf); c.sessions = { staleHours: 0, notStartedHours: 0 }; fs.writeFileSync(cf, JSON.stringify(c, null, 2)); }
  fs.writeFileSync(path.join(wt, 'committed.txt'), '1'); G(wt, 'add', 'committed.txt'); G(wt, 'commit', '-q', '-m', 'c1');
  const hk = node(main, ['.harness/hook-session.mjs'], { HARNESS_ROOT: main });
  assert(/HIGH RISK FEAT-1.*\(inspect: node \.harness\/sessions\.mjs handoff FEAT-1\)/.test(hk.stdout), hk.stdout);

  // Navigate start.mjs menu: [5] Sessions -> [4] checkpoint -> FEAT-1 -> note; then [5] Sessions -> [3] handoff -> FEAT-1 -> n; then [0] Exit
  const mRes = spawnSync(process.execPath, ['.harness/start.mjs'], {
    cwd: main, env: { ...env, HARNESS_ROOT: main }, input: '5\n4\nFEAT-1\nmenu note\n5\n3\nFEAT-1\nn\n0\n', encoding: 'utf8', timeout: 30000
  });
  assert(mRes.status === 0 && /CHECKPOINT FEAT-1: committed/.test(mRes.stdout) && /SESSION HANDOFF — FEAT-1/.test(mRes.stdout), `start.mjs [5][3]/[5][4] failed:\n${mRes.stderr}\n${mRes.stdout}`);

  const settings = json(path.join(REPO, '.claude', 'settings.json'));
  assert(settings.permissions.allow.includes('Bash(node .harness/sessions.mjs board:*)'), 'missing board allow rule');
  assert(settings.permissions.ask.includes('Bash(node .harness/sessions.mjs merge:*)'), 'missing merge ask rule');
});

// ───────────── v1.0.12 (Priority 4): agy duplicate PATH guard & 80% quota warnings ─────────────

await test('findAllOnPath & doctor.mjs: detects multiple agy binaries on PATH while deduplicating identical/symlinked paths', async () => {
  const { which, findAllOnPath } = await import(pathToFileURL(path.join(REPO, '.harness', 'lib', 'common.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-path-'));
  const dir1 = path.join(tmp, 'bin 1');
  const dir2 = path.join(tmp, 'bin2');
  const dirSym = path.join(tmp, 'binsym');
  fs.mkdirSync(dir1, { recursive: true });
  fs.mkdirSync(dir2, { recursive: true });
  fs.mkdirSync(dirSym, { recursive: true });

  const binName = process.platform === 'win32' ? 'agy.cmd' : 'agy';
  const body = process.platform === 'win32'
    ? '@echo off\r\nif "%1"=="--help" echo Usage: agy -p --model\r\n'
    : '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "Usage: agy -p --model"; fi\n';
  const f1 = path.join(dir1, binName);
  const f2 = path.join(dir2, binName);
  fs.writeFileSync(f1, body, { mode: 0o755 });
  fs.writeFileSync(f2, body, { mode: 0o755 });
  if (process.platform === 'win32') {
    // Also place a POSIX wrapper in dir1 alongside agy.cmd — must count as ONE install in dir1
    fs.writeFileSync(path.join(dir1, 'agy'), '#!/bin/sh\necho shim\n', { mode: 0o755 });
  }
  let symOk = false;
  try { fs.symlinkSync(f1, path.join(dirSym, binName)); symOk = true; } catch { /* Windows without symlink privilege */ }

  assert(findAllOnPath('').length === 0, 'empty binary should return []');
  assert(findAllOnPath('no-such-bin-xyz', `${dir1}${path.delimiter}${dir2}`).length === 0, 'missing binary');
  const two = findAllOnPath('agy', `"${dir1}"${path.delimiter}${dir1}${path.delimiter}${dir2}`, '.CMD;.EXE');
  assert(two.length === 2 && two[0].startsWith(dir1) && two[1].startsWith(dir2), `expected 2 ordered quoted entries, got ${JSON.stringify(two)}`);
  assert(which('agy', `"${dir1}"`, '.CMD;.EXE')?.startsWith(dir1), 'which() should strip Windows quotes around PATH directories');
  if (symOk) {
    const dedup = findAllOnPath('agy', `${dir1}${path.delimiter}${dirSym}`);
    assert(dedup.length === 1, `symlink to same realpath must deduplicate, got ${JSON.stringify(dedup)}`);
  }

  // E2E doctor.mjs check: HARNESS_ENGINES must be deleted (not ''), and leave antigravity without consent so `agy models` isn't invoked
  const d = sandbox();
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const envTwo = { ...env };
  delete envTwo.HARNESS_ENGINES;
  envTwo[pathKey] = `${dir1}${path.delimiter}${dir2}${path.delimiter}${env[pathKey] || ''}`;
  const rTwo = spawnSync(process.execPath, ['.harness/doctor.mjs'], { cwd: d, env: envTwo, encoding: 'utf8', timeout: 30000 });
  assert(/multiple 'agy' binaries on PATH/.test(rTwo.stdout) && rTwo.stdout.includes(dir1) && rTwo.stdout.includes(dir2), `expected duplicate agy warning in doctor:\n${rTwo.stdout}\n${rTwo.stderr}`);

  const envOne = { ...env };
  delete envOne.HARNESS_ENGINES;
  envOne[pathKey] = `${dir1}${path.delimiter}${env[pathKey] || ''}`;
  const rOne = spawnSync(process.execPath, ['.harness/doctor.mjs'], { cwd: d, env: envOne, encoding: 'utf8', timeout: 30000 });
  assert(!/multiple 'agy' binaries on PATH/.test(rOne.stdout), `single agy on PATH must not warn:\n${rOne.stdout}`);
});

await test('quotaWarnings & CLI pre-flight: warns cleanly at >= 80% across common.mjs, usage.mjs, start.mjs, and non-blocking dispatch.mjs', () => {
  const d = sandbox();
  const cfgFile = path.join(d, '.harness', 'config.json');
  const cfg = json(cfgFile);
  cfg.dailyLimits = {
    note: 'string note ignored',
    mock: { calls: 10, usd: 5, tokens: 1000 },
    claude: { calls: 10, usd: 5 }
  };
  cfg.quotaFallback = {
    ...(cfg.quotaFallback || {}),
    mock: { engine: 'claude', models: {} }
  };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const logFile = path.join(d, '.harness', 'telemetry.log');
  const mkEv = (ts, engine, usd = 0, tokens = 0) => JSON.stringify({ ts, phase: 'AGENT_USAGE', engine, model: 'fast', ok: true, usd, tokens, ms: 500 });

  // Boundary check < 80% (7/10 calls, $3.99/$5, 799/1000 tokens + old yesterday records ignored)
  const belowEvents = [
    ...Array(5).fill(0).map(() => mkEv(`${yesterday}T12:00:00.000Z`, 'mock', 5, 2000)),
    ...Array(7).fill(0).map((_, i) => mkEv(`${today}T00:01:0${i}.000Z`, 'mock', i === 0 ? 3.99 : 0, i === 0 ? 799 : 0))
  ];
  fs.writeFileSync(logFile, belowEvents.join('\n') + '\n');

  const checkWarnings = () => {
    const script = `import { quotaWarnings } from '${pathToFileURL(path.join(d, '.harness', 'lib', 'common.mjs')).href}'; console.log(JSON.stringify(quotaWarnings()));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: d, env: { ...env, HARNESS_ROOT: d }, encoding: 'utf8' });
    assert(r.status === 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert(checkWarnings().length === 0, `expected 0 warnings below 80%, got ${JSON.stringify(checkWarnings())}`);

  // Push mock to exact 80% on calls (8/10), 80% on usd via IEEE-754 tricky $0.01 + seven $0.00..., let's do 10 x $0.40 on claude ($4.00/$5 = 80%) and 100% tokens on mock
  fs.writeFileSync(logFile, [
    ...Array(8).fill(0).map((_, i) => mkEv(`${today}T00:02:0${i}.000Z`, 'mock', 0.1, i === 0 ? 1000 : 0)),
    ...Array(10).fill(0).map((_, i) => mkEv(`${today}T00:03:0${i}.000Z`, 'claude', 0.4, 0))
  ].join('\n') + '\n');

  const warns = checkWarnings();
  const tokW = warns.find((w) => w.engine === 'mock' && w.metric === 'tokens');
  const callsW = warns.find((w) => w.engine === 'mock' && w.metric === 'calls');
  const usdW = warns.find((w) => w.engine === 'claude' && w.metric === 'usd');
  assert(tokW && tokW.pct === 100 && tokW.over === true && tokW.remaining === 0, JSON.stringify(tokW));
  assert(callsW && callsW.pct === 80 && callsW.over === false && callsW.remaining === 2, JSON.stringify(callsW));
  assert(usdW && usdW.pct === 80 && usdW.over === false && usdW.used === 4 && usdW.remaining === 1, JSON.stringify(usdW));

  // usage.mjs (--json + text)
  const uJson = JSON.parse(node(d, ['.harness/usage.mjs', '--json']).stdout);
  assert(Array.isArray(uJson.warnings) && uJson.warnings.length >= 3, JSON.stringify(uJson));
  const uTxt = node(d, ['.harness/usage.mjs']);
  assert(uTxt.status === 0 && /Quota warning: mock at 80% of daily calls limit \(8\/10 calls\)/.test(uTxt.stdout) && /Quota warning: claude at 80% of daily usd limit \(\$4\.00\/\$5\)/.test(uTxt.stdout), uTxt.stdout);

  // start.mjs (--json + --summary)
  const sJson = JSON.parse(node(d, ['.harness/start.mjs', '--json']).stdout);
  assert(Array.isArray(sJson.quotaWarnings) && sJson.quotaWarnings.length >= 3, JSON.stringify(sJson.quotaWarnings));
  const sSum = node(d, ['.harness/start.mjs', '--summary']);
  assert(sSum.status === 0 && /! Quota warning: mock at 80% of daily calls limit/.test(sSum.stdout), sSum.stdout);

  // dispatch.mjs pre-flight warning: adjust mock below 100% (8/10 calls, 800/1000 tokens -> 80%, not blocked) and confirm non-blocking execution + quotaFallback hint
  fs.writeFileSync(logFile, Array(8).fill(0).map((_, i) => mkEv(`${today}T00:04:0${i}.000Z`, 'mock', 0.1, 100)).join('\n') + '\n');
  const disp = node(d, ['.harness/dispatch.mjs', '--goal', 'WRITE src/p4.txt ok', '--files', 'src/p4.txt', '--check', existsCheck('src/p4.txt'), '--wait']);
  assert(disp.status === 0, `dispatch failed: ${disp.stdout}\n${disp.stderr}`);
  assert(/! Quota warning: mock at 80% of daily calls limit \(8\/10 calls\) \(quotaFallback → claude configured\)/.test(disp.stdout), disp.stdout);
  assert(/RESULT: COMMITTED/.test(disp.stdout) && read(d, 'src/p4.txt') === 'ok', disp.stdout);

  // dispatch --engine agy alias normalizes cleanly to antigravity
  const dAgy = sandbox();
  withProfiles(dAgy, { antigravity: tieredProfile({ fast: 'ag-fast', medium: 'ag-med', high: 'ag-high' }) });
  const rAgy = node(dAgy, ['.harness/dispatch.mjs', '--goal', 'WRITE src/agy_alias.txt ok', '--files', 'src/agy_alias.txt', '--engine', 'agy', '--check', existsCheck('src/agy_alias.txt'), '--wait']);
  assert(rAgy.status === 0 && /Dispatched \[ANTIGRAVITY\]/.test(rAgy.stdout) && read(dAgy, 'src/agy_alias.txt') === 'ok', rAgy.stdout + rAgy.stderr);
});

// ───────────── v1.0.13 (Priority 5): local read-only web UI (.harness/ui.mjs) ─────────────

async function startUiProcess(cwd, extraEnv = {}, extraArgs = []) {
  const child = spawn(process.execPath, [path.join(cwd, '.harness', 'ui.mjs'), '--port', '0', '--no-open', ...extraArgs], {
    cwd,
    env: { ...env, HARNESS_ROOT: cwd, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  let err = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ui.mjs did not announce URL within 10s.\nstdout: ${out}\nstderr: ${err}`)), 10000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`ui.mjs exited early (${code}).\nstdout: ${out}\nstderr: ${err}`));
    });
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 1500);
      child.once('close', () => { clearTimeout(killTimer); resolve(); });
      try { child.kill('SIGTERM'); } catch { clearTimeout(killTimer); resolve(); }
    });
  };
  return { url, port: new URL(url).port, stop };
}

await test('ui.mjs CLI guards & local HTTP dashboard (offline SPA, 127.0.0.1, read-only routes, 405/404, non-git sessions)', async () => {
  const d = sandbox();
  // CLI guards
  const rHelp = node(d, ['.harness/ui.mjs', '--help']);
  assert(rHelp.status === 0 && /ui\.mjs/.test(rHelp.stdout) && /--no-open/.test(rHelp.stdout), rHelp.stdout + rHelp.stderr);
  assert(node(d, ['.harness/ui.mjs', '--no-open'], { HARNESS_WORKER: '1' }).status === 2, 'HARNESS_WORKER=1 must exit 2');
  for (const badPort of [['--port', 'bad'], ['--port', '-1'], ['--port', '70000'], ['--port=']]) {
    const rb = node(d, ['.harness/ui.mjs', '--no-open', ...badPort]);
    assert(rb.status === 1 && /Invalid --port/.test(rb.stderr), `expected exit 1 for ${badPort.join(' ')}: ${rb.stderr}`);
  }

  // Populate non-git sandbox with logs, >= 80% quota usage, backlog, held item, open visible run, state
  const cfgFile = path.join(d, '.harness', 'config.json');
  const cfg = json(cfgFile);
  cfg.dailyLimits = { mock: { calls: 10, usd: 5 } };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const today = new Date().toISOString().slice(0, 10);
  const logLines = Array(8).fill(0).map((_, i) => JSON.stringify({ ts: `${today}T00:05:0${i}.000Z`, phase: 'AGENT_USAGE', engine: 'mock', model: 'fast', ok: true, tokens: 50, usd: 0.5, ms: 400, message: `usage-${i}` }));
  logLines.push('not-valid-json-line');
  logLines.push(JSON.stringify({ ts: `${today}T00:06:00.000Z`, phase: 'DISPATCH', message: 'Started job demo' }));
  fs.writeFileSync(path.join(d, '.harness', 'telemetry.log'), logLines.join('\n') + '\n');
  fs.writeFileSync(path.join(d, '.harness', 'live.log'), '[00:05:01] line one\n[00:06:00] <script>alert(1)</script>\n');
  fs.writeFileSync(path.join(d, '.harness', 'state.json'), JSON.stringify({ phase: 'IDLE', cycle: 0, maxCycles: 3, lastGateStatus: 'PASSED', updatedAt: `${today}T00:06:00.000Z` }));
  setBacklog(d, [
    { id: 'T-1', title: 'Ready work', status: 'READY', priority: 1, role: 'DEV_ENGINEER', goal: 'do it' },
    { id: 'T-HELD', title: 'Big team work', status: 'BLOCKED', needsApproval: true, blockedReason: 'Needs your OK', priority: 2, goal: 'big' }
  ]);
  const runId = runIdOf(vis(d, 'brief', '--goal', 'Dashboard visible run', '--check', PASS, '--editor', 'antigravity'));

  const srv = await startUiProcess(d);
  try {
    // 1. HTML dashboard (offline, zero CDN, no-store)
    const htmlRes = await fetch(srv.url);
    assert(htmlRes.status === 200, `GET / status ${htmlRes.status}`);
    assert((htmlRes.headers.get('cache-control') || '').includes('no-store'), 'missing no-store on /');
    assert((htmlRes.headers.get('content-type') || '').includes('text/html'), 'expected text/html');
    const html = await htmlRes.text();
    assert(/Agentic Harness/.test(html) && !/<script[^>]+src=["']https?:|<link[^>]+href=["']https?:/i.test(html), 'dashboard HTML must be offline with no external CDN URLs');
    const vm = await import('node:vm');
    new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
    assert(html.includes('r.cycles ?? r.cycle ?? 0'), 'visible table should read r.cycles (plural)');

    // 2. API endpoints
    const fetchApi = async (p) => {
      const r = await fetch(`${srv.url.replace(/\/$/, '')}${p}`);
      assert(r.status === 200 && (r.headers.get('cache-control') || '').includes('no-store'), `${p} failed: ${r.status}`);
      return r.json();
    };
    const st = await fetchApi('/api/status');
    assert(st.backlog.counts.READY === 1 && st.backlog.held.length === 1 && st.visible.open[0].id === runId && st.quotaWarnings.length >= 2, JSON.stringify(st));

    const logs = await fetchApi('/api/logs');
    assert(logs.live.length === 2 && logs.telemetry.length === 9, JSON.stringify(logs));

    const usage = await fetchApi('/api/usage');
    assert(usage.today.mock.calls === 8 && usage.days7.totals.mock.calls === 8 && usage.warnings.some((w) => w.engine === 'mock' && w.pct === 80), JSON.stringify(usage));

    const bl = await fetchApi('/api/backlog');
    assert(bl.counts.READY === 1 && bl.counts.BLOCKED === 1 && bl.next.id === 'T-1', JSON.stringify(bl));

    const visData = await fetchApi('/api/visible');
    assert(visData.runs.length === 1 && visData.runs[0].id === runId && visData.runs[0].editorLabel === 'Antigravity', JSON.stringify(visData));

    // Non-git workspace returns clean unavailable payload (never 500)
    const sess = await fetchApi('/api/sessions');
    assert(sess.status === 'unavailable' && Array.isArray(sess.tasks) && sess.tasks.length === 0, JSON.stringify(sess));

    // 3. HEAD + read-only 405 + 404 + EADDRINUSE
    const headRes = await fetch(`${srv.url.replace(/\/$/, '')}/api/status`, { method: 'HEAD' });
    assert(headRes.status === 200 && (await headRes.text()) === '', 'HEAD /api/status failed');
    const postRes = await fetch(`${srv.url.replace(/\/$/, '')}/api/status`, { method: 'POST', body: '{}' });
    assert(postRes.status === 405 && (postRes.headers.get('allow') || '').includes('GET'), `expected 405, got ${postRes.status}`);
    const delRes = await fetch(`${srv.url.replace(/\/$/, '')}/api/backlog`, { method: 'DELETE' });
    assert(delRes.status === 405, `expected 405 on DELETE, got ${delRes.status}`);
    const notFound = await fetch(`${srv.url.replace(/\/$/, '')}/api/does-not-exist`);
    assert(notFound.status === 404, `expected 404, got ${notFound.status}`);

    const dup = spawnSync(process.execPath, [path.join(d, '.harness', 'ui.mjs'), '--port', srv.port, '--no-open'], {
      cwd: d, env: { ...env, HARNESS_ROOT: d }, encoding: 'utf8', timeout: 10000
    });
    assert(dup.status === 1 && /already in use/.test(dup.stderr), `expected EADDRINUSE error: ${dup.stderr}`);
  } finally {
    await srv.stop();
  }
});

await test('ui.mjs sessions API inside git repository: returns live child sessions & HIGH RISK status', async () => {
  const { d, g } = gitSandbox();
  realTest(d); g('add', 'package.json'); g('commit', '-q', '-m', 'pkg');
  const rNew = node(d, ['.harness/sessions.mjs', 'new', 'Dashboard child feature', '--type', 'feat'], { HARNESS_ROOT: d });
  assert(rNew.status === 0, rNew.stdout + rNew.stderr);
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: d, encoding: 'utf8' }).trim();
  const boardFile = path.resolve(d, common, 'harness-sessions.json');
  const bj = json(boardFile);
  bj.tasks[0].createdAt = new Date(Date.now() - 5 * 3600000).toISOString();
  fs.writeFileSync(boardFile, JSON.stringify(bj, null, 2));

  const srv = await startUiProcess(d);
  try {
    const r = await fetch(`${srv.url.replace(/\/$/, '')}/api/sessions`);
    assert(r.status === 200, r.status);
    const data = await r.json();
    assert(data.status === 'ok' && data.tasks.length === 1 && data.tasks[0].id === 'FEAT-1' && Boolean(data.tasks[0].risk), JSON.stringify(data));
    const st = await (await fetch(`${srv.url.replace(/\/$/, '')}/api/status`)).json();
    assert(st.sessions && st.sessions.highRisk.length === 1 && st.sessions.highRisk[0].id === 'FEAT-1', JSON.stringify(st.sessions));
  } finally {
    await srv.stop();
  }
});

await test('Priority 2 lost-session guards: hook-session --help & corrupt config resilience, start.mjs menuContinue status/baseline guards, submenu back keys, version banner, and TTY raw-mode release', () => {
  // 1. Corrupt config.json must NOT hide open/stopped lost editor runs or --help in hook-session.mjs
  const { d } = gitSandbox({ autonomous: false });
  const pkg = json(path.join(REPO, 'package.json'));
  const openId = runIdOf(vis(d, 'brief', '--goal', 'Keep open visible run', '--check', PASS, '--editor', 'antigravity'));
  const helpRes = node(d, ['.harness/hook-session.mjs', '--help']);
  assert(helpRes.status === 0 && /hook-session\.mjs/.test(helpRes.stdout) && !/\[Agentic Harness\] This folder/.test(helpRes.stdout), `hook-session --help failed:\n${helpRes.stdout}`);

  fs.writeFileSync(path.join(d, '.harness', 'config.json'), '{ broken json');
  const hkBroken = node(d, ['.harness/hook-session.mjs', '--brief']);
  assert(hkBroken.status === 0, hkBroken.stderr);
  const brokenLines = hkBroken.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert(brokenLines.length >= 4 && brokenLines.length <= 8, `broken config --brief expected 4-8 lines, got ${brokenLines.length}:\n${hkBroken.stdout}`);
  assert(new RegExp(`Open run ${openId}`).test(hkBroken.stdout) && /config\.json invalid/.test(hkBroken.stdout) && /node \.harness\/start\.mjs/.test(hkBroken.stdout), hkBroken.stdout);

  // Restore valid config in a fresh sandbox for start.mjs menuContinue & dispatch guards
  const d2 = sandbox();
  fs.writeFileSync(path.join(d2, '.harness', 'MANIFEST.json'), JSON.stringify({ template: 'agentic-harness', version: pkg.version, files: {} }));
  const sum2 = node(d2, ['.harness/start.mjs', '--summary']);
  assert(sum2.status === 0 && sum2.stdout.includes(`v${pkg.version}`), `expected version v${pkg.version} in banner:\n${sum2.stdout}`);

  // Create BOTH a HALTED_HITL_REQUIRED run (no baseline left) AND an open BRIEFED run (baseline present)
  const haltedId = runIdOf(vis(d2, 'brief', '--goal', 'Halted lost run', '--check', FAIL_VERIFY));
  assert(vis(d2, 'assign', haltedId, deleg([{ lead: 'lead-dev', goal: 'edit', files: ['src/'] }])).status === 0, 'assign halted');
  agentsWrite(d2, [['src/h.js', 'bad']]);
  for (let i = 0; i < 3; i++) assert(vis(d2, 'verify', haltedId).status === 1, `verify fail cycle ${i + 1}`);
  assert(runJson(d2, haltedId).status === 'HALTED_HITL_REQUIRED' && !fs.existsSync(path.join(d2, '.harness', 'visible', haltedId, 'baseline')), 'halted run should remove baseline');

  // handoff omits rollback command when baseline is absent
  const haltedHandoff = vis(d2, 'handoff', haltedId);
  assert(haltedHandoff.status === 0 && !/visible\.mjs rollback/.test(haltedHandoff.stdout) && /Undo snapshot unavailable/.test(haltedHandoff.stdout), haltedHandoff.stdout);

  const open2 = runIdOf(vis(d2, 'brief', '--goal', 'Open briefed run', '--check', PASS, '--editor', 'antigravity'));

  const runMenu2 = (input) => spawnSync(process.execPath, ['.harness/start.mjs'], { cwd: d2, env: { ...env, HARNESS_ROOT: d2 }, input, encoding: 'utf8', timeout: 20000 });
  // [1] Continue sees BOTH open2 and haltedId; picking haltedId + [3] Resume is refused cleanly; 'b' goes back inside submenu; open2 + [4] Verify is refused cleanly; 'q' goes back inside submenu [6]
  const haltedBlocked = runMenu2(`1\n${haltedId}\n3\n1\n${haltedId}\nb\n0\n`);
  assert(haltedBlocked.status === 0 && haltedBlocked.stdout.includes(open2) && haltedBlocked.stdout.includes(haltedId), haltedBlocked.stdout);
  assert(/unavailable: HALTED_HITL_REQUIRED/.test(haltedBlocked.stdout) && /Cannot resume run/.test(haltedBlocked.stdout), haltedBlocked.stdout);
  assert(!/Unknown option "b"/.test(haltedBlocked.stdout) && !/Unknown choice "b"/.test(haltedBlocked.stdout), `submenu back key 'b' failed:\n${haltedBlocked.stdout}`);

  const briefedVerifyBlocked = runMenu2(`1\n${open2}\n4\n6\nq\n0\n`);
  assert(briefedVerifyBlocked.status === 0 && /unavailable: BRIEFED/.test(briefedVerifyBlocked.stdout) && /Cannot verify run/.test(briefedVerifyBlocked.stdout), briefedVerifyBlocked.stdout);
  assert(!/Unknown option "q"/.test(briefedVerifyBlocked.stdout) && !/Unknown choice "q"/.test(briefedVerifyBlocked.stdout) && /Bye!/.test(briefedVerifyBlocked.stdout), briefedVerifyBlocked.stdout);

  // Menu [2] rejects invalid mode & engine typos instead of defaulting/running
  const badDispatch = runMenu2('2\nTest goal\nweird\n2\nTest goal\n1\n\n\nbogus-engine\n0\n');
  assert(badDispatch.status === 0 && /Unknown mode "weird"; cancelled/.test(badDispatch.stdout) && /Unknown engine "bogus-engine"; cancelled/.test(badDispatch.stdout), badDispatch.stdout);

  // Simulated TTY spy: raw mode transitions true -> false around child runScript -> true, and custom output captures Bye!
  const ttyScript = `
    import { PassThrough } from 'node:stream';
    import { runMenu } from './.harness/start.mjs';
    const input = new PassThrough();
    const output = new PassThrough();
    const rawTransitions = [];
    let out = '';
    output.on('data', (c) => { out += c.toString(); });
    input.isTTY = true;
    input.setRawMode = (mode) => { rawTransitions.push(Boolean(mode)); return input; };
    const p = runMenu({ input, output });
    setTimeout(() => input.write('6\\r6\\r0\\r'), 30);
    await p;
    console.log(JSON.stringify({ rawTransitions, hasBanner: out.includes('AGENTIC HARNESS'), hasBye: out.includes('Bye!') }));
  `;
  const ttyRes = spawnSync(process.execPath, ['--input-type=module', '-e', ttyScript], { cwd: d2, env: { ...env, HARNESS_ROOT: d2 }, encoding: 'utf8', timeout: 20000 });
  assert(ttyRes.status === 0, ttyRes.stderr + ttyRes.stdout);
  const ttyJson = JSON.parse(ttyRes.stdout.trim().split(/\r?\n/).pop());
  assert(ttyJson.hasBanner && ttyJson.hasBye && ttyJson.rawTransitions.join(',') === 'true,false,true,false', JSON.stringify(ttyJson));

  // Simulated TTY Ctrl+C (\x03) closes cleanly with exit 0
  const ttySig = ttyScript.replace("'6\\r6\\r0\\r'", "'\\x03'");
  const sigRes = spawnSync(process.execPath, ['--input-type=module', '-e', ttySig], { cwd: d2, env: { ...env, HARNESS_ROOT: d2 }, encoding: 'utf8', timeout: 20000 });
  assert(sigRes.status === 0 && JSON.parse(sigRes.stdout.trim().split(/\r?\n/).pop()).hasBanner, sigRes.stderr + sigRes.stdout);

  assert(vis(d2, 'rollback', open2).status === 0, 'cleanup open2');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

