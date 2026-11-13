import type { ReactNode } from 'react';
import { ArrowRight, CheckCircle2, Gauge, Monitor } from 'lucide-react';
import { CopyButton, GithubMark } from './ui';
import { INSTALL_CMD, TEMPLATE_URL, TESTS_PASSING } from '../site';
import { Rich, useLang } from '../lib/lang';
import { fmt } from '../data/i18n';

export function Hero() {
  const { t } = useLang();
  const h = t.hero;
  const leads = [
    { id: 'lead-ba', role: 'BA_ANALYST', note: h.notes.ba },
    { id: 'lead-dev', role: 'DEV_ENGINEER', note: h.notes.dev },
    { id: 'lead-qa', role: 'QA_AUDITOR', note: h.notes.qa },
  ];
  return (
    <section id="top" className="relative overflow-hidden">
      <div className="hero-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-16 text-center sm:px-6 sm:pt-24">
        <a href="#how" className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted transition hover:text-fg">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" /> {h.pill} <ArrowRight size={12} className="shrink-0" />
        </a>
        <h1 className="mx-auto mt-6 max-w-4xl text-balance text-[40px] font-semibold leading-[1.08] tracking-tight text-fg sm:text-[56px]">{h.title}</h1>
        <p className="mx-auto mt-6 max-w-2xl text-pretty text-[17px] leading-8 text-muted"><Rich text={h.lead} /></p>

        <div className="mx-auto mt-9 max-w-xl">
          <div className="flex items-center gap-3 rounded-xl border border-term-line bg-term px-4 py-3 text-left font-mono text-sm">
            <span className="select-none text-term-muted">$</span>
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-term-fg">{INSTALL_CMD}</code>
            <CopyButton text={INSTALL_CMD} />
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <a href={TEMPLATE_URL} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-lg bg-fg px-4 text-sm font-medium text-bg transition hover:opacity-90">
              <GithubMark size={15} /> {h.template}
            </a>
            <a href="#use-cases" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line px-4 text-sm text-fg transition hover:bg-surface-2">
              {h.playbooks} <ArrowRight size={14} />
            </a>
          </div>
          <p className="mt-3 text-xs text-faint">{h.needs}</p>
        </div>

        <ul className="mt-8 flex flex-wrap justify-center gap-2" aria-label={h.statusLabel}>
          <Badge icon={<CheckCircle2 size={13} className="text-ok" />}>{fmt(h.badges.tests, { n: TESTS_PASSING })}</Badge>
          <Badge icon={<Monitor size={13} className="text-accent" />}>{h.badges.os}</Badge>
          <Badge icon={<Gauge size={13} className="text-warn" />}>{h.badges.tiers}</Badge>
        </ul>

        {/* The agent team as an org chart */}
        <div className="mx-auto mt-14 max-w-4xl rounded-2xl border border-line bg-surface/80 p-5 text-left shadow-[0_24px_60px_-30px_rgba(0,0,0,0.35)] backdrop-blur-sm sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-xs text-faint">{h.teamFile}</p>
            <span className="rounded-md bg-ok-soft px-2 py-0.5 text-[11px] text-ok">{h.teamValid}</span>
          </div>
          <div className="mx-auto mt-5 max-w-sm"><Node level="L1" id="orchestrator" role="PO_ARCHITECT" note={h.notes.orchestrator} highlight /></div>
          <div className="relative mx-auto mt-0 hidden h-6 max-w-[67%] border-x border-t border-dashed border-line-strong sm:block" aria-hidden="true">
            <span className="absolute -top-6 left-1/2 h-6 border-l border-dashed border-line-strong" />
          </div>
          <div className="mt-3 grid gap-3 sm:mt-0 sm:grid-cols-3">
            {leads.map((l) => <Node key={l.id} level="L2" {...l} />)}
          </div>
          <p className="mt-4 text-center text-[12px] text-faint">{h.l3}</p>
        </div>
      </div>
    </section>
  );
}

function Badge({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <li className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-muted">{icon}{children}</li>;
}

function Node({ level, id, role, note, highlight = false }: { level: string; id: string; role: string; note: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 text-center ${highlight ? 'border-accent/40 bg-accent-soft' : 'border-line bg-surface-2'}`}>
      <p className="font-mono text-[10px] text-faint">{level}</p>
      <p className="font-mono text-sm font-medium text-fg">{id}</p>
      <p className="font-mono text-[11px] text-accent">[{role}]</p>
      <p className="mt-1 text-xs text-muted">{note}</p>
    </div>
  );
}
