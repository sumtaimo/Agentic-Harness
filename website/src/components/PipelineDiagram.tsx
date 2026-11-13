import { useState, type ReactNode } from 'react';
import { ArrowRight, Check, GitBranch, GitMerge, History, Lock, ShieldCheck, Wallet, X } from 'lucide-react';
import { Section, TierPill } from './ui';
import { Rich, useLang } from '../lib/lang';
import { fmt, type Dict } from '../data/i18n';
import { TIERS } from '../lib/routing';

// The controller's real phase names (.harness/daemon.mjs).
const STAGE_IDS = ['1_PLANNER', '2_EXECUTOR', '3_VERIFIER', '4_COMMITTED'];

const GUARD_ICONS: Record<keyof Dict['arch']['guards'], ReactNode> = {
  worktrees: <GitBranch size={16} />, uat: <GitMerge size={16} />, rollback: <History size={16} />,
  scopes: <Lock size={16} />, budget: <Wallet size={16} />, fatal: <ShieldCheck size={16} />,
};

export function PipelineDiagram() {
  const { t } = useLang();
  const a = t.arch;
  const [stage, setStage] = useState(0);
  return (
    <Section id="architecture" eyebrow={a.eyebrow} title={a.title} intro={a.intro}>
      {/* Stage stepper */}
      <div role="tablist" aria-label={a.stagesLabel} className="mx-auto grid max-w-4xl grid-cols-2 gap-2 sm:grid-cols-4">
        {a.stages.map((s, i) => (
          <button key={STAGE_IDS[i]} type="button" role="tab" aria-selected={stage === i} onClick={() => setStage(i)}
            className={`rounded-xl border p-3 text-center transition ${stage === i ? 'border-accent/60 bg-accent-soft' : 'border-line bg-surface hover:border-line-strong'}`}>
            <span className={`mx-auto grid h-7 w-7 place-items-center rounded-full font-mono text-xs font-semibold ${stage === i ? 'bg-accent text-bg' : 'bg-surface-2 text-muted'}`}>{i + 1}</span>
            <span className="mt-2 block text-sm font-medium text-fg">{s.title}</span>
            <code className="mt-0.5 block font-mono text-[11px] text-faint">{STAGE_IDS[i]}</code>
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mx-auto mt-4 max-w-4xl rounded-xl border border-line bg-surface p-6">
        <p className="text-center text-base font-medium text-fg">{a.stages[stage].text}</p>
        <ul className="mx-auto mt-4 grid max-w-3xl gap-2 sm:grid-cols-2">
          {a.stages[stage].checks.map((c) => (
            <li key={c} className="flex gap-2.5 rounded-lg bg-surface-2 p-3 text-sm leading-6 text-muted">
              <Check size={15} className="mt-1 shrink-0 text-ok" /><span><Rich text={c} /></span>
            </li>
          ))}
        </ul>
      </div>

      <RetryLoop />
      <BranchFlow />

      <h3 className="mt-20 text-center text-xl font-semibold tracking-tight text-fg">{a.guardsTitle}</h3>
      <div className="mt-8 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
        {(Object.keys(GUARD_ICONS) as (keyof typeof GUARD_ICONS)[]).map((k) => (
          <div key={k} className="bg-surface p-5 text-center">
            <div className="flex items-center justify-center gap-2.5 text-fg"><span className="text-accent">{GUARD_ICONS[k]}</span><h4 className="font-medium">{a.guards[k].title}</h4></div>
            <p className="mt-2 text-sm leading-6 text-muted"><Rich text={a.guards[k].text} /></p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** A small 1-file edit starts on fast; each failed cycle runs one tier higher; 3 failures → rollback. */
function RetryLoop() {
  const { t } = useLang();
  const a = t.arch;
  const [passOn, setPassOn] = useState(1); // 1..3, or 4 = never
  const cycles = [1, 2, 3].filter((c) => c <= Math.min(passOn, 3));
  return (
    <div className="mx-auto mt-16 max-w-4xl text-center">
      <h3 className="text-xl font-semibold tracking-tight text-fg">{a.simTitle}</h3>
      <p className="mt-2 text-sm text-muted">{a.simHint}</p>
      <div className="mt-4 inline-flex flex-wrap justify-center rounded-lg border border-line bg-surface p-0.5" role="radiogroup" aria-label={a.simTitle}>
        {a.passOn.map((label, i) => (
          <button key={label} type="button" role="radio" aria-checked={passOn === i + 1} onClick={() => setPassOn(i + 1)}
            className={`rounded-md px-3 py-1 text-xs transition ${passOn === i + 1 ? 'bg-fg text-bg' : 'text-muted hover:text-fg'}`}>{label}</button>
        ))}
      </div>
      <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row" aria-live="polite">
        {cycles.map((c, i) => {
          const ok = c === passOn;
          return (
            <div key={c} className="flex flex-col items-center gap-2 sm:flex-row">
              {i > 0 && <ArrowRight size={14} className="rotate-90 text-faint sm:rotate-0" aria-hidden="true" />}
              <div className={`w-44 rounded-xl border p-3 ${ok ? 'border-ok/50 bg-ok-soft' : 'border-danger/40 bg-danger-soft'}`}>
                <p className="text-xs text-muted">{fmt(a.cycleN, { n: c })}</p>
                <div className="mt-1.5"><TierPill tier={TIERS[c - 1]} /></div>
                <p className={`mt-1.5 flex items-center justify-center gap-1 text-xs font-medium ${ok ? 'text-ok' : 'text-danger'}`}>
                  {ok ? <Check size={13} /> : <X size={13} />}{ok ? a.passed : a.failed}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <p className={`mx-auto mt-5 max-w-2xl rounded-lg border p-3 text-sm leading-6 ${passOn <= 3 ? 'border-ok/40 bg-ok-soft text-fg' : 'border-warn/40 bg-warn-soft text-fg'}`}>
        <Rich text={passOn <= 3 ? fmt(a.kept, { n: passOn }) : a.rolled} />
      </p>
    </div>
  );
}

function BranchFlow() {
  const { t } = useLang();
  const a = t.arch;
  const n = a.branchNodes;
  const node = (label: string, cls: string, mono = true) => <span className={`rounded-lg border px-3 py-1.5 text-sm ${mono ? 'font-mono' : ''} ${cls}`}>{label}</span>;
  return (
    <div className="mx-auto mt-16 max-w-4xl rounded-2xl border border-line bg-surface p-6 text-center sm:p-8">
      <h3 className="text-xl font-semibold tracking-tight text-fg">{a.branchTitle}</h3>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2" aria-hidden="true">
        {node(n.worker, 'border-line bg-surface-2 text-muted')}
        <ArrowRight size={14} className="text-faint" />
        {node(n.uat, 'border-accent/50 bg-accent-soft text-accent')}
        <ArrowRight size={14} className="text-faint" />
        {node(n.you, 'border-line bg-surface-2 text-fg', false)}
        <ArrowRight size={14} className="text-faint" />
        {node(n.main, 'border-ok/50 bg-ok-soft text-ok')}
      </div>
      <p className="mx-auto mt-5 max-w-2xl text-sm leading-7 text-muted"><Rich text={a.branchText} /></p>
    </div>
  );
}
