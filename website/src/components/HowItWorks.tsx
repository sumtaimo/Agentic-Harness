import { useState, type ReactNode } from 'react';
import {
  ArrowDown, BookLock, Cpu, FileLock2, GitBranch, Lock, OctagonX, ScanSearch, User, Users, Info,
} from 'lucide-react';
import { Section } from './ui';
import { Rich, useLang } from '../lib/lang';
import type { Dict } from '../data/i18n';

type Duty = keyof Dict['how']['duties'];

/** Where each duty lives in the harness code (real file + function names). */
const DUTIES: { id: Duty; icon: ReactNode; code: string }[] = [
  { id: 'charter', icon: <BookLock size={16} />, code: 'lib/governance.mjs · readCharter()' },
  { id: 'scope', icon: <FileLock2 size={16} />, code: 'daemon.mjs · validateSubtasks() · lib/governance.mjs · validateTeam()' },
  { id: 'tier', icon: <Cpu size={16} />, code: 'lib/common.mjs · chooseModelTier()' },
  { id: 'isolate', icon: <GitBranch size={16} />, code: 'lib/integration.mjs · ensureWorkerWorktree()' },
  { id: 'verify', icon: <ScanSearch size={16} />, code: 'daemon.mjs · runVerifier()' },
  { id: 'fatal', icon: <OctagonX size={16} />, code: 'daemon.mjs · engineErrorIsFatal()' },
];

const SHARED_FILES = ['.harness/charter.md', '.harness/backlog.json', '.harness/team.json', '.harness/memory/lessons.md'];
const PERSONAL_FILES = ['.claude/settings.local.json', '.agent-state/', '.harness/memory/profile.md*'];

export function HowItWorks() {
  const { t } = useLang();
  const h = t.how;
  return (
    <Section id="how" eyebrow={h.eyebrow} title={h.title} intro={<Rich text={h.intro} />}>
      <ControllerBrain />
      <AgentFlow />
      <People />
    </Section>
  );
}

function SubHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <h3 className="text-xl font-semibold tracking-tight text-fg">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted">{hint}</p>
    </div>
  );
}

/* ── 1. The controller brain ─────────────────────────────────────────── */
function ControllerBrain() {
  const { t } = useLang();
  const h = t.how;
  const [active, setActive] = useState<Duty>('tier');
  const duty = DUTIES.find((d) => d.id === active)!;
  const button = (d: (typeof DUTIES)[number]) => (
    <button key={d.id} type="button" role="tab" aria-selected={active === d.id} onClick={() => setActive(d.id)}
      className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition ${active === d.id ? 'border-accent/60 bg-accent-soft text-fg' : 'border-line bg-surface text-muted hover:border-line-strong hover:text-fg'}`}>
      <span className={active === d.id ? 'text-accent' : 'text-faint'}>{d.icon}</span>
      <span className="font-medium">{h.duties[d.id].title}</span>
    </button>
  );
  return (
    <div>
      <SubHead title={h.brainTitle} hint={h.brainHint} />
      <div className="mt-8 grid items-center gap-3 md:grid-cols-[1fr_auto_1fr] md:gap-6" role="tablist" aria-label={h.brainTitle}>
        <div className="space-y-3">{DUTIES.slice(0, 3).map(button)}</div>
        <div className="mx-auto grid h-36 w-36 place-items-center rounded-full border border-accent/40 bg-accent-soft text-center shadow-[0_0_60px_-12px_var(--accent)]" aria-hidden="true">
          <div>
            <Lock size={20} className="mx-auto text-accent" />
            <p className="mt-1.5 font-semibold text-fg">{h.brainCore}</p>
            <p className="mt-0.5 px-3 text-[10.5px] leading-4 text-muted">{h.brainCoreSub}</p>
          </div>
        </div>
        <div className="space-y-3">{DUTIES.slice(3).map(button)}</div>
      </div>
      <div role="tabpanel" className="mx-auto mt-6 max-w-3xl rounded-xl border border-line bg-surface p-5 text-center">
        <p className="flex items-center justify-center gap-2 font-medium text-fg"><span className="text-accent">{duty.icon}</span>{h.duties[active].title}</p>
        <p className="mt-2 text-sm leading-7 text-muted"><Rich text={h.duties[active].text} /></p>
        <code className="mt-3 inline-block rounded-md bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-faint">.harness/{duty.code}</code>
      </div>
    </div>
  );
}

/* ── 2. The agent flow (identical for every person) ──────────────────── */
function AgentFlow() {
  const { t } = useLang();
  const h = t.how;
  return (
    <div className="mt-20">
      <SubHead title={h.flowTitle} hint={h.flowHint} />
      <ol className="mx-auto mt-8 max-w-xl">
        {h.flow.map((s, i) => (
          <li key={i} className="flex flex-col items-center">
            <div className={`w-full rounded-xl border p-4 text-center ${i === 3 ? 'border-accent/50 bg-accent-soft' : 'border-line bg-surface'}`}>
              <p className="font-mono text-[13px] font-medium text-fg">{s.t}</p>
              <p className="mt-1 text-sm leading-6 text-muted"><Rich text={s.d} /></p>
            </div>
            {i < h.flow.length - 1 && <ArrowDown size={16} className="my-1.5 text-faint" aria-hidden="true" />}
          </li>
        ))}
      </ol>
      <p className="mx-auto mt-5 max-w-2xl text-center text-xs leading-6 text-faint"><Rich text={h.flowNote} /></p>
    </div>
  );
}

/* ── 3. One developer or a team of people ────────────────────────────── */
function People() {
  const { t } = useLang();
  const h = t.how;
  const [who, setWho] = useState<'solo' | 'group'>('solo');
  return (
    <div className="mt-20">
      <SubHead title={h.peopleTitle} hint={h.peopleHint} />

      <div className="mx-auto mt-6 flex max-w-3xl gap-3 rounded-xl border border-ok/40 bg-ok-soft p-4 text-sm leading-6 text-fg">
        <Info size={16} className="mt-1 shrink-0 text-ok" />
        <p><Rich text={h.notSolo} /></p>
      </div>

      {/* Toggle on small screens; both cards side by side on wide screens */}
      <div className="mt-8 flex justify-center md:hidden">
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" role="radiogroup" aria-label={h.peopleTitle}>
          {(['solo', 'group'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={who === k} onClick={() => setWho(k)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${who === k ? 'bg-fg text-bg' : 'text-muted'}`}>{h[k].label}</button>
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:mt-8 md:grid-cols-2">
        <PersonCard hidden={who !== 'solo'} icon={<User size={18} />} label={h.solo.label} tag={h.solo.tag} points={h.solo.points} />
        <PersonCard hidden={who !== 'group'} icon={<Users size={18} />} label={h.group.label} tag={h.group.tag} points={h.group.points}>
          <div className="grid gap-3 sm:grid-cols-2">
            <FileGroup title={h.group.shared} files={SHARED_FILES} />
            <FileGroup title={h.group.personal} files={PERSONAL_FILES} muted />
          </div>
        </PersonCard>
      </div>

      <div className="mx-auto mt-8 max-w-4xl overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-xs text-muted">
              {h.compare.head.map((c, i) => <th key={i} className={`px-4 py-2.5 font-medium ${i === 0 ? 'text-left' : 'text-center'}`}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {h.compare.rows.map((r) => (
              <tr key={r[0]} className="border-b border-line bg-surface last:border-0">
                <td className="px-4 py-2.5 text-muted"><Rich text={r[0]} /></td>
                <td className="px-4 py-2.5 text-center text-fg"><Rich text={r[1]} /></td>
                <td className="px-4 py-2.5 text-center text-fg"><Rich text={r[2]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mx-auto mt-6 grid max-w-4xl gap-3 text-xs leading-6 text-muted md:grid-cols-2">
        <p className="rounded-lg border border-line bg-surface p-3">* <Rich text={h.profileNote} /></p>
        <p className="rounded-lg border border-warn/30 bg-warn-soft p-3 text-fg"><Rich text={h.coordNote} /></p>
      </div>
    </div>
  );
}

function PersonCard({ hidden, icon, label, tag, points, children }: { hidden: boolean; icon: ReactNode; label: string; tag: string; points: string[]; children?: ReactNode }) {
  return (
    <div className={`${hidden ? 'hidden md:flex' : 'flex'} flex-col rounded-2xl border border-line bg-surface p-6`}>
      <div className="flex items-center justify-center gap-2.5 text-fg">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-accent-soft text-accent">{icon}</span>
        <h4 className="text-lg font-semibold">{label}</h4>
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-faint">{tag}</span>
      </div>
      <ul className="mt-5 flex-1 space-y-2.5 text-sm leading-6 text-muted">
        {points.map((p) => <li key={p} className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /><span><Rich text={p} /></span></li>)}
      </ul>
      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}

function FileGroup({ title, files, muted = false }: { title: string; files: string[]; muted?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${muted ? 'border-line bg-surface-2' : 'border-accent/30 bg-accent-soft'}`}>
      <p className="text-xs font-medium text-fg">{title}</p>
      <ul className="mt-1.5 space-y-0.5 font-mono text-[11.5px] text-muted">{files.map((f) => <li key={f}>{f}</li>)}</ul>
    </div>
  );
}
